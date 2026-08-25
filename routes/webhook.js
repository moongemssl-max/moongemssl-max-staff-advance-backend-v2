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
  extractPayInOutItems,
  recognizeReceiptSection,
  inspectPayInOutSection
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

const SESSION_TTL_MS = 45 * 60 * 1000;

function sessionDocId(senderNumber) {
  return String(senderNumber || '').replace(/\D/g, '').slice(-15) || 'unknown';
}

function nextMissingSection(data) {
  if (!data?.branch) return 'branch';
  if (!Number.isFinite(Number(data?.actualEndingCash))) return 'cash_drawer';
  if (data?.payInOutVerified !== true) return 'pay_in_out';
  return null;
}

function sectionPrompt(section) {
  if (section === 'branch') {
    return 'Branch එක විතරක් තව පැහැදිලි නැහැ. Receipt එකේ උඩ තියෙන Branch / Shift Summary කොටස විතරක් ලඟින් photo එකක් එවන්න.';
  }
  if (section === 'cash_drawer') {
    return 'Cash Drawer එක විතරක් තව verify කරන්න ඕන. Starting Cash සිට Difference දක්වා Cash Drawer කොටස විතරක් ලඟින් photo එකක් එවන්න.';
  }
  if (section === 'pay_in_out') {
    return 'Pay In / Pay Out එක විතරක් තව verify කරන්න ඕන. Receipt එකේ Payin/Payout කොටස විතරක් ලඟින් photo එකක් එවන්න.';
  }
  return 'අවශ්‍ය කොටස විතරක් ලඟින් photo එකක් එවන්න.';
}

async function loadActiveShiftSession(senderNumber) {
  const ref = db.collection('shift_receipt_sessions').doc(sessionDocId(senderNumber));
  const snap = await ref.get();
  if (!snap.exists) return { ref, data: null };

  const data = snap.data() || {};
  const updatedAt = data.updatedAt?.toDate?.() || data.createdAt?.toDate?.() || null;
  if (data.status === 'completed' || (updatedAt && Date.now() - updatedAt.getTime() > SESSION_TTL_MS)) {
    await ref.delete().catch(() => undefined);
    return { ref, data: null };
  }
  return { ref, data };
}

async function saveCompletedShift(data, currentMessageId, senderNumber) {
  const rootMessageId = data.rootMessageId || currentMessageId;
  const branch = data.branch;
  const actualEndingCash = Number(data.actualEndingCash);
  // Existing StaffAdvance rule: calculateBalance() is the amount the employee removes
  // (normally Rs. 4,000–4,999.99); the rest is handed over.
  const removeAmount = calculateBalance(actualEndingCash);
  if (!(removeAmount >= 4000 && removeAmount < 5000)) {
    throw new Error(`Shift cash safety check failed: ${removeAmount}`);
  }
  const bringAmount = calculateBringAmount(actualEndingCash, removeAmount);

  const resultForReply = {
    branch,
    actualEndingCash,
    balance: removeAmount
  };
  const replyText = buildReply(resultForReply);
  const sendResult = await sendWhatsAppMessage(senderNumber, replyText);
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

  const record = {
    id: rootMessageId,
    whatsappMessageId: rootMessageId,
    senderNumber,
    branch,
    branchRaw: data.branchRaw || null,
    actualEndingCash,
    removeAmount,
    balance: removeAmount,
    bringAmount,
    difference: data.difference ?? data.drawerValues?.difference ?? null,
    drawerValues: data.drawerValues || null,
    payInOutItems: Array.isArray(data.payInOutItems) ? data.payInOutItems : [],
    ocrMode: 'phase19_section_retry',
    dateKey: sriLankaDate,
    replyText,
    replySent: Boolean(sendResult?.success),
    replyMessageId: sendResult?.messageId || null,
    createdAt: processedAt
  };

  await db.collection('shift_cash_history').doc(rootMessageId).set(record, { merge: true });
  await db.collection('shift_receipt_messages').doc(rootMessageId).set(
    { ...record, status: 'completed', processedAt },
    { merge: true }
  );

  return { replyText, bringAmount, removeAmount };
}

