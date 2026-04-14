# Remaining Complexity Simplification - Subagent Implementation Plan

Date: 2026-04-14

Status: Draft pending review loop

## Purpose

Plan the remaining simplification work after the committed Phase 1-3 tranche:

- `bda1b404` - audit/research/plan plus report-card snapshot split
- `2ca5a8f3` - centralized stablecoin price application
- `ef8f796d` - DEX liquidity coordinator phase extraction

This plan covers the remaining complexity targets and leftover follow-ups:

1. Depeg / DEWS / PegScore
2. Live reserve registry, adapter helpers, sync, and read path
3. Mint/burn sync and API
4. Blacklist/freeze amount recovery, sync, API, and page controller
5. Stability Index / PSI worker, API, and UI
6. Yield config, optional sources, arbitration, and detail UI
7. Redemption backstop builder and card view-model
8. Report-card blacklist-risk matcher/fixed-point split
9. Pricing provider source registry split
10. DEX process-pools, dex-api-common, and API projection split

This is a planning artifact only. It does not authorize implementation until the review gate at the end records fewer than 2 open Minor issues.

## Global Assumptions

- The committed phases above are the new baseline.
- This is a behavior-preserving simplification program unless a later ticket explicitly chooses a behavior change.
- No methodology version bump is required for pure refactors.
- Any scoring, trust, API payload, cache, D1, or methodology behavior change must be isolated into its own behavior-change plan and docs update.
- Subagents must have disjoint file ownership when working concurrently.
- Every subagent must be told: other agents may be editing nearby code; do not revert or overwrite changes outside your ownership.
- Use short-lived feature branches or separate commits per lane when possible.

## Global Success Criteria

- All touched modules keep public API response shape stable unless explicitly planned otherwise.
- All touched cron metadata keys remain stable unless explicitly planned otherwise.
- Existing scoring/pricing/depeg/yield/liquidity/reserve outputs remain numerically identical for existing fixtures unless a behavior-change ticket explicitly says otherwise.
- Each lane ends with focused tests plus root typecheck.
- Final integration runs `npm run test:merge-gate` before push/merge.

## Execution Overview

The program should run in waves, not as one giant refactor.

### Wave 0 - Contract Freeze And Worktree Inventory

Owner: lead agent.

Tasks:

1. Confirm clean worktree or record unrelated dirty files.
2. Run fast baseline tests for each lane that will be active in the next wave.
3. Add missing characterization tests for critical contracts before moving code.
4. Create one implementation tracker under `/agents/plans/` or update this plan with progress.

Minimum baseline commands:

```bash
npm run typecheck
cd worker && npx tsc --noEmit
```

Do not start any code split until its lane-specific test contract is identified.

### Wave 1 - Highest-Value Independent Structural Splits

These lanes can run in parallel after Wave 0 because their file sets are disjoint:

- Lane R1: live reserve shared registry split.
- Lane R2: live reserve adapter helper split.
- Lane R3: live reserve store read-path split.
- Lane Y1: yield config raw-data split.
- Lane P1: pricing source registry split.
- Lane RB1: redemption card view-model split.
- Lane RC1: report-card blacklist-risk matcher/fixed-point split.
- Lane DX3: DEX API projection split.

Hold back:

- Live reserve cron split until R1 and R3 settle.
- Depeg state-machine split until depeg/pending characterization is complete.
- Mint/burn and blacklist sync coordinator splits until their resolver/config contracts are frozen.
- PSI worker/API split until depeg/DEWS contract freeze is complete.

### Wave 2 - Worker Coordinator And State-Machine Splits

These can run in parallel only if their contract dependencies from Wave 1 are complete:

- Lane D1: depeg detection + pending confirmation state-machine extraction.
- Lane D2: DEWS source-state loader extraction.
- Lane D3: PegScore pure-component extraction.
- Lane R4: live reserve sync coordinator split.
- Lane MB1: mint/burn config registry split.
- Lane BL1: blacklist amount resolver extraction.
- Lane Y2: yield optional-source adapter split.
- Lane DX1: DEX dex-api-common helper split.
- Lane DX2: DEX process-pools split.

