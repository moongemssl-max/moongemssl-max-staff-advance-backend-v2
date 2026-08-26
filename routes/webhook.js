'use strict';

const express = require('express');
const { db } = require('../firebase');
const parseAdvanceMessage = require('../services/messageParser');
const { sendAdvanceRequestNotification } = require('../services/notifications');
const sendWhatsAppMessage = require('../services/whatsapp');
const {
  downloadWhatsAppImage,
  recognizeFullReceipt,
  recognizeField,
  calculateBalance,
  calculateBringAmount,
  buildReply,
  paySectionComplete
} = require('../services/shiftReceipt');

const router = express.Router();

const FLOW_VERSION = 'clean_rebuild_v1';
const SESSION_TTL_MS = 45 * 60 * 1000;

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
    const values = doc.exists && Array.isArray(doc.data()?.reasons)
      ? doc.data().reasons
      : [];

    const cleaned = values
      .map((value) => String(value || '').trim())
      .filter(Boolean);

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

function sessionId(senderNumber) {
  return String(senderNumber || '').replace(/\D/g, '').slice(-15) || 'unknown';
}

async function loadSession(senderNumber) {
  const ref = db.collection('shift_receipt_sessions').doc(sessionId(senderNumber));
  const snap = await ref.get();

  if (!snap.exists) return { ref, data: null };

  const data = snap.data() || {};
  const updatedAt = data.updatedAt?.toDate?.() || data.createdAt?.toDate?.() || null;

  const expired = updatedAt && Date.now() - updatedAt.getTime() > SESSION_TTL_MS;
  const oldFlow = data.flowVersion !== FLOW_VERSION;
  const completed = data.status === 'completed';

  if (expired || oldFlow || completed) {
    await ref.delete().catch(() => undefined);
    return { ref, data: null };
  }

  return { ref, data };
}

function sriLankaDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Colombo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function criticalMissing(data) {
  if (!data?.branch) return 'branch';
  if (!Number.isFinite(Number(data?.actualEndingCash))) return 'cash';
  return null;
}

function reportMissing(data) {
  const items = Array.isArray(data?.payInOutItems) ? data.payInOutItems : [];
  const totals = data?.payTotals || null;

  if (!totals) return 'pay';

  if (paySectionComplete(items, totals)) return null;

  return 'pay';
}

function promptFor(field, cashAlreadySent = false) {
  if (field === 'branch') {
    return 'Branch එක විතරක් read වුණේ නැහැ. Receipt එකේ “Branch:” සහ “Shift Summary” පේන උඩ කොටස විතරක් ලඟින් photo එකක් එවන්න.';
  }

  if (field === 'cash') {
    return 'Actual Ending Cash එක විතරක් read වුණේ නැහැ. Receipt එකේ “Cash Drawer” ඇතුළේ “Actual Ending Cash” line එක පේන කොටස විතරක් ලඟින් photo එකක් එවන්න.';
  }

  if (field === 'pay') {
    return cashAlreadySent
      ? 'Cash instruction එක දීලා ඉවරයි. Report එකට Pay In/Out section එක තව ඕන. (IN)/(OUT) lines සහ Payin/Payout Count පේන කොටස විතරක් ලඟින් photo එකක් එවන්න.'
      : 'Pay In/Out section එක විතරක් තව read කරන්න ඕන. (IN)/(OUT) lines සහ Payin/Payout Count පේන කොටස විතරක් ලඟින් photo එකක් එවන්න.';
  }

  return 'Read නොවුණු කොටස විතරක් ලඟින් photo එකක් එවන්න.';
}

async function sendCashInstructionOnce(session, senderNumber) {
  if (session.cashInstructionSent === true) return session;

  if (criticalMissing(session)) return session;

  const actual = Number(session.actualEndingCash);
  const balance = calculateBalance(actual);

  if (balance === null) {
    // Safety: never send a negative/impossible cash instruction.
    session.actualEndingCash = null;
    return session;
  }

  const bringAmount = calculateBringAmount(actual, balance);
  const replyText = buildReply({
    branch: session.branch,
    actualEndingCash: actual,
    balance
  });

  const sendResult = await sendWhatsAppMessage(senderNumber, replyText);

  session.balance = balance;
  session.removeAmount = balance;
  session.bringAmount = bringAmount;
  session.cashReplyText = replyText;
  session.cashInstructionSent = Boolean(sendResult?.success);
  session.cashReplyMessageId = sendResult?.messageId || null;
  session.cashInstructionSentAt = new Date();

  return session;
}

