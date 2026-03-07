# Testing Coverage Implementation Plan (2026-03-07)

## Purpose

This document turns the 2026-03-07 coverage audit into an execution brief for an autonomous agent.
The goal is to maximize global coverage increase per unit of test runtime while keeping changes low-risk, local, and easy to verify.

This plan is based on a fresh local run, not the older screenshot artifact.

## Implementation Status

Status: completed on 2026-03-07.

Implemented items:

- Batch A: `process-pools.ts`, `scoring.ts`, `pool-helpers.ts`
- Batch B: `confirm-pending-depegs.ts`, `persistence.ts`
- Batch C: `status-reliability.ts`, `severity-colors.ts`, `twitter.ts`, `coingecko-onchain.ts`, `abort.ts`, `stablecoins-cache.ts`

Verification commands run after implementation:

```bash
npm test
npm run test:coverage
npm run lint
npm run build
cd worker && npx tsc --noEmit
```

Observed post-implementation results:

- Full test suite wall time: about `2.50s`
- Coverage run wall time: about `3.47s`
- Line coverage: `67.78%`
- Branch coverage: `56.24%`
- Function coverage: `71.00%`

Realized improvement versus baseline:

- Line coverage: `+4.01 pts`
- Branch coverage: `+5.84 pts`
- Function coverage: `+5.07 pts`

## Baseline Snapshot

Generated on 2026-03-07 with:

```bash
npm test
npm run test:coverage
```

Observed baseline:

- Full test suite wall time: about `2.655s`
- Coverage run wall time: about `4.042s`
- Line coverage: `63.77%` (`6442 / 10102`)
- Branch coverage: `50.40%` (`3898 / 7734`)
- Function coverage: `65.93%` (`952 / 1444`)

Important: several files shown as under-covered in the old screenshot are already fully covered now. Do not use the screenshot as the source of truth for implementation order.

## Execution Rules

The implementing agent should follow these rules:

1. Prefer adding tests over changing production code.
2. Only introduce production-code seams if a branch is otherwise unreachable through public exports, and only if the seam is minimal and justified in the PR summary.
3. Reuse existing helpers first:
   - `worker/src/api/__tests__/helpers/mock-d1.ts`
   - `worker/src/api/__tests__/helpers/mock-fetch.ts`
   - `worker/src/api/__tests__/helpers/fixtures.ts`
4. Keep tests deterministic:
   - stub `Date.now`
   - stub `crypto.randomUUID` / `crypto.subtle` when needed
   - stub network calls instead of hitting live APIs
5. Use small synthetic fixtures. Do not pull in large real payloads unless necessary for parser realism.
6. Do not relax coverage thresholds.
7. Do not rewrite existing tests unless they directly block one of the items below.
8. If an item needs more than a tiny production-code seam, stop and re-rank before proceeding.

## Recommended Delivery Order

Implement in the order below. The ranking optimizes for coverage gain vs expected runtime cost.

