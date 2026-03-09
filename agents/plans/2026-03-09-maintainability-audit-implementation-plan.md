# Maintainability Audit — Implementation Plan

> Detailed remediation plan for the maintainability audit findings raised on 2026-03-09.
> Scope is intentionally incremental: reduce correctness risk first, then remove duplication, then decompose oversized modules, then tighten tooling and cleanup.

## Objective

Resolve the audited maintainability issues without introducing downtime, schema churn, or broad architectural rewrites.

The plan is constrained by the repo's operating rules:

- Preserve existing behavior unless the current behavior is explicitly incorrect.
- Prefer additive refactors and narrow contract changes over wide rewrites.
- Verify every phase with repo-standard gates before moving on.
- Update application docs when runtime behavior or operator expectations change.

## Source Findings Covered

This plan resolves the following audit findings:

1. Quarter-hour cron dependency chaining can run downstream jobs after degraded `sync-stablecoins`.
2. Lenient stablecoins-cache loading can silently downgrade broken cache state to empty "valid" data.
3. Safety score snapshot failures can collapse to empty output and generate incorrect downstream summaries.
4. Frontend table shells are duplicated across multiple large components.
5. DEX ingestion and observation mapping contains repeated source-specific loops.
6. Router/admin route wiring repeats the same guard/idempotency/error patterns.
7. `generateDailyDigest()` is too large and couples unrelated concerns.
8. `computeRawStatus()` is too large and couples loading, policy, and response shaping.
9. Critical coverage gates omit several operator-critical paths.
10. Dependency/script hygiene issues: implicit `tsx`, unused root `@resvg/resvg-wasm`, stale helper files, and duplicated cache parsing in OG rendering.

## Non-Goals

- No redesign of the stablecoins pipeline architecture.
- No migration of route handling to a new framework.
- No UI redesign beyond extracting repeated table scaffolding.
- No methodology changes to PSI, DEWS, report cards, or yield scoring.

## Verification Gates

Run these after every completed phase unless the phase explicitly says otherwise:

```bash
npm run lint
npm test
cd worker && npx tsc --noEmit
npm run build
npm run coverage:critical
```

For table refactors, also run:

```bash
npm run test:smoke-ui
```

For worker orchestration and API contract changes, also run targeted suites while developing:

```bash
npx vitest run worker/src/__tests__/index.scheduled.test.ts
npx vitest run worker/src/api/__tests__/status.test.ts
npx vitest run worker/src/cron/__tests__/daily-digest.test.ts
npx vitest run worker/src/cron/__tests__/sync-stablecoins.test.ts
npx vitest run worker/src/cron/__tests__/sync-yield-data.test.ts
```

## Execution Order

```text
Phase 1: Correctness Barriers
  A1 stablecoins-cache contract hardening
  A2 safety snapshot contract hardening
  A3 quarter-hour cron dependency gating

Phase 2: Redundancy Reduction
  B1 route builder consolidation
  B2 DEX ingestion helper extraction
  B3 frontend table scaffold extraction
  B4 OG cache loader reuse

Phase 3: Module Decomposition
  C1 split daily-digest into collectors + writer + publisher
  C2 split status computation into loaders + synthesis

Phase 4: Tooling and Cleanup
  D1 expand critical coverage gate
  D2 explicit script/dependency hygiene
  D3 stale file cleanup
```

Phases 1 and 4 are mandatory. Phases 2 and 3 can be broken into separate worktrees after correctness is stabilized.

---

## Phase 1 — Correctness Barriers

### A1. Harden the stablecoins cache contract

**Problem**

`worker/src/lib/stablecoins-cache.ts` currently returns `ok: true` with `payload: { peggedAssets: [] }` for missing cache, JSON parse failure, and malformed payload when `mode: "lenient"` is used. That is dangerous in production-critical code because several callers continue from that empty payload as if it were valid data.

**Primary files**

