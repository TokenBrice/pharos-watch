# Maintainability Audit - Remediation Plan

> Detailed remediation plan for the maintainability audit completed on 2026-03-12.
> Scope is intentionally incremental: fix correctness and observability first, then remove duplication, then decompose the remaining high-complexity modules, then close with tests, docs, and low-risk dependency hygiene.

## Objective

Resolve every issue identified in the current maintainability audit without introducing downtime, public contract churn, or broad architectural rewrites.

The target outcome is:

- fail-closed behavior for first-party API contract mismatches
- status and operator tooling that surface query failure instead of hiding it behind zero-like values
- one canonical stablecoins-cache read path
- no methodology-sensitive hardcoded fallback where shared scoring data already exists
- smaller orchestration surfaces in the worker's most critical modules
- first-party frontend consumers using the narrowest correct API contracts

## Source Findings Covered

This plan resolves all findings from the current audit:

1. Frontend API contract validation is fail-open for non-strict endpoints.
2. `/api/status` can mask subquery failures as healthy-looking zeros.
3. Mint/burn flight-to-quality classification silently falls back to hardcoded safe havens.
4. Feedback auto-verification hardcodes a `$1` peg reference for all stablecoins.
5. Stablecoins-cache parsing is still duplicated across worker modules despite an existing shared loader.
6. `sync-blacklist` and `sync-mint-burn` duplicate cron-lane orchestration concerns.
7. First-party frontend supply-history consumers reconstruct history from the detail endpoint instead of using the dedicated history endpoint.
8. `syncStablecoins()` is still an oversized orchestration chokepoint.
9. `worker/src/api/status.ts` still mixes handler composition, loading, and policy synthesis in one module.
10. Low-risk sustainability follow-up remains: missing regression coverage around the remediated paths, patch/minor dependency drift, and docs alignment for the changed behavior.

## Non-Goals

- No scoring or methodology formula changes to PSI, DEWS, report cards, peg scoring, liquidity scoring, or yield scoring.
- No redesign of the worker/router architecture.
- No public endpoint removals in the same phase as contract hardening.
- No full stablecoins-pipeline rewrite.
- No UI redesign beyond rendering better unavailable/degraded states where correctness requires it.
- No major dependency upgrades during this remediation plan.

## Baseline Confirmation

The following commands passed on the audit baseline before planning:

```bash
npm run lint
npm run check:worker-boundary
cd worker && npx tsc --noEmit
npm test
npm run build
```

These results make the remediation plan primarily structural and correctness-hardening work, not defect triage.

## Execution Principles

- Prefer additive safeguards before subtractive cleanup.
- Preserve endpoint shapes unless the current shape actively hides broken state.
- When a helper is introduced, it must replace real duplication in at least 3 call sites or remove a production-risk divergence.
- Keep worker/frontend/shared boundaries explicit.
- Update application docs whenever operator expectations, API semantics, or data-flow responsibilities change.
- Stop and split the work if a "refactor" starts changing behavior in multiple unrelated paths at once.

## Verification Gates

### Mandatory gate after every completed phase

```bash
npm run lint
npm test
cd worker && npx tsc --noEmit
npm run build
```

### Targeted suites during development

Use these while developing the relevant workstreams:

```bash
npx vitest run src/lib/__tests__/api-fetch-contracts.test.ts
npx vitest run src/lib/__tests__/stablecoin-detail-view-model.test.ts
npx vitest run worker/src/lib/__tests__/stablecoins-cache.test.ts
npx vitest run worker/src/api/__tests__/status.test.ts
npx vitest run worker/src/api/__tests__/feedback.test.ts
npx vitest run worker/src/api/__tests__/mint-burn-flows.test.ts
npx vitest run worker/src/api/__tests__/stablecoin-summary.test.ts
npx vitest run worker/src/cron/__tests__/snapshot-supply.test.ts
npx vitest run worker/src/cron/__tests__/dex-liquidity-scoring.test.ts
npx vitest run worker/src/cron/__tests__/sync-stablecoins.test.ts
npx vitest run worker/src/cron/__tests__/sync-blacklist.test.ts
npx vitest run worker/src/cron/__tests__/sync-mint-burn.test.ts
```

