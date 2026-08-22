'use strict';

const express = require('express');
const { db } = require('../firebase');
const sendWhatsAppMessage = require('../services/whatsapp');
const { registerDeviceToken } = require('../services/notifications');

const router = express.Router();


router.post('/device-token', async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    const deviceName = req.body?.deviceName || null;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'FCM token is required'
      });
    }

    await registerDeviceToken(token, deviceName);
    console.log('FCM device token registered:', deviceName || 'Unknown Android device');

    return res.json({
      success: true,
      message: 'Device registered for notifications.'
    });
  } catch (error) {
    console.error('Device token registration error:', error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});


router.get('/notification-status', async (_req, res) => {
  try {
    const snapshot = await db
      .collection('device_tokens')
      .where('active', '==', true)
      .get();

    return res.json({
      success: true,
      activeDevices: snapshot.size
    });
  } catch (error) {
    console.error('Notification status error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/login', (req, res) => {
  const username = String(req.body?.username || '');
  const password = String(req.body?.password || '');

  const expectedUsername = process.env.ADMIN_USERNAME || 'admin';
  const expectedPassword = process.env.ADMIN_PASSWORD || '1234';
  const token = process.env.LOGIN_TOKEN || 'staffadvance2026';

  if (username === expectedUsername && password === expectedPassword) {
    return res.json({
      success: true,
      token
    });
  }

  return res.status(401).json({
    success: false,
    message: 'Invalid username or password'
  });
});



const DEFAULT_PAY_IN_OUT_REASONS = [
  'Hadunkuru', 'Poltel', 'Petrol', 'Adu', 'Wedi', 'Battry', 'Bill Payment',
  'Rusiru Advance', 'Prasanna Advance', 'Nandasena Advance'
];

function cleanReasons(values) {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!value || value.length > 40) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

router.get('/pay-in-out-reasons', async (_req, res) => {
  try {
    const ref = db.collection('app_settings').doc('pay_in_out_reasons');
    const doc = await ref.get();
    let reasons = doc.exists ? cleanReasons(doc.data()?.reasons) : [];
    if (!reasons.length) {
      reasons = DEFAULT_PAY_IN_OUT_REASONS;
      await ref.set({ reasons, updatedAt: new Date() }, { merge: true });
    }
    return res.json({ success: true, reasons });
  } catch (error) {
    console.error('Get Pay In/Out reasons error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/pay-in-out-reasons', async (req, res) => {
  try {
    const reasons = cleanReasons(req.body?.reasons);
    if (!reasons.length) {
      return res.status(400).json({ success: false, message: 'At least one reason is required.' });
    }
    if (reasons.length > 50) {
      return res.status(400).json({ success: false, message: 'Maximum 50 reasons are allowed.' });
    }
    await db.collection('app_settings').doc('pay_in_out_reasons').set({
      reasons,
      updatedAt: new Date()
    }, { merge: true });
    return res.json({ success: true, reasons });
  } catch (error) {
    console.error('Save Pay In/Out reasons error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/pay-in-out-summary', async (req, res) => {
  try {
    const month = String(req.query?.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, message: 'month must be YYYY-MM' });
    }
    const start = `${month}-01`;
    const [year, monthNumber] = month.split('-').map(Number);
    const nextMonth = new Date(Date.UTC(year, monthNumber, 1));
    const nextKey = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}-01`;

    const snapshot = await db.collection('shift_cash_history')
      .where('dateKey', '>=', start)
      .where('dateKey', '<', nextKey)
      .get();

    const buckets = new Map();
    function add(branch, item) {
      const b = String(branch || '').toUpperCase();
      if (!['MAIN', 'GETAHETTA'].includes(b)) return;
      const reason = String(item?.reason || '').trim();
      const type = String(item?.type || '').toUpperCase() === 'IN' ? 'IN' : 'OUT';
      const amount = Number(item?.amount || 0);
      if (!reason || !Number.isFinite(amount) || amount <= 0) return;
      const key = `${b}\u0000${reason.toLowerCase()}\u0000${type}`;
      const current = buckets.get(key) || { branch: b, reason, type, total: 0, count: 0 };
      current.total = Math.round((current.total + amount) * 100) / 100;
      current.count += 1;
      buckets.set(key, current);
    }

    for (const doc of snapshot.docs) {
      const data = doc.data();
      for (const item of Array.isArray(data.payInOutItems) ? data.payInOutItems : []) add(data.branch, item);
    }

    const items = [...buckets.values()].sort((a, b) =>
      a.branch.localeCompare(b.branch) || a.reason.localeCompare(b.reason) || a.type.localeCompare(b.type)
    );
    const branchTotals = {};
    for (const branch of ['MAIN', 'GETAHETTA']) {
      const rows = items.filter((item) => item.branch === branch);
      branchTotals[branch] = {
        inTotal: Math.round(rows.filter((i) => i.type === 'IN').reduce((sum, i) => sum + i.total, 0) * 100) / 100,
        outTotal: Math.round(rows.filter((i) => i.type === 'OUT').reduce((sum, i) => sum + i.total, 0) * 100) / 100
      };
    }

    return res.json({ success: true, month, items, branchTotals });
  } catch (error) {
    console.error('Get Pay In/Out summary error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/shift-cash-history', async (req, res) => {
  try {
    const date = String(req.query?.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, message: 'date must be YYYY-MM-DD' });
    }

    const snapshot = await db
      .collection('shift_cash_history')
      .where('dateKey', '==', date)
      .get();

    const records = snapshot.docs.map((doc) => {
      const data = doc.data();
      const createdAt = data.createdAt?.toDate ? data.createdAt.toDate() : data.createdAt;
      return {
        id: doc.id,
        branch: data.branch || '',
        actualEndingCash: Number(data.actualEndingCash || 0),
        removeAmount: Number(data.removeAmount || 0),
        bringAmount: Number(data.bringAmount || 0),
        difference: data.difference == null ? null : Number(data.difference),
        payInOutItems: Array.isArray(data.payInOutItems) ? data.payInOutItems.map((item) => ({
          reason: String(item.reason || ''),
          amount: Number(item.amount || 0),
          type: String(item.type || '').toUpperCase() === 'IN' ? 'IN' : 'OUT'
        })) : [],
        ocrMode: data.ocrMode || null,
        dateKey: data.dateKey || date,
        createdAt: createdAt instanceof Date ? createdAt.toISOString() : null
      };
    }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

    return res.json({ success: true, date, records });
  } catch (error) {
    console.error('Get shift cash history error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/requests', async (_req, res) => {
  try {
    const snapshot = await db
      .collection('advance_requests')
      .orderBy('receivedAt', 'desc')
      .get();

    const requests = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    }));

    return res.json({
      success: true,
      requests
    });
  } catch (error) {
    console.error('Get requests error:', error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

router.patch('/requests/:id/status', async (req, res) => {
  try {
    const status = String(req.body?.status || '').toLowerCase();

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status'
      });
    }

    const requestRef = db
      .collection('advance_requests')
      .doc(req.params.id);

    const requestDoc = await requestRef.get();

    if (!requestDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Request not found'
      });
    }

    const requestData = requestDoc.data();
    const amount = Number(requestData.amount || 0);
    const formattedAmount = amount.toLocaleString('en-LK', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });

    const replyMessage = status === 'approved'
      ? `Your advance request of Rs. ${formattedAmount} has been approved.`
      : `Your advance request of Rs. ${formattedAmount} has been rejected. Please contact the office for more information.`;

    let whatsappResult = {
      success: false,
      skipped: true,
      reason: 'Sender number is missing'
    };

    if (requestData.senderNumber) {
      try {
        whatsappResult = await sendWhatsAppMessage(
          requestData.senderNumber,
          replyMessage
        );
      } catch (whatsappError) {
        console.error('WhatsApp reply error:', whatsappError);
        whatsappResult = {
          success: false,
          skipped: false,
          reason: whatsappError.message
        };
      }
    }

    await requestRef.update({
      status,
      updatedAt: new Date(),
      replyMessage,
      whatsappReplySent: whatsappResult.success === true,
      whatsappReplyMessageId: whatsappResult.messageId || null,
      whatsappReplyError: whatsappResult.success
        ? null
        : (whatsappResult.reason || 'Unknown WhatsApp error'),
      whatsappReplyAt: new Date()
    });

    return res.json({
      success: true,
      message: status === 'approved'
        ? 'Request approved.'
        : 'Request rejected.',
      whatsapp: whatsappResult
    });
  } catch (error) {
    console.error('Status update error:', error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = router;
