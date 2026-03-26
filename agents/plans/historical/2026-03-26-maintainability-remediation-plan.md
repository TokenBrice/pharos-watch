# Maintainability Remediation Plan

Date: 2026-03-26
Source audit: `agents/audits/2026-03-26-maintainability-audit.md`
Goal: remediate all critical/high/medium findings with incremental, low-risk changes that preserve behavior unless a bug is explicitly fixed.

## Current State Verification

| ID | Finding | Prior Severity | Current State | Evidence | Plan Disposition |
| --- | --- | --- | --- | --- | --- |
| CF-1 | Yield auto-discovery matcher contract drift | Critical | Closed | `findBestLendingPool()` now intentionally prefers address matches before symbol fallback in `worker/src/cron/yield-helpers.ts:240-311`; identity resolution now drops ambiguous candidates in `worker/src/cron/yield-sync/identity.ts:43-130`; docs reflect address-first matching in `docs/yield-intelligence.md:231`; `npm test -- worker/src/cron/__tests__/yield-helpers.test.ts` passes (74/74) and includes `prefers address match over exact symbol when both are available` in `worker/src/cron/__tests__/yield-helpers.test.ts:560-590`. | No remediation required. Keep as a validated closure item and preserve regression coverage. |
| CF-2 | Report cards fail closed on soft dependencies | Critical | Open | `worker/src/lib/report-cards-snapshot.ts:86-113` still uses one `Promise.all()` across stablecoins, bluechip ratings, DEX liquidity, redemption backstops, and live reserves; `worker/src/lib/__tests__/report-cards-snapshot.test.ts` still has only 5 tests and no degraded-path coverage for liquidity/live-reserve loader failure. | Remediate in Workstream 1. |
| RR-1 | `/api/health` and `/api/status` duplicate incident assessment logic | High | Open | `worker/src/api/health.ts:32-216` still independently computes DB/cache/blacklist/mint-burn/circuit status; `worker/src/lib/status-evaluation.ts:165-741` still computes overlapping status semantics separately. | Remediate in Workstream 2. |
| RR-2 | Collateral drift detection duplicated | Medium | Partially resolved | Shared threshold helper now exists in `shared/lib/status-thresholds.ts`, and `worker/src/lib/collateral-drift.ts:1-47` uses it; `worker/src/lib/report-cards-snapshot.ts:177-189` still reimplements the drift loop and still hardcodes `delta > 15`. | Finish remediation in Workstream 1. |
| RR-3 | Dependency graph semantics are recomputed in multiple places | Medium | Open | Worker emits canonical edges in `worker/src/lib/report-cards-snapshot.ts:248-263`, but frontend still re-derives from metadata in `src/hooks/use-coverage-matrix-model.ts:46-80`, `src/app/dependency-map/client.tsx:39-76`, and `src/lib/contagion-layout.ts:201-275`. | Remediate in Workstream 3. |
| RR-4 | Chain-circulation normalization duplicated and inconsistent across views | Medium | Open | `shared/lib/chain-aggregator.ts:53-95` and `src/hooks/use-chains.ts:37-64` both canonicalize aliases through `resolveChainId()`, while `src/components/stablecoin-detail/distribution-section.tsx:216-232` still lowercases raw keys and does direct `CHAIN_META` lookup. | Remediate in Workstream 4. |
| CQ-1 | `syncDexLiquidity()` is oversized | High | Open | `worker/src/cron/dex-liquidity/orchestrator.ts` is still 1019 lines and the main function still spans orchestration + merge + persistence responsibilities from `:188` onward. | Remediate in Workstream 5. |
| CQ-2 | `syncFxRates()` hides a complex state machine in mutable local flow | High | Open | `worker/src/cron/sync-fx-rates.ts` is still 798 lines and still uses shared mutable local state across nested closures from `:256` onward. | Remediate in Workstream 6. |
| CQ-3 | `syncStablecoins()` mixes multiple pipeline phases in one path | High | Open | `worker/src/cron/sync-stablecoins.ts` is still one 372-line top-level workflow beginning at `:61`, with intake, pricing, validation, publish, and depeg pipeline decisions interleaved. | Remediate in Workstream 7. |

