# Complexity Simplification Implementation Plan

Date: 2026-04-14

Status: Phases 1-3 implemented

Inputs:

- `agents/audits/2026-04-14-module-complexity-simplification-targets.md`
- `agents/research/2026-04-14-pricing-simplification-research.md`
- `agents/research/2026-04-14-report-card-snapshot-simplification-research.md`
- `agents/research/2026-04-14-dex-liquidity-simplification-research.md`

## Scope

This plan covers behavior-preserving simplification for the first three audited targets:

1. Report-card snapshot assembly and blacklist-risk inference.
2. Pricing validation/publication and post-enrichment policy.
3. DEX liquidity cron/API orchestration.

The plan is intentionally phased. The first implementation tranche will only start after the plan review loop has zero open issues at Minor severity or above.

Post-gate implementation authorization is limited to **Phase 1: Report-card snapshot split**. Phases 2 and 3 remain planned follow-up work until Phase 1 passes focused verification and the worktree is reassessed.

## Current Worktree Constraint

The worktree already has uncommitted changes outside this plan, including report-card/redemption docs, shared report-card code, redemption backstop code/tests, status UI tests, coverage tests, and prior audit/research artifacts. Do not revert or overwrite those changes.

Specific implication:

- Report-card remediation must be based on the current worktree shape, including the in-progress v6.96 redemption-uplift changes around `isRedemptionEligibleForLiquidity()`.
- Avoid broad formatting or mechanical rewrites in files already dirty unless the current tranche explicitly owns that file.
- If a dirty file must be edited, make the smallest patch and verify that the patch composes with the existing modifications.

Required preflight before Phase 1 implementation:

```bash
git diff -- worker/src/lib/report-cards-snapshot.ts shared/lib/report-card-peg-liquidity.ts shared/lib/report-cards.ts shared/lib/__tests__/report-cards.test.ts worker/src/lib/__tests__/report-cards-snapshot.test.ts worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts worker/src/api/__tests__/report-cards.test.ts src/lib/__tests__/report-cards.test.ts
```

Use this only to understand current uncommitted context. Do not revert those diffs.

## Guiding Rules

- Behavior-preserving decomposition only unless a behavior change is explicitly called out later.
- No methodology version bump for pure refactors.
- No API response shape changes.
- No D1 schema changes.
- No new data sources.
- No provider/rate-limit behavior changes.
- Prefer private helpers first; export new helpers only when tests or existing callers need them.
- Keep each PR/tranche independently reviewable and testable.

## Global Success Criteria

- Existing public API payloads remain schema-compatible.
- Cron metadata keys documented in module docs remain unchanged.
- Critical scoring and pricing outputs remain unchanged for existing fixtures.
- No source admission, trust, replay, or degradation semantics change unless a test explicitly demonstrates the old and new behavior are identical.
- New module boundaries reduce coordinator responsibilities without adding abstraction that hides side effects.

## Phase Order

1. **Phase 1: Report-card snapshot split**
   - Lowest operational risk.
   - Best first proof of the decomposition pattern.
   - Must wait for current report-card/redemption dirty changes to be understood and preserved.
2. **Phase 2: Pricing publication/finalization boundary**
   - Higher behavioral risk.
   - Do after Phase 1 establishes test discipline.
   - Do not split provider fetch fan-in until publication/finalization is stable.
3. **Phase 3: DEX liquidity coordinator phase extraction**
   - Large but mostly orchestration-focused.
   - Keep matching/scoring/direct-API helper logic intact in the first DEX tranche.
4. **Phase 4: Follow-up simplifications**
   - Blacklist-risk matcher/fixed-point split.
   - Pricing provider source-map split.
   - DEX `processPoolMetrics()`, `dex-api-common.ts`, and API projection split.

## Phase 1: Report-Card Snapshot Split

### Goal

Reduce `worker/src/lib/report-cards-snapshot.ts` from a broad loader/assembler/finalizer into a thin coordinator while preserving `/api/report-cards` behavior.

### Files Owned

Primary:

- `worker/src/lib/report-cards-snapshot.ts`

New files:

- `worker/src/lib/report-cards-snapshot-inputs.ts`
- `worker/src/lib/report-cards-snapshot-card.ts`
- `worker/src/lib/report-cards-snapshot-finalize.ts`

Likely tests:

- `worker/src/lib/__tests__/report-cards-snapshot.test.ts`
- `worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts`
- `worker/src/api/__tests__/report-cards.test.ts`
- `shared/lib/__tests__/report-cards.test.ts`

