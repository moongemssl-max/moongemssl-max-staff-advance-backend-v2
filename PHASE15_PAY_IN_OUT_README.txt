PHASE 15 - PAY IN / OUT REASON OCR + BRANCH MONTHLY SUMMARY

Backend changes:
- Reads configured Pay In/Out reason rows from Shift Summary OCR.
- Saves each matched item as reason + amount + IN/OUT inside shift_cash_history.
- MAIN and GETAHETTA remain separate.
- Adds GET/PUT /api/pay-in-out-reasons.
- Adds GET /api/pay-in-out-summary?month=YYYY-MM.
- Initial reasons: Hadunkuru, Poltel, Petrol, Adu, Wedi, Battry, Bill Payment,
  Rusiru Advance, Prasanna Advance, Nandasena Advance.
- Poltel and Petrol are intentionally separate; ambiguous fuzzy OCR is rejected instead of guessed.
- Existing cash calculation / reply / Difference logic is unchanged.

Deploy patch files:
services/shiftReceipt.js
routes/webhook.js
routes/dashboard.js