## Sequencing Principles

1. Fix availability and semantic drift before tackling hotspot refactors.
2. Land shared semantic helpers before moving multiple consumers onto them.
3. Add characterization tests before splitting large cron files.
4. Keep each change backward-compatible at the API and DB layer.
5. Ship in small PRs. Do not combine semantic consolidation with large structural refactors.

## Workstream 0: Yield Closure Validation

Status: completed in code, keep as a guarded closure item.

### Objective

Preserve the yield remediation that already landed and prevent regression while the rest of the plan proceeds.

### Current Evidence

- Address-first matcher behavior is now intentional and documented.
- Ambiguous protocol-native candidates are dropped rather than guessed.
- Coverage manifest and intentional gaps exist (`usg-tangent` is explicit, not silent).

### Actions

1. Do not reopen the old symbol-first matcher behavior.
2. Keep `worker/src/cron/__tests__/yield-helpers.test.ts` and the new identity-resolution tests as mandatory regression guards for future yield changes.
3. When touching yield again, diff source-key continuity explicitly because protocol-native source keys intentionally changed.

### Validation

- `npm test -- worker/src/cron/__tests__/yield-helpers.test.ts`
- Relevant yield sync suites already tied to the changed helpers

## Workstream 1: Report Cards Resilience + Collateral Drift Consolidation

Scope: `CF-2`, `RR-2`
Priority: Highest
Suggested PR count: 1-2
Risk: Moderate, but confined to one endpoint and one shared helper

### Objective

Keep `/api/report-cards` available when soft dependencies fail, and stop maintaining two collateral-drift implementations.

### Files In Scope

- `worker/src/lib/report-cards-snapshot.ts`
- `worker/src/lib/collateral-drift.ts`
- `worker/src/lib/dex-liquidity.ts`
- `worker/src/lib/live-reserves-store.ts`
- `worker/src/api/report-cards.ts`
- `worker/src/lib/__tests__/report-cards-snapshot.test.ts`
- `worker/src/api/__tests__/report-cards.test.ts`
- `docs/report-cards.md`
- `docs/api-reference.md`

### Implementation Steps

1. Extract a dedicated input loader for report cards, for example `loadReportCardsInputs(db)`.
   - Hard dependencies: stablecoins cache, redemption-backstop snapshot.
   - Soft dependencies: DEX liquidity, bluechip cache parse, live reserves.

2. Replace the current all-or-nothing `Promise.all()` with explicit hard/soft dependency handling.
   - Keep hard-dependency failure behavior unchanged.
   - For DEX liquidity failure: fall back to empty `dexLiqMap`, treat liquidity as unavailable/stale, and continue building cards.
   - For live-reserve failure: fall back to an empty `liveReserveMap`, continue scoring from curated reserves, and continue building cards.
   - For bluechip cache parse/load failure: continue with `{}`.

3. Consolidate collateral drift logic.
   - Extract a pure helper that accepts `ACTIVE_STABLECOINS` + `liveReserveMap` and returns:
     - `driftCoins`
     - `fallbackCoins`
   - Use the shared threshold helper from `shared/lib/status-thresholds`.
   - Reuse the helper in both `checkCollateralDrift()` and `buildReportCardsSnapshot()`.

4. Decide the minimal additive snapshot metadata needed to preserve operator diagnosability.
   - Recommended: add an optional warnings/source-health field rather than silently swallowing loader failure.
   - Keep any new fields additive and optional.

### Test Plan

Add or extend tests for:

1. DEX liquidity loader failure still returns a valid snapshot and `/api/report-cards` stays `200`.
2. Live-reserve loader failure still returns a valid snapshot and `liveToFallbackCoins` remains meaningful.
3. Bluechip cache corruption falls back to empty ratings instead of failing the endpoint.
4. Redemption-backstop unavailability still returns the current controlled failure path.
5. Shared drift helper produces the same drift/fallback result for both call sites.

### Risk Controls

