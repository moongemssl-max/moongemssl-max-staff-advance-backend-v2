'use strict';

function normalizeWhatsAppNumber(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

async function sendWhatsAppMessage(recipientNumber, message) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v22.0';
  const normalizedNumber = normalizeWhatsAppNumber(recipientNumber);

  if (!normalizedNumber) {
    return {
      success: false,
      skipped: true,
      reason: 'Recipient number is missing'
    };
  }

  if (!accessToken || !phoneNumberId) {
    console.warn('WhatsApp credentials are missing. Message was not sent.');
    return {
      success: false,
      skipped: true,
      reason: 'WhatsApp credentials are missing'
    };
  }

  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedNumber,
      type: 'text',
      text: {
        preview_url: false,
        body: String(message)
      }
    })
  });

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      `WhatsApp API error ${response.status}: ${JSON.stringify(responseBody)}`
    );
    error.statusCode = response.status;
    error.responseBody = responseBody;
    throw error;
  }

  return {
    success: true,
    messageId: responseBody?.messages?.[0]?.id || null,
    data: responseBody
  };
}

module.exports = sendWhatsAppMessage;
