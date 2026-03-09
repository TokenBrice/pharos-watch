# Liquidity / Depeg Reliability Fix Plan

Date: March 9, 2026  
Source audit: `/liquidity` feature audit + `/depeg` DEX Price Check audit  
Primary routes: `/liquidity/`, `/depeg/`

## Purpose

This document converts the liquidity/depeg audit findings into an execution-ready implementation plan.

The goal is to improve data quality, scoring correctness, and depeg cross-validation trust without expanding scope into a larger redesign of the DEX pipeline.

## Scope

In scope:

- `worker/src/cron/dex-liquidity/*`
- `worker/src/cron/dex-discovery/*`
- `worker/src/cron/detect-depegs.ts`
- `worker/src/cron/confirm-pending-depegs.ts`
- `worker/src/api/dex-liquidity.ts`
- `worker/src/api/peg-summary.ts`
- `src/app/liquidity/*`
- `src/app/depeg/*`
- `src/components/peg-heatmap.tsx`
- `src/components/depeg-tracker-table.tsx`
- `src/components/dex-liquidity-card.tsx`
- liquidity/depeg docs and methodology docs

Out of scope:

- adding brand-new upstream data sources
- redesigning the `/liquidity` or `/depeg` UI layout
- changing the core cron split between discovery and scoring
- broader report-card or DEWS formula changes unless required by corrected liquidity outputs

## Non-Negotiables

- Preserve the current discovery/scoring cron separation.
- Preserve the existing `dex_prices` and `dex_liquidity` tables unless a schema change is clearly justified.
- Do not relax source-quality guardrails to recover coverage numbers.
- Prefer deterministic recomputation over patching derived fields in place.
- If a behavior change affects documented methodology, update:
  - `docs/dex-liquidity.md`
  - `docs/depeg-detection.md`
  - `docs/api-reference.md`
  - `/methodology` page content and any supporting methodology docs
- No new source should be introduced, so `/about` does not need a data-source update for this plan.

## Verification Standard

Every implementation phase must finish with:

```bash
npm run build
npm run lint
npm test
cd worker && npx tsc --noEmit
```

Minimum targeted suites during development:

```bash
npm test -- \
  worker/src/cron/__tests__/dex-liquidity-scoring.test.ts \
  worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts \
  worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts \
  worker/src/cron/__tests__/detect-depegs.test.ts \
  worker/src/cron/__tests__/confirm-pending-depegs.test.ts \
  worker/src/api/__tests__/peg-summary.test.ts \
  worker/src/api/__tests__/dex-liquidity.test.ts
```

## Findings To Fix

| ID | Severity | Problem | Root cause |
|---|---|---|---|
| F1 | High | Liquidity score and exported metrics still reflect filtered-out or capped pools | post-filter/cap recomputation only rebuilds some aggregates |
| F2 | High | Thin staged pools can influence `dex_prices` and suppress/promote depeg logic too easily | staged price-observation threshold is too low and trust policy is inconsistent |
| F3 | High | Discovery-to-staging drops scoring-critical metadata and misclassifies pools | normalized protocol is persisted where raw DEX/pool metadata should be preserved |
| F4 | High | Staged pools can double-count physical pools already represented by DL via token-pair fingerprints | staging merge only checks `poolId`, not fingerprint dedup |
| F5 | Medium-high | Discovery misses alternate traded addresses and same-chain multi-address cases | orchestrator only uses `contracts` and collapses targets into `Map<chain,address>` |
| F6 | Medium | Discovery budget is not truly tier-first | candidates are globally sorted by staleness after tier assignment |
| F7 | Medium | CoinGecko tickers fallback no longer matches documented behavior and can miss valid orderbook coverage | trigger condition, quote filtering, and price aggregation drifted from docs |
| F8 | Medium-low | HHI and global 7d volume semantics do not match documentation | HHI uses truncated display pools; 7d global volume is a naive per-coin sum |

## Implementation Strategy

Implement in three workstreams, in this order:

1. Score integrity and dedup correctness
2. DEX price trust and depeg gating
3. Discovery fidelity and scheduling

This order minimizes the risk of depeg behavior being tuned against already-wrong liquidity aggregates.

## Workstream 1: Score Integrity And Dedup Correctness

### 1.1 Rebuild all scoring aggregates from retained pools

Fixes: `F1`, part of `F8`

Current problem:

- `computeStablecoinScores()` filters and scales `m.topPools`, then only partially rebuilds `m`.
- Score inputs still read stale `totalVolume24hUsd`, `qualityAdjustedTvl`, balance weights, organic weights, stress weights, and locked-liquidity weights.

Implementation:

1. Extend `PoolEntry` so a retained pool carries every value required for deterministic recomputation.
2. Add a helper in `worker/src/cron/dex-liquidity/scoring.ts` that rebuilds a full aggregate snapshot from the retained pre-display pool list.
3. Compute score inputs from that rebuilt snapshot, not from the pre-filter `LiquidityMetrics`.
4. Keep top-10 truncation as a display/persistence concern only.

Required `PoolEntry` additions:

- `volumeUsd7d?: number | null`
- `qualityAdjustedTvl?: number`
- `effectiveTvl?: number`
- `organicFraction?: number`
- `hasMeasuredOrganicFraction?: boolean`
- `stressIndex?: number`
- `balanceRatio?: number | null`
- `lockedLiquidityPct?: number | null`
- `maturityDays?: number`

Primary files:

- `worker/src/cron/dex-liquidity/types.ts`
- `worker/src/cron/dex-liquidity/process-pools.ts`
- `worker/src/cron/dex-liquidity/fetch-crawlers.ts`
- `worker/src/cron/dex-liquidity/staging-merge.ts`
- `worker/src/cron/dex-liquidity/scoring.ts`

Acceptance criteria:

- Removing or scaling a pool changes every dependent aggregate consistently.
- `score`, `avg_pool_stress`, `weighted_balance_ratio`, `organic_fraction`, `locked_liquidity_pct`, `total_volume_24h_usd`, and protocol/chain breakdowns are all computed from the same retained pool set.
- No filtered-out pool can still affect score components or exported aggregate fields.

Tests:

- Add a scoring test where a high-volume bad pool is filtered out and verify:
  - `totalVolume24hUsd` drops
  - `volumeActivity` drops
  - `avgStress` drops if the filtered pool was stressed
  - `organicFraction` and `weightedBalanceRatio` ignore removed pools
- Add a test where protocol TVL scaling reduces `qualityAdjustedTvl`, `effectiveTvl`, and final score together.

### 1.2 Apply fingerprint dedup during staged merge

Fixes: `F4`

Current problem:

- `buildKnownPoolAddresses()` creates `fp:` fingerprints specifically to reconcile DL UUID pools with on-chain discovery pools.
- `mergeStagedPools()` only checks `knownPoolAddrs.has(stagedPool.poolId)`.

Implementation:

1. Extract a shared helper that builds the canonical pool fingerprint:
   - `fp:<chain>:<normalized_protocol>:<sorted_token_addresses>`
2. Use this helper everywhere fingerprints are created:
   - `buildKnownPoolAddresses()`
   - `crawl-helpers.ts`
   - `fetch-fallbacks.ts`
   - `staging-merge.ts`
3. In `mergeStagedPools()`, reject a staged row if either:
   - the `poolId` is already known
   - the fingerprint is already known
4. Log separate counts for:
   - address-based skips
   - fingerprint-based skips

Primary files:

- `worker/src/cron/dex-liquidity/fetch-primary.ts`
- `worker/src/cron/dex-liquidity/crawl-helpers.ts`
- `worker/src/cron/dex-liquidity/fetch-fallbacks.ts`
- `worker/src/cron/dex-liquidity/staging-merge.ts`

Acceptance criteria:

- A DL pool and an on-chain discovered pool representing the same token pair on the same protocol/chain are counted once.
- `stagedPoolsSkipped` remains meaningful and can be broken down by reason.

Tests:

- Add a staging-merge test where:
  - `knownPoolAddrs` contains only the fingerprint
  - the staged row uses a different `poolId`
  - merge must skip the staged row

### 1.3 Restore documented HHI and global 7d volume semantics

Fixes: `F8`

Implementation:

1. Compute `concentration_hhi` from the full retained pool set before top-10 truncation.
2. Keep the UI rendering capped at top 10 pools without changing HHI.
3. Rebuild `globalTotalVol7d` from deduped pool entries by `poolId`, the same way `globalTotalVol24h` is deduped.
4. Populate `PoolEntry.volumeUsd7d` for DL pools from `volumeUsd7d`; leave non-DL pools as `null` or `0` consistently.

Decision:

- Do not infer fake 7d volume for staged pools.
- Use actual 7d volume when provided; treat missing as zero for aggregation.

Primary files:

- `worker/src/cron/dex-liquidity/process-pools.ts`
- `worker/src/cron/dex-liquidity/scoring.ts`
- `docs/dex-liquidity.md`
- `docs/api-reference.md`

Acceptance criteria:

- Stored HHI matches the documented pre-truncation definition.
- `__global__.total_volume_7d_usd` is pool-deduped.

Tests:

- Update scoring tests to expect HHI from the full retained pool set.
- Add a test where the same pool appears under two stablecoins and 7d volume is counted once globally.

## Workstream 2: DEX Price Trust And Depeg Gating

### 2.1 Raise staged price observation thresholds to the documented floor

Fixes: `F2`

Current problem:

- Primary price sources use a `$50k` pool-liquidity floor for price observations.
- `mergeStagedPools()` admits staged price observations at `$10k` adjusted TVL.

Implementation:

1. Define one shared minimum observation-liquidity constant for DEX prices:
   - `DEX_PRICE_OBSERVATION_MIN_TVL_USD = 50_000`
2. Use it in:
   - Curve price extraction
   - UniV3 price extraction
   - Aerodrome price extraction
   - discovery-stage price collection
   - staged merge price collection
   - fallback price collection
3. For staged pools, apply the threshold after confidence decay.

Primary files:

- `worker/src/cron/dex-liquidity/scoring.ts`
- `worker/src/cron/dex-liquidity/staging-merge.ts`
- `worker/src/cron/dex-liquidity/crawl-helpers.ts`
- `worker/src/cron/dex-discovery/crawl-sources.ts`
- `worker/src/lib/constants.ts` or a dedicated dex-price constant module

Acceptance criteria:

- No sub-`$50k` pool contributes a stored DEX price, regardless of source family.

Tests:

- Add staging/discovery tests proving a `$10k` staged pool can still count for liquidity scoring but not for `dex_prices`.

### 2.2 Centralize DEX trust policy for depeg logic and UI

Fixes: `F2`

Current problem:

- `detectDepegEvents()` suppresses new events on any fresh DEX price.
- `confirmPendingDepegs()` promotes on any fresh DEX price.
- `/api/peg-summary` shows DEX Price Check for any fresh row above the supply gate.
- These three consumers do not share a common trust policy.

Implementation:

1. Add a shared helper, likely in `worker/src/lib/depeg-helpers.ts` or a new `worker/src/lib/dex-price-trust.ts`, that evaluates a `dex_prices` row for:
   - freshness
   - source total TVL
   - optional supply-aware thresholds
2. Use explicit trust tiers:
   - `ui`: freshness `< 3600s`, `source_total_tvl >= 250_000`
   - `depeg`: freshness `< 1200s`, `source_total_tvl >= 1_000_000`
3. Reuse the helper in:
   - `detectDepegEvents()`
   - `confirmPendingDepegs()`
   - `handlePegSummary()`
4. Keep existing ongoing-event auto-close behavior at the `depeg` tier.
5. For small-cap coins, do not allow a fresh but thin DEX row to suppress a new event.
6. For pending confirmations, do not allow a thin DEX row to promote a pending event when CG is absent.

Decision:

- Do not require `source_pool_count >= 2`.
- A single deep pool should remain eligible if TVL is strong enough.

Primary files:

- `worker/src/lib/depeg-helpers.ts`
- `worker/src/cron/detect-depegs.ts`
- `worker/src/cron/confirm-pending-depegs.ts`
- `worker/src/api/peg-summary.ts`

Acceptance criteria:

- A fresh DEX row below `$1M` source TVL cannot suppress or confirm a depeg.
- A fresh DEX row below `$250k` source TVL does not show up as a UI DEX Price Check.
- Ongoing-event auto-close still works for strong DEX disagreement.

Tests:

- `detect-depegs.test.ts`
  - new event is not suppressed by a fresh low-TVL DEX row
  - new event is suppressed by a fresh high-TVL DEX row
- `confirm-pending-depegs.test.ts`
  - low-TVL DEX alone cannot promote a pending event
  - high-TVL DEX can still promote
- `peg-summary.test.ts`
  - low-TVL DEX row is hidden from `dexPriceCheck`
  - high-TVL row still appears

### 2.3 Make `/depeg` DEX Price Check explicitly “trusted-only”