- Preserve current response shape for existing fields.
- Make any new metadata additive only.
- Do not weaken hard-dependency handling for stablecoins cache or redemption backstops.

### Definition Of Done

- `/api/report-cards` serves cards during soft-loader failures.
- Drift threshold is no longer duplicated.
- Report-card tests cover both degraded and hard-failure paths.

## Workstream 2: Shared Public Health / Status Assessment Core

Scope: `RR-1`
Priority: High
Suggested PR count: 1
Risk: Moderate because it touches operator-facing incident semantics

### Objective

Remove semantic drift between `/api/health` and `/api/status` by computing shared public-health inputs and downgrade rules once.

### Files In Scope

- `worker/src/api/health.ts`
- `worker/src/lib/status-evaluation.ts`
- `worker/src/lib/api-utils.ts`
- New shared worker helper, e.g. `worker/src/lib/public-health-assessment.ts`
- Existing frontend helper references for parity only:
  - `src/lib/status/public-status.ts`
  - `src/lib/status/cache-health.ts`
- `worker/src/api/__tests__/health.test.ts`
- `worker/src/api/__tests__/status.test.ts`

### Implementation Steps

1. Extract a Worker-side shared core that computes:
   - DB sentinel result
   - cache freshness summary
   - blacklist public-health impact
   - mint/burn public-health impact
   - circuit public-health impact
   - normalized downgrade floor / warnings

2. Make `/api/health` use the shared core directly.
   - Keep the `HealthResponse` contract unchanged.
   - Remove local `worstRatioMut` threshold mutations from the route once equivalent logic lives in the shared core.

3. Make `computeRawStatus()` consume the same core result for the overlapping public-availability portion.
   - Keep `/status` richer than `/health`.
   - Do not collapse `/status` data-quality logic into `/health`; only centralize the overlapping availability/public-impact semantics.

4. Align any duplicated thresholds with the frontend status helpers.
   - If a shared runtime-neutral helper is viable, move pure threshold/status computations into `shared/lib/`.
   - Keep DB loaders Worker-only.

### Test Plan

Add paired health/status tests for the same fixtures:

1. DB sentinel failure
2. cache freshness degraded vs stale
3. blacklist query failure
4. mint/burn critical lane unhealthy
5. repeated FX cached-fallback with fresh usable sync
6. open circuit groups

The goal is not identical payloads; the goal is identical public-health interpretation for the overlapping domains.

### Risk Controls

- Start with extraction-only commits that keep tests green.
- Snapshot the overlapping fields from both endpoints before the refactor.
- Preserve endpoint-specific fields and wording.

### Definition Of Done

- One shared Worker core owns the overlapping downgrade logic.
- Health and status no longer need manual threshold drift fixes in two places.

## Workstream 3: Canonical Dependency Graph Semantics

Scope: `RR-3`
Priority: Medium
Suggested PR count: 1
Risk: Low

### Objective

Stop recomputing dependency edges and live-edge filtering differently across Worker and frontend consumers.

### Files In Scope

- New shared helper, e.g. `shared/lib/dependency-graph.ts`
- `worker/src/lib/report-cards-snapshot.ts`
- `src/hooks/use-coverage-matrix-model.ts`
- `src/app/dependency-map/client.tsx`
- `src/lib/contagion-layout.ts`
- `src/hooks/use-stress-test.ts`
- Tests:
  - new shared helper tests
  - `src/lib/__tests__/contagion-layout.test.ts`
  - coverage/dependency map tests as needed

### Implementation Steps

1. Extract a shared helper that can produce:
   - canonical edge list
   - live-edge filtering given a set of live IDs
   - inbound/outbound aggregates when needed
   - dependency-covered ID set

2. Make `buildReportCardsSnapshot()` call the helper to build `dependencyGraph.edges`.

3. Migrate consumers one by one:
   - `useStressTest()` can stay on API edges
   - `useCoverageMatrixModel()` should stop re-deriving local edges
   - `DependencyMapClient` mobile summary should consume the same canonical helper or the API edges
   - `buildGraphData()` should use canonical live edges instead of re-deriving from metadata

### Test Plan

