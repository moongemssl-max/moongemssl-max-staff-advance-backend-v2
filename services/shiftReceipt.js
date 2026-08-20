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

function levenshtein(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const rows = right.length + 1;
  const cols = left.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let row = 0; row < rows; row += 1) matrix[row][0] = row;
  for (let col = 0; col < cols; col += 1) matrix[0][col] = col;

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = right[row - 1] === left[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost
      );
    }
  }

  return matrix[rows - 1][cols - 1];
}

function compactLetters(value) {
  return similarityText(value)
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w');
}

function fuzzyContains(value, target, maxDistance = 2) {
  const text = compactLetters(value);
  const needle = compactLetters(target);
  if (!text || !needle) return false;
  if (text.includes(needle)) return true;

  const minWindow = Math.max(3, needle.length - maxDistance);
  const maxWindow = needle.length + maxDistance;
  for (let size = minWindow; size <= maxWindow; size += 1) {
    for (let index = 0; index + size <= text.length; index += 1) {
      if (levenshtein(text.slice(index, index + size), needle) <= maxDistance) return true;
    }
  }

  return false;
}

function detectKnownBranch(value) {
  const text = String(value || '');
  const compact = compactLetters(text);

  // Known printed names / common OCR variations for the two shops.
  const getahettaAliases = [
    'getahetta', 'getahetta', 'getahatta', 'gettahetta', 'getaheta',
    'getaherta', 'getaherta', 'getahetra', 'getahetta'
  ];
  if (getahettaAliases.some((alias) => compact.includes(alias)) || fuzzyContains(text, 'getahetta', 3)) {
    return 'GETAHETTA';
  }

  // "Main Branch" is short and OCR normally reads at least one of these words.
  if (compact.includes('mainbranch') || compact.includes('main') || fuzzyContains(text, 'main', 1)) {
    return 'MAIN';
  }

  return null;
}

function extractBranch(lines) {
  // 1) Prefer a line explicitly labelled Branch, allowing OCR errors such as "Braneh" / "Brancn".
  for (const rawLine of lines) {
    const line = normalizeLine(rawLine);
    const compact = compactLetters(line);
    const hasBranchLabel = compact.includes('branch') || fuzzyContains(line, 'branch', 2);
    if (!hasBranchLabel) continue;

    const known = detectKnownBranch(line);
    if (known) return { branch: known, branchRaw: line };

    const match = line.match(/br[a-z0-9]{2,8}\s*[:\-]?\s*(.+)$/i);
    if (match?.[1]) {
      const branchRaw = match[1].trim();
      const mapped = detectKnownBranch(branchRaw);
      if (mapped) return { branch: mapped, branchRaw };
    }
  }

  // 2) The top crop contains little else, so accept a known branch name even when "Branch:" was lost.
  for (const rawLine of lines.slice(0, Math.min(lines.length, 24))) {
    const known = detectKnownBranch(rawLine);
    if (known) return { branch: known, branchRaw: normalizeLine(rawLine) };
  }

  // 3) Last fallback: search all OCR text for the long/unique Getahetta name. For MAIN we remain
  // conservative to avoid matching unrelated words elsewhere on the receipt.
  const whole = lines.join(' ');
  if (fuzzyContains(whole, 'getahetta', 3)) return { branch: 'GETAHETTA', branchRaw: 'Getahetta' };

  return { branch: null, branchRaw: null };
}

function lineHasFuzzyWords(line, words, maxDistance = 2) {
  return words.every((word) => fuzzyContains(line, word, maxDistance));
}

function findNearbyMoney(lines, index, maxDistance = 2) {
  // Prefer the labelled line itself. Thermal-printer OCR sometimes puts the amount
  // on a separate adjacent line, so also inspect a small neighbourhood.
  const direct = extractLastMoney(lines[index]);
  if (direct !== null) return direct;

  for (let distance = 1; distance <= maxDistance; distance += 1) {
    for (const neighbour of [index + distance, index - distance]) {
      if (neighbour < 0 || neighbour >= lines.length) continue;
      const candidateLine = normalizeLine(lines[neighbour]);
      if (!candidateLine) continue;

      // Do not steal a value from the next labelled drawer row.
      const normalized = similarityText(candidateLine);
      const looksLikeAnotherLabel = [
        'startingcash', 'netcashinflow', 'expectedendingcash',
        'actualendingcash', 'difference'
      ].some((label) => normalized.includes(label));
      if (looksLikeAnotherLabel) continue;

      const amount = extractLastMoney(candidateLine);
      if (amount !== null) return amount;
    }
  }

  return null;
}

