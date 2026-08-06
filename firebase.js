'use strict';

const admin = require('firebase-admin');

function getCredential() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;


  if (serviceAccountJson) {
    try {
      const serviceAccount = JSON.parse(serviceAccountJson);
      return admin.credential.cert(serviceAccount);
    } catch (error) {
      throw new Error(
        `FIREBASE_SERVICE_ACCOUNT is not valid JSON: ${error.message}`
      );
    }
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (projectId && clientEmail && privateKey) {
    return admin.credential.cert({
      projectId,
      clientEmail,
      privateKey
    });
  }

  throw new Error(
    'Firebase credentials are missing. Set FIREBASE_SERVICE_ACCOUNT or the separate Firebase environment variables.'
  );
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: getCredential()
  });
  console.log('Firebase Admin SDK initialized successfully.');
}

const db = admin.firestore();

module.exports = { admin, db };
