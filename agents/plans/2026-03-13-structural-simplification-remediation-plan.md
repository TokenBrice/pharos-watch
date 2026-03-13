# Structural Simplification Remediation Plan

Date: 2026-03-13

> Self-sufficient implementation plan for the structural simplification audit completed on 2026-03-13.
> This file is written for autonomous execution after a context reset. It restates the problems, the target end state, the sequencing, the file scopes, the validation gates, and the stop conditions so implementation does not depend on the original chat.

## Objective

Reduce maintenance cost in the Pharos codebase by removing duplicated orchestration, converging repeated UI and worker patterns, and shrinking the number of places where the same operational knowledge is maintained twice.

The target outcome is:

- one authoritative route/endpoint registry per runtime concern
- one stable pattern for sortable leaderboard tables
- one canonical tracked-stablecoin registry usage pattern
- one standard shell for client-heavy feature pages
- smaller, easier-to-scan status and coverage page modules
- one dependency management path for shared tooling, or an explicit documented fallback if workspace convergence is not viable

This plan covers every issue identified in the 2026-03-13 audit:

1. Endpoint path, method, probe, cache, and routing data are duplicated across `shared/lib/api-endpoints.ts` and `worker/src/router.ts`.
2. Sortable leaderboard tables repeat the same shell, sort wiring, header plumbing, and pagination structure across multiple components.
3. Stablecoin ID maps and sets are rebuilt locally even though shared canonical registries already exist.
4. `createClientFeaturePage()` exists but only some client-heavy routes use it.
5. `src/app/status/client.tsx` still carries too much page-local presentation and configuration despite an existing status component tree and model hook.
6. `src/app/coverage/client.tsx` mixes seven-query orchestration, derived row/model construction, page-local design config, and rendering in one file.
7. Root and worker package trees duplicate shared toolchain dependencies and maintain separate lockfiles and `node_modules` trees.

## Baseline Snapshot

### Architecture boundaries

- Frontend page layer: `src/app/*`
- Frontend UI layer: `src/components/*`
- Frontend hooks/utilities: `src/hooks/*`, `src/lib/*`
- Shared runtime-neutral logic: `shared/lib/*`, `shared/types/*`
- Worker HTTP/scheduled entry: `worker/src/index.ts`, `worker/src/handlers/*`
- Worker API layer: `worker/src/api/*`
- Worker cron layer: `worker/src/cron/*`
- Worker runtime/utilities: `worker/src/lib/*`

### Code-volume concentration

Measured during the audit:

| Module | Files | Lines |
|---|---:|---:|
| `src/app` | 76 | 12,933 |
| `src/components` | 179 | 29,972 |
| `src/hooks` | 43 | 3,771 |
| `src/lib` | 70 | 10,037 |
| `shared/lib` | 40 | 11,585 |
| `worker/src/api` | 92 | 17,787 |
| `worker/src/cron` | 125 | 32,792 |
| `worker/src/lib` | 103 | 19,139 |

### Baseline verification already completed

These commands passed on the current baseline before this plan was written:

```bash
npm run build
cd worker && npx tsc --noEmit
```

The plan should therefore be executed as behavior-preserving refactors plus targeted simplification, not as a broad defect hunt.

## Non-Goals

- No public endpoint removals or path changes.
- No methodology/scoring changes to PSI, DEWS, report cards, liquidity, yield, or peg scoring.
- No rewrite of `shared/lib/stablecoins.ts` into many files.
- No redesign of the visual language or route IA.
- No changes to `src/components/ui/*`.
- No generic abstraction unless it replaces at least 3 real concrete cases.
- No package-manager migration that breaks existing local worker development flow.

## Execution Rules

- Prefer deletions to new abstractions.
- Keep API response shapes and query keys stable unless explicitly noted.
- Do not mix package/workspace churn with route or table churn in the same commit series.
- If a new helper does not remove meaningful duplication, delete it instead of keeping both paths.
- Update docs when architecture ownership, operator workflow, or implementation conventions change.
- Use one branch/workstream per major phase to keep reviewable diffs.

