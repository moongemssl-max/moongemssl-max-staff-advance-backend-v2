PHASE 8 - DIFFERENCE + APP NAME

Backend:
- Difference is saved from the printed value when available.
- If printed Difference/Expected is missed, Difference is derived safely from:
  Actual Ending Cash - (Starting Cash + Net Cash Inflow).
- Existing receipt balance calculation and WhatsApp workflow are unchanged.

Android:
- App visible name changed to: New Imashi Staff
- Shift Cash History retains Difference display.

Backend files to replace in GitHub:
  services/shiftReceipt.js
  routes/webhook.js
  routes/dashboard.js

Android patch is under android/ in this zip.
