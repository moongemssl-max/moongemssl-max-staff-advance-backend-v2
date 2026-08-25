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
  calculateBalance,
  calculateBringAmount,
  extractPayInOutItems,
  recognizeReceiptSection,
  inspectPayInOutSection,
  recognizeReceiptField,
  extractPayTotalsAndCount,
  mergeUniquePayItems,
  payItemsComplete,
  reconcilePayItemsWithTotals
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
const FLOW_VERSION = 'cash_first_field_recovery_v1';

function sessionDocId(senderNumber) {
  return String(senderNumber || '').replace(/\D/g, '').slice(-15) || 'unknown';
}

function criticalMissingField(data) {
  if (!data?.branch) return 'branch';
  if (!Number.isFinite(Number(data?.actualEndingCash))) return 'actual_ending_cash';
  return null;
}

function reportMissingField(data) {
  if (!Number.isFinite(Number(data?.difference))) return 'difference';

  const totals = data?.payTotals || null;
  const items = Array.isArray(data?.payInOutItems) ? data.payInOutItems : [];

  if (
    !totals ||
    (totals.count == null && totals.totalPayIn == null && totals.totalPayOut == null)
  ) {
    return 'pay_totals';
  }

  // Printed Count is authoritative because extractPayInOutItems() only returns
  // rows that begin with IN/OUT.
  if (
    totals.count != null &&
    Number.isFinite(Number(totals.count)) &&
    items.length === Number(totals.count)
  ) {
    return null;
  }

  const reconciled = reconcilePayItemsWithTotals(items, totals);
  if (!reconciled.complete) return 'pay_line';
  return null;
}

function nextMissingField(data) {
  return criticalMissingField(data) || reportMissingField(data);
}

