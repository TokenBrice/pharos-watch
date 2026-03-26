# Pharos Maintainability Audit

Date: 2026-03-26
Scope: frontend, shared logic, Worker API, cron pipelines, production-critical data paths

## Executive Summary

1. `findBestLendingPool()` has an active contract drift: tests and docs say exact symbol match should win, but production code currently prefers address matches first. This is already a red test and can attach the wrong lending pool to a stablecoin.
2. `buildReportCardsSnapshot()` is all-or-nothing on optional data loaders. A failure in DEX liquidity or live reserves can currently take `/api/report-cards` down even though card computation already tolerates those inputs being absent.
3. Health/status observability is split across two independently evolving implementations. `/api/health` and `/api/status` can describe the same incident differently, which raises operator burden during live failures.
4. Several domain semantics are duplicated instead of shared: collateral drift detection, dependency graph derivation, and chain-circulation normalization. These are low-risk consolidation targets that would reduce drift and make future changes cheaper.
5. The main cron hotspots are still concentrated in a few oversized orchestrators (`syncDexLiquidity`, `syncFxRates`, `syncStablecoins`). They are well-tested, but each change now carries avoidable review and regression cost because acquisition, validation, fallback policy, and persistence are interleaved.

Two checks came back clean and are not top-priority problems in this pass: `npm run check:unused-code` found no dead internal modules/exports, and `npm run audit:deps` reported no known vulnerabilities.

## Critical Findings

### CF-1: Yield auto-discovery pool selection has a live contract mismatch

- Location: `worker/src/cron/yield-helpers.ts:240-311`, `worker/src/cron/yield-sync/resolve.ts:603-621`, `worker/src/cron/__tests__/yield-helpers.test.ts:518-522`, `docs/yield-intelligence.md:231`, `docs/yield-intelligence-timeline.md:145-152`
- Category: Production Risk
- Severity: Critical
- Current State: `findBestLendingPool()` currently returns the highest-TVL underlying-address match before considering exact symbol candidates. That behavior conflicts with the current test expectation (`p5` expected, `p6` returned), the public docs for auto-discovery, and the timeline note that address matching is a fallback when symbol matching fails. Because `yield-sync/resolve.ts` uses this helper for `defillama-auto` lending discovery, the mismatch can silently attach the wrong pool to a tracked stablecoin and skew yield rankings.
- Recommended Change: Define one explicit precedence contract for auto-discovery and align code, tests, and docs to it. Given the current docs/tests, the lowest-risk fix is to make exact symbol matches win first and use address matches only as fallback. Add characterization tests for ambiguous cases: exact symbol plus shared address, multi-address collisions, and chain-filtered ties.
- Risk Assessment: Changing precedence can move some auto-discovered pool assignments. Mitigate by replaying the current tracked universe through the helper, diffing the resulting `defillama-auto` assignments, and reviewing only the changed assets before shipping.

### CF-2: Report cards snapshot fails closed on optional inputs and can drop a critical endpoint

- Location: `worker/src/lib/report-cards-snapshot.ts:86-113`, `worker/src/lib/report-cards-snapshot.ts:115-123`, `worker/src/lib/report-cards-snapshot.ts:160-189`, `worker/src/lib/report-cards-snapshot.ts:283-310`, `worker/src/api/report-cards.ts:8-17`, `worker/src/lib/dex-liquidity.ts:24-50`, `worker/src/lib/live-reserves-store.ts:1148-1163`, `worker/src/lib/__tests__/report-cards-snapshot.test.ts:44-158`
- Category: Production Risk
- Severity: Critical
- Current State: `buildReportCardsSnapshot()` loads stablecoins, bluechip ratings, DEX liquidity, redemption backstops, and live reserves in one `Promise.all()`. Only redemption-backstop unavailability is converted into a controlled `ReportCardsSnapshotUnavailableError`; other loader failures bubble out and make `/api/report-cards` return a generic failure. That is stricter than the scoring code itself: `computeCard()` already tolerates missing liquidity (`liq` can be `undefined`) and missing live reserves (`liveSlices` absent falls back to curated reserves). Tests cover missing stablecoins and missing redemption backstops, but not degraded behavior when liquidity/live-reserve loaders fail.
- Recommended Change: Keep stablecoins and redemption backstops as hard dependencies, but treat DEX liquidity, bluechip ratings, and live reserves as soft dependencies. Replace the current all-or-nothing load with guarded per-loader fallbacks or `Promise.allSettled()`, emit snapshot metadata/warnings when those inputs are absent, and add tests proving `/api/report-cards` still serves cards when those optional loaders fail.
- Risk Assessment: The main risk is accidentally masking a truly hard dependency. Mitigate by preserving explicit failure behavior for stablecoins and redemption backstops, and by surfacing degraded metadata in the response so operators still see that the snapshot is incomplete.

