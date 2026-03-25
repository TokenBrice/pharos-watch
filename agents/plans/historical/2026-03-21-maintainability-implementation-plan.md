# Pharos Maintainability Implementation Plan

Date: 2026-03-21

Source audit: `agents/2026-03-21-maintainability-audit.md`

## Objectives

- Execute all nine audit findings through incremental, low-risk changes.
- Reduce maintainability cost without changing product behavior unless the audit identified a real bug.
- Improve data-correctness and availability safeguards first, then reduce structural complexity.
- Keep every step independently deployable and revertable.

## Constraints

- No downtime, schema migration, or cache-key migration is planned in this program.
- Production contracts stay unchanged unless a finding explicitly calls for corrected behavior.
- Large refactors must be preceded by characterization coverage on current output and side-effect order.
- Documentation updates ship with the code change when behavior, file ownership, or methodology references move.

## Delivery Rules

- Keep workstreams separate. Do not combine unrelated refactors in one PR.
- Prefer move-and-wrap refactors before logic edits.
- When tightening behavior, add tests first or in the same PR.
- Preserve cron fetch ordering and body-consumption discipline in worker jobs.
- Treat `npm run lint`, `npm test`, `cd worker && npx tsc --noEmit`, and `npm run build` as the minimum global gate for the full program.

## Recommended Sequence

1. Workstream 1: Fail transformed cache endpoints closed on malformed JSON.
2. Workstream 2: Introduce a shared cache/state JSON decode contract and migrate loaders.
3. Workstream 3: Make React Query polling intent explicit.
4. Workstream 4: Correct the status layer boundary.
5. Workstream 5: Consolidate shared explorer-link and formatting helpers.
6. Workstream 6: Decompose `syncYieldData()` into smaller orchestration stages.
7. Workstream 7: Decompose `syncStablecoins()` into smaller orchestration stages.
8. Workstream 8: Split `methodology-sections.tsx` into section modules.

## Parallelization

- Workstreams 3, 4, and 5 can run in parallel after Workstream 1.
- Workstream 8 can run in parallel with any backend work once the doc-update owner is clear.
- Workstreams 6 and 7 should not be bundled together; both are large cron refactors and deserve isolated review/deploy windows.
- Workstream 2 should start before Workstreams 6 and 7 so the shared decode pattern is established before more orchestration code moves around it.

## PR Map

1. `cache-endpoints-fail-closed`
2. `cache-json-contract-foundation`
3. `cache-json-contract-migrate-reporting-loaders`
4. `cache-json-contract-migrate-critical-loaders`
5. `query-polling-contract`
6. `status-layer-boundary`
7. `shared-explorer-links`
8. `shared-formatters`
9. `yield-sync-characterization`
10. `yield-sync-stage-extraction-1`
11. `yield-sync-stage-extraction-2`
12. `stablecoins-sync-characterization`
13. `stablecoins-sync-stage-extraction-1`
14. `stablecoins-sync-stage-extraction-2`
15. `stablecoins-sync-stage-extraction-3`
16. `methodology-sections-split`

## Workstream 1: Fail Transformed Cache Endpoints Closed

Findings covered: 1

### Scope

- `worker/src/api/cache-handlers.ts`
- `worker/src/api/mint-burn-flows-shared.ts`
- `worker/src/api/__tests__/yield-rankings.test.ts`
- `worker/src/api/__tests__/mint-burn-flows.test.ts`

### Implementation

- Add a shared helper for transformed cache reads, for example in `worker/src/lib/`, that parses cached JSON and returns a typed success/error result instead of raw body passthrough.
- Update `handleYieldRankings()` to use the helper and return `503` on malformed cached JSON.
- Update mint/burn cached fallback handling to return `503` when the cached body cannot be parsed for freshness derivation.
- Add structured logging fields for cache parse failures so operators can distinguish corrupt cache from upstream outage.
- Keep last-known-good cache write behavior unchanged. This work only changes read-time failure handling.

### Tests

- Extend `worker/src/api/__tests__/yield-rankings.test.ts` with malformed-cache coverage.
- Extend `worker/src/api/__tests__/mint-burn-flows.test.ts` with malformed-cache coverage.
- Keep current happy-path, empty-cache, and stale-cache assertions intact.

