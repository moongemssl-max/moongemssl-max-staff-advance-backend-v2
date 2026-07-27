'use strict';

const express = require('express');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { db } = require('../firebase');
const { sendAttendanceNotification } = require('../services/notifications');

const router = express.Router();
const TZ = 'Asia/Colombo';

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').replace(/^0/, '94');
}

function publicBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}

function sriLankaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((out, item) => { out[item.type] = item.value; return out; }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    hour: Number(parts.hour), minute: Number(parts.minute)
  };
}

function isLate(parts) {
  const configured = String(process.env.ATTENDANCE_LATE_AFTER || '08:30');
  const [h, m] = configured.split(':').map(Number);
  return parts.hour * 60 + parts.minute > h * 60 + m;
}

function employeeDocId(phone) { return normalizePhone(phone); }

async function markAttendanceForToken(token, location = null) {
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  const accuracy = Number(location?.accuracy);
  const hasLocation = Number.isFinite(latitude) && Number.isFinite(longitude);
  const locationData = hasLocation ? {
    latitude,
    longitude,
    accuracy: Number.isFinite(accuracy) ? accuracy : null,
    googleMapsLink: `https://www.google.com/maps?q=${latitude},${longitude}`,
    capturedAt: new Date()
  } : null;

  const tokenDoc = await db.collection('attendance_qr_tokens').doc(token).get();
  if (!tokenDoc.exists || tokenDoc.data().active !== true) {
    const error = new Error('This QR code is invalid. Please ask the manager for a new QR code.');
    error.statusCode = 401;
    throw error;
  }

  const phone = normalizePhone(tokenDoc.data().employeePhone);
  const employee = await db.collection('employees').doc(employeeDocId(phone)).get();
  if (!employee.exists || employee.data().active === false) {
    const error = new Error('This employee is not active.');
    error.statusCode = 404;
    throw error;
  }

  const now = new Date();
  const parts = sriLankaParts(now);
  const recordId = `${parts.date}_${phone}`;
  const ref = db.collection('attendance').doc(recordId);
  let action;
  let status;
  let result;

  await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (!current.exists) {
      action = 'check_in';
      status = isLate(parts) ? 'Late' : 'Present';
      result = { checkInTime: parts.time };
      tx.set(ref, {
        employeePhone: phone,
        employeeName: employee.data().name,
        localEmployeeId: Number(employee.data().localId || 0),
        workDate: parts.date,
        checkInAt: now,
        checkInTime: parts.time,
        checkOutAt: null,
        checkOutTime: null,
        status,
        source: 'individual_qr',
        createdAt: now,
        updatedAt: now,
        ...(locationData ? { checkInLocation: locationData, latestLocation: locationData } : {})
      });
    } else if (!current.data().checkOutAt) {
      action = 'check_out';
      status = current.data().status || 'Present';
      result = { checkInTime: current.data().checkInTime, checkOutTime: parts.time };
      tx.update(ref, {
        checkOutAt: now,
        checkOutTime: parts.time,
        updatedAt: now,
        ...(locationData ? { checkOutLocation: locationData, latestLocation: locationData } : {})
      });
    } else {
      action = 'completed';
      status = current.data().status || 'Present';
      result = { checkInTime: current.data().checkInTime, checkOutTime: current.data().checkOutTime };
    }
  });

  if (action !== 'completed') {
    await sendAttendanceNotification({
      employeeName: employee.data().name,
      employeePhone: phone,
      action,
      status,
      workDate: parts.date,
      time: action === 'check_in' ? result.checkInTime : result.checkOutTime,
      location: locationData
    });
  }

  return {
    success: true,
    action,
    status,
    employeeName: employee.data().name,
    workDate: parts.date,
    locationCaptured: Boolean(locationData),
    googleMapsLink: locationData?.googleMapsLink || '',
    ...result
  };
}