### Smoke gates

Run after Phase 1 and after Phase 4:

```bash
npm run test:smoke-ui
npm run test:smoke-api -- --base-url https://api.pharos.watch
```

## Docs Expected To Change

Not every phase will touch every document, but these are the likely update targets:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/data-flow-map.md`
- `docs/data-pipeline.md`
- `docs/status-dashboard.md`
- `docs/mint-burn-flows.md`
- `docs/feedback-pipeline.md`
- `docs/testing.md`
- `docs/worker-infrastructure.md`

## Recommended Execution Order

```text
Phase 0: Baseline and characterization
  P0-A capture current behavior and contract fixtures

Phase 1: Correctness and observability barriers
  A1 frontend API contract enforcement
  A2 status query-failure explicitness
  A3 stablecoins-cache loader convergence
  A4 mint/burn flight-to-quality classification convergence
  A5 feedback peg-reference correctness

Phase 2: Data-path and duplication cleanup
  B1 supply-history API convergence for first-party consumers
  B2 narrow cron-lane orchestration extraction

Phase 3: Module decomposition
  C1 sync-stablecoins phase extraction
  C2 status endpoint decomposition

Phase 4: Sustainability closure
  D1 regression coverage and critical-path tests
  D2 patch/minor dependency refresh
  D3 docs, endpoint inventory, and cleanup pass
