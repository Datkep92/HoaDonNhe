# Cloudflare Workers Free Gateway

This is the no-billing deployment target for the support Gateway. Create a Worker from the Cloudflare dashboard, paste `src/index.js`, and set the non-secret variables from `wrangler.jsonc`.

Add these as **Secrets**, never as plain variables:

- `GAS_SHARED_SECRET`
- `TOKEN_SECRET`
- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`

After deployment, use the Worker URL as `url` in `release/du_lieu/support-gateway.json`. Register Telegram webhook at `https://<worker>/v1/telegram/webhook` with `TELEGRAM_WEBHOOK_SECRET`.

## Deploy without the dashboard (API)

`deploy.mjs` uploads `src/index.js` as an ES module through the Cloudflare API (no wrangler, no browser).
The token needs one permission only: **Account → Workers Scripts → Edit** (give it a 1-day expiry and revoke it afterwards).

```powershell
cd cloudflare-worker
$env:CLOUDFLARE_API_TOKEN = (Get-Content "$env:TEMP\cf-token.txt" -Raw).Trim()   # or paste the token here
$env:GAS_URL = 'https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec'
$env:FIREBASE_DATABASE_URL = 'https://<PROJECT>-default-rtdb.firebaseio.com'
$env:TELEGRAM_CHAT_ID = '-1001234567890'
node deploy.mjs
```

Optional: set `GAS_SHARED_SECRET`, `TOKEN_SECRET`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET` as environment variables and the same script pushes them as secrets too; otherwise
add them by hand in **Settings → Variables and Secrets**. Variables left unset are simply skipped, so the
script is safe to run before Google Apps Script or Firebase are ready.

If the token cannot list accounts, set `CLOUDFLARE_ACCOUNT_ID` (the `…` id in your dashboard URL) as well.

The script finishes by calling `<worker>/healthz`, which must answer `{"ok":true}`.

Verify the wiring without touching spreadsheet data: `POST /v1/licenses/status` with a made-up
`installationId` (UUID) and `chatRoomId` (`ROOM_WIN_…`) is read-only and must answer
`{"ok":true,"value":{"status":"Unactivated"}}`. Do **not** use `/v1/devices/register` for testing — it appends
a row to the `Devices` sheet.
