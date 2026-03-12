# Pricing Pipeline Audit — 2026-03-12

Status: resolved in the follow-up implementation pass completed on 2026-03-12. This document remains the pre-implementation audit snapshot; see the current code and tests for the shipped fixes.

## Scope

Audited the end-to-end pricing path after the CoinGecko-primary switch:

- live stablecoins sync (`worker/src/cron/sync-stablecoins.ts`)
- primary price selection and enrichment (`worker/src/cron/enrich-prices.ts`)
- supplemental commodity / CoinGecko-only supply overlays (`worker/src/cron/sync-stablecoins/supplemental-assets.ts`)
- pending depeg confirmation (`worker/src/cron/confirm-pending-depegs.ts`)
- detail/history normalization (`worker/src/api/stablecoin-detail*.ts`)
- shared validation and downstream consumers (`worker/src/lib/price-validation.ts`, `worker/src/api/peg-summary.ts`, `src/hooks/use-stablecoins.ts`)

Also verified current upstream DefiLlama behavior for:

- list endpoint values already in USD for non-USD pegs
- detail endpoint `tokens[].circulating` remaining in native units for non-USD pegs

## What Was Fixed

### 1. CoinGecko supplemental market-cap health was not circuit-protected

`fetchCoinGeckoMarketData()` did not use the dedicated `coingecko-mcap` circuit and did not record source outcomes. That meant:

- repeated blind retries during a CoinGecko market-cap outage
- missing health signal for the exact endpoint that feeds supplemental commodity / CG-only supply

Fix:

- gate the batch market-cap fetch through `shouldAttemptFetch(..., CIRCUIT_SOURCE.CG_MCAP)`
- record success/failure with `recordOutcomeSafe(...)`

### 2. Supplemental supply provenance was underreported

Supplemental assets (gold, silver, CG-only fiat) were returned without an explicit `supplySource`, and later downstream normalization could treat them as generic DefiLlama-backed rows.

Fix:

- stamp `supplySource: "coingecko-fallback"` for silver + CG-only fiat supplementals
- stamp gold supply provenance based on the actual mcap path:
  - `defillama` when protocol mcap wins
  - `coingecko-fallback` when CoinGecko mcap wins

### 3. Pending depeg confirmation could reuse CoinGecko as both primary and secondary

When a pending depeg already had a CoinGecko-derived current primary (`priceSource = "coingecko"` or `"coingecko+defillama"`), the confirmation pass still re-queried CoinGecko `/simple/price` as the “secondary” check. After the provider switch, that weakened the confirmation lane.

Fix:

- if the current primary already uses CoinGecko, switch the off-chain confirmer to DefiLlama `coins.llama.fi/prices/current/coingecko:{geckoId}`
- keep CoinGecko as the off-chain confirmer only when the primary does not already depend on CoinGecko

Effect:

- low-confidence CoinGecko-primary events now require either DefiLlama persistence or trusted DEX support, not CoinGecko echoing itself

### 4. CoinGecko primary health could be marked healthy after partial batch failure

`fetchPrimaryPrices()` previously marked `coingecko-prices` successful even if one or more `/simple/price` batches failed mid-loop.

Fix:

- track batch-level failure and record circuit success only when all CoinGecko price batches succeed

## Remaining Weak Spots

### 1. Non-USD detail payload contract is still internally inconsistent

`worker/src/api/stablecoin-detail/defillama.ts` converts `tokens[].circulating` to USD for non-USD pegs, while the public API reference still describes native-unit detail history under `totalCirculating`.

Why this matters:

- the frontend is safe because it only consumes the USD-side market-cap history
- external integrators can still misread the contract because the worker mutates `circulating` instead of materializing a separate USD field for regular DefiLlama detail payloads

Risk level: medium

Recommended follow-up:

- either normalize regular DefiLlama detail responses onto the documented `totalCirculatingUSD` / `totalCirculating` contract
- or explicitly document that non-USD regular detail responses mutate `circulating` into USD

### 2. Canonical-ID dedupe is still not enforced after DefiLlama ID remap

`syncStablecoins()` remaps DefiLlama numeric IDs to canonical IDs but does not dedupe collisions after remap. The test suite already characterizes this and allows duplicate canonical IDs through.

Why this matters:

- a bad upstream duplicate can still double-count supply / price rows in the cached payload
- the new supplemental dedupe only protects supplemental merges, not DefiLlama-internal duplicate remaps

Risk level: medium

Recommended follow-up:

- decide on merge semantics for post-remap collisions and make them explicit instead of “allow duplicates but don’t crash”

## Verified Behaviors

- DefiLlama list endpoint values for EURC, A7A5, and JPYC are still USD-denominated despite non-USD peg keys.
- DefiLlama detail endpoint values for EURC, A7A5, and JPYC still expose native-unit `tokens[].circulating`.
- The CoinGecko full-supply fallback path already contains the same major guardrails as the main path:
  - authoritative live overrides
  - pre-validation
  - final validation before cache persistence
  - `price_cache` refresh
  - cached-price fallback
  - pending depeg confirmation
- Supplemental last-known-good restoration during CoinGecko market-cap outage is already present and now explicitly tested.

## Verification Run

- `npm run lint`
- `npm run build`
- `cd worker && npx tsc --noEmit`
- `npm test -- --run worker/src/cron/__tests__/confirm-pending-depegs.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/enrich-prices.test.ts worker/src/lib/__tests__/price-validation.test.ts`
