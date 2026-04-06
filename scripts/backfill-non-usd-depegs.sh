#!/usr/bin/env bash
# Re-backfill depeg events for all non-USD stablecoins using the improved
# FX linear-interpolation pipeline.  Only replaces source='backfill' rows;
# live-detected events are never touched.
#
# Usage:
#   OPS_API_SERVICE_TOKEN_ID=… OPS_API_SERVICE_TOKEN_SECRET=… ./scripts/backfill-non-usd-depegs.sh
#
# Optional:
#   WORKER_URL  — override the default ops-api origin
#   DELAY       — seconds to wait between coins (default 5, respects CG rate limits)
set -euo pipefail

WORKER_URL="${WORKER_URL:-https://ops-api.pharos.watch}"
DELAY="${DELAY:-5}"

AUTH_HEADERS=()
if [[ -n "${OPS_API_SERVICE_TOKEN_ID:-}" && -n "${OPS_API_SERVICE_TOKEN_SECRET:-}" ]]; then
  AUTH_HEADERS+=(
    -H "CF-Access-Client-Id: $OPS_API_SERVICE_TOKEN_ID"
    -H "CF-Access-Client-Secret: $OPS_API_SERVICE_TOKEN_SECRET"
  )
fi

if [[ ${#AUTH_HEADERS[@]} -eq 0 ]]; then
  echo "Error: set OPS_API_SERVICE_TOKEN_ID and OPS_API_SERVICE_TOKEN_SECRET." >&2
  exit 1
fi

# All non-USD PSI-eligible stablecoins, grouped by peg currency.
# Pre-launch coins (eur-qivalis, pgold-polaris) excluded — no price history.
NON_USD_COINS=(
  # CHF
  "zchf-frankencoin"
  "chfau-allunity"
  "vchf-vnx"
  # EUR
  "eurc-circle"
  "eurcv-societe-generale-forge"
  "aeur-anchored-coins"
  "euri-banking-circle"
  "eure-monerium"
  "eurs-stasis"
  "ceur-celo"
  "veur-vnx"
  "eurr-stablr"
  "europ-schuman"
  "eurq-quantoz"
  "eurau-allunity"
  "deuro-deuro"
  # GBP
  "vgbp-vnx"
  "tgbp-tokenised"
  "gbpm-mento"
  # BRL
  "brz-transfero"
  "brla-brla-digital"
  # JPY
  "gyen-gyen"
  "jpyc-jpyc"
  "cjpy-yamato"
  # SGD
  "xsgd-straitsx"
  # AUD
  "audd-novatti"
  # CNH
  "axcnh-anchorx"
  # IDR
  "idrt-rupiah-token"
  "idrx-idrx"
  # TRY
  "tryb-bilira"
  # ZAR
  "zarp-zarp"
  # CAD
  "cadc-cad-coin"
  # PHP
  "pht-pht"
  # MXN
  "cetes-etherfuse"
  "mxnb-juno"
  # RUB
  "a7a5-old-vector"
  # VAR (variable peg)
  "fpi-frax"
  "isc-international-stable-currency"
  "rai-reflexer"
  "silk-shade-protocol"
  # GOLD
  "xaut-tether"
  "paxg-paxos"
  "kau-kinesis"
  "xaum-matrixdock"
  "cgo-comtech"
  "dgld-gold-token-sa"
  "pgold-pleasing"
  "ggbr-goldfish-gold"
  # SILVER
  "kag-kinesis"
)

total=${#NON_USD_COINS[@]}
echo "Backfilling $total non-USD coins against: $WORKER_URL"
echo "Delay between coins: ${DELAY}s"
echo "---"

ok=0
fail=0
for i in "${!NON_USD_COINS[@]}"; do
  id="${NON_USD_COINS[$i]}"
  n=$((i + 1))
  echo -n "[$n/$total] $id ... "
  response=$(curl -sf \
    -X POST \
    "${AUTH_HEADERS[@]}" \
    "$WORKER_URL/api/backfill-depegs?stablecoin=$id" 2>&1) && rc=0 || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "$response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
events = d.get('eventsCreated', '?')
errors = d.get('errors', [])
skipped = d.get('skipped', [])
status = f'{events} events'
if skipped: status += f' | skipped: {skipped}'
if errors: status += f' | ERRORS: {errors}'
print(status)
" 2>/dev/null || echo "$response"
    ((ok++))
  else
    echo "FAILED (curl exit $rc): $response"
    ((fail++))
  fi
  # Respect CG rate limits between coins
  if [[ $n -lt $total ]]; then
    sleep "$DELAY"
  fi
done

echo "---"
echo "Done: $ok succeeded, $fail failed out of $total."
