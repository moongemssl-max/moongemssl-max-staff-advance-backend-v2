PHASE 9 - DIFFERENCE ONLY FIX

Only services/shiftReceipt.js is changed.

Change:
- Restores the previously working Phase 7 Difference calculation behavior.
- If Expected Ending Cash is available: Difference = Actual Ending Cash - Expected Ending Cash.
- Otherwise, use the Difference value read from the receipt.

Not changed:
- Branch detection
- Actual Ending Cash calculation
- Balance calculation
- WhatsApp reply wording
- Shift Cash save/history logic
- Android app name or UI
