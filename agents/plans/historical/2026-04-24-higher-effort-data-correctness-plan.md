# Higher-Effort Data Correctness Implementation Plan

Date: 2026-04-24
Status: reviewed by specialized subagents, ready for execution planning
Scope: remaining higher-effort data correctness, pipeline accuracy, and public contract clarity opportunities after the 2026-04-24 data-pipeline hardening pass.

## Assumptions

- Current local `main` is ahead of `origin/main` and the worktree already contains unrelated `/alt-pegs/` changes. Do not mix implementation of this plan with that dirty tree.
- The next implementation pass should start from a clean state or an explicit branch/worktree.
- Data correctness beats visual stability, but scoring/methodology changes need explicit docs and timeline updates.
- Prefer a few verifiable pipeline invariants over broad observability churn.
- Keep public API changes backward-compatible unless a fail-closed contract is intentionally chosen.

## Success Criteria

- Public report-card scoring, dependency graph output, and raw inputs agree on the same dependency source.
- Cache publication code can distinguish "published" from "skipped because newer data already exists".
- Public reserve and report-card API consumers get runtime validation for the data shapes they depend on.
- Freshness metadata explains which input degraded, not just that a fallback occurred.
- Each workstream has focused tests, docs updates, and a clear merge-gate path.

## Reviewed Inputs

Three read-only reviewer passes were used:

- Live reserve dependency reviewer: confirmed the highest product-correctness gap is that score-grade live reserve snapshots can drive collateral quality and blacklist attribution while Dependency Risk and `dependencyGraph.edges` still come from curated reserves.
- API/schema reviewer: confirmed `/api/stablecoin-reserves/:id` has a type-only response contract and the frontend reserve hook does not runtime-validate successful 200 responses.
- Cache/observability reviewer: confirmed `setCacheIfNewer()` only logs CAS skips while some callers still report publication success or advance cooldown markers.

## Impact Ranking

### 1. Live Reserve Dependency Alignment

Impact: highest user-facing correctness impact.

Current behavior:

- `loadFreshIndependentLiveReserveMap()` supplies score-grade live reserve slices to report-card scoring.
- `scoreResilience()` and blacklist attribution can use those live slices.
- Dependency scoring still calls `deriveVariantAwareDependencies(meta)`, which reads curated metadata only.
- `dependencyGraph.edges` is rebuilt from `ACTIVE_STABLECOINS`, so the public graph can diverge from the live reserve source used for other card dimensions.

Why it matters:

- A card can truthfully show `collateralFromLive = true` while Dependency Risk and dependency-map edges still reflect older curated reserve slices.
- This can understate live exposure to tracked stablecoins such as USDC, USDT, wrapped variants, or mechanism dependencies when adapters emit `coinId` / `depType`.

Effort/risk:

- Medium-high implementation effort.
- Methodology-impacting because it can change Safety Scores, stress-test recomputation, and `/dependency-map/`.
- Requires careful ordering because dependency scores are computed topologically; live-derived upstreams must be scored before dependents.

Recommendation:

- Make this the main strategic correctness workstream, but execute it after a small resolver/test slice proves the model.

### 2. CAS Outcome Visibility and Publication Integrity

Impact: highest pipeline integrity impact.

Current behavior:

- `setCacheIfNewer()` returns `void`.
- On CAS skip, it only logs that existing cache is newer.
- Callers can still report "written" or advance companion markers even when the canonical cache row did not change.

Why it matters:

- Cron metadata can overstate publication success.
- Companion markers such as chart write/cooldown sentinels can drift from canonical cache state.
- Post-run debugging cannot distinguish "fresh data published" from "newer data already won the race".

Effort/risk:

- Medium implementation effort.
- Moderate regression risk because `setCacheIfNewer()` is shared by multiple crons and API repair paths.

Recommendation:

- Treat as the strongest pipeline-invariant workstream. It can ship independently before or after the live-dependency work.

### 3. Stablecoin Reserve API Contract Hardening

Impact: high clarity, lower risk.

Current behavior:

- `StablecoinReservesResponse` is a TypeScript interface only.
- Stored reserve snapshots are validated before display, but the public API/frontend boundary has no shared Zod response schema.
- `fetchStablecoinReserves()` preserves `nullOn404`, but successful malformed 200 responses can reach hooks.

Why it matters:

- The reserve card is a high-trust data surface.
- Stable response validation gives a fast canary for adapter/store/schema drift without changing scoring.

Effort/risk:

- Low-medium effort.
- Low runtime risk if validation is added at frontend/API-client boundaries first and metadata remains passthrough.

Recommendation:

- Ship this as the first execution slice if the goal is quick progress before the larger scoring and CAS work.

### 4. Freshness Sentinel Validation

Impact: medium-high operator clarity.

Current behavior:

- Freshness sentinels write JSON payloads with producer/source fields.
- Freshness readers primarily trust the cache row timestamp and do not validate the sentinel payload as the producer assertion.

Why it matters:

- A malformed or wrong-source sentinel can look authoritative.
- Status/health should say when freshness came from a valid sentinel versus a fallback table/cron probe.

Effort/risk:

- Medium effort.
- Low product risk if fallback behavior is preserved.

Recommendation:

- Bundle after CAS outcome visibility or implement as a separate status/freshness hardening slice.

### 5. Strict Stablecoins Cache Read Contract

Impact: medium.

Current behavior:

- The stablecoins writer validates the full response schema before write.
- The shared reader validates only critical fields and can filter malformed entries while still returning an `ok` object-shaped payload.

Why it matters:

- Partial cache corruption can be reduced to a console warning instead of surfacing as degraded status.

Effort/risk:

- Medium effort.
- Higher compatibility risk because legacy-array and partial-filter behavior may still be intentionally tolerated in some consumers.

Recommendation:

- Defer until CAS and sentinel work are done. Start with diagnostic fields (`filteredCount`, degraded reason) before making strict mode fail closed everywhere.

## Execution Plan

### Phase 0: Baseline and Worktree Isolation

Goal: avoid mixing this plan with unrelated UI changes.

Steps:

1. Verify status:
   ```bash
   git status --short --branch
   git diff --stat
   git diff --cached --stat
   ```
2. If unrelated files are dirty, create a clean worktree from the current intended base:
   ```bash
   git fetch origin
   git worktree add .worktrees/data-correctness-plan -b data-correctness-plan origin/main
   ```
3. Re-read the files touched by the selected workstream before editing; do not rely only on this plan.

Done criteria:

- implementation workspace is clean or the dirty scope is explicitly approved
- first workstream selected and file ownership is clear

### Phase 1: Reserve API Contract Hardening

Goal: add a shared runtime contract for `/api/stablecoin-reserves/:id` without changing scoring behavior.

Primary files:

- `shared/types/live-reserves.ts`
- `shared/types/reserves.ts`
- `src/lib/api.ts`
- `src/hooks/use-stablecoin-reserves.ts`
- `src/lib/__tests__/api-fetch-contracts.test.ts`
- `src/hooks/__tests__/use-stablecoin-reserves.test.tsx`
- `worker/src/api/__tests__/stablecoin-reserves.test.ts`
- `docs/api-reference.md`
- `docs/live-reserves.md`
- `docs/testing.md` if smoke/canary coverage changes

Implementation steps:

1. Add `StablecoinReservesResponseSchema` beside `StablecoinReservesResponse`.
2. Compose it from existing reserve-slice schema/fields where possible.
3. Keep adapter `metadata` and nested `details` passthrough so future telemetry does not break the client.
4. Wire `fetchStablecoinReserves()` to validate successful responses while preserving `nullOn404`.
5. Update hook tests to use contract-valid `provenance`, `displayBadge`, and `sync` fixtures.
6. Add an API contract test proving malformed reserve responses throw schema errors and 404 still returns `null`.
7. Consider adding `/api/stablecoin-reserves/iusd-infinifi` to strict smoke/API canary coverage if the smoke harness already supports schema checks.

Validation:

```bash
npm test -- src/lib/__tests__/api-fetch-contracts.test.ts src/hooks/__tests__/use-stablecoin-reserves.test.tsx worker/src/api/__tests__/stablecoin-reserves.test.ts
npm run typecheck
npm run check:doc-sync
npm run check:verified-doc-links
```

Exit gate:

```bash
npm run test:merge-gate
```

### Phase 2: CAS Outcome Visibility

Goal: make cache publication results explicit and stop companion markers from advancing after skipped canonical writes.

Primary files:

- `worker/src/lib/db-cache.ts`
- `worker/src/cron/sync-stablecoins/post-enrichment.ts`
- `worker/src/cron/sync-stablecoin-charts.ts`
- `worker/src/api/mint-burn-flows-shared.ts`
- every direct `setCacheIfNewer()` caller found by `rg "setCacheIfNewer"`
- `worker/src/lib/__tests__/db-cache*.test.ts` or new focused tests
- affected cron tests
- `docs/data-pipeline.md`

Implementation steps:

1. Change `setCacheIfNewer()` to return:
   ```ts
   {
     written: boolean;
     skippedBecauseNewer: boolean;
   }
   ```
2. Keep current SQL behavior in the first slice; do not introduce migrations or sub-second publication tokens yet.
3. Update direct callers to record `cacheWriteMode` as `"published"` or `"skipped-newer"`.
4. In `sync-stablecoin-charts`, only update `stablecoin-charts:last-write` when canonical chart cache was written, or after readback confirms the existing chart cache is newer than the attempted write.
5. In stablecoins sync, stop returning or logging `{ written: true }` when CAS skipped.
6. Add cron metadata fields where useful: `casSkipped`, `syncStartSec`, `cacheKey`, and `cacheWriteMode`.

