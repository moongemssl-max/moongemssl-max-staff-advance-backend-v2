PHASE 10 - DIFFERENCE ONLY SAFE FIX

Replace only:
  services/shiftReceipt.js

What changed:
- Difference is read from the printed "Difference" row independently in each OCR pass.
- Multiple OCR passes vote on the Difference value.
- It no longer calculates Difference from Expected Ending Cash, which could be OCR-misread.
- If Difference cannot be read reliably, it remains blank/null instead of saving a wrong value.

Everything else is unchanged.