Fixes: downstream effect of `F2`

Implementation:

1. Keep the current `dexPriceCheck` payload shape unless the UI needs more nuance.
2. Change the contract so `dexPriceCheck` is omitted unless it passes the shared UI trust tier.
3. Do not render disagreement badges or table checks for low-confidence rows.
4. Preserve source TVL and pool count in the payload when the check is shown.

Primary files:

- `worker/src/api/peg-summary.ts`
- `src/components/peg-heatmap.tsx`
- `src/components/depeg-tracker-table.tsx`

Acceptance criteria:

- `/depeg` disagreement markers are only shown for DEX checks that pass the UI trust threshold.

## Workstream 3: Discovery Fidelity And Scheduling

### 3.1 Persist raw discovery metadata needed by scoring

Fixes: `F3`

Current problem:

- discovery currently persists normalized `protocol`
- staged merge re-derives quality from that normalized protocol string
- concentrated-liquidity and orderbook pools lose their true type/quality

Implementation:

1. Extend `dex_pool_staging` with scoring-critical fields:
   - `dex_id TEXT NULL`
   - `pool_type TEXT NULL`
   - `quality_multiplier REAL NULL`
2. Discovery should persist:
   - raw source dex id in `dex_id`
   - exact pool type selected during discovery
   - exact quality multiplier used during discovery
3. `protocol` can remain the normalized grouping key if still useful, but scoring must prefer:
   - stored `quality_multiplier`
   - stored `pool_type`
   - raw `dex_id` for display/debugging
4. `mergeStagedPools()` must stop deriving quality from normalized `protocol` when explicit staging fields exist.
5. Add backward compatibility:
   - if old rows lack the new columns, keep current fallback derivation until rows are refreshed out of the table

Primary files:

- `worker/migrations/*` new migration
- `worker/src/cron/dex-discovery/types.ts`
- `worker/src/cron/dex-discovery/crawl-sources.ts`
- `worker/src/cron/dex-discovery/persistence.ts`
- `worker/src/cron/dex-liquidity/staging-merge.ts`

Acceptance criteria:

- staged CG/GT/DexScreener/orderbook pools preserve the quality classification chosen at discovery time
- orderbook pools score with `0.6x`, not generic `0.3x`
- concentrated pools retain their CL-specific classification when available

Tests:

- Add a discovery->staging->merge integration test for:
  - CG concentrated pool
  - GT concentrated pool
  - CG tickers orderbook pool

### 3.2 Include `tradedContracts` and preserve multi-address same-chain discovery

Fixes: `F5`

Implementation:

1. Replace `Map<string, string>` chain targeting with an array of deployments.
2. Build discovery targets from `getTrackedContracts(meta)`, not `coin.contracts`.
3. Deduplicate only exact `(chain,address)` duplicates, not all same-chain entries.
4. Update `crawlCoin()` to accept the array form and iterate every target.

Primary files:

- `worker/src/cron/dex-discovery/orchestrator.ts`
- `worker/src/cron/dex-discovery/crawl-sources.ts`
- reuse `getTrackedContracts()` from `worker/src/cron/dex-liquidity/pool-helpers.ts`

Acceptance criteria:

- discovery can crawl wrapper or traded addresses defined in `tradedContracts`
- discovery can handle multiple addresses on the same chain for one stablecoin

Tests:

- Add an orchestrator test for `tradedContracts`
- Add a test for multiple same-chain deployments being preserved, not overwritten by a `Map`

### 3.3 Enforce tier-first scheduling before staleness sort

Fixes: `F6`

Implementation:

1. Add explicit tier priority:
   - `t1`
   - `t2`
   - `t3`
   - `dormant`
2. Sort candidates by:
   - tier priority first
   - `lastCrawlAt` second
3. Keep existing cadence gating and miss backoff.
4. Include attempted counts per tier in metadata if useful for operators.

Primary files:

- `worker/src/cron/dex-discovery/orchestrator.ts`
- `worker/src/cron/dex-discovery/__tests__/orchestrator.test.ts`

Acceptance criteria:

- zero-pool and low-coverage coins always consume budget before stale high-coverage coins

### 3.4 Restore documented CoinGecko tickers fallback behavior

Fixes: `F7`

Implementation:

1. Trigger the fallback when a coin still has:
   - zero pools, or
   - no usable price observation
