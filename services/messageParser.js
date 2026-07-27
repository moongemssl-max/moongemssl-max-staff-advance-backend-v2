'use strict';

function parseAdvanceMessage(text) {
  if (typeof text !== 'string') {
    return {
      amount: null,
      isAdvanceRequest: false
    };
  }

  const normalized = text.trim();
  const match = normalized.match(
    /(?:rs\.?|lkr)?\s*(\d[\d,]*(?:\.\d{1,2})?)/i
  );

  if (!match) {
    return {
      amount: null,
      isAdvanceRequest: false
    };
  }

  const amount = Number(match[1].replace(/,/g, ''));

  return {
    amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    isAdvanceRequest: Number.isFinite(amount) && amount > 0
  };
}

module.exports = parseAdvanceMessage;
