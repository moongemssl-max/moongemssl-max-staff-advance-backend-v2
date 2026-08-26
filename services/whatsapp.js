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



async function sendWhatsAppImage(recipientNumber, imageBuffer, caption = '') {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v22.0';
  const normalizedNumber = normalizeWhatsAppNumber(recipientNumber);

  if (!normalizedNumber || !imageBuffer?.length) {
    return { success: false, skipped: true, reason: 'Recipient number or image is missing' };
  }
  if (!accessToken || !phoneNumberId) {
    return { success: false, skipped: true, reason: 'WhatsApp credentials are missing' };
  }

  const uploadUrl = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/media`;
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'image/jpeg');
  form.append('file', new Blob([imageBuffer], { type: 'image/jpeg' }), 'shift-receipt.jpg');

  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form
  });
  const uploadBody = await uploadResponse.json().catch(() => ({}));
  if (!uploadResponse.ok || !uploadBody?.id) {
    const error = new Error(`WhatsApp media upload error ${uploadResponse.status}: ${JSON.stringify(uploadBody)}`);
    error.statusCode = uploadResponse.status;
    throw error;
  }

  const sendUrl = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const response = await fetch(sendUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizedNumber,
      type: 'image',
      image: {
        id: uploadBody.id,
        ...(caption ? { caption: String(caption) } : {})
      }
    })
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`WhatsApp image error ${response.status}: ${JSON.stringify(responseBody)}`);
    error.statusCode = response.status;
    throw error;
  }

  return {
    success: true,
    messageId: responseBody?.messages?.[0]?.id || null,
    mediaId: uploadBody.id
  };
}

module.exports = sendWhatsAppMessage;
module.exports.sendWhatsAppImage = sendWhatsAppImage;
