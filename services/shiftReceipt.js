'use strict';

const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

let sharedWorkerPromise = null;
let ocrQueue = Promise.resolve();

async function getWorker() {
  if (!sharedWorkerPromise) {
    sharedWorkerPromise = createWorker('eng').catch((error) => {
      sharedWorkerPromise = null;
      throw error;
    });
  }
  return sharedWorkerPromise;
}

function runExclusive(task) {
  const run = ocrQueue.then(task, task);
  ocrQueue = run.catch(() => undefined);
  return run;
}

function cleanMoneyToken(value) {
  return String(value || '')
    .replace(/[Oo]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/S/g, '5')
    .replace(/B/g, '8')
    .replace(/,/g, '')
    .replace(/[^0-9.\-]/g, '');
}

function parseMoney(value) {
  const cleaned = cleanMoneyToken(value);
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function lastMoney(line) {
  const matches = String(line || '').match(
    /-?[$S]?\s*[0-9OoIl|BS][0-9OoIl|BS,.\s]*(?:[.,][0-9OoIl|BS]{1,2})?/g
  );
  if (!matches?.length) return null;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const value = parseMoney(matches[i].replace(/\s+/g, ''));
    if (value !== null) return value;
  }
  return null;
}

function letters(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/[^a-z]/g, '')
    .replace(/rn/g, 'm');
}

function levenshtein(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  const row = Array.from({ length: y.length + 1 }, (_, i) => i);

  for (let i = 1; i <= x.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= y.length; j += 1) {
      const old = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prev + (x[i - 1] === y[j - 1] ? 0 : 1)
      );
      prev = old;
    }
  }
  return row[y.length];
}

function fuzzyContains(value, target, distance = 2) {
  const text = letters(value);
  const needle = letters(target);
  if (!text || !needle) return false;
  if (text.includes(needle)) return true;

  const min = Math.max(3, needle.length - distance);
  const max = needle.length + distance;
  for (let size = min; size <= max; size += 1) {
    for (let i = 0; i + size <= text.length; i += 1) {
      if (levenshtein(text.slice(i, i + size), needle) <= distance) return true;
    }
  }
  return false;
}

function normalizeTextLine(line) {
  return String(line || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapBranch(value) {
  const text = normalizeTextLine(value);
  const key = letters(text);

  if (
    key.includes('mainbranch') ||
    key.includes('mainbranc') ||
    key.includes('mainbraneh') ||
    key.includes('mainbrnch') ||
    fuzzyContains(text, 'main branch', 3) ||
    fuzzyContains(text, 'main', 1)
  ) {
    return 'MAIN';
  }

  if (
    key.includes('getahetta') ||
    key.includes('getahatta') ||
    key.includes('getaheta') ||
    key.includes('gettahetta') ||
    fuzzyContains(text, 'getahetta', 3)
  ) {
    return 'GETAHETTA';
  }

  return null;
}

function extractBranch(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(normalizeTextLine)
    .filter(Boolean);

  // First: explicit Branch label.
  for (const line of lines.slice(0, 30)) {
    const key = letters(line);
    const looksLikeBranchLabel =
      key.includes('branch') ||
      fuzzyContains(line, 'branch', 3);

    if (!looksLikeBranchLabel) continue;

    const afterColon = line.includes(':')
      ? line.slice(line.indexOf(':') + 1).trim()
      : line;

    const mapped = mapBranch(afterColon) || mapBranch(line);
    if (mapped) {
      return { branch: mapped, branchRaw: afterColon || line };
    }
  }

  // Second: known branch name in header even if "Branch:" was lost.
  const header = lines.slice(0, 30).join(' ');
  const mapped = mapBranch(header);
  if (mapped) return { branch: mapped, branchRaw: header };

  return { branch: null, branchRaw: null };
}

function numberOnlyLine(line) {
  const raw = normalizeTextLine(line);
  if (!raw) return null;
  const stripped = raw
    .replace(/-?[$S]?\s*[0-9OoIl|BS][0-9OoIl|BS,.\s]*(?:[.,][0-9OoIl|BS]{1,2})?/g, '')
    .replace(/[.:\-\s]/g, '');
  if (stripped.length > 2) return null;
  return lastMoney(raw);
}

function findLabelMoney(lines, labelWords, fuzzyDistance = 3) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const matches = labelWords.every((word) => fuzzyContains(line, word, fuzzyDistance));
    if (!matches) continue;

    const direct = lastMoney(line);
    if (direct !== null) return direct;

    for (let offset = 1; offset <= 2; offset += 1) {
      const next = lines[i + offset];
      if (!next) break;
      const value = numberOnlyLine(next);
      if (value !== null) return value;

      // Stop if next line is clearly another drawer label.
      const nextKey = letters(next);
      if (
        nextKey.includes('startingcash') ||
        nextKey.includes('netcashinflow') ||
        nextKey.includes('expectedendingcash') ||
        nextKey.includes('actualendingcash') ||
        nextKey.includes('difference')
      ) break;
    }
  }
  return null;
}