- `worker/src/lib/stablecoins-cache.ts`
- `worker/src/lib/safety-scores.ts`
- `worker/src/api/status.ts`
- `worker/src/cron/daily-digest.ts`
- `worker/src/api/mint-burn-flows.ts`
- `worker/src/api/backfill-depegs.ts`
- `worker/src/cron/stability-index.ts`
- `worker/src/cron/compute-dews.ts`
- `worker/src/api/og.tsx`

**Target state**

Replace the current boolean shape with a discriminated result that cannot misrepresent broken cache state as healthy:

```ts
type StablecoinsCacheLoadResult =
  | { kind: "ok"; payload: StablecoinsCachePayload; updatedAt: number }
  | { kind: "degraded"; reason: StablecoinsCacheFailureReason; payload: StablecoinsCachePayload | null; updatedAt: number | null }
  | { kind: "error"; reason: StablecoinsCacheFailureReason; updatedAt: number | null };
```

Where:

- `ok` means parsed, structurally valid payload.
- `degraded` means caller may optionally use a non-empty fallback payload, but must treat the read as unhealthy.
- `error` means no usable payload exists.

**Implementation steps**

1. Refactor `loadStablecoinsCache()` to stop returning `ok: true` for `missing-cache`, `json-parse-failed`, `invalid-payload-shape`, and `missing-pegged-assets`.
2. Keep legacy-array support only for real legacy payloads, and mark it `kind: "degraded"` so callers know the format is transitional.
3. Add a small helper in `stablecoins-cache.ts`:
   - `hasUsableStablecoinsPayload(result): result is { kind: "ok" | "degraded"; payload: StablecoinsCachePayload }`
   - Only true when `payload` exists and `peggedAssets.length > 0`.
4. Migrate callers by class:
   - `status.ts`: if cache is not `ok`, mark data quality degraded and surface cause text. Do not compute `totalStablecoins = 0` unless that is the actual cached dataset.
   - `daily-digest.ts`: if cache is not `ok`, abort digest generation or load last known digest and skip regeneration.
   - `mint-burn-flows.ts`: permit degraded fallback only when serving an explicit cached fallback response, not for live aggregate synthesis.
   - `backfill-depegs.ts`: degraded payload is acceptable if present because this is an admin/backfill path, but the response metadata must include the degraded reason.
   - `stability-index.ts` and `compute-dews.ts`: treat non-`ok` as degraded and skip writes.
   - `safety-scores.ts`: stop lenient-empty reads entirely; use `ok` only.
   - `og.tsx`: remove local JSON parsing and reuse the shared loader.
5. Add shared logging helper so every caller emits the same structured message:
   - `source=stablecoins-cache`
   - `kind=degraded|error`
   - `reason=...`

**Required tests**

- `worker/src/lib/__tests__/stablecoins-cache.test.ts`
  - Replace the current "lenient empty payload" expectations with discriminated degraded/error states.
- `worker/src/api/__tests__/status.test.ts`
  - Add case: malformed stablecoins cache yields degraded data quality and explicit cause.
  - Add case: missing cache does not report `missingPrices = 0` as healthy.
- `worker/src/cron/__tests__/daily-digest.test.ts`
  - Add case: degraded/error stablecoins cache causes digest generation to skip and not store a false zero-mcap digest.
- `worker/src/api/__tests__/mint-burn-flows.test.ts`
  - Add case: live aggregate path refuses empty-lenient payload and falls back cleanly.

**Docs to update**

- `docs/data-flow-map.md`
- `docs/status-dashboard.md`
- `docs/digest-pipeline.md`

**Risk**

Some endpoints may become explicitly degraded or unavailable in scenarios that currently look "healthy". That is desirable, but rollout should be staged behind tests to ensure no route accidentally loses valid fallback behavior.

### A2. Harden the safety score snapshot contract

**Problem**

`worker/src/lib/safety-scores.ts` catches all errors and returns an empty snapshot. `sync-yield-data.ts` already treats zero coverage as degraded, but `daily-digest.ts` does not and can synthesize false safety conclusions.

**Primary files**