function findDrawerValues(lines) {
  const values = {
    startingCash: null,
    netCashInflow: null,
    expectedEndingCash: null,
    actualEndingCash: null,
    difference: null
  };

  const normalizedLines = lines.map((line) => normalizeLine(line)).filter(Boolean);

  for (let index = 0; index < normalizedLines.length; index += 1) {
    const line = normalizedLines[index];
    const compact = similarityText(line);

    const isStarting = looksLike(line, ['starting', 'cash']) ||
      lineHasFuzzyWords(line, ['starting', 'cash'], 2);
    const isNetInflow = looksLike(line, ['net', 'cash', 'inflow']) ||
      lineHasFuzzyWords(line, ['net', 'cash', 'inflow'], 2);
    const isExpected = looksLike(line, ['expected', 'ending', 'cash']) ||
      lineHasFuzzyWords(line, ['expected', 'ending', 'cash'], 2);
    const isActual = looksLike(line, ['actual', 'ending', 'cash']) ||
      lineHasFuzzyWords(line, ['actual', 'ending', 'cash'], 2) ||
      (fuzzyContains(line, 'actual', 2) && fuzzyContains(line, 'ending', 2));
    const isDifference = compact.includes('difference') || fuzzyContains(line, 'difference', 3);

    if (isStarting && values.startingCash === null) {
      values.startingCash = findNearbyMoney(normalizedLines, index, 2);
    } else if (isNetInflow && values.netCashInflow === null) {
      values.netCashInflow = findNearbyMoney(normalizedLines, index, 2);
    } else if (isExpected && values.expectedEndingCash === null) {
      values.expectedEndingCash = findNearbyMoney(normalizedLines, index, 2);
    } else if (isActual && values.actualEndingCash === null) {
      values.actualEndingCash = findNearbyMoney(normalizedLines, index, 2);
    } else if (isDifference && values.difference === null) {
      values.difference = findNearbyMoney(normalizedLines, index, 2);
    }
  }

  // Fallback for receipts where OCR loses most labels but keeps the Cash Drawer block
  // as five sequential monetary rows. Find the Cash Drawer heading and inspect the next
  // few lines, assigning only when the sequence is strongly plausible.
  const drawerIndex = normalizedLines.findIndex((line) =>
    looksLike(line, ['cash', 'drawer']) || lineHasFuzzyWords(line, ['cash', 'drawer'], 2)
  );

  if (drawerIndex >= 0) {
    const nearby = [];
    for (let i = drawerIndex + 1; i < Math.min(normalizedLines.length, drawerIndex + 14); i += 1) {
      const amount = extractLastMoney(normalizedLines[i]);
      if (amount !== null) nearby.push({ index: i, amount });
    }

    // Typical order: Starting, Net inflow, Expected, Actual, Difference.
    if (nearby.length >= 5) {
      const seq = nearby.slice(0, 5).map((item) => item.amount);
      const [starting, inflow, expected, actual, difference] = seq;
      const expectedMath = starting + inflow;
      const actualMath = expected + difference;
      if (
        starting >= 0 && starting < 20000 && inflow >= 0 &&
        expected >= 4000 && actual >= 4000 && Math.abs(expectedMath - expected) <= 5 &&
        Math.abs(actualMath - actual) <= 5
      ) {
        if (values.startingCash === null) values.startingCash = starting;
        if (values.netCashInflow === null) values.netCashInflow = inflow;
        if (values.expectedEndingCash === null) values.expectedEndingCash = expected;
        if (values.actualEndingCash === null) values.actualEndingCash = actual;
        if (values.difference === null) values.difference = difference;
      }
    }
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
  const metadata = await sharp(imageBuffer).rotate().metadata();
  const width = metadata.width || 1200;
  const height = metadata.height || 1600;

  const upscaleWidth = Math.min(Math.max(Math.round(width * 2.5), 1800), 3000);
  const base = (input) => input
    .rotate()
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.4 })
    .resize({ width: upscaleWidth, withoutEnlargement: false });

  // Top 22% is where "Branch:" is printed on these Shift Summary receipts.
  const topHeight = Math.max(1, Math.floor(height * 0.22));
  const topSource = () => sharp(imageBuffer).rotate().extract({ left: 0, top: 0, width, height: topHeight });

  const topNormal = await base(topSource()).png().toBuffer();
  const topHighContrast = await base(topSource()).linear(1.55, -35).png().toBuffer();
  const topThreshold = await base(topSource()).threshold(178).png().toBuffer();
  const topThresholdLight = await base(topSource()).threshold(205).png().toBuffer();

  // Cash Drawer position varies with receipt length (refund/credit sections add height),
  // so OCR several overlapping middle/lower crops instead of relying on one fixed crop.
  const drawerCrops = [
    [0.42, 0.46],
    [0.50, 0.42],
    [0.58, 0.34]
  ];
  const drawerVariants = [];
  for (const [topRatio, heightRatio] of drawerCrops) {
    const cropTop = Math.max(0, Math.floor(height * topRatio));
    const cropHeight = Math.max(1, Math.min(height - cropTop, Math.floor(height * heightRatio)));
    const crop = () => sharp(imageBuffer).rotate().extract({ left: 0, top: cropTop, width, height: cropHeight });
    drawerVariants.push(await base(crop()).png().toBuffer());
    drawerVariants.push(await base(crop()).linear(1.5, -30).png().toBuffer());
    drawerVariants.push(await base(crop()).threshold(185).png().toBuffer());
  }

  const full = await base(sharp(imageBuffer)).png().toBuffer();
  const fullThreshold = await base(sharp(imageBuffer)).threshold(188).png().toBuffer();

  return {
    branch: [topNormal, topHighContrast, topThreshold, topThresholdLight],
    drawer: drawerVariants,
    full: [full, fullThreshold]
  };
}