function extractCashDrawer(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(normalizeTextLine)
    .filter(Boolean);

  const values = {
    startingCash: findLabelMoney(lines, ['starting', 'cash']),
    netCashInflow: findLabelMoney(lines, ['net', 'cash', 'inflow']),
    expectedEndingCash: findLabelMoney(lines, ['expected', 'ending', 'cash']),
    actualEndingCash: findLabelMoney(lines, ['actual', 'ending', 'cash']),
    difference: findLabelMoney(lines, ['difference'])
  };

  // Safe derivation only from two labelled Cash Drawer values.
  if (
    values.actualEndingCash === null &&
    values.expectedEndingCash !== null &&
    values.difference !== null
  ) {
    const derived = Math.round(
      (Number(values.expectedEndingCash) + Number(values.difference)) * 100
    ) / 100;

    if (derived >= 4000 && derived <= 2000000) {
      values.actualEndingCash = derived;
    }
  }

  // Cross-check expected cash when possible.
  if (
    values.startingCash !== null &&
    values.netCashInflow !== null &&
    values.expectedEndingCash !== null
  ) {
    const expected = Math.round(
      (Number(values.startingCash) + Number(values.netCashInflow)) * 100
    ) / 100;

    if (Math.abs(expected - Number(values.expectedEndingCash)) > 5) {
      // We do not reject an explicitly labelled Actual line, but mark math mismatch.
      values.mathMismatch = true;
    }
  }

  return values;
}

function reasonKey(value) {
  return letters(value).replace(/battery/g, 'battry');
}