1. Add one shared fixture with aliased/live/defunct dependency cases.
2. Assert that:
   - report-cards edges
   - coverage dependency IDs
   - dependency-map hub counts
   - contagion graph links
   all agree on the same fixture.

### Risk Controls

- Keep edge direction unchanged (`from: dependency`, `to: dependent`) to avoid breaking consumers.
- Migrate one consumer at a time.

### Definition Of Done

- Canonical dependency semantics live in one place.
- Frontend no longer recomputes edge sets differently from the Worker snapshot.

## Workstream 4: Canonical Chain-Circulation Normalization

Scope: `RR-4`
Priority: Medium
Suggested PR count: 1
Risk: Low

### Objective

Use one chain-circulation canonicalizer across `/chains`, chain detail, and stablecoin detail distribution.

### Files In Scope

- New shared helper, e.g. `shared/lib/chain-circulating.ts`
- `shared/lib/chain-aggregator.ts`
- `src/hooks/use-chains.ts`
- `src/components/stablecoin-detail/distribution-section.tsx`
- `src/hooks/__tests__/use-chains.test.ts`
- `shared/lib/__tests__/chain-aggregator.test.ts`
- New cross-view test for alias-heavy inputs

### Implementation Steps

1. Extract a runtime-neutral helper that:
   - canonicalizes raw chain keys via `resolveChainId()`
   - merges aliased and canonical entries
   - returns summed current/day/week/month buckets
   - optionally returns display metadata for UI use

2. Reuse it in `aggregateChains()`.

3. Replace `findChainData()` internals with the shared helper.

4. Update `ChainDistributionCard` so it uses canonicalized chain buckets instead of direct lowercase `CHAIN_META` lookup.

### Test Plan

1. Preserve the current `use-chains` alias tests.
2. Add one cross-view test proving:
   - chain page totals
   - chain detail rows
   - stablecoin distribution donut labels/counts
   stay consistent for an asset with canonical + alias keys together.

### Risk Controls

- Keep totals invariant.
- Treat label regrouping as acceptable only when totals remain unchanged.

### Definition Of Done

- Chain alias handling exists in one shared helper.
- Stablecoin detail and chain-level views group the same data the same way.

## Workstream 5: `syncDexLiquidity()` Phase Extraction

Scope: `CQ-1`
Priority: High
Suggested PR count: 2-3
Risk: Moderate

### Objective

Make DEX liquidity changes cheaper and safer by splitting the current orchestrator into typed phases without changing behavior.

### Files In Scope

- `worker/src/cron/dex-liquidity/orchestrator.ts`
- New phase helpers under `worker/src/cron/dex-liquidity/`
- `worker/src/cron/__tests__/sync-dex-liquidity.test.ts`

### Implementation Steps

Phase A: characterization
1. Add metadata/result characterization tests for:
   - catastrophic source failure
   - degraded optional source failure
   - stablecoin cache unavailable fallback
   - previous-run drift/evidence telemetry

Phase B: extraction
2. Extract input loading:
   - validation references
   - stablecoin tracked-price context
   - source fetch registry construction

3. Extract external fetch phases:
   - primary source family fetch
   - direct API fetch loop
   - circuit-breaker recording wrapper

4. Extract merge/compute phases:
   - observation assembly
   - pool dedupe / source preference
   - coverage diagnostics and metadata synthesis

5. Extract persistence phase:
   - current snapshot writes
   - history writes
   - final `CronResult` assembly

### Test Plan

- Re-run existing sync suite after each extraction step.
- Add one metadata snapshot test so internal reorganization does not silently change emitted run metadata.

### Risk Controls

- No behavior changes in the same PR as extraction.
- Keep phase inputs/outputs typed and serializable where possible.

### Definition Of Done

- `syncDexLiquidity()` becomes a thin orchestration layer over named phases.

## Workstream 6: `syncFxRates()` State-Machine Extraction

Scope: `CQ-2`
Priority: High
Suggested PR count: 2
Risk: Moderate

### Objective

Replace the current mutable closure-driven flow with explicit phase/state transitions while preserving provenance and fallback order.

### Files In Scope