Required tests:

- CAS write returns `written: true` for new/older rows.
- CAS write returns `skippedBecauseNewer: true` for newer rows.
- stablecoins sync metadata does not claim publication on CAS skip.
- stablecoin-charts marker does not advance after skipped canonical chart write.
- unchanged callers compile and preserve old behavior when writes succeed.

Validation:

```bash
npm test -- worker/src/lib worker/src/cron/__tests__/sync-stablecoin-charts.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts
cd worker && npx tsc --noEmit
npm run check:cron-sync
npm run check:cron-connections
npm run test:merge-gate
```

### Phase 3: Live Reserve Dependency Alignment

Goal: make Dependency Risk scoring, `rawInputs.dependencies`, and `dependencyGraph.edges` use the same effective dependency source.

Primary files:

- `shared/lib/dependency-derivation.ts`
- `shared/lib/stablecoins/variants.ts`
- `shared/lib/dependency-graph.ts`
- `worker/src/lib/report-cards-snapshot-card.ts`
- `worker/src/lib/report-cards-snapshot-finalize.ts`
- `worker/src/lib/report-cards-snapshot.ts`
- `shared/types/report-cards.ts` if provenance is added
- `shared/lib/safety-score-version-data.ts` or report-card methodology version file
- `docs/report-cards.md`
- `docs/report-cards-timeline.md`
- `docs/live-reserves.md`
- `docs/dependency-map.md`

Implementation steps:

1. Add a pure resolver:
   ```ts
   deriveEffectiveDependencies(meta, options?: { liveReserveSlices?: ReserveSlice[] })
   ```
2. Resolver rules:
   - prefer live reserve slices only when the caller passes score-grade live slices
   - aggregate live slices with `coinId` exactly like curated reserves
   - preserve `depType`
   - leave unmapped live reserve percentage as implicit self-backed/non-stablecoin exposure, not as a dropped dependency
   - preserve variant parent wrapper injection and avoid duplicate parent edges
   - fall back to curated reserves/manual dependencies when live slices are absent
3. Update report-card card construction to use effective dependencies for `scoreDependencyRisk()` and `rawInputs.dependencies`.
4. Update topological ordering to use the same live-aware effective dependencies so upstream live dependencies are scored before dependents.
5. Build `dependencyGraph.edges` from the same effective dependency result used in the snapshot, not by recomputing from static metadata during finalization.
6. Add optional provenance if needed:
   - minimal option: `rawInputs.dependencyFromLive?: boolean`
   - richer option: snapshot-level `dependencySources: Record<coinId, "live" | "curated" | "manual" | "variant">`
7. Update methodology and docs because this can change Safety Scores and public graph behavior.

Required tests:

- pure resolver prefers live linked slices over curated linked slices
- live slices without `coinId` do not erase self-backed/non-stablecoin remainder
- live `depType` affects dependency ceiling semantics
- variant wrapper edge still exists and remains dominant over duplicate parent reserve links
- topological order follows live-derived dependencies
- `rawInputs.dependencies` and `dependencyGraph.edges` agree for a live-backed fixture
- live loader failure or non-score-grade live reserve fallback preserves existing curated behavior
- stress-test recomputation remains stable with the new graph source

Validation:

```bash
npm test -- shared/lib/__tests__/dependency-graph.test.ts shared/lib/__tests__/report-cards.test.ts worker/src/lib/__tests__/report-cards-snapshot.test.ts worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts src/hooks/__tests__/use-stress-test.test.ts
npm run typecheck
cd worker && npx tsc --noEmit
npm run check:doc-sync
npm run check:verified-doc-links
npm run test:merge-gate
```

Rollout note:

- This is the most impactful item, but it is also methodology-changing. It should be a dedicated commit with a clear changelog/timeline entry and before/after fixture expectations.

### Phase 4: Report-Card Live Reserve Freshness Telemetry

Goal: explain live-reserve scoring availability separately from DEX and redemption freshness.

Primary files:

- `worker/src/lib/report-cards-snapshot-inputs.ts`
- `worker/src/lib/report-cards-snapshot.ts`
- `worker/src/lib/report-cards-snapshot-finalize.ts`
- `shared/types/report-cards.ts`
- `worker/src/lib/__tests__/report-cards-snapshot.test.ts`
- `docs/api-reference.md`
- `docs/report-cards.md`
- `docs/live-reserves.md`

Implementation steps:

1. Extend `ReportCardsInputFreshness` with optional `liveReserves`.
2. Do not change scoring in this phase unless it is bundled with Phase 3 intentionally.
3. Include fields that distinguish:
   - live reserve loader unavailable
   - no configured live reserves
   - live reserve data present but not score-grade
   - score-grade live reserve data used
   - fallback count via `liveToFallbackCoins`