router.post('/api/employees/sync', async (req, res) => {
  try {
    const employees = Array.isArray(req.body?.employees) ? req.body.employees : [];
    if (!employees.length) return res.status(400).json({ success: false, message: 'Employees are required' });
    const batch = db.batch();
    for (const item of employees) {
      const phone = normalizePhone(item.phone);
      if (!phone || !String(item.name || '').trim()) continue;
      const ref = db.collection('employees').doc(employeeDocId(phone));
      batch.set(ref, {
        localId: Number(item.id || 0), name: String(item.name).trim(), phone,
        active: item.isActive !== false, updatedAt: new Date()
      }, { merge: true });
    }
    await batch.commit();
    return res.json({ success: true, synced: employees.length });
  } catch (error) {
    console.error('Employee sync error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/api/employees/:phone/qr', async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const suppliedName = String(req.body?.name || '').trim();
    const employeeRef = db.collection('employees').doc(employeeDocId(phone));
    let employee = await employeeRef.get();

    // Upsert the employee from the manager app before generating the QR.
    // This removes the previous timing issue where QR generation could run
    // before the periodic employee sync completed.
    if (suppliedName) {
      await employeeRef.set({
        localId: Number(req.body?.id || employee.data()?.localId || 0),
        name: suppliedName,
        phone,
        active: req.body?.isActive !== false,
        updatedAt: new Date()
      }, { merge: true });
      employee = await employeeRef.get();
    }

    if (!employee.exists) {
      return res.status(404).json({ success: false, message: 'Employee details were not received. Please reopen the employee profile and try again.' });
    }
    if (employee.data().active === false) {
      return res.status(400).json({ success: false, message: 'Cannot generate a QR code for an inactive employee.' });
    }

    const existing = await db.collection('attendance_qr_tokens').where('employeePhone', '==', phone).where('active', '==', true).get();
    const batch = db.batch();
    existing.docs.forEach(doc => batch.update(doc.ref, { active: false, revokedAt: new Date() }));

    const token = crypto.randomBytes(24).toString('base64url');
    const tokenRef = db.collection('attendance_qr_tokens').doc(token);
    batch.set(tokenRef, {
      employeePhone: phone,
      employeeName: employee.data().name,
      active: true,
      createdAt: new Date()
    });
    await batch.commit();

    const scanUrl = `${publicBaseUrl(req)}/attendance/scan/${token}`;
    return res.json({
      success: true,
      employeeName: employee.data().name,
      token,
      scanUrl,
      qrImageUrl: `${publicBaseUrl(req)}/attendance/qr-image/${token}`
    });
  } catch (error) {
    console.error('QR generation error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/api/employees/:phone/qr', async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const snapshot = await db.collection('attendance_qr_tokens').where('employeePhone', '==', phone).where('active', '==', true).limit(1).get();
    if (snapshot.empty) return res.status(404).json({ success: false, message: 'QR code has not been generated' });
    const token = snapshot.docs[0].id;
    return res.json({
      success: true,
      token,
      scanUrl: `${publicBaseUrl(req)}/attendance/scan/${token}`,
      qrImageUrl: `${publicBaseUrl(req)}/attendance/qr-image/${token}`
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/attendance/qr-image/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '');
    const tokenDoc = await db.collection('attendance_qr_tokens').doc(token).get();
    if (!tokenDoc.exists || tokenDoc.data().active !== true) return res.status(404).send('Invalid QR');
    const scanUrl = `${publicBaseUrl(req)}/attendance/scan/${token}`;
    const png = await QRCode.toBuffer(scanUrl, { width: 900, margin: 3, errorCorrectionLevel: 'H' });
    res.set('Cache-Control', 'no-store');
    return res.type('png').send(png);
  } catch (error) {
    return res.status(500).send(error.message);
  }
});

router.post('/attendance/scan/:token/mark', async (req, res) => {
  try {
    return res.json(await markAttendanceForToken(String(req.params.token || ''), req.body || null));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

router.get('/attendance/scan/:token', async (req, res) => {
  const token = String(req.params.token || '');
  const tokenDoc = await db.collection('attendance_qr_tokens').doc(token).get();
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  if (!tokenDoc.exists || tokenDoc.data().active !== true) {
    return res.status(404).type('html').send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:28px"><h2>QR කේතය වලංගු නැත</h2><p>කරුණාකර කළමනාකරුගෙන් නව QR කේතයක් ලබාගන්න.</p></body>');
  }

  const employeeName = String(tokenDoc.data().employeeName || 'Employee')
    .replace(/[<>&"']/g, '');

  return res.type('html').send(`<!doctype html>
<html lang="si">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>New Imashi Motors Attendance</title>
  <style>
    *{box-sizing:border-box}body{font-family:system-ui,-apple-system,"Noto Sans Sinhala",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(145deg,#eef7f1,#edf2ff);color:#152033;padding:20px}.card{width:min(480px,100%);background:#fff;border-radius:28px;padding:34px 24px;box-shadow:0 18px 55px #13264a20;text-align:center}.brand{font-size:25px;font-weight:900;margin-bottom:7px}.name{font-size:24px;font-weight:850;margin:22px 0 6px}.muted{color:#687086}.spinner{width:54px;height:54px;margin:25px auto;border:6px solid #dce5f1;border-top-color:#3157d5;border-radius:50%;animation:spin .85s linear infinite}.icon{font-size:72px;line-height:1;margin:18px 0}.greeting{font-size:34px;font-weight:950;margin:10px 0}.message{font-size:21px;font-weight:750;line-height:1.55}.details{margin-top:22px;font-size:19px;line-height:1.7}.footer{margin-top:22px;font-size:20px;font-weight:800}.ok{color:#126b35}.error{color:#a31d1d}.retry{border:0;border-radius:14px;padding:14px 20px;background:#3157d5;color:#fff;font-size:17px;font-weight:800;margin-top:20px}@keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">🚗 New Imashi Motors</div>
    <div id="content">
      <div class="name">${employeeName}</div>
      <div class="spinner"></div>
      <div class="muted" id="progress">ස්ථානය ලබාගනිමින් පවතී...</div>
    </div>
  </main>
  <script>
    const content = document.getElementById('content');

    function escapeHtml(value) {
      return String(value || '').replace(/[&<>"']/g, function (char) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
      });
    }

    function timeGreeting() {
      const hour = new Date().getHours();
      if (hour < 12) return 'සුභ උදෑසනක්!';
      if (hour < 17) return 'සුභ දහවලක්!';
      return 'සුභ සන්ධ්‍යාවක්!';
    }

    function showSuccess(data) {
      const isCheckIn = data.action === 'check_in';
      const isCheckOut = data.action === 'check_out';
      const greeting = isCheckOut ? 'සුභ රාත්‍රියක්!' : (isCheckIn ? timeGreeting() : 'අද දින සටහන සම්පූර්ණයි');
      const message = isCheckIn
        ? 'ඔබගේ පැමිණීම සාර්ථකව සටහන් විය.'
        : isCheckOut
          ? 'ඔබගේ පිටවීම සාර්ථකව සටහන් විය.'
          : 'ඔබගේ අද දින පැමිණීම සහ පිටවීම දැනටමත් සටහන් කර ඇත.';
      const footer = isCheckOut ? 'ආරක්ෂිතව නිවසට යන්න!' : 'ඔබට සුබ දවසක් වේවා!';
      const shownTime = isCheckOut ? data.checkOutTime : data.checkInTime;
      content.innerHTML = '<div class="icon">✅</div>' +
        '<div class="greeting ok">' + escapeHtml(greeting) + '</div>' +
        '<div class="message">' + escapeHtml(message) + '</div>' +
        '<div class="details"><strong>👤 ' + escapeHtml(data.employeeName) + '</strong><br>🕒 ' + escapeHtml(shownTime || '') + '</div>' +
        '<div class="footer">' + escapeHtml(footer) + '</div>';
    }

    function showError(message) {
      content.innerHTML = '<div class="icon">⚠️</div>' +
        '<div class="greeting error">සටහන් කිරීමට නොහැකි විය</div>' +
        '<div class="message">' + escapeHtml(message) + '</div>' +
        '<button class="retry" onclick="startAttendance()">නැවත උත්සාහ කරන්න</button>';
    }

    async function submitAttendance(locationData) {
      document.getElementById('progress').textContent = 'පැමිණීම සටහන් කරමින් පවතී...';
      const response = await fetch(location.pathname + '/mark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(locationData || {})
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || 'Attendance save failed');
      showSuccess(data);
    }

    function startAttendance() {
      content.innerHTML = '<div class="name">${employeeName}</div><div class="spinner"></div><div class="muted" id="progress">ස්ථානය ලබාගනිමින් පවතී...</div>';
      if (!navigator.geolocation) {
        submitAttendance({}).catch(function (error) { showError(error.message); });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        function (position) {
          submitAttendance({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy
          }).catch(function (error) { showError(error.message); });
        },
        function () {
          submitAttendance({}).catch(function (error) { showError(error.message); });
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
      );
    }

    window.addEventListener('load', startAttendance);
  </script>
</body>
</html>`);
});

router.get('/api/attendance', async (req, res) => {
  try {
    const date = String(req.query.date || sriLankaParts().date);
    const snapshot = await db.collection('attendance').where('workDate', '==', date).get();
    const attendance = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    attendance.sort((a, b) => String(a.checkInTime || '').localeCompare(String(b.checkInTime || '')));
    return res.json({ success: true, attendance });
  } catch (error) {
    console.error('Attendance fetch error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
