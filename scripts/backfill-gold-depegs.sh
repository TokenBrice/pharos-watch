#!/usr/bin/env bash
set -euo pipefail

WORKER_URL="${WORKER_URL:-https://ops-api.pharos.watch}"
DEV_VARS="$(dirname "$0")/../worker/.dev.vars"

AUTH_HEADERS=()

if [[ -n "${OPS_API_SERVICE_TOKEN_ID:-}" && -n "${OPS_API_SERVICE_TOKEN_SECRET:-}" ]]; then
  AUTH_HEADERS+=(
    -H "CF-Access-Client-Id: $OPS_API_SERVICE_TOKEN_ID"
    -H "CF-Access-Client-Secret: $OPS_API_SERVICE_TOKEN_SECRET"
  )
elif [[ -n "${ADMIN_KEY:-}" ]]; then
  AUTH_HEADERS+=(-H "X-Admin-Key: $ADMIN_KEY")
elif [[ -f "$DEV_VARS" ]]; then
  ADMIN_KEY=$(grep -E '^ADMIN_KEY' "$DEV_VARS" | sed 's/^ADMIN_KEY *= *//' | tr -d '"' || true)
  if [[ -n "${ADMIN_KEY:-}" ]]; then
    AUTH_HEADERS+=(-H "X-Admin-Key: $ADMIN_KEY")
  fi
fi

if [[ ${#AUTH_HEADERS[@]} -eq 0 ]]; then
  echo "Error: set OPS_API_SERVICE_TOKEN_ID + OPS_API_SERVICE_TOKEN_SECRET, or provide ADMIN_KEY." >&2
  exit 1
fi

GOLD_COINS=(
  "xaut-tether"
  "paxg-paxos"
  "kau-kinesis"
  "xaum-matrixdock"
  "cgo-comtech"
  "dgld-gold-token-sa"
  "pgold-pleasing"
  "ggbr-goldfish-gold"
)

echo "Backfilling gold depeg events against: $WORKER_URL"
echo "---"

for id in "${GOLD_COINS[@]}"; do
  echo -n "[$id] ... "
  response=$(curl -sf \
    -X POST \
    "${AUTH_HEADERS[@]}" \
    "$WORKER_URL/api/backfill-depegs?stablecoin=$id")
  echo "$response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
events = d.get('eventsCreated', '?')
errors = d.get('errors', [])
commodities = d.get('commodities', {})
src = commodities.get('source', '')
pts = commodities.get('goldDataPoints', '')
status = f'{events} events'
if src: status += f' | gold data: {pts}pt ({src})'
if errors: status += f' | ERRORS: {errors}'
print(status)
" 2>/dev/null || echo "$response"
done

echo "---"
echo "Done."
