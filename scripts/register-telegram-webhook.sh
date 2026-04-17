#!/usr/bin/env bash
set -euo pipefail

# Register the Telegram webhook URL for the Pharos alert bot.
# Usage: TELEGRAM_BOT_TOKEN=xxx TELEGRAM_WEBHOOK_SECRET=yyy ./scripts/register-telegram-webhook.sh

command -v jq >/dev/null 2>&1 || {
  echo "Error: jq is required (brew install jq / apt install jq)" >&2
  exit 1
}

: "${TELEGRAM_BOT_TOKEN:?Error: TELEGRAM_BOT_TOKEN is required}"
: "${TELEGRAM_WEBHOOK_SECRET:?Error: TELEGRAM_WEBHOOK_SECRET is required}"

WEBHOOK_BASE_URL="${WEBHOOK_BASE_URL:-https://api.pharos.watch}"
WEBHOOK_URL="${WEBHOOK_BASE_URL}/api/telegram-webhook"

if [[ ! "${WEBHOOK_URL}" =~ ^https:// ]]; then
  echo "Error: WEBHOOK_URL must use https:// (got: ${WEBHOOK_URL})" >&2
  exit 1
fi

# Secret is passed only in the JSON body; URL is safe to log.
echo "Registering webhook: ${WEBHOOK_URL}"

# allowed_updates explicitly lists accepted update types so Telegram does not
# forward unrelated activity (chat_join_request, poll_answer, etc.). The bot
# uses message for commands and callback_query for inline-keyboard buttons.
PAYLOAD=$(jq -n \
  --arg url "${WEBHOOK_URL}" \
  --arg secret "${TELEGRAM_WEBHOOK_SECRET}" \
  '{url: $url, secret_token: $secret, allowed_updates: ["message", "callback_query"]}')

RESPONSE=$(curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}")

OK=$(echo "${RESPONSE}" | jq -r '.ok // false')
if [ "${OK}" = "true" ]; then
  DESC=$(echo "${RESPONSE}" | jq -r '.description // "registered"')
  echo "OK: ${DESC}"
else
  echo "Error: webhook registration failed." >&2
  echo "${RESPONSE}" | jq . >&2 || echo "${RESPONSE}" >&2
  exit 1
fi
