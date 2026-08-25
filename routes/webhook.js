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
  inspectPayInOutSection,
  recognizeReceiptField,
  extractPayTotalsAndCount,
  mergeUniquePayItems,
  payItemsComplete
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

function requiredField(data) {
  if (!data?.branch) return 'branch';
  if (!Number.isFinite(Number(data?.actualEndingCash))) return 'actual_ending_cash';
  if (!Number.isFinite(Number(data?.difference))) return 'difference';

  const totals = data?.payTotals || null;
  const items = Array.isArray(data?.payInOutItems) ? data.payInOutItems : [];
  if (!totals || (totals.count == null && totals.totalPayIn == null && totals.totalPayOut == null)) return 'pay_totals';
  if (!payItemsComplete(items, totals)) return 'pay_line';
  return null;
}

function payItemScore(items, totals) {
  const list = Array.isArray(items) ? items : [];
  const inSum = Math.round(
    list.filter(x => String(x.type || '').toUpperCase() === 'IN')
      .reduce((sum, x) => sum + Number(x.amount || 0), 0) * 100
  ) / 100;
  const outSum = Math.round(
    list.filter(x => String(x.type || '').toUpperCase() === 'OUT')
      .reduce((sum, x) => sum + Number(x.amount || 0), 0) * 100
  ) / 100;

  let score = 0;
  if (totals?.count != null && list.length === Number(totals.count)) score += 4;
  if (totals?.totalPayIn != null && Math.abs(inSum - Number(totals.totalPayIn)) <= 0.02) score += 3;
  if (totals?.totalPayOut != null && Math.abs(outSum - Number(totals.totalPayOut)) <= 0.02) score += 3;
  if (totals?.netInflow != null && Math.abs((inSum - outSum) - Number(totals.netInflow)) <= 0.02) score += 2;
  return score;
}

function chooseBestPayItems(existingItems, newItems, totals) {
  const existing = Array.isArray(existingItems) ? existingItems : [];
  const incoming = Array.isArray(newItems) ? newItems : [];
  const merged = mergeUniquePayItems(existing, incoming);

  const candidates = [existing, incoming, merged]
    .filter(list => list.length > 0)
    .map(list => ({ list, score: payItemScore(list, totals) }))
    .sort((a, b) => b.score - a.score || a.list.length - b.list.length);

  // Important: if the new close-up itself matches printed Count/Totals,
  // discard stale rows saved by an older OCR attempt.
  if (incoming.length && payItemsComplete(incoming, totals)) return incoming;

  return candidates[0]?.list || [];
}

function fieldPrompt(field, data = {}) {
  switch (field) {
    case 'branch':
      return 'Branch එක විතරක් read වුණේ නැහැ. Receipt එකේ Branch / Shift Summary header තියෙන පොඩි කොටස විතරක් ලඟින් photo එකක් එවන්න.';
    case 'actual_ending_cash':
      return 'Actual Ending Cash value එක විතරක් read වුණේ නැහැ. “Actual Ending Cash” line එක පේන පොඩි කොටස විතරක් ලඟින් photo එකක් එවන්න.';
    case 'difference':
      return 'Difference value එක විතරක් read වුණේ නැහැ. “Difference” line එක පේන පොඩි කොටස විතරක් ලඟින් photo එකක් එවන්න.';
    case 'pay_totals':
      return 'Pay In/Out check කරන්න totals ටික විතරක් ඕන. “Payin/Payout Count, Total Payin, Total Payout” lines තුන පේන පොඩි කොටස විතරක් photo එකක් එවන්න.';
    case 'pay_line': {
      const totals = data?.payTotals || {};
      const items = Array.isArray(data?.payInOutItems) ? data.payInOutItems : [];
      const got = items.length;
      const expected = totals.count != null ? Number(totals.count) : null;
      const need = expected != null
        ? (got <= expected ? ` (${got}/${expected} lines read)` : ` (${expected} expected; OCR mismatch)`)
        : '';
      return `Pay In/Out එකේ තව line එකක් පැහැදිලි නැහැ${need}. Reason + Amount + (IN/OUT) පේන ඒ line එක විතරක් ලඟින් photo එකක් එවන්න. උදා: (OUT) Rusiru Advance 21000.00`;
    }
    default:
      return 'Read නොවුණු පොඩි කොටස විතරක් ලඟින් photo එකක් එවන්න.';
  }
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
  const removeAmount = calculateBalance(actualEndingCash);
  if (!(removeAmount >= 4000 && removeAmount < 5000)) {
    throw new Error(`Shift cash safety check failed: ${removeAmount}`);
  }
  const bringAmount = calculateBringAmount(actualEndingCash, removeAmount);
  const resultForReply = { branch, actualEndingCash, balance: removeAmount };
  const replyText = buildReply(resultForReply);
  const sendResult = await sendWhatsAppMessage(senderNumber, replyText);
  const processedAt = new Date();

  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit'
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
    difference: Number(data.difference),
    drawerValues: data.drawerValues || null,
    payInOutItems: Array.isArray(data.payInOutItems) ? data.payInOutItems : [],
    payInOutTotals: data.payTotals || null,
    ocrMode: 'phase20_field_recovery',
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
  return record;
}