## Validation Gates

### Mandatory gate after every completed phase

```bash
npm run lint
npm test
cd worker && npx tsc --noEmit
npm run build
```

### Targeted suites by workstream

Use the relevant subset while developing each phase:

```bash
npx vitest run src/hooks/__tests__/use-sort.test.ts
npx vitest run src/hooks/__tests__/use-sorted-table-rows.test.ts
npx vitest run src/hooks/__tests__/use-table-pagination.test.ts
npx vitest run src/hooks/__tests__/query-polling-policy.test.ts
npx vitest run src/components/__tests__/flow-table.test.tsx
npx vitest run src/components/__tests__/liquidity-table.test.ts
npx vitest run src/components/__tests__/cron-card.test.tsx
npx vitest run src/components/__tests__/data-quality-cards.test.tsx
npx vitest run src/lib/__tests__/coverage.test.ts
npx vitest run src/lib/__tests__/api-endpoints.test.ts
npx vitest run worker/src/api/__tests__/router-contract.test.ts
npx vitest run worker/src/api/__tests__/status.test.ts
npx vitest run worker/src/api/__tests__/status-history.test.ts
npx vitest run worker/src/api/__tests__/cache-passthrough.test.ts
npx vitest run worker/src/__tests__/index.fetch.test.ts
```

### Boundary and smoke checks

```bash
npm run check:worker-boundary
npm run test:smoke-ui
npm run test:smoke-api
```

Run `check:worker-boundary` after Phase 1 and again after Phase 5.

## Docs Expected To Change

Treat these as likely update targets:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/status-dashboard.md`
- `docs/testing.md`
- `docs/deployment-process.md`
- `docs/methodology-page.md`

## Recommended Execution Order

```text
Phase 0: Baseline and fixture capture
  P0-A baseline verification and snapshots

Phase 1: Low-risk convergence
  A1 canonical stablecoin registries
  A2 client feature-page shell convergence

Phase 2: Table-pattern convergence
  B1 shared sortable table shell
  B2 migrate leaderboard tables
  B3 normalize stablecoin-table header definitions

Phase 3: Route/endpoint ownership simplification
  C1 shrink shared endpoint metadata
  C2 create worker-owned route registry
  C3 rewire status/probe/cache consumers

Phase 4: Large frontend file decomposition
  D1 status page decomposition
  D2 coverage page model extraction

Phase 5: Tooling and package simplification
  E1 workspace feasibility pass
  E2 implement single-toolchain dependency path
  E3 CI/docs normalization

Phase 6: Cleanup and closeout
  F1 dead-file/dead-export sweep
  F2 final docs and audit delta capture