### Docs

- Update `docs/api-reference.md` for the affected endpoint error semantics if malformed-cache behavior is described there.
- Update `docs/yield-intelligence.md` if the rankings endpoint cache-read behavior is documented.
- Update `docs/mint-burn-flows.md` if fallback behavior is described as successful passthrough today.

### Acceptance Criteria

- Malformed cached JSON for transformed endpoints returns `503`, not `200`.
- Existing valid-cache and empty-cache behavior remains unchanged.
- Logs identify the endpoint and cache key on parse failure.
- No cache-write path or cache key changes are introduced.

### Risks And Mitigation

- Risk: latent bad cache rows become visible immediately after deploy.
- Mitigation: land logging with the behavior change, deploy this PR by itself, and confirm no unexpected parse-failure spike before continuing.

## Workstream 2: Standardize Cache And State JSON Decoding

Findings covered: 2

### Scope

- `worker/src/lib/stablecoins-cache.ts`
- `worker/src/lib/report-card-cache.ts`
- `worker/src/lib/fx-rate-state.ts`
- `worker/src/lib/live-reserves-store.ts`
- `worker/src/lib/redemption-backstops-store.ts`
- Supporting tests under `worker/src/lib/__tests__/`

### Phase 2A: Shared Contract

- Introduce a shared internal decoder utility, for example `worker/src/lib/cache-json.ts`, with explicit modes such as `strict`, `degraded`, and `bestEffort`.
- Standardize the return contract to include at least `ok`, `reason`, `payload`, and `updatedAt`.
- Make callers choose fail-closed versus fail-soft behavior explicitly rather than inheriting it from local helper quirks.
- Add focused unit coverage for the decoder contract itself before migrating callers.

### Phase 2B: Lower-Risk Loader Migrations

- Migrate `report-card-cache.ts`, `live-reserves-store.ts`, and `redemption-backstops-store.ts` first.
- Preserve current outward behavior while replacing ad hoc parsing and fallback logic.
- Add dedicated loader tests where direct coverage is missing today.

### Phase 2C: Critical Loader Migrations

- Migrate `fx-rate-state.ts` and `stablecoins-cache.ts` after characterization coverage is in place.
- Keep current external behavior first, then consider any stricter semantics in follow-up PRs only if justified by tests and operator evidence.
- Avoid changing cache freshness rules, timestamp interpretation, or staleness thresholds in this stream.

### Tests

- Extend `worker/src/lib/__tests__/live-reserves-store.test.ts`.
- Extend `worker/src/lib/__tests__/fx-rate-state.test.ts`.
- Extend `worker/src/lib/__tests__/stablecoins-cache.test.ts`.
- Extend `worker/src/lib/__tests__/stablecoins-cache-validation.test.ts`.
- Add focused tests for `report-card-cache` and `redemption-backstops-store` if existing API-level coverage is not enough to lock behavior.

### Docs

- Update `docs/live-reserves.md` and `docs/redemption-backstops.md` if loader fallback semantics become explicit operator-facing behavior.
- Update `docs/testing.md` if new dedicated suites are added or the ownership table changes.
- Update `docs/architecture.md` only if the new shared decode utility becomes part of the documented worker structure.

### Acceptance Criteria

- All five loaders use the same decode contract.
- Silent parse fallback is replaced by explicit caller-selected handling.
- Existing public payload shapes remain unchanged.
- There is a direct test covering malformed JSON and missing-state behavior for each migrated loader.

### Risks And Mitigation

- Risk: multiple endpoints shift edge-case behavior at once.
- Mitigation: migrate one loader family per PR, compare behavior before and after with fixtures, and keep outward semantics unchanged unless the audit flagged a bug.

## Workstream 3: Make Query Polling Intent Explicit

Findings covered: 8

### Scope

- `src/components/providers.tsx`
- `src/hooks/use-api-query.ts`
- `src/hooks/api-hooks.ts`
- `src/hooks/__tests__/query-polling-policy.test.ts`

### Implementation

