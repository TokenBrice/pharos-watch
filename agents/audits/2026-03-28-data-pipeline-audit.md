# 2026-03-28 Data Pipeline Audit

## Scope

Loop 1 audit of the Pharos data pipeline, focused on the live worker ingestion and computation path:

- FX references
- stablecoin intake and pricing
- stablecoin chart caching
- blacklist ingestion
- DEWS computation
- PSI computation

Read set for this audit:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/testing.md`
- `docs/worker-and-api-limits.md`
- `docs/data-pipeline.md`
- `docs/data-flow-map.md`
- `docs/dews.md`
- `docs/blacklist-tracker.md`
- `docs/depeg-detection.md`
- `docs/pricing-pipeline.md`
- `worker/src/handlers/scheduled.ts`
- `worker/src/cron/{sync-stablecoins.ts,detect-depegs.ts,compute-dews.ts,stability-index.ts,snapshot-supply.ts,sync-stablecoin-charts.ts,sync-fx-rates.ts}`
- `worker/src/lib/{stablecoins-cache.ts,price-consensus.ts,fx-rate-state.ts,fx-metals.ts,peg-analytics.ts,blacklist-contracts.ts}`
- `worker/src/api/{peg-summary.ts,stablecoin-detail.ts,feedback/verification.ts}`

## Findings

### 1. DEWS blacklist coverage is incomplete despite live tracker support

- Severity: Medium
- Area: `worker/src/cron/compute-dews.ts`
- Evidence:
  - `BLACKLIST_SYMBOL_TO_IDS` only maps `USDC`, `USDT`, `PAXG`, and `XAUT`.
  - `docs/blacklist-tracker.md` states live blacklist coverage includes `PYUSD` and `USD1`.
  - `docs/dews.md` states `S_black` applies to `USDC`, `USDT`, `PAXG`, `XAUT`, `PYUSD`, and `USD1`.
- Impact:
  - `PYUSD` and `USD1` blacklist events are ingested into `blacklist_events`, but their DEWS `black` signal is always unavailable.
  - That suppresses issuer-intervention stress for two tracked blacklistable coins and makes DEWS less complete than the documented model.
- Root cause:
  - DEWS uses a stale hardcoded symbol-to-id map instead of deriving tracked blacklist coverage from the shared registry / supported symbol set.
- Remediation:
  - Replace the hardcoded coverage map with a derived map built from the PSI-eligible/tracked metadata filtered by `BLACKLIST_STABLECOINS`.
  - Add regression coverage proving `PYUSD` and `USD1` receive blacklist counts when rows exist.

### 2. DEWS thin non-USD peg references ignore cached FX fallback rates

- Severity: Medium
- Area: `worker/src/cron/compute-dews.ts`
- Evidence:
  - `computeAndStoreDEWS()` calls `derivePegRates(assets, PSI_ELIGIBLE_META_BY_ID)` without `stablecoinsCache.payload.fxFallbackRates`.
  - `derivePegRates()` explicitly supports `fallbackRates` for thin peg groups.
  - Live depeg detection and peg analytics already pass `fxFallbackRates`.
- Impact:
  - For thin non-USD groups, DEWS divergence can anchor to a self-derived median instead of the current cached FX reference.
  - A depegged or noisy peer inside a sparse peg group can mute or distort `S_diverg`, especially for non-USD and commodity-pegged coins.
- Root cause:
  - DEWS did not maintain parity with the rest of the peg-aware pipeline when `fxFallbackRates` was added as the thin-group guardrail.
- Remediation:
  - Pass cached `fxFallbackRates` into `derivePegRates()` inside `computeAndStoreDEWS()`.
  - Add a regression test proving fallback FX is used when present.

### 3. Stablecoin chart FX repair can rewrite valid historical USD values with today’s FX

- Severity: Medium
- Area: `worker/src/cron/sync-stablecoin-charts.ts`
- Evidence:
  - The chart cron repairs `totalCirculatingUSD` by comparing every historical point to the current `fx-rates` cache.
  - When the implied historical FX rate is outside `fxRate / 3 .. fxRate * 3`, it rewrites the point with `rawVal * currentFxRate`.
  - The correction uses the current FX state, not a point-date-matched historical FX reference.
- Impact:
  - Valid old chart points for volatile non-USD pegs can be overwritten if the underlying fiat moved materially over time.
  - The repair intended for obvious corruption can itself introduce historical chart inaccuracies.
- Root cause:
  - A live-only FX reference is being used as if it were a historical reference.
- Remediation:
  - Restrict FX-based repair to points near the live FX reference window instead of rewriting deep history with today’s rate.
  - Add regression coverage proving older historical points are preserved.

## Audit Outcome

- Loop: 1
- Medium-or-higher issues found: 3
- Blocking status for termination: not eligible to terminate; medium issues remain above the target threshold

## Implementation Direction

The remediation should stay minimal and root-cause driven:

1. Fix DEWS blacklist coverage derivation.
2. Fix DEWS peg-rate derivation to pass cached FX fallback rates.
3. Narrow stablecoin-charts FX repair to the safe recent window.
4. Update DEWS methodology/changelog docs for the scoring-input fixes.
5. Update pipeline/worker docs for the chart-repair safety change.

---

## Loop 2 Closure Review

Post-implementation verification on the three loop-1 findings:

1. DEWS blacklist coverage
   - `worker/src/cron/compute-dews.ts` now derives coverage from shared `BLACKLIST_STABLECOINS`.
   - Regression coverage added for `PYUSD` and `USD1`.
   - Status: resolved.

2. DEWS thin non-USD peg references
   - `computeAndStoreDEWS()` now passes cached `fxFallbackRates` into `derivePegRates()`.
   - Regression coverage added for the call contract.
   - Status: resolved.

3. Historical chart FX rewrite risk
   - `syncStablecoinCharts()` now limits live-FX repair to recent points instead of rewriting deep history with today's FX reference.
   - Regression coverage added for older-point preservation.
   - Status: resolved.

Validation completed after remediation:

- `npm test -- worker/src/cron/__tests__/compute-dews.test.ts`
- `npm test -- worker/src/cron/__tests__/sync-stablecoin-charts.test.ts`
- `npm run lint`
- `npm run check:doc-sync`
- `npm test`
- `npm run build`
- `cd worker && npx tsc --noEmit`

Loop 2 audit result:

- Medium-or-higher issues remaining in audited scope: 0
- Termination condition: satisfied
