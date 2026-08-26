Phase 11 - Actual Ending Cash OCR safety fix only

Replace only:
  services/shiftReceipt.js

Fix:
- Rejects/recover implausibly concatenated OCR values such as 65,940,005.
- For that example it recovers 65,940 before the existing cash calculation runs.
- Existing branch, Difference, WhatsApp reply, history and normal cash calculation logic are unchanged.