| Rank | Target | Current Gap | Global Line Ceiling | Runtime Cost | Test File |
|------|--------|-------------|---------------------|--------------|-----------|
| 1 | `worker/src/cron/dex-liquidity/process-pools.ts` | 112 lines / 91 branches | `+1.11 pts` | Low | `worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts` |
| 2 | `worker/src/cron/dex-liquidity/scoring.ts` | 183 lines / 124 branches | `+1.81 pts` | Low-Medium | `worker/src/cron/__tests__/dex-liquidity-scoring.test.ts` |
| 3 | `worker/src/cron/dex-liquidity/pool-helpers.ts` | 59 lines / 72 branches | `+0.58 pts` | Low | `worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts` |
| 4 | `worker/src/cron/confirm-pending-depegs.ts` | 87 lines / 73 branches | `+0.86 pts` | Medium | `worker/src/cron/__tests__/confirm-pending-depegs.test.ts` |
| 5 | `worker/src/cron/dex-liquidity/persistence.ts` | 31 lines / 14 branches | `+0.31 pts` | Low | `worker/src/cron/__tests__/dex-liquidity-persistence.test.ts` |
| 6 | `worker/src/lib/status-reliability.ts` | 28 lines / 48 branches | `+0.28 pts` | Very Low | expand `worker/src/lib/__tests__/status-reliability.test.ts` |
| 7 | `src/lib/severity-colors.ts` | 31 lines / 44 branches | `+0.31 pts` | Very Low | `src/lib/__tests__/severity-colors.test.ts` |
| 8 | `worker/src/lib/twitter.ts` | 37 lines / 12 branches | `+0.37 pts` | Low | `worker/src/lib/__tests__/twitter.test.ts` |
| 9 | `worker/src/lib/coingecko-onchain.ts` | 23 lines / 24 branches | `+0.23 pts` | Low | `worker/src/lib/__tests__/coingecko-onchain.test.ts` |
| 10 | `worker/src/lib/abort.ts` + `worker/src/lib/stablecoins-cache.ts` | 23 lines / 20 branches combined | `+0.23 pts` | Very Low | expand `worker/src/lib/__tests__/stablecoins-cache.test.ts` and add `worker/src/lib/__tests__/abort.test.ts` |

The theoretical ceiling of these 10 items is about `+6.09` global line-coverage points. Realized gain will be lower because some lines will remain intentionally unreachable or not worth forcing.

## Batch Plan

To keep momentum high and feedback loops short, execute in batches:

- Batch A: items 1-3
- Batch B: items 4-5
- Batch C: items 6-10

Run verification after each batch, then run full verification at the end.

## Detailed Work Items

### 1. `process-pools.ts`

Target: `worker/src/cron/dex-liquidity/process-pools.ts`

Create: `worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts`

Why first:

- Largest cheap pure-function target still uncovered
- No real network required
- High branch density with simple synthetic fixtures

Scenarios to cover:

1. skips dust TVL, absurd TVL, blocked DEX IDs, non-whitelisted DEXes, and `exposure === "single"`
2. matches by underlying token address first, and learns address mappings from unambiguous symbol/token pairs
3. falls back to symbol matching only for non-colliding symbols
4. preserves collision safety by refusing ambiguous symbol-only matches
5. resolves Curve stable vs crypto pools, including A-factor branch and metapool-adjusted TVL only for address matches
6. resolves Uni v3 fee tiers from address map and then from symbol map fallback
7. resolves Aerodrome stable override when `isStable === true`
8. computes organic fraction from `apyBase / apy`, plus the fallback branches for zero/near-zero APY
9. computes maturity from Curve creation timestamp and from `count` fallback
10. writes enriched `topPools` extras and accumulates weighted balance, stress, protocol TVL, and chain TVL correctly

Fixture strategy:

- Build a tiny synthetic pool list with 5-8 pools max
- Use one stablecoin with unambiguous symbol and one colliding-symbol case
- Keep `curvePoolMap`, `uniV3PoolFees`, `uniV3SymbolFees`, and `aerodromeIsStable` as hand-built maps

Acceptance criteria:

- The new suite covers all major matching and enrichment branches
- No production-code export changes are introduced just for convenience

### 2. `scoring.ts`

Target: `worker/src/cron/dex-liquidity/scoring.ts`

Create: `worker/src/cron/__tests__/dex-liquidity-scoring.test.ts`

Why second:

- Biggest remaining line-coverage opportunity
- Still mostly deterministic with a mocked D1 layer

Scenarios to cover for `computeStablecoinScores`:

1. first-run behavior when stability and volume-history queries throw
2. filtering of pools with `volume / tvl > 50` and fake-TVL pools with huge TVL but tiny volume
3. protocol cap scaling for non-DL pools while preserving DL pools
4. aggregate recomputation after pool filtering/scaling
5. global dedup across shared pools
6. top-pool sort and truncation to 10 before HHI calculation
7. per-coin weighted metrics: `weightedBalanceRatio`, `organicFrac`, `avgStress`, `lockedLiqPct`
8. global protocol cap reduction and proportional chain TVL reduction