function fieldPrompt(field, data = {}) {
  switch (field) {
    case 'branch':
      return 'Branch එක විතරක් read වුණේ නැහැ. Receipt එකේ Branch / Shift Summary header තියෙන පොඩි කොටස විතරක් ලඟින් photo එකක් එවන්න.';
    case 'actual_ending_cash':
      return 'Actual Ending Cash value එක විතරක් read වුණේ නැහැ. “Actual Ending Cash” line එක පේන පොඩි කොටස විතරක් ලඟින් photo එකක් එවන්න.';
    case 'difference':
      return 'Cash instruction එක දීලා ඉවරයි. Report එකට Difference value එක විතරක් තව ඕන. “Difference” line එක පේන පොඩි කොටස විතරක් photo එකක් එවන්න.';
    case 'pay_totals':
      return 'Cash instruction එක දීලා ඉවරයි. Report එකට Pay In/Out totals ටික තව ඕන. “Payin/Payout Count, Total Payin, Total Payout” lines පේන පොඩි කොටස විතරක් photo එකක් එවන්න.';
    case 'pay_line': {
      const totals = data?.payTotals || {};
      const items = Array.isArray(data?.payInOutItems) ? data.payInOutItems : [];
      const expected = totals.count != null ? Number(totals.count) : null;
      const got = items.length;
      const suffix = expected != null ? ` (${got}/${expected} lines read)` : '';
      return `Cash instruction එක දීලා ඉවරයි. Report එකට Pay In/Out transaction line එකක් තව ඕන${suffix}. Reason + Amount + (IN/OUT) පේන ඒ line එක විතරක් ලඟින් photo එකක් එවන්න.`;
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

  // Drop old/stuck sessions automatically after this deploy.
  if (
    data.flowVersion !== FLOW_VERSION ||
    data.status === 'completed' ||
    (updatedAt && Date.now() - updatedAt.getTime() > SESSION_TTL_MS)
  ) {
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

async function ensureCashInstruction(data, currentMessageId, senderNumber) {
  if (data?.cashInstructionSent === true) {
    return {
      cashInstructionSent: true,
      cashReplyText: data.cashReplyText || null,
      removeAmount: data.removeAmount,
      bringAmount: data.bringAmount
    };
  }

  const critical = criticalMissingField(data);
  if (critical) return { cashInstructionSent: false };

  const actualEndingCash = Number(data.actualEndingCash);
  const removeAmount = calculateBalance(actualEndingCash);

  if (!(removeAmount >= 4000 && removeAmount < 5000)) {
    throw new Error(`Shift cash safety check failed: ${removeAmount}`);
  }

  const bringAmount = calculateBringAmount(actualEndingCash, removeAmount);
  const cashReplyText = buildReply({
    branch: data.branch,
    actualEndingCash,
    balance: removeAmount
  });

  const sendResult = await sendWhatsAppMessage(senderNumber, cashReplyText);
  const now = new Date();
  const rootMessageId = data.rootMessageId || currentMessageId;

  const cashRecord = {
    id: rootMessageId,
    whatsappMessageId: rootMessageId,
    senderNumber,
    branch: data.branch,
    branchRaw: data.branchRaw || null,
    actualEndingCash,
    removeAmount,
    balance: removeAmount,
    bringAmount,
    difference: Number.isFinite(Number(data.difference)) ? Number(data.difference) : null,
    drawerValues: data.drawerValues || null,
    payInOutItems: Array.isArray(data.payInOutItems) ? data.payInOutItems : [],
    payInOutTotals: data.payTotals || null,
    cashReplyText,
    replyText: cashReplyText,
    replySent: Boolean(sendResult?.success),
    replyMessageId: sendResult?.messageId || null,
    cashInstructionSent: Boolean(sendResult?.success),
    cashInstructionSentAt: now,
    status: 'cash_instruction_sent',
    ocrMode: 'cash_first_field_recovery',
    dateKey: sriLankaDateKey(now),
    createdAt: now,
    updatedAt: now
  };

  // Owner/Android can see the shift immediately, even if report fields still need recovery.
  await db.collection('shift_cash_history').doc(rootMessageId).set(cashRecord, { merge: true });
  await db.collection('shift_receipt_messages').doc(rootMessageId).set(cashRecord, { merge: true });

  return {
    cashInstructionSent: Boolean(sendResult?.success),
    cashReplyText,
    removeAmount,
    bringAmount,
    cashInstructionSentAt: now
  };
}

async function finalizeShiftRecord(data, currentMessageId, senderNumber) {
  const rootMessageId = data.rootMessageId || currentMessageId;
  const now = new Date();

  const record = {
    id: rootMessageId,
    whatsappMessageId: rootMessageId,
    senderNumber,
    branch: data.branch,
    branchRaw: data.branchRaw || null,
    actualEndingCash: Number(data.actualEndingCash),
    removeAmount: Number(data.removeAmount),
    balance: Number(data.removeAmount),
    bringAmount: Number(data.bringAmount),
    difference: Number.isFinite(Number(data.difference)) ? Number(data.difference) : null,
    drawerValues: data.drawerValues || null,
    payInOutItems: Array.isArray(data.payInOutItems) ? data.payInOutItems : [],
    payInOutTotals: data.payTotals || null,
    cashReplyText: data.cashReplyText || null,
    replyText: data.cashReplyText || null,
    cashInstructionSent: data.cashInstructionSent === true,
    cashInstructionSentAt: data.cashInstructionSentAt || null,
    status: 'completed',
    ocrMode: 'cash_first_field_recovery',
    dateKey: sriLankaDateKey(now),
    updatedAt: now
  };

  await db.collection('shift_cash_history').doc(rootMessageId).set(record, { merge: true });
  await db.collection('shift_receipt_messages').doc(rootMessageId).set(
    { ...record, processedAt: now },
    { merge: true }
  );

  return record;
}

async function processShiftReceiptImage(message, senderNumber) {
  const currentReceiptRef = db.collection('shift_receipt_messages').doc(message.id);
  const { ref: sessionRef, data: existingSession } = await loadActiveShiftSession(senderNumber);

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

  const reasons = await getPayInOutReasons();

  try {
    const imageBuffer = await downloadWhatsAppImage(message.image?.id);

    // -----------------------------------------------------
    // RETRY PHOTO — read only the field previously requested
    // -----------------------------------------------------
    if (existingSession?.awaitingField) {
      const field = existingSession.awaitingField;
      let partial;

      try {
        partial = await recognizeReceiptField(imageBuffer, field, reasons);
      } catch (fieldError) {
        console.error('Field OCR error:', field, fieldError);
        const reply = fieldPrompt(field, existingSession);
        await sendWhatsAppMessage(senderNumber, reply);
        await sessionRef.set(
          { ...existingSession, updatedAt: new Date(), lastPrompt: reply },
          { merge: true }
        );
        return;
      }

      const merged = {
        ...existingSession,
        flowVersion: FLOW_VERSION,
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
        // Dedicated close-up is authoritative; do not merge stale full-photo OCR rows.
        merged.payInOutItems = Array.isArray(partial.items) ? partial.items : [];
      }

      // Reconcile only for storage quality. Printed Count remains authoritative for completion.
      const payReconciled = reconcilePayItemsWithTotals(
        merged.payInOutItems || [],
        merged.payTotals || null
      );
      if (payReconciled.complete) merged.payInOutItems = payReconciled.items;

      // Cash instruction is independent from Difference/Pay In-Out report completion.
      const cash = await ensureCashInstruction(merged, message.id, senderNumber);
      Object.assign(merged, cash);

      const next = nextMissingField(merged);
      if (next) {
        const reply = fieldPrompt(next, merged);

        // Avoid sending the same cash-independent recovery prompt twice in one retry.
        if (next !== field || !partial.success) {
          await sendWhatsAppMessage(senderNumber, reply);
        } else if (next === field) {
          await sendWhatsAppMessage(senderNumber, reply);
        }

        await sessionRef.set(
          {
            ...merged,
            awaitingField: next,
            status: merged.cashInstructionSent ? 'cash_sent_waiting_report' : 'waiting_field',
            lastPrompt: reply
          },
          { merge: true }
        );

        await currentReceiptRef.set(
          {
            status: 'field_retry_processed',
            field,
            nextField: next,
            cashInstructionSent: merged.cashInstructionSent === true,
            processedAt: new Date()
          },
          { merge: true }
        );
        return;
      }

      await finalizeShiftRecord(merged, message.id, senderNumber);
      await sessionRef.set(
        { ...merged, awaitingField: null, status: 'completed', completedAt: new Date() },
        { merge: true }
      );
      await currentReceiptRef.set(
        { status: 'field_retry_completed', processedAt: new Date() },
        { merge: true }
      );
      console.log('Shift completed field-by-field:', merged.rootMessageId);
      return;
    }

    // -----------------------------------------------------
    // NEW FULL RECEIPT — salvage every field independently
    // -----------------------------------------------------
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

    const safeField = async (field) => {
      try {
        return await recognizeReceiptField(imageBuffer, field, reasons);
      } catch (error) {
        console.warn('Best-effort field failed:', field, error.message);
        return { success: false, field };
      }
    };

    const [branchField, actualField, differenceField, totalsField] = await Promise.all([
      result.branch
        ? Promise.resolve({ success: true, branch: result.branch, branchRaw: result.branchRaw })
        : safeField('branch'),
      Number.isFinite(Number(result.actualEndingCash))
        ? Promise.resolve({
            success: true,
            actualEndingCash: result.actualEndingCash,
            drawerValues: result.drawerValues
          })
        : safeField('actual_ending_cash'),
      Number.isFinite(Number(result.difference ?? result.drawerValues?.difference))
        ? Promise.resolve({
            success: true,
            difference: result.difference ?? result.drawerValues?.difference
          })
        : safeField('difference'),
      safeField('pay_totals')
    ]);

    const payText = result.payInOutText || result.text || '';
    const initialItems = extractPayInOutItems(payText, reasons);
    const initialTotals = totalsField.success
      ? totalsField.totals
      : extractPayTotalsAndCount(payText);

    const session = {
      flowVersion: FLOW_VERSION,
      rootMessageId: message.id,
      senderNumber,
      status: 'processing',
      createdAt: new Date(),
      updatedAt: new Date(),
      branch: branchField.success ? branchField.branch : null,
      branchRaw: branchField.branchRaw || null,
      actualEndingCash: actualField.success ? Number(actualField.actualEndingCash) : null,
      difference: differenceField.success ? Number(differenceField.difference) : null,
      drawerValues: {
        ...(result.drawerValues || {}),
        ...(actualField.drawerValues || {})
      },
      payInOutItems: initialItems,
      payTotals: initialTotals,
      cashInstructionSent: false,
      retryMessageIds: []
    };

    const initialReconciled = reconcilePayItemsWithTotals(
      session.payInOutItems || [],
      session.payTotals || null
    );
    if (initialReconciled.complete) session.payInOutItems = initialReconciled.items;

    // 1) If Branch/Actual Cash are missing, ask ONLY for that critical field.
    const critical = criticalMissingField(session);
    if (critical) {
      const reply = fieldPrompt(critical, session);
      await sendWhatsAppMessage(senderNumber, reply);

      await sessionRef.set(
        {
          ...session,
          awaitingField: critical,
          status: 'waiting_critical_field',
          lastPrompt: reply
        },
        { merge: true }
      );

      await currentReceiptRef.set(
        {
          status: 'waiting_critical_field',
          awaitingField: critical,
          savedPartial: {
            branch: session.branch,
            actualEndingCash: session.actualEndingCash,
            difference: session.difference,
            payInOutItems: session.payInOutItems,
            payTotals: session.payTotals
          },
          processedAt: new Date()
        },
        { merge: true }
      );
      return;
    }

    // 2) Branch + Actual Ending Cash are enough to tell employee what cash to remove.
    const cash = await ensureCashInstruction(session, message.id, senderNumber);
    Object.assign(session, cash);

    // 3) Report details never block the cash instruction.
    const reportMissing = reportMissingField(session);
    if (reportMissing) {
      const reportReply = fieldPrompt(reportMissing, session);
      await sendWhatsAppMessage(senderNumber, reportReply);

      await sessionRef.set(
        {
          ...session,
          awaitingField: reportMissing,
          status: 'cash_sent_waiting_report',
          lastPrompt: reportReply
        },
        { merge: true }
      );

      await currentReceiptRef.set(
        {
          status: 'cash_instruction_sent_waiting_report',
          awaitingField: reportMissing,
          cashInstructionSent: session.cashInstructionSent === true,
          processedAt: new Date()
        },
        { merge: true }
      );
      return;
    }

    await finalizeShiftRecord(session, message.id, senderNumber);
    await sessionRef.set(
      { ...session, awaitingField: null, status: 'completed', completedAt: new Date() },
      { merge: true }
    );
    console.log('Shift completed from full image:', message.id);
  } catch (error) {
    console.error('Shift receipt outer processing error:', message.id, error);

    // Preserve everything already read. Never demand the whole receipt again.
    if (existingSession) {
      const current = {
        ...existingSession,
        flowVersion: FLOW_VERSION,
        updatedAt: new Date()
      };

      // If cash is already readable, still try to send the employee instruction.
      try {
        const cash = await ensureCashInstruction(current, message.id, senderNumber);
        Object.assign(current, cash);
      } catch (cashError) {
        console.error('Cash instruction recovery failed:', cashError);
      }

      const field = nextMissingField(current) || existingSession.awaitingField || 'actual_ending_cash';
      const reply = fieldPrompt(field, current);
      await sendWhatsAppMessage(senderNumber, reply).catch(() => undefined);

      await sessionRef.set(
        {
          ...current,
          awaitingField: field,
          status: current.cashInstructionSent ? 'cash_sent_waiting_report' : 'waiting_field',
          lastPrompt: reply
        },
        { merge: true }
      );
      return;
    }

    // Catastrophic first-photo error: start with one small critical field, not whole receipt.
    const seed = {
      flowVersion: FLOW_VERSION,
      rootMessageId: message.id,
      senderNumber,
      status: 'waiting_critical_field',
      createdAt: new Date(),
      updatedAt: new Date(),
      retryMessageIds: [],
      branch: null,
      actualEndingCash: null,
      difference: null,
      payInOutItems: [],
      payTotals: null,
      cashInstructionSent: false
    };

    const field = 'branch';
    const reply = fieldPrompt(field, seed);
    await sendWhatsAppMessage(senderNumber, reply).catch(() => undefined);

    await sessionRef.set(
      { ...seed, awaitingField: field, lastPrompt: reply },
      { merge: true }
    );

    await currentReceiptRef.set(
      {
        status: 'waiting_critical_field',
        awaitingField: field,
        error: error.message,
        processedAt: new Date()
      },
      { merge: true }
    );
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
