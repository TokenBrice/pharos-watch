# DEX Liquidity Simplification Research

Date: 2026-04-14

Target: complexity audit item 3, DEX liquidity coordinator, scoring, shared direct-API helpers, and API projection.

## Scope

Primary files:

- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `worker/src/cron/dex-liquidity/orchestrator-phases.ts`
- `worker/src/cron/dex-liquidity/orchestrator-metadata.ts`
- `worker/src/cron/dex-liquidity/process-pools.ts`
- `worker/src/cron/dex-liquidity/scoring.ts`
- `worker/src/lib/dex-api-common.ts`
- `worker/src/api/dex-liquidity.ts`

Docs reviewed:

- `docs/dex-liquidity.md`
- `docs/liquidity-score-timeline.md`

## Current Behavior Map

`syncDexLiquidity()` currently owns the full scoring run:

1. Load price validation references, tracked stablecoin prices, and market caps.
2. Fetch primary data sources through `fetchDataSources()`.
3. Build symbol/address lookup maps.
4. Build Curve lookups and initial price observations.
5. Build direct API fetchers.
6. Fetch UniV3/Aerodrome subgraph enrichment.
7. Run direct API fetches and build authoritative staged-pool confirmation.
8. Prefer direct API pools over overlapping DL pools.
9. Build known pool identity index.
10. Process primary DL/Curve/subgraph pools into liquidity metrics.
11. Integrate direct API pools and price observations.
12. Merge staged discovery pools.
13. Run in-run DexScreener and CoinGecko ticker fallbacks.
14. Compute scores, retained pools, global aggregates, stability maps, and diagnostics.
15. Analyze post-score coverage and value guardrails.
16. Persist `dex_liquidity`.
17. Publish challenger snapshots.
18. Rebuild and persist `dex_prices`.
19. Write historical snapshots.
20. Persist depth stability.
21. Build cron metadata and final status.

`handleDexLiquidity()` then reads `dex_liquidity`, `dex_liquidity_history`, `dex_prices`, and last cron metadata, and projects the public JSON response, trend baselines, warnings, evidence classification, and methodology fallback.

## Why This Is A Good Simplification Target

This pipeline already has useful phase modules, but `syncDexLiquidity()` still has too much live state threaded across the whole function:

- `failedSources`
- `criticalSourceFailures`
- `fallbackSignals`
- `metrics`
- `knownPoolIndex`
- `priceObservations`
- `retainedPoolsByStablecoin`
- `analysis`
- `persistence`
- `historicalSnapshot`

The risk is not that DEX logic is unnecessary. The risk is that critical runtime semantics are implicit in ordering and mutable maps. The first remediation should make the existing ordering explicit with typed phase results.

## Invariants To Preserve

Do not change these in a first remediation tranche:

- Catastrophic DL+Curve failure still throws.
- Non-catastrophic critical source failures degrade when guardrails require it.
- Optional direct API source turbulence alone does not degrade the run when coverage/value guardrails remain healthy.
- Subgraph enrichment completes before direct API fetches to preserve connection-budget sequencing.
- Direct API precedence over DL only applies to preferred/eligible direct pools and conservative identity matches.
- Staged discovery authoritative-protocol confirmation must fail open when native direct source is degraded/unavailable.
- Addressed unknown tokens must not fall back to symbol matching.
- Symbol fallback is only allowed for addressless rows and chain-scoped unique symbols.
- Retained-pool scoring and `dex_prices` publication must use final retained pools after filters/dedupe/caps.
- `dex_price_challengers` publication must use retained pools and source coverage completeness rules.
- `dex_liquidity_history` write failure degrades but does not necessarily corrupt the current table write.
- `computeDepthStability()` remains non-fatal.
- API trend baselines must preserve missed-cron tolerance windows and confidence thresholds.
- API warnings must continue reading latest cron metadata and returning `Warning: 199` when degraded/error/drift.
- Response field names in `/api/dex-liquidity` must not change.

## Proposed Split

The first pass should split coordinator staging, not DEX matching logic:

1. Introduce a run context/result model in `orchestrator.ts` or a new `orchestrator-run.ts`:
   - `DexLiquidityRunContext`: db, syncStartSec, graphApiKey, signal, coingeckoApiKey, chainRpcs.
   - `DexLiquiditySourceState`: dataSources, lookup maps, validation references, tracked prices/mcaps.
   - `DexLiquidityPoolState`: metrics, knownPoolIndex, priceObservations, staged counters, fallback counters.
   - `DexLiquidityScoreState`: scoreResults, globalAgg, retainedPoolsByStablecoin, tvlStabilityMap, diagnostics, analysis.
   - `DexLiquidityPersistenceState`: persistence, challengerPublication, historicalSnapshot.