async function saveHistory(session) {
  const id = session.rootMessageId;
  const now = new Date();

  await db.collection('shift_cash_history').doc(id).set({
    id,
    whatsappMessageId: id,
    senderNumber: session.senderNumber,
    branch: session.branch || null,
    branchRaw: session.branchRaw || null,
    actualEndingCash: Number.isFinite(Number(session.actualEndingCash))
      ? Number(session.actualEndingCash)
      : null,
    removeAmount: Number.isFinite(Number(session.removeAmount))
      ? Number(session.removeAmount)
      : null,
    balance: Number.isFinite(Number(session.balance))
      ? Number(session.balance)
      : null,
    bringAmount: Number.isFinite(Number(session.bringAmount))
      ? Number(session.bringAmount)
      : null,
    difference: Number.isFinite(Number(session.difference))
      ? Number(session.difference)
      : null,
    drawerValues: session.drawerValues || null,
    payInOutItems: Array.isArray(session.payInOutItems) ? session.payInOutItems : [],
    payInOutTotals: session.payTotals || null,
    payComplete: Boolean(session.payComplete),
    cashInstructionSent: Boolean(session.cashInstructionSent),
    cashReplyText: session.cashReplyText || null,
    ocrMode: FLOW_VERSION,
    dateKey: sriLankaDateKey(now),
    updatedAt: now,
    createdAt: session.createdAt || now
  }, { merge: true });
}

async function continueSessionAfterRead(session, sessionRef, receiptRef, senderNumber) {
  // Cash reply depends ONLY on Branch + Actual Ending Cash.
  await sendCashInstructionOnce(session, senderNumber);

  const critical = criticalMissing(session);
  if (critical) {
    const reply = promptFor(critical, false);
    const sendResult = await sendWhatsAppMessage(senderNumber, reply);

    session.awaitingField = critical;
    session.status = 'waiting_critical';
    session.lastPrompt = reply;
    session.updatedAt = new Date();

    await sessionRef.set(session, { merge: true });
    await receiptRef.set({
      status: 'waiting_critical',
      awaitingField: critical,
      replyText: reply,
      replySent: Boolean(sendResult?.success),
      processedAt: new Date()
    }, { merge: true });
    return;
  }

  await saveHistory(session);

  // Pay In/Out is report data only; it never blocks the employee cash instruction.
  const reportField = reportMissing(session);
  if (reportField) {
    const reply = promptFor(reportField, true);
    const sendResult = await sendWhatsAppMessage(senderNumber, reply);

    session.awaitingField = reportField;
    session.status = 'cash_sent_waiting_report';
    session.lastPrompt = reply;
    session.updatedAt = new Date();

    await sessionRef.set(session, { merge: true });
    await receiptRef.set({
      status: 'cash_sent_waiting_report',
      awaitingField: reportField,
      cashInstructionSent: session.cashInstructionSent,
      replyText: reply,
      replySent: Boolean(sendResult?.success),
      processedAt: new Date()
    }, { merge: true });
    return;
  }

  session.awaitingField = null;
  session.status = 'completed';
  session.updatedAt = new Date();
  session.completedAt = new Date();

  await saveHistory(session);
  await sessionRef.set(session, { merge: true });
  await receiptRef.set({
    status: 'completed',
    cashInstructionSent: session.cashInstructionSent,
    processedAt: new Date()
  }, { merge: true });

  console.log('Shift complete:', session.rootMessageId);
}