async function recognizeVariants(worker, variants, pageSegMode) {
  await worker.setParameters({
    tessedit_pageseg_mode: String(pageSegMode),
    preserve_interword_spaces: '1'
  });

  const texts = [];
  for (const variant of variants) {
    const result = await worker.recognize(variant);
    texts.push(result?.data?.text || '');
  }
  return texts;
}

async function recognizeReceipt(imageBuffer) {
  const worker = await createWorker('eng');
  try {
    const variants = await buildOcrVariants(imageBuffer);

    // PSM 6 works much better for the small, single receipt block at the top/drawer.
    const branchTexts = await recognizeVariants(worker, variants.branch, 6);
    const drawerTexts = await recognizeVariants(worker, variants.drawer, 6);
    // PSM 3 is kept as a general fallback for the whole receipt.
    const fullTexts = await recognizeVariants(worker, variants.full, 3);

    const branchText = branchTexts.join('\n');
    const drawerText = drawerTexts.join('\n');
    const fullText = fullTexts.join('\n');
    const combinedText = [branchText, drawerText, fullText].join('\n');

    const branchLines = branchText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const allLines = combinedText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    // Branch is resolved from the dedicated top crop first, then all OCR text as fallback.
    let branchInfo = extractBranch(branchLines);
    if (!branchInfo.branch) branchInfo = extractBranch(allLines);

    const drawerValues = findDrawerValues(allLines);
    const chosen = chooseActualEndingCash(drawerValues);

    if (!branchInfo.branch) {
      return {
        success: false,
        reason: 'branch_not_found',
        text: combinedText,
        branchOcrPreview: branchLines.slice(0, 12).join(' | ')
      };
    }

    if (chosen.amount === null) {
      return {
        success: false,
        reason: 'actual_ending_cash_not_found',
        branch: branchInfo.branch,
        drawerValues,
        drawerOcrPreview: drawerText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 30).join(' | '),
        text: combinedText
      };
    }

    const balance = calculateBalance(chosen.amount);
    if (!(balance >= 4000 && balance < 5000)) {
      return {
        success: false,
        reason: 'balance_out_of_range',
        branch: branchInfo.branch,
        actualEndingCash: chosen.amount,
        text: combinedText
      };
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

function calculateBringAmount(actualEndingCash, balance) {
  return Math.round((Number(actualEndingCash) - Number(balance)) * 100) / 100;
}

function buildReply(result) {
  const bringAmount = calculateBringAmount(result.actualEndingCash, result.balance);
  return `${result.branch} - Rs. ${formatMoney(result.balance)} අයින් කරලා, ඉතිරි Rs. ${formatMoney(bringAmount)} රැගෙන එන්න.`;
}

module.exports = {
  downloadWhatsAppImage,
  recognizeReceipt,
  calculateBalance,
  calculateBringAmount,
  buildReply,
  formatMoney
};