Do not edit in Phase 1 unless a failing test requires it:

- `shared/lib/report-card-blacklist-risk.ts`
- `shared/lib/report-card-peg-liquidity.ts`
- `shared/lib/report-card-overall.ts`
- `worker/src/api/report-cards.ts`
- docs/methodology files

### Proposed Module Boundaries

`report-cards-snapshot.ts`:

- keep `ReportCardsSnapshot` interface.
- keep `ReportCardsSnapshotUnavailableError`.
- keep public `buildReportCardsSnapshot(db)`.
- keep `topologicalOrder()` export at least for compatibility with existing tests.
- orchestrate:
  - `loadReportCardsSnapshotInputs(db)`
  - `buildLiveReportCards(...)`
  - `buildDefunctReportCards()`
  - `sortReportCards(...)`
  - `buildReportCardsSnapshotEnvelope(...)`

`report-cards-snapshot-inputs.ts`:

- own `ReportCardsSnapshotInputs`.
- own `EMPTY_DEX_LIQUIDITY_SNAPSHOT`.
- own `loadReportCardsSnapshotInputs(db)`.
- preserve exact fail-hard/degrade behavior:
  - stablecoins cache missing/corrupt -> throw `ReportCardsSnapshotUnavailableError("Cached stablecoins data is corrupt")` where applicable.
  - redemption snapshot unavailable -> throw `ReportCardsSnapshotUnavailableError("Redemption backstop snapshot unavailable")`.
  - Bluechip cache unavailable -> warn and return `null`.
  - DEX liquidity unavailable/stale -> warn and set `liquidityStale = true`.
  - live reserves unavailable -> warn and use empty map.

`report-cards-snapshot-card.ts`:

- own `ComputeCardInput`.
- own `resolvePegInput(...)`.
- own `computeReportCard(input)`.
- own `buildLiveReportCards(...)` as a thin ordered loop over `topologicalOrder(...)` and `computeReportCard(...)`.
- preserve current `rawInputs` defaults and `redemptionUsedForLiquidity` behavior.

`report-cards-snapshot-finalize.ts`:

- own `buildDefunctReportCards()`.
- own `sortReportCards(cards)`.
- own `buildReportCardsSnapshotEnvelope(...)`.
- keep defunct-card materialization in worker code for this tranche; do not move it to shared.

### Phase 1 Step Plan

0. Run the required Phase 1 preflight diff command and read the current dirty owned-file diffs.
1. Run the focused report-card snapshot tests once as a baseline when practical:
   ```bash
   npm test -- worker/src/lib/__tests__/report-cards-snapshot.test.ts worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts worker/src/api/__tests__/report-cards.test.ts shared/lib/__tests__/report-cards.test.ts src/lib/__tests__/report-cards.test.ts
   ```
   If the baseline fails because of existing dirty worktree changes, stop and record the failing tests before refactoring.
2. Add characterization tests before moving code:
   - card sorting with a live card, an NR card, and a defunct card.
   - `redemptionUsedForLiquidity` matches `isRedemptionEligibleForLiquidity()` for low-confidence, impaired, severe-static, and severe-live-direct cases.
3. Extract input loading into `report-cards-snapshot-inputs.ts`.
4. Extract card computation into `report-cards-snapshot-card.ts`.
5. Extract defunct-card, sorting, and envelope helpers into `report-cards-snapshot-finalize.ts`.
6. Keep `buildReportCardsSnapshot()` as the coordinator and compare code paths via tests.
7. Run focused tests.

### Phase 1 Invariants

- `ReportCardsSnapshot` shape is unchanged.
- `updatedAt` continues to come from stablecoins cache.
- `liquidityStale` semantics are unchanged.
- `collateralDriftCoins` and `liveToFallbackCoins` remain omitted when empty.
- dependency graph edges still come from `buildDependencyGraphEdges(ACTIVE_STABLECOINS)`.
- `topologicalOrder()` behavior is unchanged, including circular-dependency termination.
- `resolveBlacklistStatuses()` remains unchanged.
- `scoreLiquidity()` and `isRedemptionEligibleForLiquidity()` remain unchanged.

### Phase 1 Verification

Minimum:

```bash
npm test -- worker/src/lib/__tests__/report-cards-snapshot.test.ts worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts worker/src/api/__tests__/report-cards.test.ts shared/lib/__tests__/report-cards.test.ts src/lib/__tests__/report-cards.test.ts
npm run typecheck
```