Scenarios to cover for `computeDepthStability`:

1. skips coins with fewer than 7 days of history
2. skips non-positive mean TVL
3. persists computed stability when valid rows exist
4. logs warning but does not throw on DB failure

Scenarios to cover for `computeDexPrices`:

1. returns early on empty observations
2. loads primary prices from well-formed cache
3. ignores malformed cache JSON
4. computes TVL-weighted median correctly
5. handles divergence/warning branches and persistence batch creation

Fixture strategy:

- Use a minimal fake D1 object instead of substring `mockD1` if that is simpler for multi-query state
- Keep pool observations tiny and explicit
- Stub `Date.now` for stable midnight calculations

Acceptance criteria:

- One suite covers all three exports in this file
- The suite stays deterministic and does not depend on current tracked-stablecoin count beyond placeholder expectations

### 3. `pool-helpers.ts`

Target: `worker/src/cron/dex-liquidity/pool-helpers.ts`

Create: `worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts`

Why third:

- Pure branch-heavy module
- Very low setup cost

Scenarios to cover:

1. `parsePoolSymbols` for known composite names, prefixed composite names, and generic delimiters
2. `classifyPoolType` for Curve, Fluid, Aerodrome, Balancer stable, Balancer weighted, Uni v3, and generic
3. `getQualityMultiplier` with and without Curve A override
4. `getGtDexQuality` known-prefix match and generic fallback
5. `getActiveChainMap` and `getActiveChainReverse` under CoinGecko-onchain enabled and disabled states
6. `computeDurabilityScore` default branches vs weighted branches
7. `computeLiquidityScore` for zero-TVL edge case and healthy multi-chain case
8. `normalizeProtocol` coverage for the named mappings and passthrough branch
9. `getPairQuality` and `computePoolPairQuality` for tracked stablecoin, known volatile asset, and fallback value
10. `computePoolStress`, `isCryptoSwap`, and `buildSymbolLookups`

Acceptance criteria:

- Cover the boundary conditions, not just the happy path
- Avoid any real dependency on live chain-map configuration beyond toggling the exported availability flag

### 4. `confirm-pending-depegs.ts`

Target: `worker/src/cron/confirm-pending-depegs.ts`

Create: `worker/src/cron/__tests__/confirm-pending-depegs.test.ts`

Why fourth:

- Large coverage upside
- Mostly mocked D1 + mocked fetch

Scenarios to cover:

1. returns early when there are no pending rows
2. deletes pending rows with invalid `peg_reference`
3. cleans pending rows when an open event already exists
4. clears pending rows when primary price has recovered below threshold
5. keeps rows that are younger than `DEPEG_PENDING_MIN_AGE_SEC`
6. expires rows older than `DEPEG_PENDING_EXPIRY_SEC`
7. promotes event when CoinGecko agrees
8. promotes event when DEX agrees and CoinGecko is unavailable
9. deletes pending row when both secondaries disagree
10. deletes pending row when CoinGecko disagrees and DEX is missing
11. keeps pending row when both secondaries are unavailable
12. handles missing `dex_prices` table without failing the run
13. rethrows abort-related failures

Fixture strategy:

- Reuse `makeAsset()` where possible
- Stub `Date.now`
- Stub `fetchWithRetry`
- Use a stateful fake D1 to inspect queued statements if `mockD1` becomes too rigid

Acceptance criteria:

- Every decision branch in the confirmation state machine is exercised
- Tests assert both side effects and non-side effects

### 5. `persistence.ts`

Target: `worker/src/cron/dex-liquidity/persistence.ts`

Create: `worker/src/cron/__tests__/dex-liquidity-persistence.test.ts`

Why fifth:

- Good coverage return for a small isolated file
- Easy to validate via captured prepared statements

Scenarios to cover for `persistScores`:

1. writes data rows for scored coins
2. writes placeholder rows for tracked coins missing from `metrics`
3. always writes the `__global__` sentinel row
4. passes the expected serialized payloads into the upsert statements

Scenarios to cover for `writeHistoricalSnapshots`:

1. exits early when existing row count and scored count are already good enough
2. rewrites the snapshot when existing coverage is degraded
3. inserts placeholder rows for missing coins
4. logs warning but does not throw on DB failure

Fixture strategy:

- Mock `batchExecute` and inspect the prepared statements array length and bound values
- Stub `Date.now` so the midnight snapshot date is stable

Acceptance criteria:

- Tests assert row counts and the presence of placeholder/global rows
- No D1 batch-size logic is reimplemented in tests

### 6. `status-reliability.ts`

Target: `worker/src/lib/status-reliability.ts`

Expand: `worker/src/lib/__tests__/status-reliability.test.ts`

Why sixth:

- Existing suite is already very fast
- A small number of additional tests should unlock many untouched branches

Add scenarios for:

1. healthy -> stale immediate escalation
2. stale -> degraded recovery after dwell threshold
3. stale -> healthy recovery after dwell threshold
4. snapshot read with stale `ageSeconds`
5. recent transition listing with bounded limit and optional range filters
6. `writeStatusProbeRun` success and migration-missing swallow path
7. `getLatestStatusProbe` no-row fallback and real-row mapping
8. `updateDiscrepancyObservation` for divergent and non-divergent updates
9. `markDiscrepancyAlertSent` and `markProbeFailureAlertSent`
10. `getDiscrepancyStreak` success and failure fallback
11. `buildDiscrepancy` for unknown probe, stale probe, and fresh divergent probe

Acceptance criteria:

- Extend the existing stateful D1 fake instead of building a second competing harness
- Preserve the current fast runtime profile

### 7. `severity-colors.ts`

Target: `src/lib/severity-colors.ts`

Create: `src/lib/__tests__/severity-colors.test.ts`

Why seventh:

- Extremely cheap to test
- No current direct coverage despite many small branch functions

Scenarios to cover:

1. `deviationColorClass` at `<50`, `50-199`, `200-499`, `>=500`
2. `deviationBgClass` at the same boundaries
3. `deviationColorHex` at the same boundaries
4. `deviationIconName` at the same boundaries
5. `getScoreTier` at `<40`, `40-59`, `60-79`, `>=80`
6. `getScoreColor` matches `TIER_TEXT`
7. `pegScoreColor` for `null`, `>=90`, `70-89`, `<70`
8. `getDurabilityColor` and `getDurabilityBgColor` at `40` and `70`

Acceptance criteria:

- Boundary assertions should be exact
- No component rendering is needed; keep this as a pure unit test

### 8. `twitter.ts`

Target: `worker/src/lib/twitter.ts`

Create: `worker/src/lib/__tests__/twitter.test.ts`

Why eighth:

- Good line gain for a self-contained module
- Mostly string and request-shape assertions

Scenarios to cover:

1. `buildTweetText` strips duplicated title prefix from digest text
2. `buildTweetText` injects a cashtag only on the first symbol mention
3. `buildTweetText` truncates at a word boundary when over 280 chars
4. `postDigestTweet` posts the computed text to the Twitter v2 endpoint
5. OAuth header contains the required keys
6. failed Twitter response throws with status/body snippet

Implementation notes:

- Drive the private OAuth code through `postDigestTweet`; do not export internals just for tests
- Stub:
  - `fetch`
  - `Date.now`
  - `crypto.randomUUID`
  - `crypto.subtle.importKey`
  - `crypto.subtle.sign`
  - `btoa`

Acceptance criteria:

- The suite verifies the public behavior without changing production exports

### 9. `coingecko-onchain.ts`

Target: `worker/src/lib/coingecko-onchain.ts`

Create: `worker/src/lib/__tests__/coingecko-onchain.test.ts`