4. Keep the shape optional/backward-compatible.

Required tests:

- live reserve loader failure sets a clear freshness/status reason and preserves endpoint success
- no live-enabled coins does not falsely report stale live data
- live fallback coins and freshness counts agree

Validation:

```bash
npm test -- worker/src/lib/__tests__/report-cards-snapshot.test.ts worker/src/api/__tests__/report-cards.test.ts src/lib/__tests__/api-fetch-contracts.test.ts
npm run typecheck
npm run test:merge-gate
```

### Phase 5: Freshness Sentinel Validation

Goal: trust sentinel freshness only when the sentinel payload is a valid producer assertion.

Primary files:

- `worker/src/lib/db-cache.ts`
- `worker/src/lib/freshness-sentinels.ts`
- `worker/src/lib/api-freshness.ts`
- status/health tests around freshness fallback
- `docs/api-reference.md`
- `docs/data-pipeline.md`

Implementation steps:

1. Define a schema for sentinel values:
   ```ts
   {
     updatedAt: number;
     source: string;
     publishStatus: "ok";
     rowsWritten?: number;
     coverageRatio?: number;
   }
   ```
2. Validate expected producer source for each sentinel-backed key.
3. If sentinel JSON is malformed, wrong-source, stale, or missing `publishStatus: "ok"`, fall back to the existing table/cron freshness path.
4. Add warning metadata such as `freshnessSource` and `sentinelValidationReason`.

Required tests:

- valid sentinel remains fast path
- wrong-source sentinel falls back
- malformed sentinel falls back
- fallback warning appears in status/API freshness metadata

Validation:

```bash
npm test -- worker/src/lib/__tests__/api-freshness.test.ts worker/src/api/__tests__/health.test.ts worker/src/api/__tests__/status*.test.ts
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

### Phase 6: Stablecoins Cache Read Contract Split

Goal: surface partial cache corruption as degraded status instead of silently filtering malformed rows under strict readers.

Primary files:

- `worker/src/lib/stablecoins-cache.ts`
- `worker/src/lib/__tests__/stablecoins-cache.test.ts`
- strict consumers such as report cards, status, peg summary, mint/burn, daily digest, DEWS/PSI
- `docs/data-pipeline.md`
- `docs/api-reference.md`

Implementation steps:

1. Add an explicit mode such as:
   ```ts
   contract: "published" | "critical-fields"
   ```
2. In published-contract mode, validate against the same shared response schema the writer uses.
3. In critical-field mode, preserve current compatibility but return `filteredCount` and degraded reason when entries are dropped.
4. Move strict public/operator consumers to the published-contract mode one at a time.
5. Keep legacy array compatibility explicit and documented until production cache history is verified clean.

Required tests:

- published-contract mode rejects partial malformed payloads
- critical-field mode returns degraded with `filteredCount`
- legacy array support remains explicit
- report-card hard dependency fails closed on malformed published cache
- lenient consumers continue to degrade safely

Validation:

```bash
npm test -- worker/src/lib/__tests__/stablecoins-cache.test.ts worker/src/lib/__tests__/report-cards-snapshot.test.ts worker/src/api/__tests__/peg-summary.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

## Recommended Execution Order

1. Phase 1: reserve API contract hardening.
2. Phase 2: CAS outcome visibility.
3. Phase 5: freshness sentinel validation.
4. Phase 3: live reserve dependency alignment.
5. Phase 4: live reserve freshness telemetry, unless it is needed as a prerequisite for Phase 3 rollout clarity.
6. Phase 6: stablecoins cache read contract split.

Rationale:

- Phase 1 is low-risk and gives immediate contract safety.
- Phase 2 fixes a core publication invariant before adding more dynamic dependency behavior.
- Phase 5 strengthens status/freshness interpretation after CAS semantics become explicit.
- Phase 3 is highest impact but should land only after its resolver and graph/scoring agreement tests are strong.
- Phase 6 is valuable but more compatibility-sensitive; start with diagnostics before fail-closed behavior.

## Stop / Defer Conditions

Pause implementation if:

- current worktree remains dirty with unrelated changes and no clean worktree is available
- a planned scoring change lacks methodology/timeline docs
- live dependency resolver tests show graph churn or missing upstream scores that cannot be explained
- production cache contains legacy shapes that would be rejected by a proposed strict loader mode
- Wrangler/D1 validation is required but auth is unavailable; use public endpoint validation only and document the limitation

## Final Exit Gate

For each deploy-impacting workstream:

```bash
npm run test:merge-gate
```

For final pre-push confidence after multiple workstreams:

```bash
npm test
npm run test:merge-gate
```