2. Expand accepted USD-equivalent quotes to match docs:
   - `USD`
   - `USDT`
   - `USDC`
   - `DAI`
   - other whitelisted USD-like assets already supported in constants
3. Aggregate per-exchange price using volume-weighted average, not first ticker wins.
4. Keep per-exchange synthetic TVL = `totalVolume * ORDERBOOK_TVL_FACTOR`.
5. Preserve `poolType = "orderbook"` and `qualityMultiplier = 0.6`.

Primary files:

- `worker/src/cron/dex-discovery/crawl-sources.ts`
- `worker/src/cron/dex-liquidity/constants.ts`
- `docs/dex-liquidity.md`

Acceptance criteria:

- orderbook-heavy assets can regain fallback coverage when they lack pools or a usable DEX price
- exchange-level fallback prices are aggregated deterministically

Tests:

- Add discovery-source tests for:
  - trigger when pools exist but no usable price observation exists
  - DAI or other whitelisted USD-like quotes being accepted
  - per-exchange volume-weighted average price

### 3.5 Remove stale implementation debt

Fixes: cleanup exposed during `F3`

Implementation:

- Remove the stale `TODO(phase-2)` comment in `worker/src/cron/dex-discovery/orchestrator.ts` if staged row price data remains the intended handoff for scoring.
- If a separate price-observation staging table is still desired, create a separate design doc first and do not mix it into this fix set.

## Schema / Migration Plan

One migration is expected for `dex_pool_staging`.

Proposed changes:

```sql
ALTER TABLE dex_pool_staging ADD COLUMN dex_id TEXT;
ALTER TABLE dex_pool_staging ADD COLUMN pool_type TEXT;
ALTER TABLE dex_pool_staging ADD COLUMN quality_multiplier REAL;
```

Backfill strategy:

- No explicit backfill needed.
- Existing rows can be read with fallback logic until the next 24-hour refresh window clears them.

No `dex_prices` migration is required if trust gating is computed from existing metadata.

## Documentation Updates Required

Must update:

- `docs/dex-liquidity.md`
  - retained-pool recomputation
  - fingerprint dedup at staged merge
  - staged price-observation threshold
  - HHI definition
  - global 7d volume semantics
  - discovery staging fields
  - CoinGecko tickers fallback semantics
- `docs/depeg-detection.md`
  - shared DEX trust policy
  - suppression/promotion TVL thresholds
- `docs/api-reference.md`
  - `GET /api/dex-liquidity`
  - `GET /api/peg-summary`
- `docs/methodology-page.md`
  - section mapping for any liquidity-methodology wording that changes
- `/methodology` page content
  - liquidity section
  - depeg DEX Price Check section if it describes trust gates

## Rollout Order

### Phase 1

- `F1`
- `F4`
- `F8`

Reason:

- fixes core score correctness before touching depeg trust behavior

### Phase 2

- `F2`

Reason:

- depeg logic should consume corrected DEX outputs

### Phase 3

- `F3`
- `F5`
- `F6`
- `F7`

Reason:

- improves long-tail discovery quality after the scoring path is trustworthy

## Operational Validation After Deploy

Check the next two discovery/scoring cycles for:

- `sync-dex-liquidity` remains `ok` or `degraded`, not `error`
- `sourceCoverage.currentCoverage` does not drop materially
- `stagedPoolsSkipped` rises when fingerprint dedup removes duplicates
- `priceObservationCoins` does not crater unexpectedly
- `/api/dex-liquidity` still returns the `__global__` row
- `/api/peg-summary` still returns `dexPriceCheck` for liquid majors

Manual spot checks:

- USDT on Optimism, to verify `tradedContracts` discovery still works
- KAG and KAU, to verify orderbook fallback still produces coverage
- at least one CLMM-heavy coin, to verify staging preserves concentrated-pool quality

## Definition Of Done

- No liquidity score or exported aggregate is influenced by a pool that was filtered out or scaled down without all companion metrics being recomputed.
- Staged discovery cannot double-count an already-known physical pool.
- Thin DEX price data cannot suppress or confirm depeg events.
- `/depeg` only shows DEX Price Check when the underlying DEX row passes the shared UI trust threshold.
- Discovery uses `contracts + tradedContracts`, preserves same-chain multi-address coverage, and schedules T1 before T2/T3/dormant.
- CoinGecko tickers fallback matches documented trigger and quote-selection behavior.
- Liquidity/depeg docs and methodology content are updated to match implementation.