async function processShiftReceiptImage(message, senderNumber) {
  const receiptRef = db.collection('shift_receipt_messages').doc(message.id);
  const { ref: sessionRef, data: existingSession } = await loadSession(senderNumber);

  // Meta may retry the same image webhook.
  if (
    existingSession &&
    (
      existingSession.rootMessageId === message.id ||
      (existingSession.retryMessageIds || []).includes(message.id)
    )
  ) {
    console.log('Duplicate shift image ignored:', message.id);
    return;
  }

  await receiptRef.set({
    id: message.id,
    whatsappMessageId: message.id,
    senderNumber,
    mediaId: message.image?.id || null,
    status: 'processing',
    receivedAt: new Date()
  }, { merge: true });

  const reasons = await getPayInOutReasons();

  try {
    const imageBuffer = await downloadWhatsAppImage(message.image?.id);

    // --------------------------------------------------
    // Small retry photo for one requested field only.
    // --------------------------------------------------
    if (existingSession?.awaitingField) {
      const field = existingSession.awaitingField;
      const partial = await recognizeField(imageBuffer, field, reasons);

      const session = {
        ...existingSession,
        flowVersion: FLOW_VERSION,
        updatedAt: new Date(),
        retryMessageIds: [...(existingSession.retryMessageIds || []), message.id]
      };

      if (field === 'branch' && partial.success) {
        session.branch = partial.branch;
        session.branchRaw = partial.branchRaw || null;
      }

      if (field === 'cash' && partial.success) {
        session.actualEndingCash = partial.actualEndingCash;
        session.drawerValues = {
          ...(session.drawerValues || {}),
          ...(partial.drawerValues || {})
        };
        if (Number.isFinite(Number(partial.difference))) {
          session.difference = Number(partial.difference);
        }
      }

      if (field === 'pay') {
        session.payInOutItems = Array.isArray(partial.items) ? partial.items : [];
        session.payTotals = partial.totals || null;
        session.payComplete = Boolean(partial.success);
      }

      await continueSessionAfterRead(
        session,
        sessionRef,
        receiptRef,
        senderNumber
      );
      return;
    }

    // --------------------------------------------------
    // New full receipt.
    // --------------------------------------------------
    const result = await recognizeFullReceipt(imageBuffer, reasons);

    const session = {
      flowVersion: FLOW_VERSION,
      rootMessageId: message.id,
      senderNumber,
      branch: result.branch || null,
      branchRaw: result.branchRaw || null,
      actualEndingCash: result.actualEndingCash,
      drawerValues: result.drawerValues || null,
      difference: Number.isFinite(Number(result.difference))
        ? Number(result.difference)
        : null,
      payInOutItems: result.payInOutItems || [],
      payTotals: result.payTotals || null,
      payComplete: Boolean(result.payComplete),
      cashInstructionSent: false,
      retryMessageIds: [],
      status: 'processing',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await sessionRef.set(session, { merge: true });

    await receiptRef.set({
      detectedBranch: session.branch,
      actualEndingCash: session.actualEndingCash,
      payInOutItems: session.payInOutItems,
      payTotals: session.payTotals,
      ocrMode: FLOW_VERSION
    }, { merge: true });

    await continueSessionAfterRead(
      session,
      sessionRef,
      receiptRef,
      senderNumber
    );
  } catch (error) {
    console.error('Shift receipt processing error:', message.id, error);

    // Never guess money after an OCR/media error.
    const current = existingSession
      ? { ...existingSession }
      : {
          flowVersion: FLOW_VERSION,
          rootMessageId: message.id,
          senderNumber,
          branch: null,
          actualEndingCash: null,
          payInOutItems: [],
          payTotals: null,
          cashInstructionSent: false,
          retryMessageIds: [],
          createdAt: new Date()
        };

    const field = criticalMissing(current) || 'branch';
    const reply = promptFor(field, Boolean(current.cashInstructionSent));

    await sendWhatsAppMessage(senderNumber, reply).catch(() => undefined);

    current.awaitingField = field;
    current.status = 'waiting_after_error';
    current.error = error.message;
    current.updatedAt = new Date();

    await sessionRef.set(current, { merge: true });
    await receiptRef.set({
      status: 'error_recovery',
      awaitingField: field,
      error: error.message,
      processedAt: new Date()
    }, { merge: true });
  }
}

router.post('/', async (req, res) => {
  // Meta expects a fast 200.
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body?.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const contacts = value.contacts || [];

        for (const message of value.messages || []) {
          const senderNumber = message.from;

          if (message.type === 'image') {
            await processShiftReceiptImage(message, senderNumber);
            continue;
          }

          if (message.type !== 'text') continue;

          // Existing Staff Advance text workflow kept unchanged.
          const messageText = message.text?.body || '';
          const parsed = parseAdvanceMessage(messageText);

          const employeeName =
            contacts.find((contact) => contact.wa_id === senderNumber)?.profile?.name ||
            'Unknown';

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

          if (parsed.isAdvanceRequest && !existingRequest.exists) {
            try {
              const notificationResult = await sendAdvanceRequestNotification(requestData);
              console.log('FCM notification result:', notificationResult);
            } catch (notificationError) {
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
