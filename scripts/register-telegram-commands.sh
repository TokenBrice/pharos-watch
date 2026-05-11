#!/usr/bin/env bash
set -euo pipefail

# Register the slash-command suggestions that Telegram clients show when a
# user types "/" in a chat with @PharosWatchBot. This is separate from the
# webhook's runtime switch — Telegram surfaces this list in the native UI via
# the Bot API's `setMyCommands` endpoint.
#
# Canonical source for the supported surface is
# worker/src/lib/telegram-webhook-registration.ts. Normal deploys reconcile
# these automatically; this script is a manual recovery tool when an operator
# needs to force Bot API state.
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
PRIVATE_COMMANDS=$(jq -n '[
  { command: "start",       description: "Get started with Pharos alerts" },
  { command: "help",        description: "Command reference" },
  { command: "status",      description: "Current peg, DEWS, and safety for one coin (e.g. /status USDC)" },
  { command: "brief",       description: "Latest Pharos market brief" },
  { command: "top",         description: "Rank current views: depeg, dews, yield, liquidity, chains, safety" },
  { command: "why",         description: "Explain one coin Safety Score (e.g. /why USDC)" },
  { command: "coverage",    description: "Show which Pharos data surfaces cover one coin" },
  { command: "list",        description: "Show your current subscriptions and settings" },
  { command: "subscribe",   description: "Subscribe to alerts (e.g. /subscribe usd-top-50 depeg-step 250)" },
  { command: "unsubscribe", description: "Remove coin subscriptions" },
  { command: "presets",     description: "Browse preset watchlists like usd-top25 / usd-top-25" },
  { command: "set",         description: "Tune per-coin or global thresholds (e.g. /set all depeg-step 250)" },
  { command: "settings",    description: "Open the inline settings keyboard (e.g. /settings or /settings USDC)" },
  { command: "mute",        description: "Enable quiet hours (e.g. /mute 22-07; uses your /timezone)" },
  { command: "timezone",    description: "Set chat timezone for quiet hours (e.g. /timezone Europe/Paris)" },
  { command: "unsnooze",    description: "Clear active alert snooze" },
  { command: "unmutehours", description: "Disable quiet hours" },
  { command: "cancel",      description: "Cancel a pending ticker selection" }
]')

GROUP_COMMANDS=$(jq -n '[
  { command: "subscribe",   description: "Subscribe to alerts (e.g. /subscribe usd-top-50 depeg-step 250)" },
  { command: "unsubscribe", description: "Remove coin subscriptions" },
  { command: "list",        description: "Show your current subscriptions and settings" },
  { command: "status",      description: "Current peg, DEWS, and safety for one coin (e.g. /status USDC)" },
  { command: "mute",        description: "Enable quiet hours in UTC (e.g. /mute 22-07)" },
  { command: "help",        description: "Command reference" }
]')

call_set_my_commands() {
  local label="$1"
  local commands="$2"
  local scope="$3"
  local payload
  payload=$(jq -n --argjson commands "${commands}" --argjson scope "${scope}" '{commands: $commands, scope: $scope}')

  local response
  response=$(curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands" \
    -H "Content-Type: application/json" \
    -d "${payload}")

  local ok
  ok=$(echo "${response}" | jq -r '.ok // false')
  if [ "${ok}" = "true" ]; then
    echo "OK: ${label} commands registered."
    echo "${commands}" | jq -r '.[] | "  /\(.command) — \(.description)"'
  else
    echo "Error: setMyCommands failed for ${label}." >&2
    echo "${response}" | jq . >&2 || echo "${response}" >&2
    exit 1
  fi
}

echo "Registering ${TELEGRAM_BOT_TOKEN:+bot} command suggestions..."
call_set_my_commands "private chat" "${PRIVATE_COMMANDS}" '{"type":"all_private_chats"}'
call_set_my_commands "group chat" "${GROUP_COMMANDS}" '{"type":"all_group_chats"}'