Why ninth:

- Small wrapper module with many currently untouched branches
- Cheap fetch stubbing

Scenarios to cover:

1. `initOnchainAvailability` / `isOnchainAvailable` for blank and non-blank API key
2. `onchainRateLimit` no-op when `requestCount === 0`
3. `onchainRateLimit` delegates to `sleepWithSignal` when `requestCount > 0`
4. `fetchCgTokenPools` returns `[]` on non-OK response
5. `fetchCgTokenPools` returns parsed `data` array on success
6. `fetchCgTokensBatch` returns early on empty address list
7. `fetchCgTokensBatch` returns `[]` on non-OK response
8. `fetchCgTokensBatch` returns parsed `data` array on success
9. `parseCgPoolVolume` prefers flat `h24_volume_usd`
10. `parseCgPoolVolume` falls back to nested `volume_usd.h24`
11. `parseCgPoolVolume` returns `0` for invalid or absent values

Acceptance criteria:

- No live API calls
- Keep the suite small and deterministic

### 10. Utility micro-sweep: `abort.ts` + `stablecoins-cache.ts`

Targets:

- `worker/src/lib/abort.ts`
- `worker/src/lib/stablecoins-cache.ts`

Expand/create:

- expand `worker/src/lib/__tests__/stablecoins-cache.test.ts`
- add `worker/src/lib/__tests__/abort.test.ts`

Why tenth:

- Tiny runtime cost
- Useful branch cleanup at the end of the campaign

`abort.ts` scenarios:

1. `abortError` returns the original `Error` reason
2. `abortError` wraps a non-empty string reason
3. `abortError` falls back to `"Operation aborted"`
4. `throwIfAborted` is a no-op for active signals
5. `throwIfAborted` throws for aborted signals
6. `sleepWithSignal` returns immediately for `ms <= 0`
7. `sleepWithSignal` rejects if already aborted
8. `sleepWithSignal` rejects when aborted during sleep

`stablecoins-cache.ts` scenarios still missing:

1. lenient mode on missing cache returns `ok: true` with `warningReason: "missing-cache"`
2. strict mode on invalid payload shape returns `invalid-payload-shape`
3. lenient mode on invalid payload shape returns empty payload with warning
4. object payload with mixed valid/invalid `fxFallbackRates` keeps only finite numbers
5. object payload with no valid `fxFallbackRates` omits the field

Acceptance criteria:

- Keep these as pure fast tests
- Do not overbuild custom harnesses

## Out of Scope For This Plan

Do not spend time on these until the 10 items above are complete:

- `worker/src/cron/dex-liquidity/fetch-primary.ts`
- `worker/src/cron/dex-liquidity/fetch-crawlers.ts`
- `worker/src/api/backfill-depegs.ts`
- `src/hooks/use-portfolio.ts`
- `scripts/smoke-api.mjs`

They have large raw gaps, but their setup cost is materially higher, so they are less efficient for this specific campaign.

## Verification Cadence

After each item:

```bash
npx vitest run path/to/new-or-modified.test.ts
```

After each batch:

```bash
npm test
```

Final verification for the full campaign:

```bash
npm run lint
npm test
npm run test:coverage
cd worker && npx tsc --noEmit
```

If any item adds helper code under `worker/src/api/__tests__/helpers/`, rerun the directly impacted neighboring suites as well.

## Final Acceptance Criteria

The campaign is complete when all of the following are true:

1. all 10 work items are implemented
2. the new tests are deterministic and isolated
3. `npm run lint` passes
4. `npm test` passes
5. `npm run test:coverage` passes
6. `cd worker && npx tsc --noEmit` passes
7. the final summary reports actual coverage deltas from a fresh coverage run

## Expected Reporting Format For The Implementing Agent

At the end of the work, the agent should report:

1. which items were completed
2. any item that required a production-code seam, with justification
3. the verification commands run
4. the before/after coverage numbers from the fresh final run
5. any remaining high-leverage follow-up items
