'use strict';

const express = require('express');
const { db } = require('../firebase');
const parseAdvanceMessage = require('../services/messageParser');
const { sendAdvanceRequestNotification } = require('../services/notifications');

const router = express.Router();

router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (
    mode === 'subscribe' &&
    token === process.env.VERIFY_TOKEN
  ) {
    console.log('Webhook verified.');
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

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
          if (message.type !== 'text') {
            continue;
          }

          const senderNumber = message.from;
          const messageText = message.text?.body || '';
          const parsed = parseAdvanceMessage(messageText);

          const employeeName =
            contacts.find(
              (contact) => contact.wa_id === senderNumber
            )?.profile?.name || 'Unknown';

          const requestData = {
            id: message.id,
            whatsappMessageId: message.id,
            senderNumber,
            employeeName,
            messageText,
            amount: parsed.amount,
            status: parsed.isAdvanceRequest
              ? 'pending'
              : 'needs_review',
            receivedAt: new Date()
          };

          const requestRef = db
            .collection('advance_requests')
            .doc(message.id);
          const existingRequest = await requestRef.get();

          await requestRef.set(requestData, { merge: true });

          console.log('Saved WhatsApp request:', message.id);

          // Meta may retry the same webhook. Notify only for a genuinely new message.
          if (parsed.isAdvanceRequest && !existingRequest.exists) {
            try {
              const notificationResult =
                await sendAdvanceRequestNotification(requestData);
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