Hold back:

- Lane PSI1 until the depeg/DEWS contract is frozen. PSI is a consumer of depeg and stress-signal semantics.

Serialize inside each lane. Do not split a single state machine across multiple concurrent workers unless the write scopes are disjoint and a lead agent owns integration.

### Wave 3 - API / UI / Read-Model Splits

These can run after their worker/read contract is frozen:

- Lane MB2: mint/burn API/read-model split.
- Lane BL2: blacklist sync coordinator split.
- Lane BL3: blacklist API/page controller split.
- Lane PSI2: PSI API normalization split.
- Lane PSI3: PSI UI/view-model split.
- Lane Y3: yield arbitration helper split.
- Lane Y4: yield detail UI split.
- Lane RB2: redemption worker builder split.

### Wave 4 - Documentation, Cleanup, And Integration

Tasks:

1. Update docs only for changed file maps or behavior.
2. Run lane-focused tests again for all touched surfaces.
3. Run `npm run typecheck`, `npm run lint`, `cd worker && npx tsc --noEmit`.
4. Run `npm run test:merge-gate`.
5. Prepare a final audit note under `/agents/` summarizing shipped simplification and residual follow-ups.

## Lane Details

### Lane D - Depeg / DEWS / PegScore

Goal: make the depeg state machine and DEWS source hydration explicit while preserving depeg and stress-signal semantics.

Primary files:

- `worker/src/cron/detect-depegs.ts`
- `worker/src/cron/confirm-pending-depegs.ts`
- `worker/src/lib/depeg-pending.ts`
- `worker/src/cron/dews/source-state.ts`
- `worker/src/cron/dews/scoring.ts`
- `worker/src/lib/dews.ts`
- `shared/lib/peg-score.ts`

Invariants:

- Keep `authoritative` vs `confirm_required` primary-price trust gates.
- Keep native-quote vetoes, DEX trust floors, large-cap pending routing, orphan cleanup, and duplicate-open-event merge behavior.
- Pending rows remain one incident per coin and retain current earliest-vs-worst behavior.
- DEWS keeps bootstrap-safe degradation, stale `dex_liquidity` rejection, malformed JSON handling, and the 2-signal minimum.
- PegScore keeps the 4-year cap, null below 7 days, and exact penalty math.

Subagents:

- D1 owns `detect-depegs.ts`, `confirm-pending-depegs.ts`, `depeg-pending.ts`, and direct tests.
- D2 owns `dews/source-state.ts`, DEWS loader helper modules, and loader tests.
- D3 owns `dews/scoring.ts`, `lib/dews.ts`, and DEWS scoring tests.
- D4 owns `shared/lib/peg-score.ts` and PegScore tests.

Safe parallelization:

- D2 and D4 can run in parallel after baseline characterization.
- D3 can run after D2 defines the typed `DewsSourceState` contract.
- D1 must remain serialized because detection and pending confirmation share state semantics.

Serialized steps:

1. Add/verify characterization coverage:
   - `worker/src/cron/__tests__/detect-depegs.test.ts`
   - `worker/src/cron/__tests__/confirm-pending-depegs.test.ts`
   - `worker/src/cron/__tests__/compute-dews.test.ts`
   - `worker/src/lib/__tests__/dews.test.ts`
   - `shared/lib/__tests__/peg-score.test.ts`
   - `worker/src/api/__tests__/peg-summary.test.ts`
   - `worker/src/api/__tests__/stress-signals.test.ts`
2. Extract depeg state-machine decision objects:
   - `open-live`
   - `open-pending`
   - `suppress`
   - `update-peak`
   - `close`
   - `retire-and-replace`
3. Extract DEWS per-source loaders and shared persisted-JSON decode helper.
4. Convert `computeDEWS()` to an ordered signal registry and weighted reducer.
5. Split PegScore into window selection and scoring components.
6. Re-run read API tests and report-card tests because PegScore feeds report cards.

Docs to review if behavior changes:

- `docs/depeg-detection.md`
- `docs/dews.md`
- `docs/depeg-dews-timeline.md`
- `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx`
- `shared/lib/depeg-dews-version.ts`