async function processShiftReceiptImage(message, senderNumber) {
  const currentReceiptRef = db.collection('shift_receipt_messages').doc(message.id);
  const { ref: sessionRef, data: existingSession } = await loadActiveShiftSession(senderNumber);

  // Meta may deliver the same image webhook again. Never interpret a duplicate full image
  // as the requested close-up section.
  if (
    existingSession &&
    (
      existingSession.rootMessageId === message.id ||
      (existingSession.retryMessageIds || []).includes(message.id)
    )
  ) {
    console.log('Duplicate shift image webhook ignored:', message.id);
    return;
  }

  try {
    const imageBuffer = await downloadWhatsAppImage(message.image?.id);
    const reasons = await getPayInOutReasons();

    // If a session is waiting for a specific section, treat this image ONLY as that section.
    if (existingSession?.awaitingSection) {
      const section = existingSession.awaitingSection;
      const partial = await recognizeReceiptSection(imageBuffer, section);
      const merged = {
        ...existingSession,
        updatedAt: new Date(),
        retryMessageIds: [...(existingSession.retryMessageIds || []), message.id]
      };

      if (section === 'branch' && partial.success && partial.branch) {
        merged.branch = partial.branch;
        merged.branchRaw = partial.branchRaw || null;
      } else if (section === 'cash_drawer' && partial.success && Number.isFinite(Number(partial.actualEndingCash))) {
        merged.actualEndingCash = Number(partial.actualEndingCash);
        merged.drawerValues = partial.drawerValues || merged.drawerValues || null;
        merged.difference = partial.difference ?? merged.difference ?? null;
      } else if (section === 'pay_in_out' && partial.success) {
        const items = extractPayInOutItems(partial.text, reasons);
        const inspection = inspectPayInOutSection(partial.text, items);
        if (inspection.verified) {
          merged.payInOutItems = items;
          merged.payInOutVerified = true;
          merged.payInOutTotals = {
            totalPayIn: inspection.totalPayIn,
            totalPayOut: inspection.totalPayOut
          };
        }
      }

      const stillMissing = nextMissingSection(merged);
      if (stillMissing === section) {
        const retryReply = `මේ කොටස තවම හරියට read වුණේ නැහැ. ${sectionPrompt(section)}`;
        await sendWhatsAppMessage(senderNumber, retryReply);
        await sessionRef.set(
          { ...merged, awaitingSection: section, status: 'waiting_section', lastPrompt: retryReply },
          { merge: true }
        );
        await currentReceiptRef.set(
          { status: 'section_retry_failed', section, senderNumber, processedAt: new Date() },
          { merge: true }
        );
        return;
      }

      if (stillMissing) {
        const prompt = sectionPrompt(stillMissing);
        await sendWhatsAppMessage(senderNumber, prompt);
        await sessionRef.set(
          { ...merged, awaitingSection: stillMissing, status: 'waiting_section', lastPrompt: prompt },
          { merge: true }
        );
        await currentReceiptRef.set(
          { status: 'section_retry_ok', section, nextSection: stillMissing, senderNumber, processedAt: new Date() },
          { merge: true }
        );
        return;
      }

      const completed = await saveCompletedShift(merged, message.id, senderNumber);
      await sessionRef.set(
        { ...merged, awaitingSection: null, status: 'completed', completedAt: new Date(), finalReply: completed.replyText },
        { merge: true }
      );
      await currentReceiptRef.set(
        { status: 'section_retry_completed', section, senderNumber, processedAt: new Date() },
        { merge: true }
      );
      console.log('Shift receipt completed after section retries:', merged.rootMessageId, merged.retryMessageIds);
      return;
    }

    // New full receipt.
    await currentReceiptRef.set(
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

    const result = await recognizeReceipt(imageBuffer);
    const payInOutItems = extractPayInOutItems(result.payInOutText || result.text || '', reasons);
    const payInspection = inspectPayInOutSection(result.payInOutText || result.text || '', payInOutItems);

    const session = {
      rootMessageId: message.id,
      senderNumber,
      status: 'processing',
      createdAt: new Date(),
      updatedAt: new Date(),
      branch: result.branch || null,
      branchRaw: result.branchRaw || null,
      actualEndingCash: Number.isFinite(Number(result.actualEndingCash)) ? Number(result.actualEndingCash) : null,
      drawerValues: result.drawerValues || null,
      difference: result.difference ?? result.drawerValues?.difference ?? null,
      payInOutItems,
      payInOutVerified: payInspection.verified,
      payInOutTotals: {
        totalPayIn: payInspection.totalPayIn,
        totalPayOut: payInspection.totalPayOut
      },
      retryMessageIds: []
    };

    const missing = nextMissingSection(session);

    if (missing) {
      const prompt = sectionPrompt(missing);
      await sendWhatsAppMessage(senderNumber, prompt);
      await sessionRef.set(
        { ...session, awaitingSection: missing, status: 'waiting_section', lastPrompt: prompt },
        { merge: true }
      );
      await currentReceiptRef.set(
        {
          status: 'waiting_section',
          awaitingSection: missing,
          detectedBranch: session.branch,
          drawerValues: session.drawerValues,
          payInOutItems: session.payInOutItems,
          payInOutVerified: session.payInOutVerified,
          replyText: prompt,
          processedAt: new Date()
        },
        { merge: true }
      );
      console.log('Shift receipt waiting for section:', message.id, missing);
      return;
    }

    const completed = await saveCompletedShift(session, message.id, senderNumber);
    await sessionRef.set(
      { ...session, awaitingSection: null, status: 'completed', completedAt: new Date(), finalReply: completed.replyText },
      { merge: true }
    );
    console.log('Shift receipt completed from full image:', message.id);
  } catch (error) {
    console.error('Shift receipt processing error:', message.id, error);
    try {
      const failureReply = 'Photo processing එකේ error එකක් ආවා. Receipt එක නැවත photo කරලා එවන්න.';
      await sendWhatsAppMessage(senderNumber, failureReply);
      await currentReceiptRef.set(
        { status: 'error', error: error.message, replyText: failureReply, processedAt: new Date() },
        { merge: true }
      );
    } catch (replyError) {
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
