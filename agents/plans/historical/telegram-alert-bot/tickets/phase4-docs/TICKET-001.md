---
title: "Documentation updates and webhook registration script"
agent: "codex"
model: "gpt-5.3-codex"
reasoning_effort: "medium"
done: false
---

## Goal

Update all relevant documentation to reflect the new Telegram alert bot feature and create the webhook registration convenience script.

## Task

1. **Create `scripts/register-telegram-webhook.sh`**:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Register the Telegram webhook URL for the Pharos alert bot.
# Usage: TELEGRAM_BOT_TOKEN=xxx TELEGRAM_WEBHOOK_SECRET=yyy ./scripts/register-telegram-webhook.sh

if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN is required" >&2
  exit 1
fi
if [ -z "${TELEGRAM_WEBHOOK_SECRET:-}" ]; then
  echo "Error: TELEGRAM_WEBHOOK_SECRET is required" >&2
  exit 1
fi

WEBHOOK_URL="https://api.pharos.watch/api/telegram-webhook?secret=${TELEGRAM_WEBHOOK_SECRET}"

echo "Registering webhook: ${WEBHOOK_URL}"

RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"${WEBHOOK_URL}\"}")

echo "Response: ${RESPONSE}"

OK=$(echo "${RESPONSE}" | grep -o '"ok":true' || true)
if [ -n "${OK}" ]; then
  echo "Webhook registered successfully."
else
  echo "Error: Webhook registration failed." >&2
  exit 1
fi
```

Make the script executable: `chmod +x scripts/register-telegram-webhook.sh`

2. **`docs/architecture.md`** — Add to the appropriate sections:

   a. In the API endpoints table/list, add:
   ```
   POST /api/telegram-webhook — Telegram bot webhook (command handling, subscription management)
   ```

   b. In the database tables section, add:
   ```
   telegram_subscribers — Bot subscriber preferences (chat_id, alert type flags)
   telegram_subscriptions — Per-user coin subscriptions (chat_id, stablecoin_id)
   telegram_pending_disambiguation — Ephemeral mid-conversation state for ticker disambiguation
   ```

   c. In the cron jobs section, add:
   ```
   dispatch-telegram-alerts — Detects DEWS/depeg/safety changes and fans out alerts to subscribers (runs on */15 and 0 8 triggers)
   ```

3. **`docs/api-reference.md`** — Add a new endpoint section:

   ```markdown
   ### POST /api/telegram-webhook

   Telegram Bot API webhook endpoint. Receives user messages, processes bot commands, and manages subscriptions.

   **Authentication:** Secret query parameter (`?secret=...`), not the standard X-Admin-Key.

   **Rate limiting:** Exempt from IP rate limiter (Telegram sends from fixed IPs).

   **Cache:** no-store

   **Request body:** Telegram Update object (JSON, sent by Telegram servers).

   **Response:** Always 200 OK (Telegram retries on non-2xx).

   **Commands handled:**
   - `/start` — Welcome message
   - `/subscribe <types> <tickers>` — Subscribe to alerts (types: dews, depeg, safety)
   - `/unsubscribe <tickers>` — Remove coin subscriptions
   - `/unsubscribe all` — Remove all subscriptions
   - `/list` — Show current subscriptions
   - `/help` — Command reference
   ```

4. **`docs/worker-infrastructure.md`** — Add to relevant sections:

   a. In the cron job table, add `dispatch-telegram-alerts` to both the `*/15` and `0 8` rows.

   b. In the secrets/env section, add:
   ```
   TELEGRAM_WEBHOOK_SECRET — Random string for webhook URL validation (set via wrangler secret put)
   ```

   c. Add a brief "Telegram Alert Bot" section explaining:
   - Webhook receives commands, writes to D1
   - Dispatch cron diffs state against cached snapshots
   - Circuit breaker gates Telegram API calls
   - Max 50 messages per dispatch run

5. **`src/app/about/page.tsx`** — Add a mention of the Telegram alert bot in the appropriate section (features or integrations). Brief one-liner: "Telegram bot (@PharosWatcher) for per-coin alerts on DEWS state changes, depeg events, and safety grade changes."

6. **`docs/scripts.md`** — Add entry for the new script:
   ```
   scripts/register-telegram-webhook.sh — One-time Telegram webhook registration. Requires TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET env vars.
   ```

## Acceptance Criteria

- `scripts/register-telegram-webhook.sh` exists and is executable
- `grep -c 'telegram-webhook' docs/architecture.md` returns at least 1
- `grep -c 'telegram-webhook' docs/api-reference.md` returns at least 1
- `grep -c 'dispatch-telegram-alerts' docs/worker-infrastructure.md` returns at least 1
- `grep -c 'TELEGRAM_WEBHOOK_SECRET' docs/worker-infrastructure.md` returns at least 1
- `grep -c 'register-telegram-webhook' docs/scripts.md` returns at least 1
- `grep -ci 'telegram' src/app/about/page.tsx` returns at least 1
- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