Lane verification:

```bash
npm test -- worker/src/cron/__tests__/detect-depegs.test.ts worker/src/cron/__tests__/confirm-pending-depegs.test.ts worker/src/cron/__tests__/compute-dews.test.ts worker/src/lib/__tests__/dews.test.ts shared/lib/__tests__/peg-score.test.ts worker/src/api/__tests__/peg-summary.test.ts worker/src/api/__tests__/stress-signals.test.ts shared/lib/__tests__/report-cards.test.ts
npm run typecheck
cd worker && npx tsc --noEmit
```

Risks:

- Directional confirmation can silently change depeg ledgers if pending and detection drift.
- DEWS loader refactors can accidentally turn degraded runs into hard failures.
- PegScore changes ripple into report cards and peg-summary.

### Lane R - Live Reserves

Goal: reduce registry/helper/store/sync complexity without changing adapter validation, sync lifecycle, or read-mode semantics.

Primary files:

- `shared/lib/live-reserve-adapters.ts`
- `worker/src/cron/reserve-adapters/helpers.ts`
- `worker/src/cron/sync-live-reserves.ts`
- `worker/src/cron/sync-live-reserves-core.ts`
- `worker/src/lib/live-reserves-store-parsing.ts`
- `worker/src/lib/live-reserves-store-view.ts`

Invariants:

- Every adapter key in `shared/types/live-reserves.ts` remains exhaustively defined and wired to a worker adapter.
- `LiveReservesConfigSchema` and `parseLiveReserveAdapterParams()` behavior remains stable.
- Sync remains sequential.
- Preserve 20s adapter timeout, 30s D1 finalize timeout, breaker keys, deferred breaker recording, cleanup, and prune behavior.
- Live snapshot resolution remains fail-closed and strict.
- Preserve `live`, `live-stale`, `curated-fallback`, and `unavailable` modes.

Subagents:

- R1 owns shared registry/schema split.
- R2 owns adapter helper split.
- R3 owns store parsing/view split.
- R4 owns cron coordinator split.
- R5 owns docs/tests after boundaries settle.

Safe parallelization:

- R1, R2, and R3 can run in parallel after contract tests.
- R4 must wait for R1 and R3 because cron depends on adapter contracts and store facade.
- R5 trails implementation.

Serialized steps:

1. Add/verify characterization coverage:
   - `worker/src/cron/__tests__/sync-live-reserves.test.ts`
   - `worker/src/cron/__tests__/reserve-sync-integration.test.ts`
   - `worker/src/lib/__tests__/live-reserves-store.test.ts`
   - `worker/src/cron/reserve-adapters/__tests__/registry.test.ts`
   - `worker/src/cron/__tests__/reserve-adapter-validate.test.ts`
2. Split shared registry/schema into smaller shared modules, keeping barrel exports stable.
3. Split adapter helpers into transport/retry, JSON/HTML fetch, onchain accessors, price lookup, and normalization modules, keeping `helpers.ts` as the re-export surface.
4. Split store parsing/view into strict decode, legacy recovery, provenance/badge assembly, overview aggregation, and public response resolution.
5. Split cron coordinator stages: progress, shared-source cache, fallback attempts, cleanup/prune, metadata.
6. Update docs file maps.

Docs to review:

- `docs/live-reserves.md`
- `docs/worker-infrastructure.md`
- `docs/testing.md`
- `docs/architecture.md`
- `docs/data-flow-map.md`

Lane verification:

```bash
npm test -- worker/src/cron/__tests__/sync-live-reserves.test.ts worker/src/cron/__tests__/reserve-sync-integration.test.ts worker/src/lib/__tests__/live-reserves-store.test.ts worker/src/cron/reserve-adapters/__tests__/registry.test.ts worker/src/cron/__tests__/reserve-adapter-validate.test.ts
npm run typecheck
cd worker && npx tsc --noEmit
```

Risks:

- Adapter freshness/warning/evidence semantics can drift subtly.
- Store read-mode changes can affect report-card collateral passthrough.
- Sync lifecycle changes can regress shared-source dedupe, breaker recording, or uncertain-write handling.