If shared report-card exports or docs are touched unexpectedly:

```bash
npm run check:doc-sync
```

## Phase 2: Pricing Publication/Finalization Boundary

### Goal

Make pricing publish eligibility and price metadata mutation explicit and centralized before touching provider fetch fan-in.

### Files Owned

Primary:

- `worker/src/lib/price-publish-policy.ts`
- `worker/src/cron/sync-stablecoins/pricing.ts`
- `worker/src/cron/sync-stablecoins/post-enrichment.ts`

Secondary only when a compile error proves the helper belongs there:

- `worker/src/cron/sync-stablecoins/shared.ts`
- `worker/src/lib/price-validation.ts`

Do not edit in Phase 2 first tranche:

- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- `worker/src/lib/primary-price-collector.ts`
- provider transport modules
- pricing docs/version files

### Proposed Module Boundaries

`price-publish-policy.ts`:

- keep public wrappers:
  - `validatePrimaryPriceCandidate(...)`
  - `validateFallbackPriceCandidate(...)`
  - `validatePublishedAssetPrice(...)`
- introduce a single internal decision path returning richer detail:
  - `{ accepted, reason, referenceType, referencePrice, candidateRatio, boundsUsed, gates }`
- keep old wrapper return shape stable as `{ accepted, reason }`.

`pricing.ts`:

- introduce one accepted-candidate finalizer helper:
  - input: asset, price, source, confidence, observedAt, observedAtMode, consensusSources, agreeSources, syncStartSec, selectedSource.
  - effect: assign `asset.price` and call `stampPriceMetadata()`.
- make primary, GT probe, and protocol override application use the same finalizer.
- keep `buildPreviousTrustedPriceLookup()` unchanged in production code; tests may add coverage around it without changing its implementation.

`post-enrichment.ts`:

- reuse the same finalizer or a small sibling finalizer for:
  - native-peg fill.
  - native-peg correction.
  - cached fallback rehydration.
- preserve replay cache admission filters exactly.

### Phase 2 Step Plan

1. Add characterization tests for stamping consistency:
   - accepted primary consensus.
   - accepted GT probe.
   - accepted protocol override.
   - native-implied correction/fill.
   - cached fallback rehydration.
2. Add or extend tests for rejection clearing:
   - rejected candidate clears `price`, source/confidence/timestamps, `consensusSources`, and `agreeSources`.
3. Add richer internal decision path in `price-publish-policy.ts`.
4. Add finalizer helper in `pricing.ts` or a new local helper module if circular imports require it.
5. Route existing mutation sites through the finalizer.
6. Run focused pricing tests.

### Phase 2 Invariants

- Pairwise consensus behavior remains unchanged.
- `coingecko + defillama-list` downgrade remains unchanged.
- primary/fallback validation modes remain unchanged.
- severe downside corroboration exceptions remain unchanged.
- temporal jump quarantine remains unchanged.
- native-peg implied prices are not replay-cache safe.
- `price_cache` TTL and admission rules remain unchanged.
- `stampPriceMetadata()` field behavior remains unchanged.
- No provider circuit breaker behavior changes.
- No pricing methodology version bump.

### Phase 2 Verification

Minimum:

```bash
npm test -- worker/src/lib/__tests__/price-validation.test.ts worker/src/lib/__tests__/price-publish-policy.test.ts worker/src/lib/__tests__/price-consensus.test.ts worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins-post-enrichment.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts
npm run typecheck
```

If any worker-only type issue appears:

```bash
cd worker && npx tsc --noEmit
```

## Phase 3: DEX Liquidity Coordinator Phase Extraction

### Goal

Make `syncDexLiquidity()` phase boundaries and side-effect ordering explicit while preserving matching, scoring, direct-API, and API response behavior.

### Files Owned

Primary:

- `worker/src/cron/dex-liquidity/orchestrator.ts`

Secondary only when private helpers require existing type exports or metadata builders:

- `worker/src/cron/dex-liquidity/orchestrator-phases.ts`
- `worker/src/cron/dex-liquidity/orchestrator-metadata.ts`

Do not edit in Phase 3 first tranche:

- `worker/src/cron/dex-liquidity/process-pools.ts`
- `worker/src/cron/dex-liquidity/scoring.ts`
- `worker/src/lib/dex-api-common.ts`
- `worker/src/api/dex-liquidity.ts`
- DEX docs/version files

### Proposed Internal Types

Keep private to `orchestrator.ts` initially unless tests require exports:

- `DexLiquidityRunContext`
  - `db`
  - `syncStartSec`
  - `graphApiKey`
  - `signal`
  - `coingeckoApiKey`
  - `chainRpcs`
- `DexLiquiditySourceState`
  - validation references
  - stablecoin price map
  - market-cap map
  - primary data sources
  - symbol/address lookup maps
  - curve pool map
  - price observations
  - subgraph enrichment
  - direct API fetch results
  - direct API pools
  - authoritative staged-pool confirmation
  - source failure arrays
- `DexLiquidityPoolState`
  - `metrics`
  - `knownPoolIndex`
  - staged counters
  - fallback counters
  - merged `priceObservations`
- `DexLiquidityScoreState`
  - `scoreResults`
  - `globalAgg`
  - `retainedPoolsByStablecoin`
  - `tvlStabilityMap`
  - `diagnostics`
  - `analysis`
- `DexLiquidityPersistenceState`
  - `persistence`
  - `challengerPublication`
  - `historicalSnapshot`

### Proposed Phase Functions

Private functions:

- `loadDexLiquiditySourceState(ctx): Promise<DexLiquiditySourceState>`
- `buildDexLiquidityPoolState(ctx, sourceState): Promise<DexLiquidityPoolState>`
- `scoreDexLiquidityPoolState(ctx, poolState): Promise<DexLiquidityScoreState>`
- `persistDexLiquidityScoreState(ctx, poolState, scoreState): Promise<DexLiquidityPersistenceState>`
- `buildDexLiquidityCronResult(sourceState, poolState, scoreState, persistenceState): CronResult`

### Phase 3 Step Plan

1. Check existing tests for these cases and add characterization tests for any missing case:
   - subgraph enrichment before direct API fetches.
   - optional direct API failures not degrading healthy coverage.
   - critical DL failures degrading.
   - guardrail throws.
2. Extract run context creation in `syncDexLiquidity()`.
3. Extract source state phase.
4. Extract pool state phase.
5. Extract score state phase.
6. Extract persistence state phase.
7. Extract final cron result builder.
8. Keep `syncDexLiquidity()` as a thin sequential orchestrator.
9. Run focused DEX tests.

### Phase 3 Invariants

- Source fetch order is unchanged.
- `failedSources`, `criticalSourceFailures`, and `fallbackSignals` semantics are unchanged.
- direct API dedupe and optional wildcard behavior are unchanged.
- staged-pool merge counters are unchanged.
- hard coverage/value/major guardrails are unchanged.
- `persistScores()` still happens before challenger publication and `computeDexPrices()`.
- `computeDexPrices()` still uses retained pools.
- historical snapshots and depth stability remain in the same order and failure posture.
- cron metadata shape is unchanged.
- no API response changes.

### Phase 3 Verification

Minimum:

```bash
npm test -- worker/src/cron/__tests__/sync-dex-liquidity.test.ts worker/src/cron/dex-liquidity/__tests__/orchestrator-phases.test.ts worker/src/cron/dex-liquidity/__tests__/orchestrator-metadata.test.ts worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts worker/src/cron/__tests__/dex-liquidity-scoring.test.ts worker/src/cron/__tests__/dex-liquidity-series-stability.test.ts worker/src/cron/__tests__/dex-api-common.test.ts worker/src/api/__tests__/dex-liquidity.test.ts
npm run typecheck
```

If worker type boundaries are affected:

```bash
cd worker && npx tsc --noEmit
```

## Phase 4: Follow-Up Backlog

These are intentionally out of the first three implementation tranches:

1. Report-card blacklist risk matcher/fixed-point split.
2. Pricing primary provider source-map split.
3. DEX `processPoolMetrics()` split into matching/enrichment/accumulation.
4. DEX `dex-api-common.ts` split into token pricing, pool conversion, and observation extraction.
5. DEX API response projection helper extraction.

Each follow-up should get its own small plan update after Phases 1-3 are verified.

## Cross-Phase Validation Strategy

After each phase:

1. Run the phase-specific tests.
2. Run `npm run typecheck`.
3. Run `git diff --stat` and verify no unrelated files changed.
4. If docs or methodology files changed unexpectedly, stop and explain why before proceeding.

Before pushing or merging a completed multi-phase refactor:

```bash
npm run test:merge-gate
```

## Plan Review Gate

Implementation must not start until this section records zero open findings at Minor severity or above.

Severity definitions:

- **Major:** plan can cause behavior, API, data, or methodology drift.
- **Minor:** plan ambiguity could cause rework or missed tests but is unlikely to ship wrong behavior.
- **Note:** non-blocking improvement suggestion.

### Review Iteration 1

Status: Completed

Findings:

- Minor: optional wording around helper ownership (`if useful`, optional envelope helper, shared placement) left too much scope latitude.
  - Fix: made helper ownership concrete and kept defunct materialization in worker code for Phase 1.
- Minor: Phase 1 did not explicitly require a dirty-worktree preflight or baseline test run before refactoring.
  - Fix: added a required preflight diff command and focused baseline-test instruction with stop condition.
- Minor: plan did not explicitly say what implementation is authorized after the review gate.
  - Fix: post-gate implementation is explicitly limited to Phase 1.

Open Minor-or-higher findings after fixes: 0.

### Review Iteration 2

Status: Completed

Findings:

- No open findings at Minor severity or above.
- Note: remaining uses of "optional" in the plan refer to domain concepts (`optional direct API`, `optional wildcard`) rather than plan ambiguity.

Open Minor-or-higher findings after fixes: 0.

Implementation gate: Passed for Phase 1 only.

## Phase 1 Execution Note

Implemented after the review gate passed:

- Added characterization coverage in `worker/src/lib/__tests__/report-cards-snapshot.test.ts`.
- Split input loading into `worker/src/lib/report-cards-snapshot-inputs.ts`.
- Split live-card assembly and `topologicalOrder()` into `worker/src/lib/report-cards-snapshot-card.ts`.
- Split defunct-card construction, card sorting, and envelope assembly into `worker/src/lib/report-cards-snapshot-finalize.ts`.
- Reduced `worker/src/lib/report-cards-snapshot.ts` to a thin coordinator and compatibility re-export surface.

Verification run:

```bash
npm test -- worker/src/lib/__tests__/report-cards-snapshot.test.ts worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts worker/src/api/__tests__/report-cards.test.ts shared/lib/__tests__/report-cards.test.ts src/lib/__tests__/report-cards.test.ts
npm run typecheck
npm run lint
cd worker && npx tsc --noEmit
git diff --check
```

Results:

- focused report-card suite passed: 5 files, 176 tests.
- root typecheck passed.
- lint passed.
- worker typecheck passed.
- diff whitespace check passed.

Phases 2 and 3 were implemented after the user explicitly requested autonomous continuation.

## Phase 2 Execution Note

Implemented:

- Added a richer internal publication decision path in `worker/src/lib/price-publish-policy.ts` while keeping public wrapper return shape unchanged.
- Added `applyAcceptedPriceCandidate()` in `worker/src/cron/sync-stablecoins/pricing.ts`.
- Routed accepted primary, protocol override, native-implied, and cached fallback price applications through the centralized finalizer.
- Added/strengthened metadata expectations in pricing tests.

Verification run:

```bash
npm test -- worker/src/lib/__tests__/price-validation.test.ts worker/src/lib/__tests__/price-publish-policy.test.ts worker/src/lib/__tests__/price-consensus.test.ts worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-stablecoins-post-enrichment.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts
npm run typecheck
npm run lint
git diff --check
```

Results:

- focused pricing suite passed: 6 files, 201 tests.
- root typecheck passed.
- lint passed.
- diff whitespace check passed.

## Phase 3 Execution Note

Implemented:

- Split `syncDexLiquidity()` in `worker/src/cron/dex-liquidity/orchestrator.ts` into private source, pool, scoring, persistence, and final-result phases.
- Kept matching, scoring, DEX API projection, and persistence helper internals unchanged.
- Preserved source fetch order, guardrail checks, persistence ordering, challenger publication, and cron metadata shape.

Verification run:

```bash
npm test -- worker/src/cron/__tests__/sync-dex-liquidity.test.ts worker/src/cron/dex-liquidity/__tests__/orchestrator-phases.test.ts worker/src/cron/dex-liquidity/__tests__/orchestrator-metadata.test.ts worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts worker/src/cron/__tests__/dex-liquidity-scoring.test.ts worker/src/cron/__tests__/dex-liquidity-series-stability.test.ts worker/src/cron/__tests__/dex-api-common.test.ts worker/src/api/__tests__/dex-liquidity.test.ts
npm run typecheck
npm run lint
cd worker && npx tsc --noEmit
git diff --check
```

Results:

- focused DEX suite passed: 8 files, 92 tests.
- root typecheck passed.
- lint passed.
- worker typecheck passed.
- diff whitespace check passed.