function canonicalReason(raw, configuredReasons = []) {
  const cleaned = String(raw || '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return null;

  const known = [
    ...(configuredReasons || []),
    'Hadunkuru', 'Poltel', 'Petrol', 'Adu', 'Wedi', 'Battry',
    'Bill Payment', 'Rusiru Advance', 'Prasanna Advance', 'Nandasena Advance'
  ]
    .map((x) => String(x || '').trim())
    .filter(Boolean);

  const key = reasonKey(cleaned);
  const exact = known.find((item) => {
    const k = reasonKey(item);
    return key === k || key.includes(k) || k.includes(key);
  });
  if (exact) return exact;

  const fuzzy = known.find((item) => fuzzyContains(cleaned, item, 3));
  return fuzzy || cleaned;
}

function extractPayTotals(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(normalizeTextLine)
    .filter(Boolean);

  const totals = {
    count: null,
    totalPayIn: null,
    totalPayOut: null,
    netInflow: null
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const key = letters(line);

    const take = () => {
      const direct = lastMoney(line);
      if (direct !== null) return direct;
      const next = lines[i + 1];
      return next ? numberOnlyLine(next) : null;
    };

    if (key.includes('payinpayoutcount') || (key.includes('pay') && key.includes('count'))) {
      const v = take();
      if (v !== null && v >= 0 && v < 100) totals.count = Math.round(v);
    } else if (key.includes('totalpayin')) {
      const v = take();
      if (v !== null) totals.totalPayIn = Math.abs(v);
    } else if (key.includes('totalpayout')) {
      const v = take();
      if (v !== null) totals.totalPayOut = Math.abs(v);
    } else if (key.includes('netinflow')) {
      const v = take();
      if (v !== null) totals.netInflow = v;
    }
  }

  return totals;
}

function extractPayInOutItems(text, configuredReasons = []) {
  // Transaction rows only: line must START with IN or OUT.
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(normalizeTextLine)
    .filter(Boolean);

  const items = [];
  const seen = new Set();

  for (const line of lines) {
    const match = line.match(/^\s*\(?\s*(IN|OUT)\s*\)?\s+(.+)$/i);
    if (!match) continue;

    const type = match[1].toUpperCase();
    const remainder = match[2].trim();
    const amount = lastMoney(remainder);

    if (amount === null || !Number.isFinite(Number(amount))) continue;

    const reasonRaw = remainder
      .replace(/-?[$S]?\s*[0-9OoIl|BS][0-9OoIl|BS,.\s]*(?:[.,][0-9OoIl|BS]{1,2})?\s*$/i, '')
      .trim();

    const reason = canonicalReason(reasonRaw, configuredReasons);
    if (!reason) continue;

    const absoluteAmount = Math.round(Math.abs(Number(amount)) * 100) / 100;
    if (!(absoluteAmount > 0 && absoluteAmount <= 1000000)) continue;

    const key = `${type}|${reasonKey(reason)}|${absoluteAmount.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({ reason, amount: absoluteAmount, type });
  }

  return items;
}

function paySectionComplete(items, totals) {
  const list = Array.isArray(items) ? items : [];

  if (totals?.count !== null && Number.isFinite(Number(totals.count))) {
    return list.length === Number(totals.count);
  }

  if (totals?.totalPayIn === 0 && totals?.totalPayOut === 0) {
    return list.length === 0;
  }

  return false;
}

async function createMasterImage(imageBuffer) {
  // One small normalized master buffer. Everything else is created and released sequentially.
  return sharp(imageBuffer)
    .rotate()
    .resize({
      width: 1500,
      withoutEnlargement: true
    })
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer();
}

async function makeCrop(masterBuffer, topRatio, heightRatio, mode = 'normal') {
  const meta = await sharp(masterBuffer).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;

  if (width < 80 || height < 80) return null;

  const top = Math.max(0, Math.min(height - 1, Math.floor(height * topRatio)));
  const cropHeight = Math.max(
    80,
    Math.min(height - top, Math.floor(height * heightRatio))
  );

  if (width < 80 || cropHeight < 80) return null;

  let pipeline = sharp(masterBuffer)
    .extract({ left: 0, top, width, height: cropHeight })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.0 });

  if (mode === 'threshold') {
    pipeline = pipeline.threshold(188);
  } else if (mode === 'contrast') {
    pipeline = pipeline.linear(1.35, -18);
  }

  return pipeline.jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

async function ocr(worker, buffer, psm = 6) {
  if (!buffer) return '';

  const meta = await sharp(buffer).metadata();
  if ((meta.width || 0) < 80 || (meta.height || 0) < 80) {
    console.warn(`OCR skipped tiny image ${meta.width || 0}x${meta.height || 0}`);
    return '';
  }

  await worker.setParameters({
    tessedit_pageseg_mode: String(psm),
    preserve_interword_spaces: '1'
  });

  const result = await worker.recognize(buffer);
  return result?.data?.text || '';
}

async function recognizeFullReceipt(imageBuffer, configuredReasons = []) {
  return runExclusive(async () => {
    const worker = await getWorker();
    let master = null;

    try {
      master = await createMasterImage(imageBuffer);

      // Pass 1: full receipt. Gives us Pay In/Out + often Branch/Cash immediately.
      console.log('Shift OCR: full receipt pass');
      const fullText = await ocr(worker, master, 6);

      let branchInfo = extractBranch(fullText);
      let drawerValues = extractCashDrawer(fullText);

      // Pass 2: only if Branch was not found.
      let branchText = '';
      if (!branchInfo.branch) {
        console.log('Shift OCR: branch recovery pass');
        let crop = await makeCrop(master, 0.00, 0.30, 'contrast');
        branchText = await ocr(worker, crop, 6);
        crop = null;
        branchInfo = extractBranch(branchText);
      }

      // Pass 3: only if Actual Ending Cash was not found.
      let cashText = '';
      if (drawerValues.actualEndingCash === null) {
        console.log('Shift OCR: cash drawer recovery pass');
        let crop = await makeCrop(master, 0.42, 0.46, 'contrast');
        cashText = await ocr(worker, crop, 6);
        crop = null;

        const recovered = extractCashDrawer(cashText);
        drawerValues = {
          startingCash: drawerValues.startingCash ?? recovered.startingCash,
          netCashInflow: drawerValues.netCashInflow ?? recovered.netCashInflow,
          expectedEndingCash: drawerValues.expectedEndingCash ?? recovered.expectedEndingCash,
          actualEndingCash: drawerValues.actualEndingCash ?? recovered.actualEndingCash,
          difference: drawerValues.difference ?? recovered.difference,
          mathMismatch: drawerValues.mathMismatch || recovered.mathMismatch || false
        };
      }

      const payInOutItems = extractPayInOutItems(fullText, configuredReasons);
      const payTotals = extractPayTotals(fullText);

      const actual = drawerValues.actualEndingCash;
      const validActual =
        actual !== null &&
        Number.isFinite(Number(actual)) &&
        Number(actual) >= 4000 &&
        Number(actual) <= 2000000;

      return {
        branch: branchInfo.branch,
        branchRaw: branchInfo.branchRaw,
        actualEndingCash: validActual ? Number(actual) : null,
        drawerValues,
        difference: drawerValues.difference,
        payInOutItems,
        payTotals,
        payComplete: paySectionComplete(payInOutItems, payTotals),
        debug: {
          fullText,
          branchText,
          cashText
        }
      };
    } finally {
      master = null;
    }
  });
}

async function recognizeField(imageBuffer, field, configuredReasons = []) {
  return runExclusive(async () => {
    const worker = await getWorker();
    let master = null;

    try {
      master = await createMasterImage(imageBuffer);

      let processed = master;
      if (field === 'branch') {
        processed = await makeCrop(master, 0.00, 1.00, 'contrast');
      } else if (field === 'cash') {
        processed = await makeCrop(master, 0.00, 1.00, 'contrast');
      } else if (field === 'pay') {
        processed = await makeCrop(master, 0.00, 1.00, 'contrast');
      }

      const text = await ocr(worker, processed, 6);
      processed = null;

      if (field === 'branch') {
        const info = extractBranch(text);
        return {
          success: Boolean(info.branch),
          branch: info.branch,
          branchRaw: info.branchRaw,
          text
        };
      }

      if (field === 'cash') {
        const values = extractCashDrawer(text);
        const actual = values.actualEndingCash;
        const success =
          actual !== null &&
          Number.isFinite(Number(actual)) &&
          Number(actual) >= 4000 &&
          Number(actual) <= 2000000;

        return {
          success,
          actualEndingCash: success ? Number(actual) : null,
          drawerValues: values,
          difference: values.difference,
          text
        };
      }

      if (field === 'pay') {
        const items = extractPayInOutItems(text, configuredReasons);
        const totals = extractPayTotals(text);
        return {
          success: paySectionComplete(items, totals),
          items,
          totals,
          text
        };
      }

      return { success: false, text };
    } finally {
      master = null;
    }
  });
}

function calculateBalance(actualEndingCash) {
  const actual = Math.round(Number(actualEndingCash) * 100) / 100;
  if (!Number.isFinite(actual) || actual < 4000 || actual > 2000000) return null;

  const thousandsToRemove = Math.floor((actual - 4000) / 1000) * 1000;
  const balance = Math.round((actual - thousandsToRemove) * 100) / 100;

  if (!(balance >= 4000 && balance < 5000) || balance > actual) return null;
  return balance;
}

function calculateBringAmount(actualEndingCash, balance) {
  return Math.round((Number(actualEndingCash) - Number(balance)) * 100) / 100;
}

function formatMoney(value) {
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(Number(value)) ? 0 : 2,
    maximumFractionDigits: 2
  });
}

function buildReply(result) {
  const balance = Number(result.balance);
  const actual = Number(result.actualEndingCash);

  if (!Number.isFinite(actual) || !Number.isFinite(balance)) {
    throw new Error('Cash instruction values are incomplete');
  }

  if (!(balance >= 4000 && balance < 5000) || balance > actual) {
    throw new Error(`Unsafe cash instruction: actual=${actual}, remove=${balance}`);
  }

  const bring = calculateBringAmount(actual, balance);
  return `${result.branch} - Rs. ${formatMoney(balance)} අයින් කරලා, ඉතිරි Rs. ${formatMoney(bring)} බාර දෙන්න.`;
}

async function downloadWhatsAppImage(mediaId) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v22.0';

  if (!accessToken) throw new Error('WHATSAPP_ACCESS_TOKEN is missing');
  if (!mediaId) throw new Error('WhatsApp image media id is missing');

  const metaResponse = await fetch(
    `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(mediaId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const metaBody = await metaResponse.json().catch(() => ({}));
  if (!metaResponse.ok || !metaBody.url) {
    throw new Error(`Could not fetch WhatsApp media URL: ${metaResponse.status}`);
  }

  const imageResponse = await fetch(metaBody.url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!imageResponse.ok) {
    throw new Error(`Could not download WhatsApp image: ${imageResponse.status}`);
  }

  const arrayBuffer = await imageResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (!buffer.length) throw new Error('Downloaded WhatsApp image is empty');
  if (buffer.length > 12 * 1024 * 1024) throw new Error('WhatsApp image is too large');

  return buffer;
}

module.exports = {
  downloadWhatsAppImage,
  recognizeFullReceipt,
  recognizeField,
  calculateBalance,
  calculateBringAmount,
  buildReply,
  formatMoney,
  extractPayInOutItems,
  extractPayTotals,
  paySectionComplete
};