### Lane MB - Mint/Burn

Goal: simplify registry, cron orchestration, and API read models while preserving configured issuance-chain scope and cursor semantics.

Primary files:

- `worker/src/lib/mint-burn-contracts.ts`
- `worker/src/cron/sync-mint-burn.ts`
- `worker/src/cron/mint-burn/sync-config.ts`
- `worker/src/api/mint-burn-flows.ts`
- `worker/src/api/mint-burn-flows-shared.ts`
- `worker/src/api/mint-burn-events.ts`
- `worker/src/api/backfill-mint-burn.ts`
- `worker/src/api/backfill-mint-burn-prices.ts`

Invariants:

- Configured issuance-chain scope only.
- `flow_type` remains orthogonal to `burn_type`.
- run-state rotation remains deterministic.
- budget exhaustion degrades rather than silently skipping.
- safe-coverage frontier rules remain intact.
- aggregate/per-coin response shapes remain unchanged.
- cached fallback still returns `503` only for malformed cache payloads.
- FTQ classification still uses report-card cache semantics.

Subagents:

- MB1 owns contract registry split.
- MB2 owns cron orchestration split.
- MB3 owns API/read-model split.
- MB4 owns docs/tests.

Safe parallelization:

- MB1 and MB3 can run in parallel after response/config contracts are frozen, but MB3 must not depend on new registry internals.
- MB2 waits for MB1.
- MB4 trails code work.

Serialized steps:

1. Freeze tests around contract registry and API response shape.
2. Split `mint-burn-contracts.ts` into config declarations and thin registry/helper layer.
3. Split `sync-mint-burn.ts` into preflight, chain-head loading, config planning, execution, completion/metadata assembly.
4. Split `mint-burn/sync-config.ts` into scan, parse/classify, persist, and advancement helpers.
5. Split API files into fetch/build/response helpers.
6. Update docs only after behavior and file boundaries settle.

Tests:

- `worker/src/lib/__tests__/mint-burn-contracts.test.ts`
- `worker/src/lib/__tests__/mint-burn-parse.test.ts`
- `worker/src/lib/__tests__/mint-burn-bridge-classifier.test.ts`
- `worker/src/cron/__tests__/sync-mint-burn.test.ts`
- `worker/src/api/__tests__/mint-burn-flows.test.ts`
- `worker/src/api/__tests__/mint-burn-flows-shared.test.ts`
- `worker/src/api/__tests__/mint-burn-events.test.ts`
- `worker/src/api/__tests__/backfill-mint-burn.test.ts`
- `worker/src/api/__tests__/backfill-mint-burn-prices.test.ts`

Docs to review if behavior or file maps change:

- `docs/mint-burn-flows.md`
- `docs/mint-burn-flows-timeline.md`
- `src/app/methodology/mint-burn-flow-changelog/page.tsx`

Risks:

- Cursor advancement and safe-frontier behavior can silently change event ingestion.
- `flow_type` or FTQ changes affect public totals.
- API cache fallback semantics can flip between `503` and cached responses.

### Lane BL - Blacklist / Freeze Tracker

Goal: split amount resolution, sync phases, API projection, and page controller while preserving freeze-ledger semantics.

Primary files:

- `worker/src/cron/blacklist/amount-recovery.ts`
- `worker/src/cron/blacklist/current-balance-cache.ts`
- `worker/src/cron/blacklist/post-fetch.ts`
- `worker/src/cron/sync-blacklist.ts`
- `worker/src/api/blacklist.ts`
- `worker/src/api/blacklist-summary.ts`
- `worker/src/api/remediate-blacklist-amount-gaps.ts`
- `worker/src/api/backfill-blacklist-current-balances.ts`
- `src/app/blacklist/page.tsx`

Invariants:

- event-time amounts remain separate from freeze-ledger balances.
- `blacklist_current_balances` remains persistent ledger.
- gold zero-balance overrides remain gold-only.
- Tron rows still short-circuit to `permanently_unavailable`.
- cursor advancement differentiates no-event from API failure.
- methodology envelopes and freshness headers stay stable.
- page keeps URL sync, debounce, drilldown scroll, and pagination semantics.

