'use strict';

const express = require('express');
const { db } = require('../firebase');
const parseAdvanceMessage = require('../services/messageParser');
const { sendAdvanceRequestNotification } = require('../services/notifications');
const sendWhatsAppMessage = require('../services/whatsapp');
const {
  downloadWhatsAppImage,
  recognizeReceipt,
  buildReply,
  calculateBringAmount,
  extractPayInOutItems
} = require('../services/shiftReceipt');

const router = express.Router();


const DEFAULT_PAY_IN_OUT_REASONS = [
  'Hadunkuru',
  'Poltel',
  'Petrol',
  'Adu',
  'Wedi',
  'Battry',
  'Bill Payment',
  'Rusiru Advance',
  'Prasanna Advance',
  'Nandasena Advance'
];

async function getPayInOutReasons() {
  try {
    const doc = await db.collection('app_settings').doc('pay_in_out_reasons').get();
    const values = doc.exists && Array.isArray(doc.data()?.reasons) ? doc.data().reasons : [];
    const cleaned = values.map((value) => String(value || '').trim()).filter(Boolean);
    return cleaned.length ? cleaned : DEFAULT_PAY_IN_OUT_REASONS;
  } catch (error) {
    console.warn('Could not load Pay In/Out reasons, using defaults:', error.message);
    return DEFAULT_PAY_IN_OUT_REASONS;
  }
}

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified.');
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

async function processShiftReceiptImage(message, senderNumber) {
  const receiptRef = db.collection('shift_receipt_messages').doc(message.id);
  const existing = await receiptRef.get();

  // Meta can retry webhook deliveries. Never send the same automatic reply twice.
  if (existing.exists && existing.data()?.replySent === true) {
    console.log('Shift receipt already processed:', message.id);
    return;
  }

  await receiptRef.set(
    {
      id: message.id,
      whatsappMessageId: message.id,
      senderNumber,
      mediaId: message.image?.id || null,
      status: 'processing',
      receivedAt: new Date()
    },
    { merge: true }
  );

  try {
    const imageBuffer = await downloadWhatsAppImage(message.image?.id);
    const result = await recognizeReceipt(imageBuffer);

    if (!result.success) {
      const failureReply = 'Photo එක පැහැදිලිව නැවත එවන්න.';
      const sendResult = await sendWhatsAppMessage(senderNumber, failureReply);

      await receiptRef.set(
        {
          status: 'needs_clearer_photo',
          failureReason: result.reason,
          detectedBranch: result.branch || null,
          replyText: failureReply,
          replySent: Boolean(sendResult?.success),
          processedAt: new Date()
        },
        { merge: true }
      );

      console.warn('Shift receipt OCR failed:', message.id, result.reason, result.branchOcrPreview || '');
      return;
    }

    const reasons = await getPayInOutReasons();
    const payInOutItems = extractPayInOutItems(result.payInOutText || result.text, reasons);
    const replyText = buildReply(result);
    const sendResult = await sendWhatsAppMessage(senderNumber, replyText);
    const bringAmount = calculateBringAmount(result.actualEndingCash, result.balance);
    const processedAt = new Date();
    const dateParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Colombo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(processedAt).reduce((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});
    const sriLankaDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;

    await receiptRef.set(
      {
        status: 'completed',
        branch: result.branch,
        branchRaw: result.branchRaw || null,
        actualEndingCash: result.actualEndingCash,
        balance: result.balance,
        bringAmount,
        amountSource: result.amountSource,
        difference: result.difference ?? result.drawerValues?.difference ?? null,
        ocrMode: result.ocrMode || null,
        drawerValues: result.drawerValues,
        payInOutItems,
        replyText,
        replySent: Boolean(sendResult?.success),
        replyMessageId: sendResult?.messageId || null,
        dateKey: sriLankaDate,
        processedAt
      },
      { merge: true }
    );

    // History used by the Android app. One document per WhatsApp receipt keeps a complete audit trail.
    await db.collection('shift_cash_history').doc(message.id).set({
      id: message.id,
      whatsappMessageId: message.id,
      senderNumber,
      branch: result.branch,
      branchRaw: result.branchRaw || null,
      actualEndingCash: result.actualEndingCash,
      removeAmount: result.balance,
      bringAmount,
      difference: result.difference ?? result.drawerValues?.difference ?? null,
      payInOutItems,
      ocrMode: result.ocrMode || null,
      dateKey: sriLankaDate,
      replyText,
      createdAt: processedAt
    }, { merge: true });

    console.log('Shift receipt processed:', message.id, replyText, 'PayIn/Out:', payInOutItems);
  } catch (error) {
    console.error('Shift receipt processing error:', message.id, error);

    // Do not guess a cash value when OCR/media processing fails.
    try {
      const failureReply = 'Photo එක පැහැදිලිව නැවත එවන්න.';
      const sendResult = await sendWhatsAppMessage(senderNumber, failureReply);
      await receiptRef.set(
        {
          status: 'error',
          error: error.message,
          replyText: failureReply,
          replySent: Boolean(sendResult?.success),
          processedAt: new Date()
        },
        { merge: true }
      );
    } catch (replyError) {
      await receiptRef.set(
        {
          status: 'error',
          error: error.message,
          replyError: replyError.message,
          replySent: false,
          processedAt: new Date()
        },
        { merge: true }
      );
      console.error('Shift receipt failure reply error:', replyError);
    }
  }
}

router.post('/', async (req, res) => {
  // Meta expects a quick 200 response.
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body?.object !== 'whatsapp_business_account') {
      return;
    }

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const contacts = value.contacts || [];

        for (const message of value.messages || []) {
          const senderNumber = message.from;

          // NEW: Shift Summary photo automation. Existing text workflow below is unchanged.
          if (message.type === 'image') {
            await processShiftReceiptImage(message, senderNumber);
            continue;
          }

          if (message.type !== 'text') {
            continue;
          }

          const messageText = message.text?.body || '';
          const parsed = parseAdvanceMessage(messageText);

          const employeeName =
            contacts.find((contact) => contact.wa_id === senderNumber)?.profile?.name || 'Unknown';

          const requestData = {
            id: message.id,
            whatsappMessageId: message.id,
            senderNumber,
            employeeName,
            messageText,
            amount: parsed.amount,
            status: parsed.isAdvanceRequest ? 'pending' : 'needs_review',
            receivedAt: new Date()
          };

          const requestRef = db.collection('advance_requests').doc(message.id);
          const existingRequest = await requestRef.get();

          await requestRef.set(requestData, { merge: true });

          console.log('Saved WhatsApp request:', message.id);

          // Meta may retry the same webhook. Notify only for a genuinely new message.
          if (parsed.isAdvanceRequest && !existingRequest.exists) {
            try {
              const notificationResult = await sendAdvanceRequestNotification(requestData);
              console.log('FCM notification result:', notificationResult);
            } catch (notificationError) {
              // Keep the WhatsApp webhook successful even if push delivery fails.
              console.error('FCM notification error:', notificationError);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Webhook processing error:', error);
  }
});

module.exports = router;