- Audit all `createStaticQueryOptions()` consumers before changing defaults.
- Remove the global `refetchInterval` from `QueryClient`, or explicitly set `refetchInterval: false` in `createStaticQueryOptions()`.
- Keep polling logic local to `usePollingQuery()` and hook-specific code.
- Reconfirm the repo rule: `staleTime = cron interval`, `refetchInterval = 2x cron interval`.
- Update or add tests that verify static queries do not inherit polling from a provider default.

### Tests

- Extend `src/hooks/__tests__/query-polling-policy.test.ts`.
- Add a regression assertion for `useDigestSnapshot()` or any other current static-query consumer.

### Docs

- Update `docs/architecture.md` if it documents QueryClient defaults or hook ownership.
- Update `docs/testing.md` if query polling policy tests gain new explicit coverage.

### Acceptance Criteria

- No hook using `createStaticQueryOptions()` polls unless it opts in locally.
- Existing polling hooks keep their current cadence.
- There is no hidden polling behavior in `Providers`.

### Risks And Mitigation

- Risk: a page currently relies on accidental global polling.
- Mitigation: enumerate static-query consumers before the change and verify them in a browser after deploy-preview build.

## Workstream 4: Fix The Status Layer Boundary

Findings covered: 7

### Scope

- `worker/src/lib/status-evaluation.ts`
- `worker/src/api/status-data-quality.ts`
- `worker/src/api/status-derived-data.ts`
- New shared location under `worker/src/lib/status/`
- Related tests in `worker/src/api/__tests__/` and `worker/src/lib/__tests__/`

### Implementation

- Move reusable status loaders and derivation helpers into `worker/src/lib/status/`.
- Keep API modules as thin adapters or re-exports during the transition so imports can move safely.
- Remove `../api/` imports from `worker/src/lib/status-evaluation.ts`.
- Preserve the public response shape and status semantics exactly.

### Tests

- Run and update `worker/src/api/__tests__/status.test.ts`.
- Run and update `worker/src/api/__tests__/status-history.test.ts`.
- Run and update `worker/src/cron/__tests__/status-self-check.test.ts`.
- Run and update `worker/src/lib/__tests__/status-reliability.test.ts`.

### Docs

- Update `docs/status-dashboard.md`.
- Update `docs/architecture.md`.
- Update `docs/testing.md` if ownership tables reference the old file layout.

### Acceptance Criteria

- The status core no longer imports from `worker/src/api/`.
- API handlers still return identical payloads.
- Existing status and self-check tests pass without changed expectations.

### Risks And Mitigation

- Risk: refactor accidentally mixes API-only code with library code during the move.
- Mitigation: do a move-only PR first if needed, then a small cleanup PR for import normalization.

## Workstream 5: Consolidate Shared Explorer And Formatting Helpers

Findings covered: 3 and 4

### Scope

- `src/components/key-info-card.tsx`
- `src/components/stablecoin-cemetery.tsx`
- `worker/src/cron/blacklist/shared.ts`
- `shared/lib/format.ts`
- `src/lib/chain-ui.ts`
- `src/components/site-header.tsx`
- `src/lib/peg-stability.ts`
- `src/components/depeg-tracker-table.tsx`
- Shared tests in `src/lib/__tests__/` and component tests

### Phase 5A: Explorer URLs

- Add a runtime-neutral explorer URL helper under `shared/lib/`.
- Support the currently live chain cases already handled across the three call sites, including Tron, Solana, Starknet, and Aptos.
- Use one input contract for chain plus entity type (`tx`, `address`, `contract`).
- Replace local URL builders one call site at a time.
- Add table-driven tests for all supported formats before swapping consumers.

### Phase 5B: Formatting Surface

- Consolidate tracking-span formatting first, because it is already user-visible and inconsistent.
- Move address display and small number/count helpers behind a shared formatter surface where it reduces duplication without forcing broad UI churn.
- Replace local helpers incrementally instead of rewriting every format call site in one pass.

### Tests

- Extend `src/lib/__tests__/format.test.ts`.
- Extend `src/components/__tests__/depeg-table-logic.test.ts`.
- Extend `src/__tests__/depeg-tracker-sort.test.ts` if tracking-span sorting/labels depend on the format path.
- Add a dedicated shared explorer-url test file if one does not exist.

### Docs