Subagents:

- BL1 owns amount resolver extraction.
- BL2 owns sync coordinator split.
- BL3 owns API projection split.
- BL4 owns page controller extraction and tests.
- BL5 owns docs.

Safe parallelization:

- BL1 and BL4 can run in parallel after API/page contracts are frozen.
- BL2 waits for BL1.
- BL3 can run in parallel with BL2 if it does not touch amount-resolution files.
- BL5 trails implementation.

Serialized steps:

1. Add/verify characterization coverage for amount status, gold handling, Tron handling, cursor advancement, and page URL behavior.
2. Extract resolver returning `{ amount, source, status, errorClass, provider }`.
3. Make current-balance cache and amount backfill persist resolver output.
4. Split `sync-blacklist.ts` into backfill, EVM scan, Tron scan, cursor advancement, metadata.
5. Split blacklist API projection.
6. Extract page controller/view-model and add page/controller test.
7. Update docs only after behavior settles.

Tests:

- `worker/src/cron/blacklist/__tests__/current-balance-cache.test.ts`
- `worker/src/cron/blacklist/__tests__/balance-providers.test.ts`
- `worker/src/cron/blacklist/__tests__/evm-source.test.ts`
- `worker/src/api/__tests__/remediate-blacklist-amount-gaps.test.ts`
- `worker/src/cron/__tests__/sync-blacklist.test.ts`
- `worker/src/api/__tests__/blacklist.test.ts`
- `worker/src/api/__tests__/blacklist-summary.test.ts`
- new `src/app/blacklist/page.test.tsx` or controller test

Docs to review if behavior or file maps change:

- `docs/blacklist-tracker.md`
- `docs/blacklist-tracker-timeline.md`
- `src/app/methodology/blacklist-tracker-changelog/page.tsx`

Risks:

- amount-status transitions and gold override rules are brittle.
- ledger preservation on unblacklist/destroy can regress.
- cursor advancement under partial API failure is the sharp edge.
- page URL/debounce/pagination behavior currently lacks dedicated coverage.

### Lane PSI - Stability Index

Goal: split PSI worker/API/UI wrapper logic while preserving compute formula and response contract.

Primary files:

- `worker/src/cron/stability-index.ts`
- `worker/src/api/stability-index.ts`
- `src/app/stability-index/view-model.ts`
- `src/app/stability-index/client.tsx`
- `shared/lib/psi-view-model.ts`

Invariants:

- PSI sample insertion fields remain stable.
- `input_snapshot` degradation flags remain stable.
- API `current` / `history` shape remains stable.
- `detail=true` behavior remains stable.
- malformed current JSON still returns 503.
- methodology version fallback remains stable.
- displayed PSI prefers 24h average.

Subagents:

- PSI1 owns worker cron split.
- PSI2 owns API normalization split.
- PSI3 owns UI/view-model split.
- PSI4 owns docs review.

Safe parallelization:

- PSI1 and PSI3 can run in parallel after both the PSI response contract and the depeg/DEWS contract are frozen, if PSI3 consumes only current API shape.
- PSI2 should wait for PSI1 if any stored input shape is touched.
- UI section extraction can be split after view-model helper signatures are frozen.

Serialized steps:

1. Freeze PSI sample/API contracts.
2. Split worker cron into input collection, active-depeg grouping, replay-price fallback, contributor/sample assembly, persistence/prune.
3. Split API normalization: strict JSON decode, degradation parsing, current/history row normalization, today average insertion, methodology reconstruction.
4. Split UI into view-model and presentational sections.
5. Review docs for drift.

Tests:

- `worker/src/cron/__tests__/stability-index.test.ts`
- `worker/src/cron/__tests__/snapshot-psi.test.ts`
- `worker/src/api/__tests__/stability-index.test.ts`
- `src/app/stability-index/view-model.test.ts`
- `src/app/stability-index/client.test.tsx`

Docs to review:

- `docs/stability-index.md`
- `docs/stability-index-timeline.md`
- `docs/data-pipeline.md`
- `docs/worker-infrastructure.md`
- `docs/api-reference.md`

Risks:

- degraded behavior on depeg-query or DEWS failure can accidentally become healthy behavior.
- today-average dedupe and methodology-version reconstruction are easy to break.
- UI extraction can alter ordering or responsive behavior.

### Lane Y - Yield

Goal: split yield config, optional protocol sources, arbitration, and detail UI while preserving ranking payload and arbitration semantics.

Primary files:

- `worker/src/cron/yield-config.ts`
- `worker/src/cron/yield-config-registry.ts`
- `worker/src/cron/yield-sync/sources-optional-protocols.ts`
- `worker/src/cron/yield-sync/tracked-optional-source-registry.ts`
- `worker/src/cron/yield-sync/evaluation.ts`
- `worker/src/cron/sync-yield-data.ts`
- `worker/src/cron/yield-sync/publication.ts`
- `worker/src/cron/yield-sync/history.ts`
- `src/components/yield-detail-section-model.ts`
- `src/components/yield-detail-section.tsx`

Invariants:

- current source-selection hierarchy remains intact.
- row identity and history semantics in evaluation remain unchanged.
- publication shape, `altSources[]`, provenance, `data-stale` thresholds, malformed-cache rejection, and severe-shrink rejection remain unchanged.
- optional source timeout and abort semantics remain unchanged.
- detail page keeps loading/error/null states, `sources` URL param persistence, max 4 selected sources, show-all behavior, and chart inputs.

Subagents:

- Y1 owns yield config raw-data split.
- Y2 owns optional-source family split.
- Y3 owns evaluation/arbitration helper extraction.
- Y4 owns detail UI model/presentation split.
- Y5 owns docs.

Safe parallelization:

- Y1 and Y4 can run in parallel after test contracts freeze.
- Y2 and Y3 can run in parallel only if `yield-config.ts` public exports stay stable.
- Y5 trails code shape.

Serialized steps:

1. Freeze ranking payload and config registry exports with tests.
2. Split raw config data out of `yield-config.ts` while keeping exported names stable.
3. Split optional-source families while keeping `tracked-optional-source-registry.ts` as wiring layer.
4. Extract pure arbitration helpers and keep `sync-yield-data.ts` orchestration-only.
5. Split detail UI into controller/model and presentational pieces.
6. Update docs only for file boundary or behavior changes.

Tests:

- `worker/src/cron/__tests__/yield-config-registry.test.ts`
- `worker/src/cron/__tests__/yield-resolve.test.ts`
- `worker/src/cron/__tests__/yield-evaluation.test.ts`
- `worker/src/cron/__tests__/yield-publication.test.ts`
- `worker/src/cron/__tests__/sync-yield-data.test.ts`
- optional adapter tests: BIMA, Hashnote, Ondo, scrvUSD, Morpho, Pendle, Yearn/Kong, Beefy
- `src/components/__tests__/yield-detail-section.test.tsx`

Docs to review:

- `docs/yield-intelligence.md`
- `docs/yield-intelligence-operations.md`
- `docs/yield-intelligence-timeline.md`
- `docs/stablecoin-detail-page.md`
- `docs/api-reference.md`
- `docs/architecture.md`

Risks:

- silent ranking drift in `is_best`, `altSources`, source switches, provenance labels, and stale thresholds.
- optional source timeout/abort regressions.
- detail UI URL state and empty/loading branches can regress.

### Lane RB - Redemption Backstop

Goal: split worker builder/read model and frontend card formatting while preserving scoring and impairment semantics.

Primary files:

- `worker/src/lib/redemption-backstop-sources.ts`
- `worker/src/lib/redemption-backstop-capacity.ts`
- `worker/src/lib/redemption-backstop-cost.ts`
- `worker/src/lib/redemption-backstop-availability.ts`
- `worker/src/lib/redemption-backstop-live-metadata.ts`
- `worker/src/lib/redemption-backstops-store.ts`
- `worker/src/cron/sync-redemption-backstops.ts`
- `src/components/stablecoin-detail/redemption-backstop-card.tsx`