## Redundancy Report

### RR-1: `/api/health` and `/api/status` duplicate incident assessment logic

- Location: `worker/src/api/health.ts:32-216`, `worker/src/lib/status-evaluation.ts:165-741`, `worker/src/lib/api-utils.ts:72-187`, `worker/src/api/status.ts:25-56`
- Category: Redundancy
- Severity: High
- Current State: Both endpoints perform their own DB sentinel checks, cache freshness interpretation, mint/burn freshness handling, blacklist-gap degradation, and circuit-state impact mapping. They share `buildCacheStatuses()`, but the thresholding and downgrade rules diverge after that. For example, `/api/health` mutates `worstRatioMut` to `1.6` or `2.1` when certain sections fail, while `/api/status` derives availability/data-quality states through a separate cause model. That creates two operator views of the same failure domain and forces every threshold change to be made twice.
- Recommended Change: Extract a shared assessment layer that computes normalized health inputs and severity floors once, then let `/api/health` and `/api/status` format different payloads from the same core result. Keep the endpoint contracts intact; only centralize the underlying evaluation rules and source loaders.
- Risk Assessment: Consolidation can accidentally alter public payload details. Mitigate with contract tests that snapshot current `/api/health` and `/api/status` responses for representative scenarios before refactoring, then diff after extraction.

### RR-2: Collateral drift detection is implemented twice with duplicated thresholds

- Location: `worker/src/lib/report-cards-snapshot.ts:177-189`, `worker/src/lib/collateral-drift.ts:5-47`
- Category: Redundancy
- Severity: Medium
- Current State: The report-cards snapshot independently recomputes collateral drift and live-to-curated fallback lists even though `checkCollateralDrift()` already exists for the hourly reserve sync path. The duplicate code also hardcodes the `15`-point drift threshold in one place while the other uses `DRIFT_THRESHOLD`. This increases the odds that alerting, status metadata, and report-card metadata drift apart during future methodology changes.
- Recommended Change: Extract one shared helper that returns `driftCoins`, `fallbackCoins`, and the threshold used, then reuse it in both `checkCollateralDrift()` and `buildReportCardsSnapshot()`. Keep the existing outward behavior; only eliminate the duplicate implementation.
- Risk Assessment: Very low. The risk is mostly around ordering and payload shape differences. Mitigate by preserving the current sort/order behavior and adding a small unit test that both call sites produce the same drift set from the same mock live-reserve map.

### RR-3: Dependency graph semantics are recomputed in multiple places instead of consuming one canonical graph

