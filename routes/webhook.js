'use strict';

const express = require('express');
const { db } = require('../firebase');
const parseAdvanceMessage = require('../services/messageParser');
const { sendAdvanceRequestNotification } = require('../services/notifications');
const sendWhatsAppMessage = require('../services/whatsapp');
const { sendWhatsAppImage } = require('../services/whatsapp');
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


function splitNumbers(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((item) => item.replace(/[^0-9]/g, ''))
    .filter(Boolean);
}

function normalizeNumber(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function getShiftBranchForEmployee(senderNumber) {
  const number = normalizeNumber(senderNumber);
  const mainEmployees = splitNumbers(process.env.SHIFT_MAIN_EMPLOYEE_NUMBERS);
  const getahettaEmployees = splitNumbers(process.env.SHIFT_GETAHETTA_EMPLOYEE_NUMBERS);

  if (mainEmployees.includes(number)) return 'MAIN';
  if (getahettaEmployees.includes(number)) return 'GETAHETTA';
  return null;
}

function parseManualMoney(text, { allowNegative = false } = {}) {
  const raw = String(text || '').trim().replace(/,/g, '').replace(/\s+/g, '');
  const match = raw.match(allowNegative ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/);
  if (!match) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function sendShiftResult(receiptRef, data, senderNumber) {
  const result = data.result || data;
  const bringAmount = calculateBringAmount(result.actualEndingCash, result.balance);
  const replyText = buildReply({ ...result, branch: data.branch });
  const sendResult = await sendWhatsAppMessage(senderNumber, replyText);
  const processedAt = new Date();
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(processedAt).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  const sriLankaDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;

  await receiptRef.set({
    status: 'completed',
    branch: data.branch,
    branchSource: 'employee_phone_mapping',
    actualEndingCash: result.actualEndingCash,
    balance: result.balance,
    bringAmount,
    amountSource: result.amountSource || null,
    difference: result.difference ?? null,
    ocrMode: result.ocrMode || null,
    drawerValues: result.drawerValues || null,
    payInOutItems: data.payInOutItems || [],
    replyText,
    replySent: Boolean(sendResult?.success),
    replyMessageId: sendResult?.messageId || null,
    dateKey: sriLankaDate,
    processedAt
  }, { merge: true });

  await db.collection('shift_cash_history').doc(data.messageId).set({
    id: data.messageId,
    whatsappMessageId: data.messageId,
    senderNumber,
    branch: data.branch,
    branchSource: 'employee_phone_mapping',
    actualEndingCash: result.actualEndingCash,
    removeAmount: result.balance,
    bringAmount,
    difference: result.difference ?? null,
    payInOutItems: data.payInOutItems || [],
    ocrMode: result.ocrMode || null,
    dateKey: sriLankaDate,
    replyText,
    createdAt: processedAt
  }, { merge: true });
}

async function handlePendingShiftManual(message, senderNumber) {
  if (message.type !== 'text') return false;
  const pendingRef = db.collection('shift_receipt_manual_requests').doc(normalizeNumber(senderNumber));
  const pendingSnap = await pendingRef.get();
  if (!pendingSnap.exists) return false;

  const pending = pendingSnap.data() || {};
  const value = parseManualMoney(message.text?.body, { allowNegative: pending.field === 'difference' });
  if (value === null) {
    const prompt = pending.field === 'actualEndingCash'
      ? 'Actual Ending Cash amount එක විතරක් number එකක් ලෙස එවන්න. උදා: 4590'
      : 'Difference amount එක විතරක් number එකක් ලෙස එවන්න. උදා: -50';
    await sendWhatsAppMessage(senderNumber, prompt);
    return true;
  }

  const receiptRef = db.collection('shift_receipt_messages').doc(pending.messageId);
  const receiptSnap = await receiptRef.get();
  if (!receiptSnap.exists) {
    await pendingRef.delete();
    await sendWhatsAppMessage(senderNumber, 'මේ Shift Summary එක හොයාගන්න බැරි වුණා. Photo එක නැවත එවන්න.');
    return true;
  }

  const receipt = receiptSnap.data() || {};
  const branch = receipt.branch;
  const payInOutItems = receipt.payInOutItems || [];
  const result = {
    actualEndingCash: receipt.actualEndingCash,
    balance: receipt.balance,
    difference: receipt.difference,
    amountSource: receipt.amountSource,
    drawerValues: receipt.drawerValues
  };

  if (pending.field === 'actualEndingCash') {
    result.actualEndingCash = Math.round(value * 100) / 100;
    result.balance = calculateBalance(result.actualEndingCash);
    result.amountSource = 'manual_actual_ending_cash';
    await receiptRef.set({ actualEndingCash: result.actualEndingCash, balance: result.balance, amountSource: result.amountSource }, { merge: true });

    if (result.difference === null || result.difference === undefined) {
      await pendingRef.set({ field: 'difference', updatedAt: new Date() }, { merge: true });
      await receiptRef.set({ status: 'waiting_manual_difference' }, { merge: true });
      await sendWhatsAppMessage(senderNumber, 'Actual Ending Cash ලැබුණා. දැන් Difference එක විතරක් number එකක් ලෙස එවන්න. උදා: -50');
      return true;
    }
  } else {
    result.difference = Math.round(value * 100) / 100;
    await receiptRef.set({ difference: result.difference, status: 'processing_manual' }, { merge: true });
  }

  await sendShiftResult(receiptRef, { result, branch, payInOutItems, messageId: pending.messageId }, senderNumber);
  await pendingRef.delete();
  return true;
}

async function processShiftReceiptImage(message, senderNumber) {
  const receiptRef = db.collection('shift_receipt_messages').doc(message.id);
  const existing = await receiptRef.get();
  if (existing.exists && existing.data()?.replySent === true) {
    console.log('Shift receipt already processed:', message.id);
    return;
  }

  const branch = getShiftBranchForEmployee(senderNumber);
  if (!branch) {
    const reply = 'මේ WhatsApp number එකට Shift branch එක set කරලා නැහැ. Employee number එක branch එකකට map කරන්න.';
    await sendWhatsAppMessage(senderNumber, reply);
    await receiptRef.set({ id: message.id, senderNumber, status: 'needs_branch_mapping', branch: null, receivedAt: new Date() }, { merge: true });
    return;
  }

  await receiptRef.set({
    id: message.id,
    whatsappMessageId: message.id,
    senderNumber,
    mediaId: message.image?.id || null,
    branch,
    branchSource: 'employee_phone_mapping',
    status: 'processing',
    receivedAt: new Date()
  }, { merge: true });

  try {
    const imageBuffer = await downloadWhatsAppImage(message.image?.id);
    const result = await recognizeReceipt(imageBuffer);
    const reasons = await getPayInOutReasons();
    const payInOutItems = extractPayInOutItems(result.payInOutText || result.text, reasons);

    // If absolutely nothing useful can be recovered, forward the original photo to the owner's
    // personal WhatsApp. This is the last-resort path; employees are not asked to resend it.
    if (result.actualEndingCash === null && result.difference === null && payInOutItems.length === 0) {
      const adminNumber = process.env.SHIFT_ADMIN_WHATSAPP_NUMBER;
      let forwardResult = { success: false, skipped: true, reason: 'SHIFT_ADMIN_WHATSAPP_NUMBER is missing' };
      if (adminNumber) {
        forwardResult = await sendWhatsAppImage(adminNumber, imageBuffer, `Shift Summary - ${branch} - Employee ${senderNumber}`);
      }
      const reply = 'Photo එකෙන් data එකක්වත් හරියට read කරගන්න බැරි වුණා. Photo එක owner WhatsApp එකට යවලා තියෙනවා.';
      const sendResult = await sendWhatsAppMessage(senderNumber, reply);
      await receiptRef.set({
        status: 'sent_to_owner',
        payInOutItems,
        ownerForwarded: Boolean(forwardResult?.success),
        ownerForwardMessageId: forwardResult?.messageId || null,
        drawerValues: result.drawerValues || null,
        drawerOcrPreview: result.drawerOcrPreview || null,
        replyText: reply,
        replySent: Boolean(sendResult?.success),
        processedAt: new Date()
      }, { merge: true });
      return;
    }

    const saved = {
      actualEndingCash: result.actualEndingCash,
      balance: result.balance,
      difference: result.difference,
      amountSource: result.amountSource,
      drawerValues: result.drawerValues,
      payInOutItems
    };
    await receiptRef.set(saved, { merge: true });

    if (result.actualEndingCash === null) {
      await receiptRef.set({ status: 'waiting_manual_actual' }, { merge: true });
      await db.collection('shift_receipt_manual_requests').doc(normalizeNumber(senderNumber)).set({
        senderNumber,
        messageId: message.id,
        field: 'actualEndingCash',
        branch,
        createdAt: new Date()
      }, { merge: true });
      await sendWhatsAppMessage(senderNumber, 'Actual Ending Cash එක පැහැදිලි නැහැ. Actual Ending Cash amount එක විතරක් number එකක් ලෙස එවන්න. උදා: 4590');
      return;
    }

    if (result.difference === null) {
      await receiptRef.set({ status: 'waiting_manual_difference' }, { merge: true });
      await db.collection('shift_receipt_manual_requests').doc(normalizeNumber(senderNumber)).set({
        senderNumber,
        messageId: message.id,
        field: 'difference',
        branch,
        createdAt: new Date()
      }, { merge: true });
      await sendWhatsAppMessage(senderNumber, 'Actual Ending Cash හරි. Difference එක විතරක් number එකක් ලෙස එවන්න. උදා: -50');
      return;
    }

    await sendShiftResult(receiptRef, { result, branch, payInOutItems, messageId: message.id }, senderNumber);
  } catch (error) {
    console.error('Shift receipt processing error:', message.id, error);
    const adminNumber = process.env.SHIFT_ADMIN_WHATSAPP_NUMBER;
    try {
      let forwardResult = { success: false, skipped: true };
      if (adminNumber) {
        const imageBuffer = await downloadWhatsAppImage(message.image?.id);
        forwardResult = await sendWhatsAppImage(adminNumber, imageBuffer, `Shift OCR error - ${branch} - Employee ${senderNumber}`);
      }
      const failureReply = 'Photo process කරන්න බැරි වුණා. Photo එක owner WhatsApp එකට යවලා තියෙනවා.';
      const sendResult = await sendWhatsAppMessage(senderNumber, failureReply);
      await receiptRef.set({
        status: 'error',
        error: error.message,
        ownerForwarded: Boolean(forwardResult?.success),
        replyText: failureReply,
        replySent: Boolean(sendResult?.success),
        processedAt: new Date()
      }, { merge: true });
    } catch (replyError) {
      await receiptRef.set({ status: 'error', error: error.message, replyError: replyError.message, replySent: false, processedAt: new Date() }, { merge: true });
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
        for (const message of value.messages || []) {
          const senderNumber = message.from;
          if (await handlePendingShiftManual(message, senderNumber)) return;
        }
      }
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