- `worker/src/lib/safety-scores.ts`
- `worker/src/cron/daily-digest.ts`
- `worker/src/cron/sync-yield-data.ts`

**Target state**

Return a discriminated result from `computeSafetyScoresSnapshot()`:

```ts
type SafetyScoresSnapshotResult =
  | { kind: "ok"; mode: "map" | "full-grades"; ... }
  | { kind: "degraded"; reason: string; mode: "map" | "full-grades"; scores: Map<...>; grades?: SafetyGradeRow[] };
```

The function may still include partial results, but the degraded state must be explicit.

**Implementation steps**

1. Refactor `computeSafetyScoresSnapshot()` so the catch block returns `kind: "degraded"` instead of silently returning an empty success.
2. Add explicit coverage metadata:
   - `coveredCount`
   - `trackedCount`
   - `coverageRatio`
3. Update `sync-yield-data.ts`:
   - Keep the current degraded handling.
   - Switch from `scores.size === 0` heuristics to `result.kind !== "ok"` or `coverageRatio < threshold`.
4. Update `daily-digest.ts`:
   - If `kind !== "ok"`, do not synthesize `medianGrade`, `aboveBCount`, or `fCount`.
   - Leave `safetyScores` undefined and include the degraded reason in cron metadata.
5. If `report_card_cache` exists and is fresh enough, allow `daily-digest.ts` to optionally use it as a read-only fallback instead of recomputing.

**Required tests**

- `worker/src/lib/__tests__/safety-scores.test.ts`
  - Add degraded-result case.
- `worker/src/cron/__tests__/sync-yield-data.test.ts`
  - Replace implicit empty-map assumption with explicit degraded snapshot result.
- `worker/src/cron/__tests__/daily-digest.test.ts`
  - Add case: degraded safety snapshot skips the safety section instead of generating false `F`-grade aggregate output.

**Docs to update**

- `docs/digest-pipeline.md`
- `docs/yield-intelligence.md`

**Risk**

Digest output may become shorter during degraded periods. That is acceptable; the unsafe alternative is publishing incorrect score summaries.

### A3. Gate quarter-hour dependent jobs on actual upstream success

**Problem**

`worker/src/handlers/scheduled.ts` currently treats any non-throwing `syncStablecoins()` run as success. That lets `snapshot-supply`, `stability-index`, and `compute-dews` run after degraded upstream outcomes.

**Primary files**

