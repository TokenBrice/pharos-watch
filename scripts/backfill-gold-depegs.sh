#!/usr/bin/env bash
set -euo pipefail

WORKER_URL="${WORKER_URL:-https://ops-api.pharos.watch}"

AUTH_HEADERS=()

if [[ -n "${OPS_API_SERVICE_TOKEN_ID:-}" && -n "${OPS_API_SERVICE_TOKEN_SECRET:-}" ]]; then
  AUTH_HEADERS+=(
    -H "CF-Access-Client-Id: $OPS_API_SERVICE_TOKEN_ID"
    -H "CF-Access-Client-Secret: $OPS_API_SERVICE_TOKEN_SECRET"
    -H "X-Pharos-Admin: 1"
  )
fi

if [[ ${#AUTH_HEADERS[@]} -eq 0 ]]; then
  echo "Error: set OPS_API_SERVICE_TOKEN_ID and OPS_API_SERVICE_TOKEN_SECRET." >&2
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
