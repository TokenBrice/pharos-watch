#!/usr/bin/env bash
set -euo pipefail

# Register the Pharos Watch bot's profile metadata: name (display name on the
# chat header), short description (shown on the bot card before /start), and
# long description (shown on the bot's About page). Canonical source lives in
# worker/src/lib/telegram-webhook-registration.ts and the Worker reconciles
# these on a 15-minute cache cadence; this script is a manual recovery tool
# when an operator needs to force Bot API state.
#
# Profile photo: the Bot API does not expose a method for a bot to update its
# own avatar. The script attempts the call best-effort so the request is at
# least visible if Telegram ever ships one; if it fails, set the photo via
# @BotFather (/setuserpic) using public/pharos-icon.png.
#
# Usage: TELEGRAM_BOT_TOKEN=xxx ./scripts/register-telegram-profile.sh

command -v jq >/dev/null 2>&1 || {
  echo "Error: jq is required (brew install jq / apt install jq)" >&2
  exit 1
}

: "${TELEGRAM_BOT_TOKEN:?Error: TELEGRAM_BOT_TOKEN is required}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PHOTO_PATH="${REPO_ROOT}/public/pharos-icon.png"

BOT_NAME="Pharos Watch"
BOT_SHORT_DESCRIPTION="Stablecoin alerts: DEWS stress, depeg events, safety grade changes, and launches. Track 305+ coins."
BOT_DESCRIPTION="Pharos Watch tracks 305+ stablecoins and pushes alerts when something matters: DEWS stress bands, depeg events, safety grade changes, and new launches. Subscribe to curated presets like usd-top25, or build a custom watchlist of any tracked coin. Learn more at https://pharos.watch/pharoswatchbot/"

call_telegram() {
  local method="$1"
  local payload="$2"
  local response
  response=$(curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}" \
    -H "Content-Type: application/json" \
    -d "${payload}")
  local ok
  ok=$(echo "${response}" | jq -r '.ok // false')
  local description
  description=$(echo "${response}" | jq -r '.description // ""')
  if [ "${ok}" = "true" ]; then
    echo "OK: ${method}"
  elif echo "${description}" | grep -qi "is not modified"; then
    # Telegram returns 400 when the submitted value equals the current value.
    # Documented idempotent success path; treat it as OK.
    echo "OK: ${method} (unchanged)"
  else
    echo "Error: ${method} failed." >&2
    echo "${response}" | jq . >&2 || echo "${response}" >&2
    exit 1
  fi
}

echo "Reconciling Pharos Watch bot profile metadata..."

call_telegram "setMyName" "$(jq -n --arg name "${BOT_NAME}" '{name: $name}')"
call_telegram "setMyShortDescription" "$(jq -n --arg short_description "${BOT_SHORT_DESCRIPTION}" '{short_description: $short_description}')"
call_telegram "setMyDescription" "$(jq -n --arg description "${BOT_DESCRIPTION}" '{description: $description}')"

if [ -f "${PHOTO_PATH}" ]; then
  echo
  echo "Attempting one-time profile photo upload from ${PHOTO_PATH}..."
  PHOTO_RESPONSE=$(curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setUserPhoto" \
    -F "photo=@${PHOTO_PATH}" || true)
  PHOTO_OK=$(echo "${PHOTO_RESPONSE}" | jq -r '.ok // false' 2>/dev/null || echo "false")
  if [ "${PHOTO_OK}" = "true" ]; then
    echo "OK: profile photo updated."
  else
    echo "Note: profile photo could not be set via Bot API."
    echo "${PHOTO_RESPONSE}" | jq -r '.description // empty' 2>/dev/null || true
    echo "Set the photo manually via @BotFather (/setuserpic) using ${PHOTO_PATH}."
  fi
else
  echo "Note: ${PHOTO_PATH} not found; skipping profile photo step."
fi

echo
echo "Done. Verify with: curl https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/getMyName"