Invariants:

- `resolutionState`, `routeStatus`, `capacityConfidence`, `feeConfidence`, `modelConfidence`, and `effectiveExitScore` remain identical.
- severe active depeg impairment still overrides weak redemption uplift.
- store serialization stays stable unless explicitly planned.

Subagents:

- RB1 owns frontend view-model extraction.
- RB2 owns worker builder/composer extraction.
- RB3 owns store/cron compatibility review.

Safe parallelization:

- RB1 can run in parallel with RB2 after entry shape is frozen.
- RB3 can review in parallel but should not change fields until RB2 settles.

Tests:

- `worker/src/lib/__tests__/redemption-backstop-sources.test.ts`
- `worker/src/lib/__tests__/redemption-backstops-store.test.ts`
- `worker/src/cron/__tests__/sync-redemption-backstops.test.ts`
- `src/components/stablecoin-detail/__tests__/redemption-backstop-card.test.tsx`
- `shared/lib/__tests__/redemption-backstops.test.ts`
- `shared/lib/__tests__/redemption-backstop-scoring.test.ts`
- `shared/lib/__tests__/redemption-backstop-consistency.test.ts`

Docs to review:

- `docs/redemption-backstops.md`
- `docs/report-cards.md`

Risks:

- `impaired` vs `missing-capacity` drift.
- stale-liquidity effective-exit suppression drift.
- duplicated formatting between store serializer and card view-model.

### Lane RC - Report-Card Blacklist Risk

Goal: split matcher/context logic from fixed-point status resolution behind the existing facade.

Primary files:

- `shared/lib/report-card-blacklist-risk.ts`
- `shared/lib/report-card-resilience.ts`
- `shared/lib/tracked-blacklist-status.ts`

Invariants:

- precedence remains explicit override, governance default, reserve-driven direct/possible/inherited, custody fallback, text heuristics.
- fixed-point convergence remains cycle-safe.
- `getBlacklistStatusLabel()` output remains unchanged.
- `INHERITED_BLACKLIST_THRESHOLD_PCT` remains unchanged.

Subagents:

- RC1 owns matcher/context extraction.
- RC2 owns fixed-point resolver extraction.

Safe parallelization:

- RC1 and RC2 can work in parallel after the facade API is frozen, but final integration must be single-owner.

Tests:

- `shared/lib/__tests__/report-cards.test.ts`
- `worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts`

Docs to review:

- `docs/report-cards.md`
- `docs/report-cards-timeline.md`

Risks:

- `possible` vs `inherited` classification drift.
- symbol-match context accidentally coupled into fixed-point loop.

### Lane P - Pricing Provider Registry

Goal: split provider registry definitions while preserving pricing semantics and the accepted-price finalizer committed in Phase 2.

Primary files:

- `shared/lib/pricing-source-registry.ts`
- `shared/lib/pricing-sources.ts`
- `shared/lib/pricing-provider-config.ts`
- `worker/src/lib/primary-price-collector.ts`
- `worker/src/lib/pricing-source-policy.ts`

Invariants:

- Source keys, trust tiers, freshness kinds, depeg-authority flags, replay-safety, and observed-at defaults remain identical.
- Price consensus and validation behavior remains unchanged.
- accepted-price centralization remains the write-side mutation boundary.

Subagents:

- P1 owns registry entry schema freeze and assembler.
- P2-Pn own provider-family definition extraction after schema freeze.
- P-final owns collector/policy consumer rewiring.

Safe parallelization:

- Provider definition extraction can run in parallel after registry schema freeze.
- Collector/policy rewiring waits for registry assembler.

Tests:

- `worker/src/lib/__tests__/price-validation.test.ts`
- `worker/src/lib/__tests__/price-publish-policy.test.ts`
- `worker/src/lib/__tests__/price-consensus.test.ts`
- `worker/src/lib/__tests__/authoritative-price-sources.test.ts`
- `worker/src/cron/__tests__/sync-stablecoins.test.ts`

Docs to review:

- `docs/pricing-pipeline.md`
- `docs/pricing-pipeline-timeline.md`

