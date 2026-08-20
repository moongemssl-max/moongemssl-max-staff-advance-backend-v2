'use strict';

const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

function normalizeNumberToken(value) {
  return String(value || '')
    .replace(/[Oo]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/S/g, '5')
    .replace(/B/g, '8')
    .replace(/,/g, '')
    .replace(/[^0-9.\-]/g, '');
}

function parseMoney(value) {
  const cleaned = normalizeNumberToken(value);
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLine(line) {
  return String(line || '')
    .replace(/[^a-zA-Z0-9:.,\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarityText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/[^a-z]/g, '');
}

function looksLike(line, words) {
  const normalized = similarityText(line);
  return words.every((word) => normalized.includes(word));
}

function extractLastMoney(line) {
  const matches = String(line || '').match(/-?[$S]?\s*[0-9OoIl|BS][0-9OoIl|BS,.*\s-]*(?:[.,][0-9OoIl|BS]{1,2})?/g);
  if (!matches?.length) return null;

  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const value = parseMoney(matches[index].replace(/\s+/g, ''));
    if (value !== null) return value;
  }

  return null;
}

function extractBranch(lines) {
  for (const rawLine of lines) {
    const line = normalizeLine(rawLine);
    const match = line.match(/branch\s*[:\-]?\s*(.+)$/i);
    if (match?.[1]) {
      const branchRaw = match[1].trim();
      const lower = branchRaw.toLowerCase();
      if (lower.includes('getahetta')) return { branch: 'GETAHETTA', branchRaw };
      if (lower.includes('main')) return { branch: 'MAIN', branchRaw };
      return { branch: branchRaw.toUpperCase(), branchRaw };
    }
  }

  const whole = lines.join(' ').toLowerCase();
  if (whole.includes('getahetta')) return { branch: 'GETAHETTA', branchRaw: 'Getahetta' };
  if (whole.includes('main')) return { branch: 'MAIN', branchRaw: 'Main' };
  return { branch: null, branchRaw: null };
}

function findDrawerValues(lines) {
  const values = {
    startingCash: null,
    netCashInflow: null,
    expectedEndingCash: null,
    actualEndingCash: null,
    difference: null
  };

  for (const rawLine of lines) {
    const line = normalizeLine(rawLine);
    const amount = extractLastMoney(line);
    if (amount === null) continue;

    if (looksLike(line, ['starting', 'cash'])) values.startingCash = amount;
    else if (looksLike(line, ['net', 'cash', 'inflow'])) values.netCashInflow = amount;
    else if (looksLike(line, ['expected', 'ending', 'cash'])) values.expectedEndingCash = amount;
    else if (looksLike(line, ['actual', 'ending', 'cash'])) values.actualEndingCash = amount;
    else if (similarityText(line).includes('difference')) values.difference = amount;
  }

  return values;
}

function chooseActualEndingCash(values) {
  const direct = values.actualEndingCash;
  const candidates = [];

  if (direct !== null && direct >= 4000) candidates.push({ value: direct, source: 'actual_ending_cash' });

  if (values.expectedEndingCash !== null && values.difference !== null) {
    candidates.push({
      value: values.expectedEndingCash + values.difference,
      source: 'expected_plus_difference'
    });
  }

  if (values.startingCash !== null && values.netCashInflow !== null) {
    const expected = values.startingCash + values.netCashInflow;
    if (values.difference !== null) {
      candidates.push({ value: expected + values.difference, source: 'drawer_equation' });
    }
  }

  const valid = candidates.filter((item) => Number.isFinite(item.value) && item.value >= 4000);
  if (!valid.length) return { amount: null, source: null };

  // Prefer a direct OCR read when it agrees closely with a derived value.
  if (direct !== null) {
    const agreement = valid.find(
      (item) => item.source !== 'actual_ending_cash' && Math.abs(item.value - direct) <= 1
    );
    if (agreement) return { amount: direct, source: 'confirmed_actual_ending_cash' };
  }

  // If two derived candidates agree, use them even when the direct OCR line was bad.
  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      if (Math.abs(valid[i].value - valid[j].value) <= 1) {
        return { amount: valid[i].value, source: 'confirmed_by_drawer_math' };
      }
    }
  }

  // A clearly labelled direct line is still acceptable, but reject tiny values caused by dropped leading digits.
  if (direct !== null && direct >= 10000) {
    return { amount: direct, source: 'actual_ending_cash_unconfirmed' };
  }

  return { amount: null, source: null };
}

function calculateBalance(actualEndingCash) {
  const centsRounded = Math.round(Number(actualEndingCash) * 100) / 100;
  const thousandsToRemove = Math.floor((centsRounded - 4000) / 1000) * 1000;
  const balance = Math.round((centsRounded - thousandsToRemove) * 100) / 100;
  return balance;
}

function formatMoney(value) {
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2
  });
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

async function buildOcrVariants(imageBuffer) {
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 1200;
  const height = metadata.height || 1600;

  const common = (input) => input
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.2 })
    .resize({ width: Math.min(Math.max(width * 2, 1600), 2600), withoutEnlargement: false });

  const full = await common(sharp(imageBuffer)).png().toBuffer();

  const topHeight = Math.max(1, Math.floor(height * 0.28));
  const top = await common(
    sharp(imageBuffer).extract({ left: 0, top: 0, width, height: topHeight })
  ).png().toBuffer();

  const drawerTop = Math.max(0, Math.floor(height * 0.38));
  const drawerHeight = Math.max(1, Math.min(height - drawerTop, Math.floor(height * 0.48)));
  const drawer = await common(
    sharp(imageBuffer).extract({ left: 0, top: drawerTop, width, height: drawerHeight })
  ).png().toBuffer();

  return [top, drawer, full];
}

async function recognizeReceipt(imageBuffer) {
  const worker = await createWorker('eng');
  try {
    const variants = await buildOcrVariants(imageBuffer);
    const texts = [];

    for (const variant of variants) {
      const result = await worker.recognize(variant);
      texts.push(result?.data?.text || '');
    }

    const combinedText = texts.join('\n');
    const lines = combinedText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const branchInfo = extractBranch(lines);
    const drawerValues = findDrawerValues(lines);
    const chosen = chooseActualEndingCash(drawerValues);

    if (!branchInfo.branch) {
      return { success: false, reason: 'branch_not_found', text: combinedText };
    }

    if (chosen.amount === null) {
      return { success: false, reason: 'actual_ending_cash_not_found', branch: branchInfo.branch, text: combinedText };
    }

    const balance = calculateBalance(chosen.amount);
    if (!(balance >= 4000 && balance < 5000)) {
      return { success: false, reason: 'balance_out_of_range', branch: branchInfo.branch, actualEndingCash: chosen.amount, text: combinedText };
    }

    return {
      success: true,
      branch: branchInfo.branch,
      branchRaw: branchInfo.branchRaw,
      actualEndingCash: chosen.amount,
      balance,
      amountSource: chosen.source,
      drawerValues,
      text: combinedText
    };
  } finally {
    await worker.terminate();
  }
}

function buildReply(result) {
  return `${result.branch} - Rs. ${formatMoney(result.balance)} අයින් කරන්න`;
}

module.exports = {
  downloadWhatsAppImage,
  recognizeReceipt,
  calculateBalance,
  buildReply,
  formatMoney
};