- `worker/src/cron/sync-fx-rates.ts`
- New helpers under `worker/src/cron/fx-rates/` or adjacent module files
- `worker/src/cron/__tests__/sync-fx-rates.test.ts`

### Implementation Steps

Phase A: characterization
1. Add or tighten tests around:
   - Frankfurter success
   - secondary live fallback
   - ExchangeRate-API live fallback
   - carry-forward mode
   - OXR overlay application
   - provenance/source metadata preservation

Phase B: extraction
2. Introduce an explicit state object, for example:
   - previous state
   - working rates
   - per-peg provenance
   - source statuses
   - sync mode / fallback mode

3. Move the following into pure or near-pure helpers:
   - primary source resolution
   - secondary-source enrichment
   - carry-forward decision
   - realtime overlay
   - final payload assembly

4. Keep DB writes and circuit recording at the orchestration boundary.

### Test Plan

- Preserve all existing sync-fx-rates tests.
- Add assertions around state/provenance transitions if the refactor introduces explicit intermediate types.

### Risk Controls

- Do not reorder fallback precedence.
- Preserve exact emitted metadata keys.

### Definition Of Done

- `syncFxRates()` reads as an explicit state transition pipeline rather than a large mutable block.

## Workstream 7: `syncStablecoins()` Pipeline Phase Extraction

Scope: `CQ-3`
Priority: High
Suggested PR count: 2
Risk: Moderate

### Objective

Separate intake, price resolution, payload validation, publication, and downstream side effects into named phases while keeping the current pipeline behavior intact.

### Files In Scope

- `worker/src/cron/sync-stablecoins.ts`
- Existing helper modules already used by the sync
- `worker/src/cron/__tests__/sync-stablecoins.test.ts`

### Implementation Steps

Phase A: characterization
1. Preserve current tests around:
   - successful DL sync
   - fallback paths
   - GT probe ordering and metadata
   - authoritative overrides
   - staleness blocking
   - payload validation failures
   - depeg pipeline continuation behavior

Phase B: extraction
2. Introduce explicit phase boundaries:
   - `loadStablecoinIntakePhase`
   - `resolveStablecoinPricesPhase`
   - `buildPublishableStablecoinPayloadPhase`
   - `publishStablecoinsPhase`
   - `runPostPublishDepegPhase`

3. Move shared phase data into a typed run context instead of passing many ad hoc variables through the top-level function.

4. Preserve progress reporting and metadata writes at the orchestration layer.

### Test Plan

- Re-run the existing stablecoin sync suite after each extraction step.
- Add one or two metadata characterization assertions if needed to guard against accidental field loss.

### Risk Controls

- No changes to fallback ordering in the same PR as structural extraction.
- Keep circuit recording and cache-write behavior identical.

### Definition Of Done

- `syncStablecoins()` becomes an orchestrator over explicit pipeline phases, with no loss of current behavior.

## Suggested Delivery Sequence

1. Workstream 1: report-cards resiliency + drift consolidation
2. Workstream 2: shared health/status core
3. Workstream 3: canonical dependency graph
4. Workstream 4: canonical chain normalization
5. Workstream 5: `syncDexLiquidity()` extraction
6. Workstream 6: `syncFxRates()` extraction
7. Workstream 7: `syncStablecoins()` extraction

Rationale:

- Steps 1-4 remove active operational and semantic risk.
- Steps 5-7 then become lower-risk because shared semantics and test scaffolding are already stronger.

## Validation Gate For Every PR

Run at minimum:

- `npm run lint`
- `npm test`
- `npm run build`
- `cd worker && npx tsc --noEmit`

Before any push:

- `npm run test:merge-gate`

## Final Acceptance Criteria

1. All previously open critical/high/medium findings are either closed in code or reduced to tracked, characterization-backed extraction work with green validation.
2. `/api/report-cards` no longer fails closed on soft dependency loss.
3. `/api/health` and `/api/status` share the same overlapping public-health semantics.
4. Dependency graph and chain-circulation semantics each live in one canonical helper.
5. The three cron hotspots are decomposed into named phases without changing external behavior.
