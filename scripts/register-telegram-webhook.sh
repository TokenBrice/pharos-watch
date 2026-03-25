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

WEBHOOK_BASE_URL="${WEBHOOK_BASE_URL:-https://api.pharos.watch}"
WEBHOOK_URL="${WEBHOOK_BASE_URL}/api/telegram-webhook"
REDACTED_WEBHOOK_URL="${WEBHOOK_BASE_URL}/api/telegram-webhook"

echo "Registering webhook: ${REDACTED_WEBHOOK_URL}"

RESPONSE=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"${WEBHOOK_URL}\", \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET}\"}")

echo "Response: ${RESPONSE}"

OK=$(echo "${RESPONSE}" | grep -o '"ok":true' || true)
if [ -n "${OK}" ]; then
  echo "Webhook registered successfully."
else
  echo "Error: Webhook registration failed." >&2
  exit 1
fi
