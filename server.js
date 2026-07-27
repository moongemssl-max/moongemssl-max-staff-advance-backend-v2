'use strict';

require('dotenv').config();

const express = require('express');
const { db } = require('./firebase');
const dashboardRoutes = require('./routes/dashboard');
const webhookRoutes = require('./routes/webhook');
const attendanceRoutes = require('./routes/attendance');

const app = express();
const port = Number(process.env.PORT) || 10000;

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.get('/', (_req, res) => {
  return res.json({
    status: 'online',
    service: 'Staff Advance Backend',
    version: '3.0.0-phase10-attendance'
  });
});

app.get('/health', async (_req, res) => {
  try {
    await db.collection('system').doc('health').set(
      {
        status: 'online',
        checkedAt: new Date()
      },
      { merge: true }
    );

    return res.json({
      ok: true,
      firebase: 'connected'
    });
  } catch (error) {
    console.error('Health check error:', error);

    return res.status(500).json({
      ok: false,
      firebase: 'connection failed',
      message: error.message
    });
  }
});

app.use('/api', dashboardRoutes);
app.use('/webhook', webhookRoutes);
app.use('/', attendanceRoutes);

app.use((_req, res) => {
  return res.status(404).json({
    error: 'Route not found'
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Staff Advance Backend running on port ${port}`);
});
