# Staff Advance Backend 2.0

Clean backend structure for the Staff Advance Android app.

## API routes

- `GET /`
- `GET /health`
- `POST /api/login`
- `GET /api/requests`
- `PATCH /api/requests/:id/status`
- `GET /webhook`
- `POST /webhook`

## Android login

The Android app should use:

```kotlin
private const val BASE_URL =
    "https://staff-advance-backend.onrender.com/"
```

```kotlin
@POST("api/login")
```

Default development login:

- Username: `admin`
- Password: `1234`

Set secure values through Render environment variables before production use.

## Deploy to GitHub and Render

1. Delete the old duplicated backend files from the GitHub repository.
2. Upload all files and folders from this project.
3. Commit the changes to the `main` branch.
4. In Render, use:
   - Build command: `npm install`
   - Start command: `npm start`
5. Add the environment variables from `.env.example`.
6. Deploy the latest commit.

## Test login in Windows Command Prompt

```cmd
curl -X POST "https://staff-advance-backend.onrender.com/api/login" ^
-H "Content-Type: application/json" ^
-d "{\"username\":\"admin\",\"password\":\"1234\"}"
```

Expected response:

```json
{"success":true,"token":"staffadvance2026"}
```

## Automatic WhatsApp reply after Approve / Reject

The endpoint `PATCH /api/requests/:id/status` now sends a WhatsApp text reply to the original employee number and stores the send result in Firestore.

Required Render environment variables:

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_API_VERSION` (optional, defaults to `v22.0`)

The incoming employee phone number is read from the WhatsApp webhook and saved as `senderNumber`.

## WhatsApp Shift Summary photo auto-reply (v3.2.0)

When an employee sends an image to the same WhatsApp Business number, the webhook now:

1. Downloads the WhatsApp image.
2. Reads the receipt using local OCR (Tesseract.js).
3. Reads the `Branch:` line and maps `Getahetta` -> `GETAHETTA`, `Main` -> `MAIN`.
4. Reads `Actual Ending Cash` (and cross-checks the other Cash Drawer values when possible).
5. Calculates the remaining amount in the Rs. 4,000-4,999.99 range.
6. Replies in the same chat, for example: `GETAHETTA - Rs. 4,920 අයින් කරන්න`.
7. If branch/cash cannot be read safely, replies: `Photo එක පැහැදිලිව නැවත එවන්න.`

Existing text-based advance-request handling remains unchanged.

OCR packages are installed by the normal Render build command (`npm install`). The first OCR run after a fresh deploy can be slower because the English OCR model may need to be loaded.