- Location: `worker/src/lib/report-cards-snapshot.ts:248-263`, `src/hooks/use-coverage-matrix-model.ts:46-80`, `src/app/dependency-map/client.tsx:39-76`, `src/lib/contagion-layout.ts:201-275`, `src/hooks/use-stress-test.ts:156-175`
- Category: Redundancy
- Severity: Medium
- Current State: The Worker already emits `dependencyGraph.edges` in the report-cards snapshot, and `useStressTest()` consumes that graph directly. Other frontend paths ignore it and re-derive dependencies locally from `deriveDependencies(meta)` with their own filtering and aggregation logic. That creates multiple definitions of "dependency-covered" or "hub" coins and makes the frontend vulnerable to semantic drift if report-card dependency rules change.
- Recommended Change: Promote one canonical dependency-graph helper in `shared/lib/` or standardize on the API-provided `dependencyGraph` for consumers that need graph semantics. View-specific ranking and layout logic can stay local, but edge derivation and live-edge filtering should not be duplicated.
- Risk Assessment: Low. The main risk is changing the exact set/order of displayed hubs. Mitigate by adding a shared graph fixture and asserting that coverage, stress-test targeting, and dependency-map hub counts agree on the same input.

### RR-4: Chain-circulation normalization is duplicated and inconsistent across views

- Location: `shared/lib/chain-aggregator.ts:53-93`, `src/hooks/use-chains.ts:37-63`, `src/components/stablecoin-detail/distribution-section.tsx:216-232`, `src/lib/dex-constants.ts:106-110`
- Category: Redundancy
- Severity: Medium
- Current State: The chains aggregate view resolves raw DefiLlama keys through `resolveChainId()` and merges aliases like display names and alternate IDs. The stablecoin detail donut does not: it lowercases raw keys and looks up `CHAIN_META` directly. That means alias-heavy inputs can group differently across `/chains`, chain detail pages, and the stablecoin distribution UI, which is a data-presentation drift on top of duplicated normalization logic.
- Recommended Change: Extract a shared chain-circulation canonicalizer in `shared/lib/` that collapses raw `chainCirculating` entries by canonical chain ID and returns both totals and display metadata. Reuse it in the chain aggregator, `useChainStablecoins()`, and the detail distribution card.
- Risk Assessment: Low. The only meaningful risk is a visible regrouping of existing alias entries. Mitigate by snapshotting one alias-heavy stablecoin before/after and confirming that totals stay constant while labels become consistent.

## Code Quality Findings

### CQ-1: `syncDexLiquidity()` is an oversized orchestrator with too many responsibilities

- Location: `worker/src/cron/dex-liquidity/orchestrator.ts:188-1019`, `worker/src/cron/__tests__/sync-dex-liquidity.test.ts:142-361`
- Category: Code Quality
- Severity: High
- Current State: One function is responsible for loading validation references, hydrating tracked-quote prices, fetching multiple source families, managing circuit-breaker behavior, merging observations, deduplicating pools, computing coverage/diagnostics, persisting current rows and history, and synthesizing cron metadata. The function is still coherent enough to work, but the cost of changing any single concern is high because state and side effects are shared across the whole flow.
- Recommended Change: Split the function into explicit phases with typed handoff objects, for example: `loadInputs`, `fetchExternalSources`, `mergePoolObservations`, `computeCoverageDiagnostics`, and `persistDexLiquiditySnapshot`. Keep the top-level orchestration and metadata schema stable; only move logic behind phase boundaries.
- Risk Assessment: Moderate. This function sits on a critical market-data path. Mitigate by refactoring in small moves with no behavior changes, leaning on the existing test suite and adding a couple of metadata snapshot tests before extraction.

### CQ-2: `syncFxRates()` hides a complex state machine inside mutable local state and nested closures

- Location: `worker/src/cron/sync-fx-rates.ts:256-798`, `worker/src/cron/__tests__/sync-fx-rates.test.ts:23-1159`
- Category: Code Quality
- Severity: High
- Current State: `syncFxRates()` interleaves source fetches, source provenance bookkeeping, cadence logic, live-vs-cached fallback policy, commodity overlays, OXR overlays, circuit recording, and persistence in one long mutable control flow. Important transitions are expressed through local closures mutating shared bags (`usableRates`, `sourceUpdatedAtByPeg`, `sourceModeByPeg`, `sources`, `fallbackMode`) rather than through explicit state objects. That makes the function difficult to reason about when adding or modifying one fallback lane.
- Recommended Change: Extract the internal state machine into small pure helpers that each return typed deltas or a next-state object: primary source resolution, secondary-source enrichment, carry-forward decision, realtime overlay, and persistence assembly. Preserve the current metadata schema and fallback order.
- Risk Assessment: Moderate. The risk is changing subtle precedence or provenance rules. Mitigate by first adding characterization tests around source metadata and mode transitions for a few representative fallback combinations, then extracting one phase at a time.

