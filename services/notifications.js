'use strict';

const { admin, db } = require('../firebase');

const TOKENS_COLLECTION = 'device_tokens';

function tokenDocumentId(token) {
  return Buffer.from(token).toString('base64url').slice(0, 1500);
}

async function registerDeviceToken(token, deviceName = null) {
  const normalizedToken = String(token || '').trim();

  if (!normalizedToken) {
    throw new Error('FCM token is required');
  }

  await db.collection(TOKENS_COLLECTION).doc(tokenDocumentId(normalizedToken)).set(
    {
      token: normalizedToken,
      deviceName: deviceName ? String(deviceName).slice(0, 200) : null,
      platform: 'android',
      active: true,
      updatedAt: new Date(),
      createdAt: new Date()
    },
    { merge: true }
  );

  return normalizedToken;
}

async function removeInvalidTokens(tokens) {
  if (!tokens.length) return;

  const batch = db.batch();
  for (const token of tokens) {
    batch.delete(db.collection(TOKENS_COLLECTION).doc(tokenDocumentId(token)));
  }
  await batch.commit();
}

async function sendAdvanceRequestNotification(requestData) {
  const snapshot = await db
    .collection(TOKENS_COLLECTION)
    .where('active', '==', true)
    .get();

  const tokens = [...new Set(
    snapshot.docs
      .map((doc) => String(doc.data().token || '').trim())
      .filter(Boolean)
  )];

  if (!tokens.length) {
    console.warn('No registered FCM device tokens. Notification skipped.');
    return { success: false, skipped: true, reason: 'No registered devices' };
  }

  const amount = Number(requestData.amount || 0);
  const amountText = amount > 0
    ? `Rs. ${amount.toLocaleString('en-LK', { maximumFractionDigits: 2 })}`
    : 'an advance';
  const employeeName = String(requestData.employeeName || 'Employee');
  const requestId = String(requestData.id || requestData.whatsappMessageId || '');

  const invalidTokens = [];
  let successCount = 0;
  let failureCount = 0;

  // Firebase allows up to 500 registration tokens per multicast call.
  for (let index = 0; index < tokens.length; index += 500) {
    const tokenChunk = tokens.slice(index, index + 500);
    const response = await admin.messaging().sendEachForMulticast({
      tokens: tokenChunk,
      data: {
        type: 'advance_request',
        requestId,
        title: 'New Advance Request',
        body: `${employeeName} requested ${amountText}`,
        employeeName,
        amount: String(amount || '')
      },
      android: {
        priority: 'high'
      }
    });

    successCount += response.successCount;
    failureCount += response.failureCount;

    response.responses.forEach((item, responseIndex) => {
      if (item.success) return;

      const code = item.error?.code || '';
      console.error('FCM send error:', code, item.error?.message || 'Unknown error');

      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        invalidTokens.push(tokenChunk[responseIndex]);
      }
    });
  }

  await removeInvalidTokens(invalidTokens);

  return {
    success: successCount > 0,
    skipped: false,
    successCount,
    failureCount,
    removedInvalidTokens: invalidTokens.length
  };
}

async function sendAttendanceNotification(data) {
 console.log("Attendance notification data:", data); 
  const snapshot = await db
    .collection(TOKENS_COLLECTION)
    .where('active', '==', true)
    .get();

  const tokens = [
    ...new Set(
      snapshot.docs
        .map(doc =>
          String(doc.data().token || '').trim()
        )
        .filter(Boolean)
    )
  ];

  if (!tokens.length) {
    console.warn(
      'No registered FCM device tokens. Attendance notification skipped.'
    );

    return {
      success: false,
      skipped: true,
      reason: 'No registered devices'
    };
  }

  const isCheckIn =
    data.action === 'check_in';

  const title = isCheckIn
    ? 'Attendance Check In'
    : 'Attendance Check Out';

  const latitude =
    data.latitude !== undefined &&
    data.latitude !== null
      ? String(data.latitude)
      : '';

  const longitude =
    data.longitude !== undefined &&
    data.longitude !== null
      ? String(data.longitude)
      : '';

  const mapsLink = String(
    data.googleMapsLink || ''
  );

  const locationText = mapsLink
    ? ` • Location captured`
    : '';

  const body =
    `${data.employeeName} • ${data.time}` +
    `${isCheckIn ? ` • ${data.status}` : ''}` +
    locationText;

  const invalidTokens = [];

  let successCount = 0;
  let failureCount = 0;

  for (
    let index = 0;
    index < tokens.length;
    index += 500
  ) {
    const chunk =
      tokens.slice(index, index + 500);

    const response =
      await admin
        .messaging()
        .sendEachForMulticast({
          tokens: chunk,

          data: {
            type: 'attendance',

            title,
            body,

            employeeName: String(
              data.employeeName || ''
            ),

            employeePhone: String(
              data.employeePhone || ''
            ),

            action: String(
              data.action || ''
            ),

            status: String(
              data.status || ''
            ),

            workDate: String(
              data.workDate || ''
            ),

            time: String(
              data.time || ''
            ),

            latitude,
            longitude,
            googleMapsLink: mapsLink
          },

          android: {
            priority: 'high'
          }
        });

    successCount +=
      response.successCount;

    failureCount +=
      response.failureCount;

    response.responses.forEach(
      (item, responseIndex) => {
        if (item.success) return;

        const code =
          item.error?.code || '';

        console.error(
          'Attendance FCM error:',
          code,
          item.error?.message ||
            'Unknown error'
        );

        if (
          code ===
            'messaging/registration-token-not-registered' ||
          code ===
            'messaging/invalid-registration-token'
        ) {
          invalidTokens.push(
            chunk[responseIndex]
          );
        }
      }
    );
  }

  await removeInvalidTokens(
    invalidTokens
  );

  return {
    success: successCount > 0,
    skipped: false,
    successCount,
    failureCount,
    removedInvalidTokens:
      invalidTokens.length
  };
}

module.exports = {
  registerDeviceToken,
  sendAdvanceRequestNotification,
  sendAttendanceNotification
};