Risks:

- source identity or authority classification drift.
- collector source list changes ripple into consensus output.

### Lane DX - DEX Deeper Split

Goal: split helper math, pool matching, and API projection below the already-committed DEX coordinator phase boundary.

Primary files:

- `worker/src/lib/dex-api-common.ts`
- `worker/src/cron/dex-liquidity/process-pools.ts`
- `worker/src/api/dex-liquidity.ts`

Invariants:

- exact-address precedence, derived-identity fallback, and non-zero 24h volume promotion rules remain unchanged.
- retained-pool aggregates, pool counts, and warning header semantics remain unchanged.
- cron metadata and trend baseline tolerance remain unchanged.

Subagents:

- DX1 owns `dex-api-common.ts` token-price helper extraction.
- DX2 owns `process-pools.ts` matching/enrichment/accumulation split.
- DX3 owns `dex-liquidity.ts` API projection helper extraction.

Safe parallelization:

- DX1 and DX2 can run in parallel after `DexApiPool` and `LiquidityMetrics` contracts are frozen.
- DX3 can run in parallel once response shape is agreed.
- final integration must run all DEX tests together.

Tests:

- `worker/src/cron/__tests__/dex-api-common.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-price-bridge.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-scoring.test.ts`
- `worker/src/api/__tests__/dex-liquidity.test.ts`
- `worker/src/cron/__tests__/sync-dex-liquidity.test.ts`

Docs to review:

- `docs/dex-liquidity.md`

Risks:

- exact vs derived identity dedupe drift.
- `Warning` header text or missed-cron baseline tolerance drift.

## Cross-Lane Parallelization Matrix

Safe to run concurrently after Wave 0:

- R1, R2, R3
- Y1, Y4
- P1
- RB1
- RC1/RC2 with a single integration owner
- BL4

Run only after dependencies:

- DX3 after DEX API response-shape contract freeze
- R4 after R1 and R3
- D1 after depeg/pending characterization
- D3 after D2 source-state contract
- MB2 after MB1
- BL2 after BL1
- PSI2 after PSI1 if stored shape moves
- PSI1 after depeg/DEWS contract freeze
- Y2/Y3 after Y1 export freeze
- P-final after P1/provider extraction
- DX final integration after DX1-DX3

Do not parallelize:

- depeg detection and pending-confirmation semantics
- blacklist amount resolver and sync cursor advancement integration
- mint/burn run-state advancement and per-config scan mutation
- live reserve sync coordinator with store facade changes

## Review Gate

Implementation should not start from this plan until the review loop records fewer than 2 open Minor issues.

Severity definitions:

- Major: plan can cause behavior/API/data/methodology drift or unsafe subagent file overlap.
- Minor: ambiguity could cause rework or missed tests but is unlikely to ship wrong behavior.
- Note: non-blocking recommendation.

### Review Iteration 1

Status: Completed

Findings:

- Minor: Wave overview mislabeled the DEX API projection split as `DX1`, while lane details reserve `DX1` for `dex-api-common.ts`.
  - Fix: renamed Wave 1 DEX API projection to `DX3`; Wave 2 now lists `DX1` and `DX2` for `dex-api-common.ts` and `process-pools.ts`.
- Minor: PSI worker split dependency was unclear in the wave overview.
  - Fix: held `PSI1` until the depeg/DEWS contract is frozen, because PSI consumes active depeg and stress-signal semantics.
- Minor: Cross-lane matrix listed `DX3` as safe immediately after Wave 0 without restating the API response-shape freeze.
  - Fix: moved `DX3` to dependency-gated work: after DEX API response-shape contract freeze.

Open Minor-or-higher findings after fixes: 0.

### Review Iteration 2

Status: Completed

Findings:

- Minor: PSI lane-local parallelization rule did not restate the depeg/DEWS contract dependency already present in the cross-lane matrix.
  - Fix: PSI lane now requires both PSI response contract freeze and depeg/DEWS contract freeze before parallel PSI1/PSI3 work.

Open Minor-or-higher findings after fixes: 0.

Review gate status: Passed. Open Minor issues: 0.