2. Add phase functions that return those objects:
   - `loadDexLiquiditySourceState(ctx)`
   - `buildDexLiquidityPoolState(ctx, sourceState)`
   - `scoreDexLiquidityPoolState(ctx, poolState)`
   - `persistDexLiquidityScoreState(ctx, poolState, scoreState)`
   - `buildDexLiquidityCronResult(...)`
3. Leave `processPoolMetrics()` intact in the first pass.
4. Leave `dex-api-common.ts` intact in the first pass.
5. Second pass:
   - split `processPoolMetrics()` into matching, enrichment resolution, and accumulation.
   - split `dex-api-common.ts` into direct token pricing, pool conversion, and observation extraction.
6. Third pass:
   - move `handleDexLiquidity()` projection helpers into `worker/src/lib/dex-liquidity-response.ts` or similar.

## Suggested File Touch Plan

Tranche A, coordinator shape:

- `worker/src/cron/dex-liquidity/orchestrator.ts`
  - keep public `syncDexLiquidity()`.
  - extract the body into typed private phase helpers.
  - no behavior changes.
- `worker/src/cron/dex-liquidity/orchestrator-phases.ts`
  - reuse current functions; do not expand public API unless needed.
- `worker/src/cron/dex-liquidity/orchestrator-metadata.ts`
  - no major changes; pass typed phase results into existing metadata builder.

Tranche B, pure scoring/persistence boundary:

- `worker/src/cron/dex-liquidity/scoring.ts`
  - split `computeStablecoinScores()` pure-ish scoring from retained-pool/global cap aggregation if feasible.
  - keep `computeDexPrices()` and `computeDepthStability()` as write-side functions for now.

Tranche C, API projection:

- `worker/src/api/dex-liquidity.ts`
  - extract `normalizeTopPools`, `selectTrendBaseline`, `buildDexLiquidityWarning`, `classifyLiquidityEvidence`, and row projection into a response builder.
  - keep handler DB access and response headers thin.

## Tests To Add Or Reuse

Existing tests to run for any DEX liquidity remediation:

- `worker/src/cron/__tests__/sync-dex-liquidity.test.ts`
- `worker/src/cron/dex-liquidity/__tests__/orchestrator-phases.test.ts`
- `worker/src/cron/dex-liquidity/__tests__/orchestrator-metadata.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-scoring.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-series-stability.test.ts`
- `worker/src/cron/__tests__/dex-api-common.test.ts`
- `worker/src/api/__tests__/dex-liquidity.test.ts`

Characterization tests worth adding before Tranche A:

- `syncDexLiquidity()` still waits for subgraph enrichment before direct API fetches.
- Optional direct API failure does not degrade when guardrails stay healthy.
- Critical DL source failure degrades and sets the same `failedSources` / `fallbackMode` entries.
- Hard coverage/value/major-coverage guards still throw.
- Challenger publication receives retained pools and coverage completeness after persistence.
- `computeDexPrices()` still runs after challenger publication and uses retained pools.

Characterization tests worth adding before Tranche C:

- API response for a fixture row is byte-for-byte equivalent before/after extraction.
- Trend baseline ignores low-confidence or unobserved history rows.
- Warning header handles `degraded`, `error`, and `ok with qualityDriftSeverity`.
- Legacy pool source aliases `cg`, `gt`, and `ds` normalize exactly as today.

## Do Not Change Public Contracts

- `dex_liquidity` and `dex_prices` table write shapes.
- Cron metadata keys documented in `docs/dex-liquidity.md`.
- `fallbackMode` and `failedSources` warning semantics.
- `coverage_class`, `coverage_confidence`, `source_mix_json`, and measurement fields.
- `/api/dex-liquidity` response field names and cache/freshness headers.
- Liquidity methodology version.

## Open Questions Before Implementation

- Should the phase-result types live in `orchestrator.ts` first, or in a new module? Recommendation: keep them local in the first PR to reduce export surface, then move only if tests need direct imports.
- Should `computeDexPrices()` remain in `scoring.ts`? It is a write-side function, but moving it in the first tranche risks mixing coordinator refactor with persistence reshuffle.
- Should API trend/warning projection move before or after coordinator split? Recommendation: after, because it is lower operational risk but less valuable than making cron semantics explicit.