- `worker/src/handlers/scheduled.ts`
- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/snapshot-supply.ts`
- `worker/src/cron/stability-index.ts`
- `worker/src/cron/compute-dews.ts`

**Target state**

Downstream quarter-hour jobs run only when the upstream stablecoins sync completed in a downstream-safe state.

**Implementation steps**

1. Change `runQuarterHourlyJob()` to return `CronResult | null` instead of `boolean`.
2. In `sync-stablecoins.ts`, standardize metadata with an explicit field:

```ts
{
  cacheWriteMode: "main-write" | "fallback-write" | "blocked-invalid-payload" | "no-write",
  downstreamSafe: boolean
}
```

3. Define downstream-safe as:
   - `status === "ok"` and main cache write happened, or
   - a specific fallback mode that is explicitly approved for downstream use.
4. In `scheduled.ts`, gate:
   - `snapshot-supply`
   - `stability-index`
   - `compute-dews`
   on `downstreamSafe === true`.
5. Keep `sync-stablecoin-charts`, `sync-fx-rates`, `status-self-check`, and stale-data alerting independent.
6. Update `snapshot-supply.ts` and `stability-index.ts` logging to distinguish:
   - "skipped because upstream degraded"
   - "skipped because cache stale"
7. If `sync-stablecoins` degrades, emit one operator-facing status message instead of letting multiple downstream crons degrade separately.

**Required tests**

- `worker/src/__tests__/index.scheduled.test.ts`
  - Add case: degraded `syncStablecoins` does not trigger `snapshotSupply`, `computeAndStoreStabilityIndex`, or `computeAndStoreDEWS`.
  - Add case: safe fallback mode still allows downstream jobs if intentionally approved.
- `worker/src/cron/__tests__/sync-stablecoins.test.ts`
  - Assert presence and meaning of `downstreamSafe`.

**Docs to update**

- `docs/worker-infrastructure.md`
- `docs/data-flow-map.md`
- `docs/status-dashboard.md`

**Risk**

This change will reduce downstream dataset freshness during upstream incidents. That is the correct tradeoff because it prevents stale or invalid data from being re-snapshotted as fresh.

---

## Phase 2 — Redundancy Reduction

### B1. Consolidate route builder patterns

**Problem**

`worker/src/router.ts` repeats the same `withErrorHandler`, `requireAdmin`, and `runIdempotentAdminAction` patterns across many routes.

**Primary files**

- `worker/src/router.ts`
- `worker/src/lib/auth.ts`
- `worker/src/lib/idempotency.ts`

**Implementation steps**

1. Add three route builders:
   - `publicRoute(handler)`
   - `adminRoute(handler)`
   - `idempotentAdminRoute(actionName, handler)`
2. Convert one low-risk route first:
   - `/api/backfill-cg-prices`
3. After tests pass, migrate the remaining admin routes in a second commit.
4. Keep the current endpoint registry checks untouched.

**Required tests**

- `worker/src/api/__tests__/router-contract.test.ts`
- Admin auth tests for at least one migrated route

**Risk**

Low if migrated in small batches. Do not rewrite static and dynamic dispatch in the same change.

### B2. Extract shared DEX observation helpers

**Problem**

`worker/src/cron/dex-liquidity/fetch-primary.ts` and `worker/src/cron/dex-liquidity/fetch-crawlers.ts` duplicate price-observation mapping and metric accumulation logic.

**Primary files**

- `worker/src/cron/dex-liquidity/fetch-primary.ts`
- `worker/src/cron/dex-liquidity/fetch-crawlers.ts`
- `worker/src/cron/dex-liquidity/pool-helpers.ts`
- `worker/src/cron/dex-liquidity/types.ts` if needed

**Implementation steps**

1. Extract `appendTokenBatchObservations()` for the GT/CG token-batch loops.
2. Extract `mergePoolIntoMetrics()` for shared metric accumulation and `topPools` construction.
3. Keep source-specific behavior parameterized:
   - `source`
   - balance-ratio participation
   - locked-liquidity participation
   - organic-fraction participation
4. Refactor one source pair first:
   - GT token batch + CG token batch
5. Refactor the crawler metric merge second.

**Required tests**

- `worker/src/cron/__tests__/sync-dex-liquidity.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-persistence.test.ts`

**Risk**

Medium. The danger is flattening source-specific semantics. Keep each source's weighting rules as explicit parameters, not hidden conditionals inside the helper.

### B3. Extract a shared leaderboard/table scaffold

**Problem**

`stablecoin-table.tsx`, `liquidity-table.tsx`, `flow-table.tsx`, `yield-leaderboard.tsx`, and `depeg-tracker-table.tsx` share a large amount of table shell logic.

**Primary files**

- `src/components/stablecoin-table.tsx`
- `src/components/liquidity-table.tsx`
- `src/components/flow-table.tsx`
- `src/components/yield-leaderboard.tsx`
- `src/components/depeg-tracker-table.tsx`
- New shared helpers under `src/components/` or `src/lib/`

**Implementation steps**

1. Extract the smallest useful primitives first:
   - shared rank cell
   - shared coin identity cell
   - shared header definition shape for sortable columns
2. Do not attempt a generic render-everything table in one pass.
3. Migrate the three leaderboard-style tables first:
   - `liquidity-table`
   - `yield-leaderboard`
   - `depeg-tracker-table`
4. Leave `stablecoin-table` for last because virtualization and column visibility make it the most specialized.
5. Keep existing `SortableTableHead` and `InteractiveTableRow`; build around them.

**Required tests**

- Existing component tests:
  - `src/components/__tests__/liquidity-table.test.ts`
  - `src/components/__tests__/liquidity-stats.test.ts`
  - any table-specific tests already present
- Add one smoke-style snapshot test for a migrated table shell

**Risk**

Medium. The main risk is losing per-table responsive behavior. Migrate one table at a time and run `npm run test:smoke-ui`.

### B4. Reuse the shared stablecoins cache loader in OG rendering

**Problem**

`worker/src/api/og.tsx` reimplements stablecoins cache parsing instead of reusing the shared loader.

**Primary files**

- `worker/src/api/og.tsx`
- `worker/src/lib/stablecoins-cache.ts`

**Implementation steps**

1. Remove the local `loadStablecoins()` helper from `og.tsx`.
2. Use `loadStablecoinsCache()` with explicit handling for degraded/error results.
3. Preserve the current 404/500 behavior, but make malformed cache state observable and consistent with other consumers.

**Required tests**

- Add or extend OG tests only if coverage exists nearby; otherwise keep this bundled with Phase 1 shared-loader tests.

**Risk**

Low. This is mostly duplication removal after A1 is complete.

---

## Phase 3 — Module Decomposition

### C1. Split `generateDailyDigest()`

**Problem**

`worker/src/cron/daily-digest.ts` combines data collection, prompt construction, LLM calling, response parsing, persistence, and social publishing in one long function.

**Primary files**

- `worker/src/cron/daily-digest.ts`

**Target module split**

- `collectDigestInputData(db, nowSec)`
- `buildDigestPrompt(inputData, recentMeta)`
- `requestDigestFromAnthropic(...)`
- `parseDigestResponse(rawText)`
- `storeDigest(db, parsedDigest, inputData)`
- `publishDigest(parsedDigest, now, twitterCreds, telegramCreds)`

**Implementation steps**

1. Extract pure collectors first with no behavioral changes.
2. Extract the LLM response parser second, with a dedicated test file if needed.
3. Extract persistence/publishing last.
4. Keep the external `generateDailyDigest()` signature unchanged.

**Required tests**

- `worker/src/cron/__tests__/daily-digest.test.ts`
  - add focused tests for parser behavior and degraded input-data behavior

**Risk**

Medium. This is safe only after A1 and A2, because otherwise the current hidden degraded semantics will be preserved accidentally inside the new helpers.

### C2. Split `computeRawStatus()`

**Problem**

`worker/src/api/status.ts` combines D1 loading, normalization, threshold policy, cause generation, and response assembly.

**Primary files**

- `worker/src/api/status.ts`

**Target module split**

- `loadCacheHealth(db, now)`
- `loadCronHealth(db, now)`
- `loadDataQuality(db, now)`
- `loadDatasetFreshness(db)`
- `synthesizeStatus(input)`

**Implementation steps**

1. Move pure helper functions first without changing exports.
2. Extract the three data loaders.
3. Make `synthesizeStatus()` pure and unit-testable.
4. Keep `handleStatus()` unchanged except for calling the new pieces.

**Required tests**

- `worker/src/api/__tests__/status.test.ts`
  - add one synthesis-heavy fixture that validates causes and final status

**Risk**

Low-to-medium. The logic is already covered at response level, but preserve current thresholds exactly.

---

## Phase 4 — Tooling and Cleanup

### D1. Expand the critical coverage gate

**Problem**

The critical coverage gate currently omits `scheduled`, `status`, and `daily-digest`, which are high-value failure-path modules.

**Primary files**

- `package.json`
- `scripts/check-critical-coverage.mjs`

**Implementation steps**

1. Add these files to `CRITICAL_FILES`:
   - `worker/src/handlers/scheduled.ts`
   - `worker/src/api/status.ts`
   - `worker/src/cron/daily-digest.ts`
2. Add their corresponding tests to `coverage:critical`.
3. Set realistic initial thresholds:
   - `scheduled.ts`: 55% minimum
   - `status.ts`: 45% minimum
   - `daily-digest.ts`: 40% minimum
4. After the new degraded-path tests are in place, ratchet upward later.

**Required tests**

- Existing coverage command plus newly added suites

**Risk**

Low. This may fail CI immediately until the missing tests are added, so land it only with the test additions.

### D2. Make script/runtime dependencies explicit

**Problem**

Root scripts call `tsx`, but root `package.json` does not declare it directly. Root `@resvg/resvg-wasm` appears unused while worker OG rendering uses `@cf-wasm/resvg/workerd`.

**Primary files**

- `package.json`
- `package-lock.json`
- `worker/package.json`

**Implementation steps**

1. Add `tsx` explicitly to root `devDependencies`, or rewrite all root script calls to `npx tsx` consistently. Prefer explicit dependency.
2. Remove root `@resvg/resvg-wasm` only after confirming nothing outside tests imports it.
3. Do not act on `knip`'s `vite`/`postcss`/worker-package false positives blindly; they are config-boundary artifacts.

**Required verification**

```bash
npm run build
npm run sync:digests -- --help || true
```

**Risk**

Low. The only meaningful risk is breaking local scripts if `tsx` is removed before being declared explicitly.

### D3. Clean up stale files after ownership check

**Problem**

The repo contains candidate stale files:

- `DESIGN-MAPPING-TABLE.ts`
- `scripts/fetch-logos.ts`
- `scripts/screenshot-og.mjs`
- `worker/src/types/assets.d.ts`

**Implementation steps**

1. Confirm they are not referenced in docs, CI, or manual runbooks that still matter.
2. Remove one file at a time.
3. Run full repo search after each removal:

```bash
rg -n "DESIGN-MAPPING-TABLE|fetch-logos|screenshot-og|assets.d.ts" .
```

**Risk**

Medium only because stale files sometimes survive as manual operator tools. If any file is still used outside code, move it to `agents/` or document it instead of deleting it.

---

## Recommended Worktree Breakdown

If this plan is executed via parallel worktrees, use this order:

1. `maint-a1-stablecoins-cache`
2. `maint-a2-safety-snapshot`
3. `maint-a3-cron-gating`
4. `maint-b1-router-builders`
5. `maint-b2-dex-dedup`
6. `maint-b3-table-scaffold`
7. `maint-c1-digest-split`
8. `maint-c2-status-split`
9. `maint-d1-coverage-gate`
10. `maint-d2-dep-hygiene`
11. `maint-d3-stale-file-cleanup`

Phase 1 work should merge before Phases 2 and 3 begin. Phase 4 can run after Phase 1, except `D1`, which should land with its matching tests.

## Operator-Facing Rollout Notes

- Any change that converts silent empty fallback into explicit degraded behavior must be called out in `docs/status-dashboard.md`.
- Any change to digest skip behavior must be reflected in `docs/digest-pipeline.md`.
- Any change to cron gating must be reflected in `docs/worker-infrastructure.md`.
- No methodology page updates are required unless a scoring formula changes. This plan does not change formulas.

## Final Acceptance Criteria

The remediation effort is complete when all of the following are true:

- Broken stablecoins cache state can no longer appear healthy to `status`, `daily-digest`, or safety-score consumers.
- Quarter-hour dependent jobs do not run after unsafe `sync-stablecoins` outcomes.
- Safety snapshot degradation is explicit and no longer collapses to synthetic empty success.
- Frontend leaderboard/table duplication is reduced through shared scaffolding.
- DEX ingestion duplication is reduced through extracted shared helpers.
- `daily-digest.ts` and `status.ts` are split into smaller, testable units.
- Critical coverage gates include `scheduled`, `status`, and `daily-digest`.
- Script/runtime dependencies are explicit and unused root dependencies are removed.

## Recommended First PR

The safest first PR is:

1. A1 stablecoins-cache contract hardening
2. A2 safety snapshot contract hardening
3. matching tests for `status`, `daily-digest`, and `sync-yield-data`

That single PR closes the most dangerous silent-failure behavior and makes the rest of the plan safer to execute.
