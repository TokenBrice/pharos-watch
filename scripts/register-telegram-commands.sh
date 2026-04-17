#!/usr/bin/env bash
set -euo pipefail

# Register the slash-command suggestions that Telegram clients show when a
# user types "/" in a chat with @PharosWatchBot. This is separate from the
# webhook's runtime switch — Telegram surfaces this list in the native UI via
# the Bot API's `setMyCommands` endpoint.
#
# Canonical source for the supported surface is HELP_MESSAGE in
# worker/src/api/telegram-webhook-shared.ts. If you add/rename a command in
# the webhook switch, update this list too and re-run this script.
#
# Usage: TELEGRAM_BOT_TOKEN=xxx ./scripts/register-telegram-commands.sh

command -v jq >/dev/null 2>&1 || {
  echo "Error: jq is required (brew install jq / apt install jq)" >&2
  exit 1
}

: "${TELEGRAM_BOT_TOKEN:?Error: TELEGRAM_BOT_TOKEN is required}"

# Telegram constraint: command names are lowercase a-z0-9_, 1–32 chars, no
# leading slash. Descriptions are 3–256 chars. Order here is the order shown
# to users; keep the most common actions near the top.
COMMANDS=$(jq -n '[
  { command: "start",       description: "Get started with Pharos alerts" },
  { command: "help",        description: "Command reference" },
  { command: "status",      description: "Current peg, DEWS, and safety for one coin (e.g. /status USDC)" },
  { command: "list",        description: "Show your current subscriptions and settings" },
  { command: "subscribe",   description: "Subscribe to alerts (e.g. /subscribe dews USDC)" },
  { command: "unsubscribe", description: "Remove coin subscriptions" },
  { command: "presets",     description: "Browse preset watchlists like usd-top25" },
  { command: "set",         description: "Tune per-coin thresholds (e.g. /set USDT dews WARNING)" },
  { command: "mute",        description: "Enable quiet hours in UTC (e.g. /mute 22-07)" },
  { command: "unmutehours", description: "Disable quiet hours" },
  { command: "cancel",      description: "Cancel a pending ticker selection" }
]')

echo "Registering ${TELEGRAM_BOT_TOKEN:+bot} command suggestions..."

PAYLOAD=$(jq -n --argjson commands "${COMMANDS}" '{commands: $commands}')

RESPONSE=$(curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}")

OK=$(echo "${RESPONSE}" | jq -r '.ok // false')
if [ "${OK}" = "true" ]; then
  echo "OK: ${#COMMANDS} commands registered (verify in any chat with the bot by typing /)."
  echo "${COMMANDS}" | jq -r '.[] | "  /\(.command) — \(.description)"'
else
  echo "Error: setMyCommands failed." >&2
  echo "${RESPONSE}" | jq . >&2 || echo "${RESPONSE}" >&2
  exit 1
fi