```

Phases 1 and 4 are mandatory. Phases 2 and 3 should remain sequential unless file scopes are clearly disjoint.

---

## Phase 0 - Baseline And Characterization

### P0-A. Capture current behavior snapshots

**Purpose**

Freeze the current behavior before tightening contracts or decomposing critical worker modules.

**Required actions**

1. Save representative JSON responses for:
   - `GET /api/stablecoins`
   - `GET /api/stablecoin/usdt-tether`
   - `GET /api/supply-history?stablecoin=usdt-tether`
   - `GET /api/mint-burn-flows`
   - `GET /api/status` with a valid admin key
2. Record current behavior for the three fragile fallback paths:
   - malformed/nonconforming frontend API payload handling
   - status subquery failure behavior
   - mint/burn FTQ when `report_card_cache` is unavailable
3. Save one smoke snapshot for:
   - `/`
   - `/stablecoin/usdt-tether`
   - `/flows`
   - `/status`
4. Note the existing unused/first-party-unused routes:
   - `/api/stablecoin-summary/:id`
   - any first-party callers of `/api/stablecoin/:id` used only for supply history

**Why it matters**

The first two phases intentionally change failure semantics. Baseline fixtures are required so later diffs are attributable.

---

## Phase 1 - Correctness And Observability Barriers

### A1. Tighten frontend API contract enforcement

**Problem**

`src/lib/api.ts` warns and returns raw payloads on schema mismatch for non-strict paths. That is unsafe for first-party dashboard consumers because malformed data can render as if it were valid.

**Primary files**

- `src/lib/api.ts`
- `src/hooks/use-api-query.ts`
- `src/hooks/api-hooks.ts`
- `src/hooks/use-stablecoins.ts`
- `shared/lib/api-endpoints.ts`
- `src/lib/__tests__/api-fetch-contracts.test.ts`

**Target state**

- Schema-bearing first-party fetches fail closed by default.
- Any intentional fail-open behavior is explicit at the call site, not implicit because a path is absent from a registry.
- Critical first-party hooks either have schemas or are moved to narrower typed endpoints.

**Implementation steps**

1. Introduce an explicit fetch-contract mode in `src/lib/api.ts`.
   - Keep the current helpers, but change the API so schema-bearing callers can opt into `strict` or `warn`.
   - Make `strict` the default for first-party hooks that already provide schemas.
2. Update `useApiQuery()` and `useApiQueryWithMeta()` to forward the contract mode cleanly.
3. Inventory current schema-bearing hooks and convert them to explicit strict mode.
4. Keep a small explicit opt-out list only for routes that genuinely must accept temporary schema drift.
5. Do not add new untyped first-party consumers during the remediation.
6. As part of B1, remove the remaining untyped supply-history use of `/api/stablecoin/:id`.

**Required tests**

- Extend `src/lib/__tests__/api-fetch-contracts.test.ts`:
  - strict mode throws on malformed payload
  - warn mode preserves current graceful behavior where explicitly configured
- Add a focused unit test for `src/lib/api.ts` if the current suite does not directly cover mode selection.

**Docs**

- `docs/testing.md`
- `docs/architecture.md` if hook/contract ownership needs clarification

**Exit criteria**

- Any first-party hook that passes a schema fails closed unless it explicitly opts out.
- No first-party page silently renders malformed typed data as valid.

**Risk**

Medium. This can expose latent backend schema drift. Mitigate by rolling out strict mode to already-Zod-backed hooks first and using the baseline fixtures to isolate fallout.

### A2. Make `/api/status` query failures explicit and operator-visible

**Problem**

`getDataQuality()` in `worker/src/api/status.ts` catches several DB query failures and continues with `0`-like values, which can make the status surface look healthier than reality.

**Primary files**

- `worker/src/api/status.ts`
- `worker/src/api/status-derived-data.ts`
- `shared/types/status.ts`
- `src/lib/status-dashboard-model.ts`
- `src/components/status/*`

**Target state**

- Each critical status subquery reports `ok` or `failed` explicitly.
- Status synthesis degrades when a critical source fails.
- The UI can render "unavailable" or "query failed" instead of `0`.

**Implementation steps**

1. Define a small source-status structure for data-quality subqueries.
   - Recommended sources: `stablecoinsCache`, `blacklistGaps`, `activeDepegs`, `onchainSupply`.
2. Extend the `dataQuality` payload with:
   - `sourceFailures`
   - per-source status fields
   - nullable metrics where zero is otherwise ambiguous
3. Refactor `getDataQuality()` so caught failures append failure metadata instead of only logging and returning zero.
4. Update status synthesis so critical source failures degrade `dataQualityStatus`.
5. Update the frontend status model/components to display unavailable states without breaking existing cards.
6. Preserve `no-store` and admin auth behavior exactly.

**Required tests**

- `worker/src/api/__tests__/status.test.ts`
  - blacklist-gap query failure degrades status
  - active-depeg query failure is surfaced explicitly
  - on-chain supply query failure does not render as healthy zero divergence
- add at least one frontend model test if `src/lib/status-dashboard-model.ts` gains new branches

**Docs**

- `docs/status-dashboard.md`
- `docs/api-reference.md`

**Exit criteria**

- `/api/status` can no longer report healthy-looking zero values for failed critical subqueries.
- Operators can identify which source failed from the response and UI.

**Risk**

Low-to-medium. The main risk is UI churn from introducing nullable/unavailable states. Mitigate by adding fields before removing old assumptions.

### A3. Converge all stablecoins-cache consumers on the shared loader

**Problem**

The repo already has `worker/src/lib/stablecoins-cache.ts`, but multiple modules still reimplement `getCache("stablecoins") + JSON.parse()` with different fallback semantics.

**Primary files**

- `worker/src/lib/stablecoins-cache.ts`
- `worker/src/api/og.tsx`
- `worker/src/api/feedback.ts`
- `worker/src/api/stablecoin-summary.ts`
- `worker/src/lib/report-cards-snapshot.ts`
- `worker/src/cron/snapshot-supply.ts`
- `worker/src/cron/dex-liquidity/scoring.ts`
- `worker/src/handlers/scheduled/quarter-hourly.ts`
- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/sync-stablecoins/stages.ts`

**Target state**

- Every stablecoins-cache read goes through one shared loader.
- Strict versus lenient semantics are explicit per caller.
- Repeated local `StablecoinsCachePayload` type aliases disappear unless they are genuinely narrower projections.

**Implementation steps**

1. Inventory every remaining stablecoins-cache read and classify it:
   - strict read required
   - lenient/degraded read acceptable
   - internal previous-cache read
2. Migrate all read-side consumers to `loadStablecoinsCache()`.
3. Add small shared projections only if they replace repeated logic in 3 or more call sites:
   - `assetById`
   - `priceById`
   - `peggedAssets`
4. Remove local cache-loader helpers from:
   - `og.tsx`
   - `stablecoin-summary.ts`
   - `snapshot-supply.ts`
   - `report-cards-snapshot.ts`
5. Convert feedback auto-verification to use the shared loader before applying A5 peg-reference fixes.
6. For `sync-stablecoins` and `stages.ts`, keep previous-snapshot handling local only where a raw internal shape is required for in-progress sync comparison.

**Required tests**

- `worker/src/lib/__tests__/stablecoins-cache.test.ts`
- `worker/src/api/__tests__/stablecoin-summary.test.ts`
- `worker/src/api/__tests__/feedback.test.ts`
- `worker/src/lib/__tests__/report-cards-snapshot.test.ts`
- `worker/src/cron/__tests__/snapshot-supply.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-scoring.test.ts`

**Docs**

- `docs/data-flow-map.md`
- `docs/data-pipeline.md`

**Exit criteria**

- No production read-side module hand-parses the stablecoins cache.
- Strict/lenient semantics are uniform and test-covered.

**Risk**

Low. The primary risk is changing legacy-array handling unexpectedly. Migrate callers one by one.

### A4. Replace hardcoded mint/burn safe-haven fallback with shared report-card classification

**Problem**

`worker/src/api/mint-burn-flows.ts` silently falls back to hardcoded `SAFE_HAVEN_IDS` when `report_card_cache` is stale or missing, which decouples FTQ behavior from the real report-card methodology.

**Primary files**

- `worker/src/api/mint-burn-flows.ts`
- `worker/src/lib/report-cards-snapshot.ts` or a new worker-side shared helper
- `worker/src/api/__tests__/mint-burn-flows.test.ts`

**Target state**

- Safe/risky classification is derived from shared report-card logic or shared cache-derived helper output.
- Stale/missing report-card data degrades FTQ behavior explicitly instead of silently switching to hardcoded IDs.

**Implementation steps**

1. Extract a worker-side helper that derives FTQ safe/risky sets from report-card scores.
2. Update `mint-burn-flows.ts` to use that helper.
3. Decide fallback behavior:
   - preferred: omit grade-based FTQ classification and mark the response degraded
   - acceptable transitional fallback: use a shared helper over cached report-card data only
4. Remove or quarantine `SAFE_HAVEN_IDS` so it is no longer the silent runtime truth for FTQ.
5. Keep threshold semantics unchanged unless the report-card methodology explicitly changes later.

**Required tests**

- Extend `worker/src/api/__tests__/mint-burn-flows.test.ts` with:
  - stale `report_card_cache` handling
  - missing `report_card_cache` handling
  - parse failure handling
  - happy-path classification from report-card scores

**Docs**

- `docs/mint-burn-flows.md`
- `docs/report-cards.md` if the shared classification helper becomes part of the documented contract

**Exit criteria**

- FTQ classification is no longer controlled by a silent hardcoded fallback list.
- Response metadata or status clearly indicates when classification input is degraded.

**Risk**

Low. The danger is changing FTQ output shape and classification simultaneously. Keep thresholds constant in this phase.

### A5. Fix feedback auto-verification peg-reference correctness

**Problem**

`verifyDataCorrection()` in `worker/src/api/feedback.ts` hardcodes `pegRef = 1.0`, which misclassifies non-USD-pegged assets in the feedback verification block.

**Primary files**

- `worker/src/api/feedback.ts`
- `shared/lib/peg-utils.ts` or another runtime-neutral shared peg-reference helper module
- `worker/src/api/__tests__/feedback.test.ts`

**Target state**

- Feedback auto-verification resolves the correct peg reference for USD, fiat, gold, and silver pegged assets.
- The verification block is still lightweight and non-blocking.

**Implementation steps**

1. Reuse or extract a runtime-neutral peg-reference resolver from shared code instead of duplicating frontend-only logic.
2. Resolve metadata from the tracked stablecoin ID before computing deviation.
3. Use cached/fallback peg rates when necessary for fiat and commodity pegs.
4. Keep the output text format stable so GitHub issue formatting does not churn.
5. Preserve the current non-fatal behavior when cache or metadata is unavailable.

**Required tests**

- Extend `worker/src/api/__tests__/feedback.test.ts` with:
  - one EUR-pegged asset
  - one commodity-pegged asset
  - cache unavailable fallback case

**Docs**

- `docs/feedback-pipeline.md`

**Exit criteria**

- Feedback verification no longer assumes every stablecoin is pegged to `$1`.

**Risk**

Low. This is isolated to feedback triage metadata and has no runtime write-path risk.

---

## Phase 2 - Data-Path And Duplication Cleanup

### B1. Move first-party supply-history consumers to `/api/supply-history`

**Problem**

The frontend currently reconstructs supply history from `/api/stablecoin/:id` through `useSupplyHistory()` in `src/hooks/use-stablecoins.ts`, even though the worker already exposes `/api/supply-history` for exactly this purpose.

**Primary files**

- `src/hooks/use-stablecoins.ts`
- `src/hooks/api-hooks.ts`
- `src/components/total-mcap-chart.tsx`
- `src/hooks/use-stablecoin-detail-view-model.ts`
- `src/lib/stablecoin-detail-view-model.ts`
- `worker/src/api/supply-history.ts`
- `shared/types/index.ts`

**Target state**

- First-party consumers that only need daily supply history use `/api/supply-history`.
- `detailToSupplyHistory()` is removed once it has no remaining valid consumers.
- `/api/stablecoin-summary/:id` usage is explicitly inventoried and documented.

**Implementation steps**

1. Add or reuse a dedicated shared schema/type for supply-history responses.
2. Implement a first-party hook for `/api/supply-history`.
3. Migrate:
   - homepage total market-cap chart
   - stablecoin detail view model
4. Audit remaining users of `detailToSupplyHistory()`.
5. If `/api/stablecoin-summary/:id` is still unused by first-party code after migration, document its retained purpose rather than removing it in the same change.

**Required tests**

- `worker/src/api/__tests__/supply-history.test.ts`
- `src/lib/__tests__/stablecoin-detail-view-model.test.ts`
- add or extend a test for the homepage chart data assembly if needed

**Docs**

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/data-flow-map.md`

**Exit criteria**

- First-party history-only consumers no longer depend on the heavyweight detail endpoint.
- `useSupplyHistory()` no longer hand-transforms detail payloads.

**Risk**

Low. The main risk is changing time-series density expectations. Keep daily-history consumers on the daily endpoint only.

### B2. Extract a narrow shared cron-lane orchestration helper

**Problem**

`sync-blacklist` and `sync-mint-burn` repeat the same non-domain-specific concerns: budget accounting, progress payload assembly, skip/finalize bookkeeping, and final metadata serialization.

**Primary files**

- `worker/src/cron/sync-blacklist.ts`
- `worker/src/cron/sync-mint-burn.ts`
- new helper under `worker/src/lib/` or `worker/src/cron/shared/`

**Target state**

- Shared orchestration only for the repeated shell concerns.
- Chain-specific cursor advancement, scan semantics, and error classification stay local.

**Implementation steps**

1. Extract the smallest common pieces first:
   - budget metadata block builder
   - progress payload helper
   - final status/metadata assembly helpers where the structure is truly shared
2. Migrate `sync-mint-burn` first because its config summary model is already more structured.
3. Migrate `sync-blacklist` second only if the helper reduces net complexity.
4. Stop if the abstraction begins to hide chain-specific cursor semantics or add branching that makes either job harder to reason about.

**Required tests**

- `worker/src/cron/__tests__/sync-blacklist.test.ts`
- `worker/src/cron/__tests__/sync-mint-burn.test.ts`

**Docs**

- `docs/worker-infrastructure.md` only if shared metadata/status semantics change

**Exit criteria**

- Duplicated cron-lane shell code is materially reduced.
- Domain-specific scan logic remains local and readable.

**Risk**

Medium. This refactor is only worth doing if it reduces real duplication without hiding behavior.

---

## Phase 3 - Module Decomposition

### C1. Continue decomposing `syncStablecoins()` into explicit phases

**Problem**

`worker/src/cron/sync-stablecoins.ts` still owns source fetch, fallback selection, discovery upserts, normalization, price resolution, cache persistence, and depeg triggering in one large orchestration function.

**Primary files**

- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/sync-stablecoins/stages.ts`
- `worker/src/cron/sync-stablecoins/supplemental-assets.ts`
- new files under `worker/src/cron/sync-stablecoins/`

**Target state**

- The main exported function becomes a phase coordinator.
- Phase modules own:
  - source acquisition
  - normalization and canonicalization
  - price resolution and fallback application
  - payload validation and cache persistence
  - downstream depeg pipeline

**Implementation steps**

1. Introduce a typed phase context that carries shared mutable state explicitly.
2. Extract the current source/fallback selection into a source phase module.
3. Extract normalization and canonicalization next, reusing `stages.ts` where possible.
4. Extract price-resolution/persistence next, preserving metadata and warning semantics exactly.
5. Extract depeg follow-up last.
6. Keep the exported signature and result metadata shape stable during decomposition.

**Required tests**

- `worker/src/cron/__tests__/sync-stablecoins.test.ts`
- `worker/src/cron/__tests__/sync-stablecoins-stages.test.ts`
- any affected downstream cron tests if metadata fields move

**Docs**

- `docs/data-pipeline.md`
- `docs/data-flow-map.md`
- `docs/worker-infrastructure.md`

**Exit criteria**

- `syncStablecoins()` reads as a coordinator, not an all-in-one implementation.
- Existing metadata fields and fallback behavior remain unchanged unless explicitly improved in Phase 1.

**Risk**

Medium. This must remain a characterization refactor after the correctness barriers are in place.

### C2. Split status loading, synthesis, and handler composition

**Problem**

`worker/src/api/status.ts` still mixes DB loading, threshold policy, cause construction, and handler assembly in one file.

**Primary files**

- `worker/src/api/status.ts`
- `worker/src/api/status-derived-data.ts`
- new sibling modules such as:
  - `worker/src/api/status-loaders.ts`
  - `worker/src/api/status-synthesis.ts`

**Target state**

- `handleStatus()` becomes composition only.
- Data loaders are isolated from synthesis.
- Status policy becomes pure and unit-testable.

**Implementation steps**

1. Move `getDataQuality()` and similar DB-heavy helpers into loader modules.
2. Extract pure status synthesis into a standalone module.
3. Keep `handleStatus()` responsible only for:
   - admin wrapper
   - calling loaders
   - reconciliation with status state
   - assembling the final response
4. Leave route wiring, auth, and cache headers unchanged.

**Required tests**

- `worker/src/api/__tests__/status.test.ts`
- add a pure synthesis test if the extracted policy module is non-trivial

**Docs**

- `docs/status-dashboard.md`
- `docs/architecture.md`

**Exit criteria**

- `status.ts` no longer contains both the handler shell and the heavy policy/data-loading internals.

**Risk**

Low-to-medium. Keep threshold constants and cause text stable while extracting.

---

## Phase 4 - Sustainability Closure

### D1. Expand regression coverage around the remediated paths

**Problem**

Several of the issues above are only partially protected today, especially:

- strict versus warn contract semantics
- status subquery failure behavior
- non-USD feedback verification
- FTQ classification under degraded report-card state
- supply-history consumer behavior after endpoint convergence

**Primary files**

- `src/lib/__tests__/api-fetch-contracts.test.ts`
- `worker/src/api/__tests__/status.test.ts`
- `worker/src/api/__tests__/feedback.test.ts`
- `worker/src/api/__tests__/mint-burn-flows.test.ts`
- `worker/src/lib/__tests__/stablecoins-cache.test.ts`
- any newly added frontend hook/component tests

**Implementation steps**

1. Add regression tests in the same PRs as the behavior changes above.
2. After Phases 1-3 are complete, review whether the most operator-critical new paths belong in `coverage:critical` or `test:critical-contracts`.
3. If a path is promoted to critical coverage, update the scripts only after the tests are stable and non-flaky.

**Docs**

- `docs/testing.md`

**Exit criteria**

- Every Phase 1 behavior change has a direct regression test.
- Critical path coverage decisions are explicit instead of implied.

### D2. Batch low-risk patch/minor dependency refresh

**Problem**

The codebase has low-risk patch/minor drift as of 2026-03-12. It is not a production defect, but leaving it unbatched increases future maintenance friction.

**Candidate updates**

Root:

- `tailwindcss` -> `4.2.1`
- `@tailwindcss/postcss` -> `4.2.1`
- `@tanstack/react-query` -> `5.90.21`
- `@tanstack/react-virtual` -> `3.13.22`
- `@types/node` -> `20.19.37`
- `@types/react` -> `19.2.14`
- `vitest` -> `4.1.0`
- `@vitest/coverage-v8` -> `4.1.0`
- `eslint` -> `9.39.4`
- `recharts` -> `3.8.0`
- `tailwind-merge` -> `3.5.0`
- `react` / `react-dom` -> `19.2.4`

Worker:

- `wrangler` -> `4.72.0`
- `@cloudflare/workers-types` -> `4.20260312.1`

**Implementation steps**

1. Batch updates by risk class:
   - test/lint/tooling
   - Cloudflare toolchain
   - UI/runtime patches
2. Do not include majors in this remediation.
3. Re-run the full mandatory gate plus smoke checks after each batch.

**Docs**

- none unless a toolchain command changes

**Exit criteria**

- Patch/minor drift is reduced without widening the remediation blast radius.

### D3. Docs, endpoint inventory, and cleanup pass

**Problem**

The remediation changes will alter operator-visible semantics and internal ownership. Docs must be updated before the work is considered complete.

**Implementation steps**

1. Update all affected docs listed at the top of this plan.
2. Record the post-remediation status of `/api/stablecoin-summary/:id`:
   - retained and documented
   - or moved to a follow-up deprecation ticket
3. Remove dead local helpers made obsolete by:
   - stablecoins-cache loader convergence
   - supply-history hook convergence
   - status extraction
4. Run a final `rg` sweep for:
   - duplicate stablecoins-cache payload type aliases
   - unused `detailToSupplyHistory`
   - stale `SAFE_HAVEN_IDS` usage in FTQ logic

**Exit criteria**

- Docs reflect the new behavior.
- Obsolete helpers are deleted.
- The endpoint inventory is explicit.

---

## Stop Conditions

Pause and split the work if any of the following occurs:

- A1 surfaces multiple unrelated schema mismatches across public endpoints at once.
- A2 requires a breaking shared-type rewrite across frontend and worker in a single patch.
- B2 adds more branching than it removes in either cron file.
- C1 or C2 change response metadata or fallback semantics unintentionally.

When a stop condition is hit:

1. freeze the partial refactor
2. restore behavior with the smallest possible rollback
3. create a narrower follow-up plan or ticket before continuing

## Final Validation

After all phases complete, run:

```bash
npm run lint
npm test
cd worker && npx tsc --noEmit
npm run build
npm run test:smoke-api -- --base-url https://api.pharos.watch
npm run test:smoke-ui -- --url https://pharos.watch
npm outdated --json
cd worker && npm outdated --json
```

The remediation is complete only when:

- all targeted tests pass
- docs are updated
- the new failure semantics are visible in the UI and API where expected
- no first-party consumer silently relies on malformed data or silent hardcoded classification fallback