```

Do not parallelize Phases 2 and 3. They both touch cross-cutting conventions and will create avoidable merge noise if run at the same time.

---

## Phase 0 - Baseline And Fixtures

### [ ] P0-A. Capture current behavior

**Purpose**

Freeze current behavior before moving route ownership, table shells, or large page composition.

**Required actions**

1. Run the mandatory gate once on the untouched branch.
2. Save representative responses for:
   - `GET /api/stablecoins`
   - `GET /api/peg-summary`
   - `GET /api/dex-liquidity`
   - `GET /api/status` with a valid admin key
3. Save a visual smoke pass for:
   - `/liquidity`
   - `/depeg`
   - `/coverage`
   - `/status`
4. Save current file counts and line counts for:
   - `src/components`
   - `src/app`
   - `worker/src/api`
   - `shared/lib`

**Why it matters**

Most of the work below is structural. A baseline prevents the refactor from turning into a behavior rewrite by accident.

---

## Phase 1 - Low-Risk Convergence

### [ ] A1. Canonicalize stablecoin registry usage

**Audit finding covered**

Finding 3: stablecoin registries rebuilt locally.

**Primary files**

- `shared/lib/stablecoins.ts`
- `shared/lib/tracked-stablecoin-utils.ts`
- `worker/src/cron/sync-yield-data.ts`
- `worker/src/cron/yield-sync/rankings.ts`
- `worker/src/lib/peg-analytics.ts`
- any other file rebuilding `new Map(TRACKED_STABLECOINS.map(...))` or `new Set(TRACKED_STABLECOINS.map(...))`

**Target state**

- `TRACKED_META_BY_ID` and `TRACKED_IDS` from `shared/lib/stablecoins.ts` are the default source everywhere.
- Derived subsets stay explicit and local only when they are genuinely filtered views.
- `tracked-stablecoin-utils.ts` becomes a thin derived-helpers module, not a defensive second registry surface.

**Implementation steps**

1. Replace local base-registry rebuilds with direct imports of `TRACKED_META_BY_ID` / `TRACKED_IDS`.
2. Keep filtered subsets such as `YIELD_BEARING_STABLECOINS`, but define them from the shared exports without fallback logic.
3. Delete dead local constants made redundant by the shared registry.
4. Run a follow-up `rg` for `new Map(TRACKED_STABLECOINS.map` and `new Set(TRACKED_STABLECOINS.map` to catch stragglers.

**Required tests**

- `npm run build`
- `npx vitest run src/lib/__tests__/critical-invariants.test.ts`
- `npx vitest run worker/src/lib/__tests__/peg-analytics.test.ts`
- `npx vitest run worker/src/cron/__tests__/sync-yield-data.test.ts`

**Docs**

- Update `docs/architecture.md` only if helper/file ownership changes become materially simpler.

**Stop conditions**

- Stop if a local map/set is not equivalent to the global tracked registry and is intentionally filtered or augmented. In that case, rename it to make the special semantics explicit instead of forcing convergence.

### [ ] A2. Converge client-heavy feature routes on `createClientFeaturePage()`

**Audit finding covered**

Finding 4: partial adoption of the route shell factory.

**Primary files**

- `src/lib/client-feature-page.tsx`
- `src/app/coverage/page.tsx`
- `src/app/depeg/page.tsx`
- `src/app/liquidity/page.tsx`
- `src/app/yield/page.tsx`
- `src/app/stability-index/page.tsx`
- `src/app/portfolio/page.tsx`
- any other page that is effectively `FeaturePageShell + client`

**Target state**

- All client-heavy feature routes use one route shell pattern unless they have real server-only differences.
- The factory supports the minimal surface already needed by current routes: metadata stays route-local, while shell composition is standardized.

**Implementation steps**

1. Inventory current `FeaturePageShell` routes and split them into:
   - eligible for `createClientFeaturePage()`
   - intentionally manual (server-heavy, taxonomy, or content pages)
2. Expand `createClientFeaturePage()` only if required for existing route needs:
   - `preface`
   - `headerActions`
   - `beforeClient`
   - `afterClient`
3. Migrate `coverage/page.tsx` to the shared factory.
4. Migrate `depeg/page.tsx` only if its callout and JSON-LD can fit the same factory without making the helper harder to read than the route.
5. Keep manual routes manual if factory use would introduce conditional helper complexity.

**Required tests**

- `npm run build`
- `npx vitest run src/__tests__/page-metadata.test.ts`
- `npm run test:smoke-ui`

**Docs**

- Update `docs/architecture.md` to document the route shell convention if more routes are migrated.

**Stop conditions**

- If making `createClientFeaturePage()` fit `depeg/page.tsx` requires too many optional branches, stop and keep `depeg` manual. The goal is convergence, not a universal page DSL.

---

## Phase 2 - Table-Pattern Convergence

### [ ] B1. Introduce one shared sortable table shell

**Audit finding covered**

Finding 2: repeated leaderboard table shells.

**Primary files**

- `src/components/liquidity-table.tsx`
- `src/components/yield-leaderboard.tsx`
- `src/components/depeg-tracker-table.tsx`
- `src/components/flow-table.tsx`
- `src/components/blacklist-table.tsx`
- `src/components/sortable-table-head.tsx`
- `src/hooks/use-sorted-table-rows.ts`
- `src/hooks/use-sorted-paginated-table.ts`
- `src/hooks/use-table-pagination.ts`

**Target state**

- One shared table-shell pattern owns:
  - header rendering from a column config
  - shared sortable-head plumbing
  - optional pagination footer
  - consistent empty-state row handling
- Per-table files still own:
  - row rendering
  - comparator functions
  - table-specific inline controls/filters

**Implementation steps**

1. Create a small shared primitive such as `src/components/sortable-data-table.tsx` or equivalent.
2. Limit the primitive to shell responsibilities. Do not move data fetching or row/domain formatting into it.
3. Define a flat column configuration shape:
   - `key`
   - `label`
   - `sortable`
   - `sortKey`
   - `className`
   - `headerTitle`
   - `renderCell`
4. Reuse `SortableTableHead` under the hood rather than replacing it.
5. Keep comparator logic in existing `*-table-logic.ts` files for now.

**Required tests**

- `npx vitest run src/hooks/__tests__/use-sort.test.ts`
- `npx vitest run src/hooks/__tests__/use-sorted-table-rows.test.ts`
- `npx vitest run src/hooks/__tests__/use-table-pagination.test.ts`

**Docs**

- Update `docs/testing.md` if new table-shell tests are added.

**Stop conditions**

- If the shared shell starts absorbing per-table row semantics, back up and keep the primitive limited to headers/pagination/empty-state only.

### [ ] B2. Migrate the repeated leaderboard tables

**Audit finding covered**

Finding 2: repeated leaderboard table shells.

**Primary files**

- `src/components/liquidity-table.tsx`
- `src/components/yield-leaderboard.tsx`
- `src/components/depeg-tracker-table.tsx`
- `src/components/flow-table.tsx`
- `src/components/blacklist-table.tsx`

**Target state**

- Each table becomes a thin file:
  - local filters and derived rows
  - column definition array
  - row-specific formatting helpers
- Shared sort/pagination shell logic is removed from each component.

**Implementation steps**

1. Migrate `liquidity-table.tsx` first and use it as the reference implementation.
2. Migrate `depeg-tracker-table.tsx`.
3. Migrate `flow-table.tsx`.
4. Migrate `blacklist-table.tsx`.
5. Migrate `yield-leaderboard.tsx` last because it has expandable rows and local filter chips.
6. For `yield-leaderboard`, keep expansion state local and only share the outer table shell.

**Required tests**

- `npx vitest run src/components/__tests__/liquidity-table.test.ts`
- `npx vitest run src/components/__tests__/flow-table.test.tsx`
- add/extend targeted tests for `yield-leaderboard` if the migration changes header wiring or pagination behavior

**Docs**

- None expected unless test conventions change.

**Stop conditions**

- If a given table becomes less readable after migration, keep that table custom and document why. The shared shell must simplify, not homogenize.

### [ ] B3. Normalize `stablecoin-table.tsx` header/config duplication without removing virtualization

**Audit finding covered**

Finding 2: stablecoin table duplicates the same head plumbing in a custom implementation.

**Primary files**

- `src/components/stablecoin-table.tsx`
- `src/components/stablecoin-table-logic.ts`
- `src/components/stablecoin-table-column-visibility.tsx`

**Target state**

- `stablecoin-table.tsx` stays custom and virtualized.
- Column/header declarations move into a flat config array so header JSX is no longer manually repeated for every column.

**Implementation steps**

1. Extract a `STABLECOIN_COLUMN_DEFS` structure describing:
   - column id
   - sort key
   - visibility gating
   - class names
   - title/tooltip
   - label
2. Render headers from config.
3. Keep cell rendering manual if a cell-config abstraction becomes harder to follow.
4. Preserve:
   - virtualization behavior
   - column visibility prefs
   - current sort fallback logic

**Required tests**

- `npm run build`
- `npx vitest run src/hooks/__tests__/use-sort.test.ts`
- extend/add a `stablecoin-table` test only if header rendering becomes easy to assert

**Stop conditions**

- Do not force row rendering into a generic schema if it makes the file less obvious. The win here is header/config dedup only.

---

## Phase 3 - Route/Endpoint Ownership Simplification

### [ ] C1. Reduce `shared/lib/api-endpoints.ts` to frontend/shared concerns only

**Audit finding covered**

Finding 1: duplicated endpoint/route ownership.

**Primary files**

- `shared/lib/api-endpoints.ts`
- `shared/lib/strict-contract-paths.ts`
- `src/lib/api.ts`

**Target state**

- Shared file owns:
  - `API_PATHS`
  - query/path builders
  - strict-contract path list needed by frontend/runtime-neutral callers
- Worker-only operational metadata moves out:
  - methods
  - admin requirement
  - cache bypass
  - probe groups
  - status page actions

**Implementation steps**

1. Identify every consumer of `getEndpointDefinition`, `getProbePaths`, `validateEndpointMethod`, `isCacheBypassPath`, and `getStatusPageActions`.
2. Keep only the parts that are truly shared.
3. Move worker-only operational metadata into a worker-owned registry module in the next step.
4. Keep `STRICT_CONTRACT_PATHS_LIST` available to the frontend after the split.

**Required tests**

- `npx vitest run src/lib/__tests__/api-endpoints.test.ts`
- `npm run build`

**Docs**

- Update `docs/api-reference.md` if the source-of-truth description changes.

### [ ] C2. Create a worker-owned route registry and derive router behavior from it

**Audit finding covered**

Finding 1: route metadata and route handlers maintained in parallel.

**Primary files**

- `worker/src/router.ts`
- `worker/src/handlers/http.ts`
- new worker-owned registry module, for example:
  - `worker/src/router/route-registry.ts`
  - `worker/src/router/dynamic-routes.ts`

**Target state**

- One worker-owned registry defines:
  - path
  - methods
  - admin requirement
  - cache bypass
  - strict-contract status if worker needs it
  - probe/status action metadata
  - handler
- `worker/src/router.ts` becomes a dispatcher, not a second metadata table.
- `worker/src/handlers/http.ts` gets `isCacheBypassPath()` from the worker registry, not from a shared contract file.

**Implementation steps**

1. Create a `RouteDefinition` type in the worker.
2. Move static route declarations out of `router.ts` and into the registry.
3. Represent dynamic routes explicitly:
   - stablecoin detail
   - stablecoin summary
   - stablecoin reserves
   - discovery dismiss
   - OG image paths
4. Derive:
   - method validation
   - cache bypass lookup
   - probe paths
   - status page actions
5. Delete the worker-facing metadata now duplicated in `shared/lib/api-endpoints.ts`.
6. Keep route paths and endpoint behavior unchanged.

**Required tests**

- `npx vitest run worker/src/api/__tests__/router-contract.test.ts`
- `npx vitest run worker/src/api/__tests__/cache-passthrough.test.ts`
- `npx vitest run worker/src/__tests__/index.fetch.test.ts`
- `cd worker && npx tsc --noEmit`

**Docs**

- Update `docs/architecture.md`
- Update `docs/api-reference.md`

**Stop conditions**

- Stop if the registry abstraction starts hiding real special cases behind opaque callbacks. A flat explicit registry is the target, not a mini-framework.

### [ ] C3. Rewire route-adjacent consumers

**Audit finding covered**

Finding 1: worker router metadata duplication bleeds into status/probe/cache consumers.

**Primary files**

- `worker/src/api/status.ts`
- `worker/src/api/status-history.ts`
- `worker/src/handlers/http.ts`
- any module consuming `getProbePaths()` or `getStatusPageActions()`

**Target state**

- All worker-side operational consumers use the worker route registry.
- Frontend/shared consumers only depend on path builders and strict-contract lists.

**Required tests**

- `npx vitest run worker/src/api/__tests__/status.test.ts`
- `npx vitest run worker/src/api/__tests__/status-history.test.ts`
- `npx vitest run worker/src/api/__tests__/health.test.ts`

---

## Phase 4 - Large Frontend File Decomposition

### [ ] D1. Decompose `src/app/status/client.tsx`

**Audit finding covered**

Finding 5: status page file still too busy.

**Primary files**

- `src/app/status/client.tsx`
- `src/hooks/use-status-dashboard-model.ts`
- `src/components/status/*`
- `src/lib/status-dashboard-model.ts`

**Target state**

- `src/app/status/client.tsx` owns:
  - admin key gate
  - top-level page selection
  - assembly of high-level sections
- `src/components/status/*` owns:
  - local page-only presentation components currently nested in the page file
  - static copy/config objects when they are presentation-only
- `use-status-dashboard-model.ts` remains the single data orchestration hook.

**Implementation steps**

1. Move local components out of the page file:
   - `SummaryBadge`
   - `StatusSection`
   - `RecommendedActionStrip`
   - `PriorityLaneLink`
   - `NoticeRail`
2. Move top-fold copy dictionaries and any other pure presentation config into a dedicated status-page config module.
3. Split the page into:
   - auth-gated outer shell
   - authenticated dashboard view
4. Do not move business logic out of `buildStatusDashboardData()` unless it is presentation-only.

**Required tests**

- `npx vitest run src/components/__tests__/action-recommendations.test.ts`
- `npx vitest run src/components/__tests__/cron-card.test.tsx`
- `npx vitest run src/components/__tests__/data-quality-cards.test.tsx`
- `npm run build`

**Docs**

- Update `docs/status-dashboard.md`

**Stop conditions**

- If a proposed extraction only moves 10 lines from one file to another with no clarity gain, keep it inline. The point is to separate page orchestration from page-only subcomponents.

### [ ] D2. Extract a coverage-page model layer from `src/app/coverage/client.tsx`

**Audit finding covered**

Finding 6: coverage page mixes data orchestration and page rendering.

**Primary files**

- `src/app/coverage/client.tsx`
- `src/lib/coverage.ts`
- new coverage model module, for example:
  - `src/hooks/use-coverage-matrix-model.ts`
  - `src/lib/coverage-page-config.ts`

**Target state**

- Data loading + row/snapshot derivation live in one model layer.
- Page-local visual config and legends live outside the component body.
- `coverage/client.tsx` owns only:
  - local filter/search state
  - rendering
  - lightweight view-only derived state

**Implementation steps**

1. Extract query fusion and row building into a dedicated hook or model builder.
2. Move static page-local config out of the component:
   - `FEATURE_ACCENT_CLASSES`
   - `FILTER_OPTIONS`
   - `MOBILE_PREVIEW_FEATURES`
   - `LEGEND_ITEMS`
3. Keep `buildCoverageRow()` and `buildCoverageFeatureSummary()` in `src/lib/coverage.ts` as the canonical derivation primitives.
4. Return a ready-to-render model from the new hook:
   - rows
   - filtered rows
   - feature summaries
   - stale-banner input
   - derived spotlight cards
5. Leave only rendering and small UI interactions in the page component.

**Required tests**

- `npx vitest run src/lib/__tests__/coverage.test.ts`
- `npm run build`
- add focused model-hook tests if substantial logic moves out of the component

**Docs**

- Update `docs/architecture.md` if the coverage page ownership becomes materially clearer.

**Stop conditions**

- Do not create a second derivation path that duplicates `buildCoverageRow()` logic. The extraction must centralize, not clone.

---

## Phase 5 - Tooling And Package Simplification

### [ ] E1. Run a workspace-feasibility pass

**Audit finding covered**

Finding 7: duplicate toolchain dependencies and lockfiles.

**Primary files**

- `package.json`
- `worker/package.json`
- `package-lock.json`
- `worker/package-lock.json`
- CI or workflow files if they invoke package-manager commands directly

**Target state**

- Confirm whether the repo can move to a single root-managed toolchain without breaking:
  - `npm run build`
  - `cd worker && npx tsc --noEmit`
  - `cd worker && npx wrangler dev`

**Implementation steps**

1. Inventory overlapping dependencies:
   - `typescript`
   - `zod`
   - `@types/react`
2. Confirm whether worker-local commands resolve correctly when the package tree is workspace-managed.
3. If feasible, proceed to E2.
4. If not feasible, document the blocker and fall back to version alignment only, then continue to Phase 6.

**Required tests**

- `npm install`
- `npm run build`
- `cd worker && npx tsc --noEmit`

**Stop conditions**

- If workspace conversion breaks local worker development or deploy commands in a way that requires bespoke tooling, stop and keep the package boundary. In that case, implement only version alignment and doc the reason.

### [ ] E2. Implement the single-toolchain dependency path

**Audit finding covered**

Finding 7: duplicate dependency trees.

**Target state**

- Shared toolchain dependencies are managed once.
- Worker package keeps only genuinely worker-specific runtime/dev dependencies.
- Duplicate lockfiles are removed if workspace mode is adopted.

**Implementation steps**

1. Add npm workspace configuration at the root if E1 passed.
2. Remove overlapping toolchain packages from `worker/package.json`.
3. Regenerate lockfiles and verify root + worker scripts still work.
4. Delete `worker/package-lock.json` only after confirming workspace mode is stable.

**Required tests**

- mandatory phase gate
- `npm run check:worker-boundary`

**Docs**

- Update `docs/deployment-process.md`
- Update `docs/testing.md`
- Update any contributor/setup notes that mention `worker/package-lock.json`

### [ ] E3. Normalize command documentation and CI assumptions

**Target state**

- Human docs and CI commands match the package layout chosen in E2.

**Implementation steps**

1. Update docs and scripts to use the new workspace commands, if adopted.
2. Verify there is no stale documentation telling contributors to maintain two separate toolchain dependency trees.

---

## Phase 6 - Cleanup And Closeout

### [ ] F1. Dead-file and dead-export sweep

**Purpose**

Delete wrappers, helpers, and exports made obsolete by the earlier phases.

**Likely targets**

- old one-off route/page wrappers replaced by `createClientFeaturePage()`
- table helpers or local header builders made obsolete by the shared table shell
- route metadata exports no longer needed after the worker registry split
- package-management artifacts removed by workspace convergence

**Required actions**

1. Run `rg` for now-unused exports introduced by earlier deletions.
2. Remove dead imports and stale comments.
3. Re-run the mandatory gate.

### [ ] F2. Final documentation and audit delta capture

**Purpose**

Close the work with a durable record of what changed.

**Required actions**

1. Update all affected docs from earlier phases.
2. Capture the final:
   - line count deltas by module
   - file count reductions
   - deleted wrapper/module count
3. Write a short retrospective or execution note in `agents/retrospectives/` if the remediation spans multiple sessions.

---

## Suggested Commit / PR Boundaries

Keep the implementation reviewable. Recommended slices:

1. `phase-1a`: canonical stablecoin registries
2. `phase-1b`: feature-page shell convergence
3. `phase-2a`: shared sortable table shell
4. `phase-2b`: migrate leaderboard tables
5. `phase-2c`: stablecoin-table header normalization
6. `phase-3a`: shared endpoint metadata reduction
7. `phase-3b`: worker route registry migration
8. `phase-4a`: status page decomposition
9. `phase-4b`: coverage page model extraction
10. `phase-5a`: workspace/toolchain simplification
11. `phase-6`: cleanup and docs

## Final Acceptance Criteria

The remediation is complete when all of the following are true:

- No base tracked-stablecoin registry is rebuilt locally without a real filtered/augmented reason.
- Client-heavy feature routes follow one clear shell convention.
- Repeated leaderboard tables share one header/sort/pagination shell pattern.
- `shared/lib/api-endpoints.ts` no longer carries worker-only operational metadata.
- Worker routing/probe/cache behavior is derived from one worker-owned registry.
- `src/app/status/client.tsx` and `src/app/coverage/client.tsx` are materially smaller and clearly separated into model vs presentation concerns.
- Package/toolchain duplication is removed or explicitly documented as intentionally retained after a feasibility check.
- The mandatory validation gate passes.
- Docs reflect the new ownership boundaries and conventions.