async function processShiftReceiptImage(message, senderNumber) {
  const currentReceiptRef = db.collection('shift_receipt_messages').doc(message.id);
  const { ref: sessionRef, data: existingSession } = await loadActiveShiftSession(senderNumber);

  if (
    existingSession &&
    (existingSession.rootMessageId === message.id || (existingSession.retryMessageIds || []).includes(message.id))
  ) {
    console.log('Duplicate shift image webhook ignored:', message.id);
    return;
  }

  const reasons = await getPayInOutReasons();

  try {
    const imageBuffer = await downloadWhatsAppImage(message.image?.id);

    // FIELD RETRY: the employee sends only the tiny requested part.
    if (existingSession?.awaitingField) {
      const field = existingSession.awaitingField;
      let partial;
      try {
        partial = await recognizeReceiptField(imageBuffer, field, reasons);
      } catch (fieldError) {
        console.error('Field OCR error:', field, fieldError);
        const reply = `මේ ${field.replace(/_/g, ' ')} කොටස process වෙන්න බැරි වුණා. ${fieldPrompt(field, existingSession)}`;
        await sendWhatsAppMessage(senderNumber, reply);
        await sessionRef.set({ ...existingSession, updatedAt: new Date(), lastPrompt: reply }, { merge: true });
        return;
      }

      const merged = {
        ...existingSession,
        updatedAt: new Date(),
        retryMessageIds: [...(existingSession.retryMessageIds || []), message.id]
      };

      if (field === 'branch' && partial.success) {
        merged.branch = partial.branch;
        merged.branchRaw = partial.branchRaw || null;
      } else if (field === 'actual_ending_cash' && partial.success) {
        merged.actualEndingCash = Number(partial.actualEndingCash);
        merged.drawerValues = { ...(merged.drawerValues || {}), ...(partial.drawerValues || {}) };
      } else if (field === 'difference' && partial.success) {
        merged.difference = Number(partial.difference);
      } else if (field === 'pay_totals' && partial.success) {
        merged.payTotals = { ...(merged.payTotals || {}), ...(partial.totals || {}) };
      } else if (field === 'pay_line' && partial.success) {
        merged.payInOutItems = chooseBestPayItems(
          merged.payInOutItems || [],
          partial.items || [],
          merged.payTotals || null
        );
      }

      if (
        merged.payTotals?.count != null &&
        Array.isArray(merged.payInOutItems) &&
        merged.payInOutItems.length > Number(merged.payTotals.count)
      ) {
        // Do not keep stale OCR rows from older attempts. Prefer only a set that validates
        // against the printed count/totals; otherwise wait for the requested close-up.
        const expectedCount = Number(merged.payTotals.count);
        const possible = merged.payInOutItems.slice(-expectedCount);
        if (payItemsComplete(possible, merged.payTotals)) {
          merged.payInOutItems = possible;
        }
      }

      const next = requiredField(merged);
      if (next === field) {
        const reply = `ඒ value එක තවම හරියට read වුණේ නැහැ. ${fieldPrompt(field, merged)}`;
        await sendWhatsAppMessage(senderNumber, reply);
        await sessionRef.set({ ...merged, awaitingField: field, status: 'waiting_field', lastPrompt: reply }, { merge: true });
        await currentReceiptRef.set({ status: 'field_retry_failed', field, processedAt: new Date() }, { merge: true });
        return;
      }

      if (next) {
        const reply = fieldPrompt(next, merged);
        await sendWhatsAppMessage(senderNumber, reply);
        await sessionRef.set({ ...merged, awaitingField: next, status: 'waiting_field', lastPrompt: reply }, { merge: true });
        await currentReceiptRef.set({ status: 'field_retry_ok', field, nextField: next, processedAt: new Date() }, { merge: true });
        return;
      }

      const record = await saveCompletedShift(merged, message.id, senderNumber);
      await sessionRef.set({ ...merged, awaitingField: null, status: 'completed', completedAt: new Date() }, { merge: true });
      await currentReceiptRef.set({ status: 'field_retry_completed', processedAt: new Date() }, { merge: true });
      console.log('Shift completed field-by-field:', record.id);
      return;
    }

    // NEW FULL PHOTO: read as much as possible. A failure in one field must not discard other good fields.
    await currentReceiptRef.set({
      id: message.id,
      whatsappMessageId: message.id,
      senderNumber,
      mediaId: message.image?.id || null,
      status: 'processing',
      receivedAt: new Date()
    }, { merge: true });

    let result = {};
    try {
      result = await recognizeReceipt(imageBuffer);
    } catch (fullError) {
      console.error('Full receipt OCR partial failure:', fullError);
      result = {};
    }

    // Independently salvage important fields from the SAME full image.
    const safeField = async (field) => {
      try { return await recognizeReceiptField(imageBuffer, field, reasons); }
      catch (e) { console.warn('Best-effort field failed:', field, e.message); return { success: false, field }; }
    };

    const [branchField, actualField, differenceField, totalsField] = await Promise.all([
      result.branch ? Promise.resolve({ success: true, branch: result.branch, branchRaw: result.branchRaw }) : safeField('branch'),
      Number.isFinite(Number(result.actualEndingCash)) ? Promise.resolve({ success: true, actualEndingCash: result.actualEndingCash, drawerValues: result.drawerValues }) : safeField('actual_ending_cash'),
      Number.isFinite(Number(result.difference ?? result.drawerValues?.difference)) ? Promise.resolve({ success: true, difference: result.difference ?? result.drawerValues?.difference }) : safeField('difference'),
      safeField('pay_totals')
    ]);

    const payText = result.payInOutText || result.text || '';
    const initialItems = extractPayInOutItems(payText, reasons);
    const initialTotals = totalsField.success ? totalsField.totals : extractPayTotalsAndCount(payText);

    const session = {
      rootMessageId: message.id,
      senderNumber,
      status: 'processing',
      createdAt: new Date(),
      updatedAt: new Date(),
      branch: branchField.success ? branchField.branch : null,
      branchRaw: branchField.branchRaw || null,
      actualEndingCash: actualField.success ? Number(actualField.actualEndingCash) : null,
      difference: differenceField.success ? Number(differenceField.difference) : null,
      drawerValues: { ...(result.drawerValues || {}), ...(actualField.drawerValues || {}) },
      payInOutItems: initialItems,
      payTotals: initialTotals,
      retryMessageIds: []
    };

    const missing = requiredField(session);
    if (missing) {
      const reply = fieldPrompt(missing, session);
      await sendWhatsAppMessage(senderNumber, reply);
      await sessionRef.set({ ...session, awaitingField: missing, status: 'waiting_field', lastPrompt: reply }, { merge: true });
      await currentReceiptRef.set({
        status: 'waiting_field',
        awaitingField: missing,
        savedPartial: {
          branch: session.branch,
          actualEndingCash: session.actualEndingCash,
          difference: session.difference,
          payInOutItems: session.payInOutItems,
          payTotals: session.payTotals
        },
        replyText: reply,
        processedAt: new Date()
      }, { merge: true });
      console.log('Saved readable fields; waiting only for:', missing);
      return;
    }

    const record = await saveCompletedShift(session, message.id, senderNumber);
    await sessionRef.set({ ...session, awaitingField: null, status: 'completed', completedAt: new Date() }, { merge: true });
    console.log('Shift completed from one full image:', record.id);
  } catch (error) {
    console.error('Shift receipt outer processing error:', message.id, error);

    // If a session exists, never ask for the whole receipt again; preserve everything already read.
    if (existingSession) {
      const field = existingSession.awaitingField || requiredField(existingSession) || 'actual_ending_cash';
      const reply = `දැනට read කරපු data save කරලා තියෙනවා. ${fieldPrompt(field, existingSession)}`;
      await sendWhatsAppMessage(senderNumber, reply).catch(() => undefined);
      await sessionRef.set({ ...existingSession, awaitingField: field, status: 'waiting_field', updatedAt: new Date(), lastPrompt: reply }, { merge: true });
      return;
    }

    // New-photo catastrophic error: ask only for the first critical small field, not the whole receipt.
    const seed = {
      rootMessageId: message.id, senderNumber, status: 'waiting_field',
      createdAt: new Date(), updatedAt: new Date(), retryMessageIds: [],
      branch: null, actualEndingCash: null, difference: null, payInOutItems: [], payTotals: null
    };
    const field = 'branch';
    const reply = fieldPrompt(field, seed);
    await sendWhatsAppMessage(senderNumber, reply).catch(() => undefined);
    await sessionRef.set({ ...seed, awaitingField: field, lastPrompt: reply }, { merge: true });
    await currentReceiptRef.set({ status: 'waiting_field', awaitingField: field, error: error.message, processedAt: new Date() }, { merge: true });
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