- Update `docs/cemetery-and-compare.md`.
- Update `docs/stablecoin-detail-page.md`.
- Update `docs/architecture.md` if shared helper ownership moves into `shared/lib/`.

### Acceptance Criteria

- Explorer links for supported chains are generated from one shared implementation.
- Tracking-span text matches between the depeg summary and depeg table.
- Duplicated local helper logic is removed from the current audited call sites.

### Risks And Mitigation

- Risk: incorrect chain-specific URLs or slightly changed UI labels.
- Mitigation: lock current supported cases in tests first and review rendered text diffs in preview.

## Workstream 6: Decompose `syncYieldData()`

Findings covered: 6

### Scope

- `worker/src/cron/sync-yield-data.ts`
- `worker/src/cron/yield-sync/*`
- `worker/src/cron/__tests__/sync-yield-data.test.ts`
- `worker/src/cron/__tests__/yield-cache.test.ts`
- `worker/src/cron/__tests__/yield-resolve.test.ts`
- `worker/src/cron/__tests__/yield-helpers.test.ts`

### Phase 6A: Characterization

- Add or tighten golden tests on the final rankings payload, including ordering, provenance, benchmark metadata, stale flags, and degraded-mode semantics.
- Capture current write/no-write behavior for `yield_data`, `yield_history`, `report_card_cache`, and the public cache.
- Clean up the existing ESLint warning in `worker/src/cron/__tests__/yield-resolve.test.ts:487` while touching this area.

### Phase 6B: Extract Candidate Evaluation

- Move candidate matching, source arbitration, and compatibility handling into a focused stage module.
- Keep SQL, thresholds, and ranking weights unchanged.

### Phase 6C: Extract Persistence And Cache Publication

- Move D1 write logic and rankings payload assembly into dedicated modules.
- Keep current transaction boundaries and cache validation rules intact.

### Phase 6D: Extract Degradation Metadata Synthesis

- Isolate degraded-status reasoning into a pure helper so the top-level cron becomes an orchestrator.
- Ensure operator-facing degradation semantics remain identical.

### Tests

- Expand `worker/src/cron/__tests__/sync-yield-data.test.ts` with golden output assertions.
- Keep `worker/src/cron/__tests__/yield-cache.test.ts` for cache publication invariants.
- Keep `worker/src/cron/__tests__/yield-resolve.test.ts` for arbitration behavior.
- Keep `worker/src/lib/__tests__/report-cards-snapshot.test.ts` and `worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts` in the verification set because rankings rehydrate from that data.

### Docs

- Update `docs/yield-intelligence.md`.
- Update `docs/worker-infrastructure.md`.
- Update `docs/testing.md`.
- Update `docs/data-flow-map.md` if module ownership is described there.

### Acceptance Criteria

- `syncYieldData()` becomes a thin orchestrator over named stages.
- Rankings payload snapshots are unchanged before and after each extraction PR.
- Write suppression, degraded status, and provenance semantics remain unchanged.
- No new fetch concurrency or connection-pool behavior is introduced.

### Risks And Mitigation

- Risk: subtle ranking drift or provenance-field regressions.
- Mitigation: stage the refactor behind golden payload tests and review serialized before/after payloads for each PR.

## Workstream 7: Decompose `syncStablecoins()`

Findings covered: 5

### Scope

- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/sync-stablecoins/*`
- `worker/src/cron/__tests__/sync-stablecoins.test.ts`
- `worker/src/cron/__tests__/sync-stablecoins-stages.test.ts`
- Any adjacent tests that lock downstream status metadata

### Phase 7A: Characterization

- Expand characterization coverage around fallback routing, cache-write blocking, depeg handoff, staleness reporting, and final status metadata.
- Lock current side-effect order where it matters for safe downstream chaining.

### Phase 7B: Extract Intake And Fallback Gate

- Move upstream fetch selection, fallback routing, and structural validation into a dedicated stage.
- Preserve body-consumption discipline to avoid exhausting the shared Workers connection pool.

### Phase 7C: Extract Canonicalization And Discovery Merge

- Move discovery residual handling, ID remapping, supplemental merges, and canonicalization into a focused stage module.
- Keep price-consensus and enrichment inputs unchanged.

### Phase 7D: Extract Final Metadata Assembly

- Move final metadata synthesis and status-return shaping into a pure helper.
- Leave the exported cron function responsible only for orchestrating stages and invoking downstream effects.

### Tests

- Expand `worker/src/cron/__tests__/sync-stablecoins.test.ts`.
- Expand `worker/src/cron/__tests__/sync-stablecoins-stages.test.ts`.
- Include any downstream assertions that depend on sync metadata, such as status/self-check coverage, in the verification run.

### Docs

- Update `docs/data-pipeline.md`.
- Update `docs/worker-infrastructure.md`.
- Update `docs/testing.md`.
- Update `docs/data-flow-map.md` if orchestration/module ownership references change.

### Acceptance Criteria

- `syncStablecoins()` becomes a thin orchestrator over stage modules.
- Cache-write gating, depeg invocation, and returned metadata stay behaviorally identical.
- Fetch ordering and response-body consumption remain safe under Workers connection limits.

### Risks And Mitigation

- Risk: reordered side effects break downstream safety guarantees or staleness alerts.
- Mitigation: add side-effect-order assertions first and extract one stage per PR instead of moving the function in one pass.

## Workstream 8: Split `methodology-sections.tsx`

Findings covered: 9

### Scope

- `src/app/methodology/methodology-sections.tsx`
- New section modules under `src/app/methodology/`
- Route-level composition in `src/app/methodology/page.tsx` if needed

### Implementation

- Split the file by authored section, leaving the route-level composition file responsible for ordering and shared wrappers only.
- Start with the highest-churn sections named in the audit: pricing pipeline, scoring, yield, and mint/burn.
- Preserve markup, copy, anchor ids, and any structured-data dependencies exactly.
- Avoid opportunistic content rewrites in the same PR series.

### Tests

- Use build verification for static render safety.
- Add route snapshot or render smoke coverage if the current methodology page lacks direct structural regression tests.
- Keep `src/lib/__tests__/methodology-version.test.ts` in the verification set.

### Docs

- Update `docs/methodology-page.md`.
- Update `docs/architecture.md`.
- Update `docs/pricing-pipeline.md` if it references `methodology-sections.tsx` directly.

### Acceptance Criteria

- `/methodology` renders the same content with the same anchors and ordering.
- The monolith file becomes composition-only or is removed entirely in favor of section modules.
- Documentation references point to the new file layout.

### Risks And Mitigation

- Risk: content-only regressions and broken anchors.
- Mitigation: extract one section family at a time and verify rendered HTML/output in preview builds before merging.

## Cross-Cutting Verification Plan

### Per PR

- Run the targeted tests for the touched area.
- Run `npm run lint`.
- Run `cd worker && npx tsc --noEmit` for worker changes.
- Run `npm test` for behavior-sensitive streams before merge.
- Run `npm run build` for frontend or shared changes.

### Before Large Refactor PRs Merge

- Compare serialized output fixtures before and after the refactor.
- Confirm no public API response shape changes unless the PR is fixing the malformed-cache `503` bug.
- Confirm the relevant docs and timeline notes are updated when file ownership or behavior changed.

### Final Program Gate

- `npm run lint`
- `npm test`
- `cd worker && npx tsc --noEmit`
- `npm run build`

## Recommended Rollout Order By Risk

1. Ship Workstream 1 alone and observe logs.
2. Ship Workstream 3 next because it is small and reduces hidden frontend behavior.
3. Ship Workstream 2 in multiple loader-specific PRs.
4. Ship Workstream 4 and Workstream 5 in parallel or back-to-back.
5. Ship Workstream 6 as the first large orchestration refactor.
6. Ship Workstream 7 only after Workstream 6 is stable.
7. Ship Workstream 8 at any point after the first safety-critical changes, preferably in a frontend-focused slot.

## Definition Of Done

- All nine audit findings are addressed.
- No reviewed change requires downtime or data migration.
- Public contracts are preserved except for the explicit malformed-cache bug fix.
- Critical cron paths are smaller, easier to test, and protected by characterization coverage.
- Shared helpers replace audited duplication hotspots.
- Documentation points to the new code ownership accurately.
