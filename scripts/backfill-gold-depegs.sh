#!/usr/bin/env bash
set -euo pipefail

WORKER_URL="${WORKER_URL:-https://api.pharos.watch}"
DEV_VARS="$(dirname "$0")/../worker/.dev.vars"

# Read ADMIN_KEY from .dev.vars if not already set in environment
if [[ -z "${ADMIN_KEY:-}" ]]; then
  if [[ -f "$DEV_VARS" ]]; then
    ADMIN_KEY=$(grep -E '^ADMIN_KEY' "$DEV_VARS" | sed 's/^ADMIN_KEY *= *//' | tr -d '"')
  fi
fi

if [[ -z "${ADMIN_KEY:-}" ]]; then
  echo "Error: ADMIN_KEY not found in environment or worker/.dev.vars" >&2
  exit 1
fi

GOLD_COINS=(
  "xaut-tether"
  "paxg-paxos"
  "kau-kinesis"
  "xaum-matrixdock"
  "cgo-comtech"
  "dgld-gold-token-sa"
)

echo "Backfilling gold depeg events against: $WORKER_URL"
echo "---"

for id in "${GOLD_COINS[@]}"; do
  echo -n "[$id] ... "
  response=$(curl -sf \
    -X POST \
    -H "X-Admin-Key: $ADMIN_KEY" \
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