### CQ-3: `syncStablecoins()` mixes intake, pricing, validation, cache publication, and downstream side effects in one path

- Location: `worker/src/cron/sync-stablecoins.ts:61-372`, `worker/src/cron/__tests__/sync-stablecoins.test.ts:244-1774`
- Category: Code Quality
- Severity: High
- Current State: The main stablecoin sync handles DefiLlama intake, fallback strategy selection, fresh FX loading, primary pricing, enrichment, GT probing, authoritative overrides, post-enrichment validation, supply-history fill, staleness gating, cache write decisions, circuit recording, and depeg pipeline kickoff in a single function. The test suite is strong, but the implementation is still a large serial workflow where control-flow intent is hard to see at a glance.
- Recommended Change: Create explicit phase helpers around the existing steps and return a typed run context from phase to phase. The first incremental cut should separate `loadIntake`, `resolvePrices`, `validatePublishablePayload`, and `publishAndRunDepegPipeline` without changing the fallback policy.
- Risk Assessment: Moderate. This is the core data-ingest path. Mitigate by extracting phases without altering call order, and by preserving the current progress-reporting and metadata writes so external observability does not change.

## Sustainability Roadmap

1. Fix the active yield matcher contract (`CF-1`).
   Impact: Highest. Effort: Low to medium.
   Outcome: Removes an active regression, realigns code/docs/tests, and prevents silent yield misassignment.

2. Make report cards degrade gracefully on soft-dependency failures (`CF-2`).
   Impact: Highest. Effort: Medium.
   Outcome: Preserves availability of a critical endpoint during partial data-source failure.

3. Consolidate shared semantics before doing larger refactors (`RR-1` to `RR-4`).
   Impact: High. Effort: Low to medium.
   Outcome: Reduces drift risk and creates safer foundations for later code movement.

4. Split the largest cron orchestrators phase-by-phase (`CQ-1` to `CQ-3`).
   Impact: High. Effort: Medium.
   Outcome: Makes future logic changes cheaper and easier to review without rewriting the pipelines.

5. After the above, target the remaining acknowledged hotspots.
   Impact: Medium. Effort: Medium.
   Candidates: `worker/src/lib/status-evaluation.ts:165-741`, `src/components/contagion-graph.tsx:72-798`, `src/app/coverage/client.tsx:394-805`, `src/app/admin/client.tsx:51-788`, `worker/src/cron/compute-dews.ts:151-681`.

## Quick Wins

- Align `findBestLendingPool()` with the documented/tested precedence and update the yield docs in the same change.
- Change report-card loader handling so DEX liquidity and live reserves fall back to empty maps instead of aborting the whole endpoint.
- Replace the duplicate collateral-drift implementation in `buildReportCardsSnapshot()` with a call to one shared helper.
- Introduce one canonical dependency-graph helper and convert one consumer at a time, starting with `useCoverageMatrixModel()`.
- Introduce one canonical `chainCirculating` normalizer and reuse it in both `/chains` and the stablecoin detail distribution card.

## Verification

- `npm run check:unused-code` ✅
- `npm run check:hotspot-ratchet` ✅
- `npm run lint` ✅
- `cd worker && npx tsc --noEmit` ✅
- `npm run audit:deps` ✅ (`0 vulnerabilities`)
- `npm run build` ✅
- `npm test` ❌
  - Failing test: `worker/src/cron/__tests__/yield-helpers.test.ts > findBestLendingPool > prefers exact symbol match over address fallback`
  - Assertion: expected `"p5"`, received `"p6"`
