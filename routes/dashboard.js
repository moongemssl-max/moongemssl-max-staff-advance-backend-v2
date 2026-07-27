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
