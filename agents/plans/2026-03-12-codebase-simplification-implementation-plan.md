# Codebase Simplification Audit — Implementation Plan

> Self-sufficient implementation plan for the simplification, deduplication, and structural cleanup audit completed on 2026-03-12.
> This document is written for autonomous execution after context reset. It restates the current architecture, the findings to resolve, the sequencing, the file scopes, the validation gates, and the stop conditions so implementation does not depend on the original chat thread.

## Objective

Reduce maintenance cost across the Pharos codebase by deleting low-signal wrappers, collapsing repeated registries, tightening module boundaries, and decomposing the few oversized feature/orchestration files that currently carry too much responsibility.

The target outcome is:

- one source of truth per operation
- fewer pass-through files
- fewer parallel route and contract registries
- clearer worker/frontend/shared boundaries
- smaller feature modules in the places where behavioral complexity is currently concentrated

This plan covers every issue raised in the current simplification audit:

1. API route metadata and worker routing are duplicated across shared and worker-only registries.
2. Query hooks are centralized, then wrapped again by one-line hook files.
3. Shared API contracts are concentrated in one giant file with repeated manual interface plus schema definitions.
4. The status feature concentrates too much logic in one frontend file and one worker file.
5. The compare feature concentrates URL state, data fetching, view-model assembly, and share/export logic in one client component.
6. Frontend tests currently cross the worker boundary for pure constants, and the boundary check is only enforced one way.
7. The safety-score methodology changelog bypasses the shared changelog route/data workflow used by the other methodology changelogs.
8. Several feature pages repeat the same `FeaturePageShell` + metadata + lazy client wrapper pattern.

## Audit Snapshot

### System shape

- Frontend entry: `src/app/layout.tsx`
- Frontend page layer: `src/app/*`
- Frontend component layer: `src/components/*`
- Frontend hooks/utilities: `src/hooks/*`, `src/lib/*`
- Worker entry: `worker/src/index.ts`
- Worker runtime handlers: `worker/src/handlers/http.ts`, `worker/src/handlers/scheduled.ts`
- Worker API layer: `worker/src/api/*`
- Worker cron layer: `worker/src/cron/*`
- Worker infrastructure/utilities: `worker/src/lib/*`
- Shared runtime-neutral logic: `shared/lib/*`
- Shared contracts: `shared/types/index.ts`

### Code-volume concentration

Measured from `src`, `shared`, and `worker/src` at audit time:

| Module | Files | Lines |
|---|---:|---:|
| `src/app` | 76 | 13,454 |
| `src/components` | 175 | 29,179 |
| `src/hooks` | 53 | 3,072 |
| `src/lib` | 67 | 9,460 |
| `shared/lib` | 36 | 10,928 |
| `shared/types` | 1 | 2,049 |
| `worker/src/api` | 83 | 17,098 |
| `worker/src/cron` | 122 | 32,475 |
| `worker/src/lib` | 96 | 17,757 |

### Current high-signal hotspots

- `worker/src/router.ts`
- `shared/lib/api-endpoints.ts`
- `shared/types/index.ts`
- `src/app/status/client.tsx`
- `worker/src/api/status.ts`
- `src/app/compare/client.tsx`
- `src/app/methodology/scoring-changelog/page.tsx`

## Explicit Non-Goals

These are intentionally out of scope unless a workstream below explicitly requires touching them:

- No scoring or methodology formula changes to PSI, PegScore, DEWS, liquidity scoring, report cards, or yield scoring.
- No framework/router migration.
- No redesign of page UX or visual language.
- No broad split of `shared/lib/stablecoins.ts` or `shared/lib/dead-stablecoins.ts`.
- No attempt to rewrite the long-form methodology content in `src/app/methodology/methodology-sections.tsx`.
- No full cron topology rewrite.
- No new plugin/generic framework for routes, tables, or changelog content.

## Execution Principles

- Prefer deletion to addition.
- When a helper is introduced, it must replace an already repeated pattern in at least 3 real call sites.
- Preserve existing API responses, route paths, section IDs, query keys, and analytics event names unless the plan explicitly says otherwise.
- Keep `src/components/ui/*` untouched.
- Shared runtime-neutral logic belongs in `shared/lib/*` or `shared/types/*`.
- Tailwind class names must remain static strings.
- Update docs when runtime behavior, architecture, or operator workflows change.
- Stop and re-scope if a proposed abstraction adds more indirection than it removes.

## Docs Expected To Change

Not every workstream will touch every document, but these are the likely update targets:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/status-dashboard.md`
- `docs/testing.md`
- `docs/worker-infrastructure.md`
- `docs/methodology-page.md`
- `docs/cemetery-and-compare.md`

## Verification Gates

### Mandatory phase gate

Run these after every completed phase:

```bash
npm run lint
npm test
cd worker && npx tsc --noEmit
npm run build
```

### Targeted suites during development

Use these while executing the relevant workstreams:

```bash
npx vitest run src/lib/__tests__/api-endpoints.test.ts
npx vitest run src/lib/__tests__/liquidity-coverage.test.ts
npx vitest run src/components/__tests__/liquidity-table.test.ts
npx vitest run src/hooks/__tests__/query-polling-policy.test.ts
npx vitest run worker/src/api/__tests__/router-contract.test.ts
npx vitest run worker/src/api/__tests__/status.test.ts
npx vitest run worker/src/api/__tests__/cache-passthrough.test.ts
npx vitest run worker/src/__tests__/index.scheduled.test.ts
```

For the compare and status frontend refactors, also run:

```bash
npm run test:smoke-ui
```

## Tier Mapping

### Tier 1 — Quick wins

- A1. Collapse the query-hook proxy layer.
- A2. Fix the shared/runtime boundary leak around chain coverage maps and enforce the boundary both ways.
- A3. Converge the repeated client-feature page wrappers.

### Tier 2 — High-value refactors

- B1. Simplify API route ownership and remove worker-only routing concerns from the shared endpoint registry.
- B2. Split and normalize shared contracts from `shared/types/index.ts`.
- B3. Converge the safety-score changelog onto the shared methodology changelog workflow.

### Tier 3 — Structural improvements

- C1. Decompose the compare feature into selection, data-model, and share/export units.
- C2. Decompose the status frontend into auth/session, dashboard model, and section rendering helpers.
- C3. Decompose the status worker endpoint into section-specific loaders/builders.

### Final cleanup

- D1. Run a deliberate dead-code/export-surface sweep after the structural changes land.
- D2. Update documentation and capture the final simplification deltas.

## Recommended Execution Order

```text
Phase 0: Baseline and safety rails
  P0-A baseline verification and snapshots

Phase 1: Tier-1 quick wins
  A1 hook surface collapse
  A2 worker/frontend boundary hardening
  A3 repeated feature-page wrapper convergence

Phase 2: Tier-2 high-value refactors
  B1 API route registry simplification
  B2 shared contracts modularization and schema-first convergence
  B3 safety-score changelog convergence

Phase 3: Tier-3 structural improvements
  C1 compare feature decomposition
  C2 status frontend decomposition
  C3 status worker decomposition

Phase 4: Cleanup and closure
  D1 dead-code and export-surface cleanup
  D2 docs, validation, and final simplification audit pass
```

Implementation should stay sequential across phases. Within a phase, only run workstreams in parallel if their file scopes do not overlap.

---

## Phase 0 — Baseline And Safety Rails

### [ ] P0-A. Record the current baseline

**Purpose**

Freeze the current behavior before deleting wrappers or moving contract ownership.

**Required actions**

1. Run the mandatory phase gate once on the untouched branch.
2. Record representative JSON outputs for:
   - `GET /api/stablecoins`
   - `GET /api/peg-summary`
   - `GET /api/dex-liquidity`
   - `GET /api/status` with a valid admin key
3. Record one visual smoke pass for:
   - `/compare`
   - `/status`
   - `/liquidity`
   - `/depeg`
4. Save any current lint/test failures before starting refactors so later failures are attributable.

**Why it matters**

Most of the plan is structural. Without a baseline, it is too easy to confuse drift with simplification.

---

## Phase 1 — Tier-1 Quick Wins

### [ ] A1. Collapse the query-hook proxy layer

**Audit anchors**

- `src/hooks/api-hooks.ts:44-164`
- `src/hooks/use-status.ts:12-32`
- `src/hooks/use-status-history.ts:27-50`
- one-line hook wrappers in `src/hooks/use-*.ts`

**Problem**

The repo has a real hook implementation module (`src/hooks/api-hooks.ts`) plus 15 one-line wrapper files that only re-export those hooks. That adds file count and navigation noise without adding separation of concerns. Two admin hooks also duplicate the same authenticated polling pattern instead of using the existing generic query helpers.

**Target state**

- `src/hooks/api-hooks.ts` remains the single home for trivial API query hooks.
- The one-line proxy files are deleted.
- A tiny shared authenticated query helper exists for admin-key endpoints.
- Imports across the app converge on one public hook surface.

**Files to change**

- `src/hooks/api-hooks.ts`
- `src/hooks/use-api-query.ts`
- Delete:
  - `src/hooks/use-bluechip-ratings.ts`
  - `src/hooks/use-daily-digest.ts`
  - `src/hooks/use-dex-liquidity-history.ts`
  - `src/hooks/use-dex-liquidity.ts`
  - `src/hooks/use-digest-archive.ts`
  - `src/hooks/use-digest-snapshot.ts`
  - `src/hooks/use-health.ts`
  - `src/hooks/use-peg-summary.ts`
  - `src/hooks/use-report-cards.ts`
  - `src/hooks/use-safety-score-history.ts`
  - `src/hooks/use-stability-index.ts`
  - `src/hooks/use-stablecoin-charts.ts`
  - `src/hooks/use-usds-status.ts`
  - `src/hooks/use-yield-history.ts`
  - `src/hooks/use-yield-rankings.ts`
- `src/hooks/use-status.ts`
- `src/hooks/use-status-history.ts`
- all import sites currently pointing at the deleted files

**Implementation steps**

1. Extend `src/hooks/use-api-query.ts` with a small helper for header-authenticated polling queries.
   - Keep it purpose-built for existing status/admin usage.
   - Do not build a generic header-merging mini-framework.
2. Refactor `useStatus()` and `useStatusHistory()` to use that shared helper.
3. Update all import sites to pull trivial hooks directly from `@/hooks/api-hooks`.
4. Delete the one-line wrapper files.
5. Re-run import search to ensure no stale paths remain.

**Tests and verification**

```bash
npx vitest run src/hooks/__tests__/query-polling-policy.test.ts
npx vitest run src/lib/__tests__/api-fetch-contracts.test.ts
npm run lint
npm run build
```

**Docs**

- Update `docs/architecture.md` only if hook organization is described there.

**Exit criteria**

- All trivial hook imports resolve through `src/hooks/api-hooks.ts`.
- The 15 proxy files are deleted.
- `useStatus()` and `useStatusHistory()` no longer duplicate the same admin-auth polling boilerplate.

**Risk**

Low. The primary risk is stale imports after file deletion.

---

### [ ] A2. Fix the runtime boundary leak and make the boundary check bidirectional

**Audit anchors**

- `src/lib/__tests__/liquidity-coverage.test.ts:3-4`
- `worker/src/lib/chain-registry.ts`
- `scripts/check-worker-import-boundary.mjs:5-112`

**Problem**

Frontend-side tests currently import worker internals to read pure chain maps. The current boundary script only prevents `worker/src -> src/lib`, so the inverse leak is not enforced. The real source of the shared chain-provider maps lives inside `worker/src/lib/chain-registry.ts`, even though those maps are runtime-neutral.

**Target state**

- Pure provider-chain mapping data moves into a shared runtime-neutral module.
- Worker keeps env-aware RPC initialization logic in `worker/src/lib/chain-registry.ts`.
- Frontend/shared code no longer imports from `worker/src`.
- The boundary script rejects both directions:
  - worker importing frontend
  - frontend/shared importing worker runtime code

**Files to change**

- `worker/src/lib/chain-registry.ts`
- `worker/src/lib/coingecko-onchain.ts`
- `worker/src/lib/dexscreener.ts`
- `src/lib/__tests__/liquidity-coverage.test.ts`
- `scripts/check-worker-import-boundary.mjs`
- Add new shared module, likely `shared/lib/chain-provider-registry.ts`

**Implementation steps**

1. Extract these runtime-neutral exports into `shared/lib`:
   - `CHAIN_REGISTRY`
   - `CG_CHAIN_MAP`
   - `CG_CHAIN_REVERSE`
   - `DS_CHAIN_MAP`
   - `GT_CHAIN_MAP`
   - `GT_CHAIN_REVERSE`
   - `GT_ONLY_CHAIN_MAP`
2. Leave `buildChainRpcs()`, `initChainRpcs()`, and RPC-related env logic in the worker file.
3. Update worker consumers to import shared provider maps from `@shared/lib/...`.
4. Update the liquidity-coverage test to import from the shared module, not worker files.
5. Extend `scripts/check-worker-import-boundary.mjs` to scan for:
   - worker imports from `src/`
   - `src/` or `shared/` imports from `worker/src/`
6. Keep any explicit allowlist empty unless a real unavoidable exception exists.

**Tests and verification**

```bash
npx vitest run src/lib/__tests__/liquidity-coverage.test.ts
npm run check:worker-boundary
npm run lint
cd worker && npx tsc --noEmit
```

**Docs**

- `docs/architecture.md`
- `docs/testing.md`

**Exit criteria**

- No `src` or `shared` file imports `worker/src/*`.
- Provider chain maps are owned by `shared/lib/*`.
- The boundary script fails on both forbidden directions.

**Risk**

Low. The only meaningful risk is moving too much worker-specific logic into shared. Do not move RPC/env logic.

---

### [ ] A3. Converge repeated client-feature page wrappers

**Audit anchors**

- `src/app/compare/page.tsx`
- `src/app/liquidity/page.tsx`
- `src/app/dependency-map/page.tsx`
- `src/app/portfolio/page.tsx`
- `src/app/safety-scores/page.tsx`
- `src/app/stability-index/page.tsx`
- `src/app/yield/page.tsx`

**Problem**

Several feature pages repeat the same pattern:

- build metadata
- create a `dynamic()` client import with a skeleton
- wrap the page in `FeaturePageShell`
- render the client component as the only main child

The pattern is not universal, so the solution must stay narrow.

**Target state**

- One small helper owns the exact repeated pattern for client-only feature pages.
- Only low-variation pages use it.
- Custom routes like `/depeg`, `/about`, `/telegram`, `/coverage`, and `/stablecoin/[id]` stay custom.

**Files to change**

- Add helper, likely `src/app/feature-page-factory.tsx` or `src/lib/client-feature-page.tsx`
- Migrate only the pages where the helper reduces net code:
  - `src/app/compare/page.tsx`
  - `src/app/liquidity/page.tsx`
  - `src/app/dependency-map/page.tsx`
  - `src/app/portfolio/page.tsx`
  - `src/app/safety-scores/page.tsx`
  - `src/app/stability-index/page.tsx`
  - `src/app/yield/page.tsx`

**Implementation steps**

1. Build a helper that accepts:
   - metadata object
   - dynamic client loader
   - skeleton class name
   - `FeaturePageShell` props
2. Keep it literal and page-focused. Do not add branching for banners, compare presets, or other route-specific behavior.
3. Migrate only pages whose final code becomes smaller and clearer.
4. Leave `/depeg` custom because it injects a callout banner before the client.
5. Leave `/coverage` custom unless the helper can absorb it without adding another abstraction branch.

**Tests and verification**

```bash
npm run build
npm run test:smoke-ui
```

**Docs**

- none, unless `docs/architecture.md` has a section on page composition worth updating

**Exit criteria**

- The migrated pages use one shared helper.
- The helper is not used by custom pages that need bespoke composition.
- Net lines deleted are positive.

**Risk**

Low. The main risk is over-generalizing the helper. If that happens, stop and keep the custom page.

---

## Phase 2 — Tier-2 High-Value Refactors

### [ ] B1. Simplify API route ownership and remove worker-only routing data from the shared endpoint registry

**Audit anchors**

- `shared/lib/api-endpoints.ts:95-668`
- `worker/src/router.ts:76-360`
- `src/components/status/admin-actions-panel.tsx`
- `src/hooks/use-endpoint-probes.ts`

**Problem**

`shared/lib/api-endpoints.ts` currently mixes three distinct concerns:

- client path builders
- status/probe/action metadata
- worker routing glue (`handlerKey`, `routerHandled`)

The worker then duplicates the actual dispatch bindings in `worker/src/router.ts`. That makes endpoint changes expensive and couples shared code to worker implementation details.

**Target state**

- Shared endpoint metadata remains the source of truth for:
  - path builders
  - allowed methods
  - probe groups/paths
  - status dashboard actions
  - cache-bypass and strict-contract metadata, if still used cross-runtime
- Worker routing owns:
  - handler binding
  - dispatch tables
  - admin/idempotency wrapper binding
- `handlerKey` and `routerHandled` disappear from the shared endpoint definitions.

**Files to change**

- `shared/lib/api-endpoints.ts`
- `worker/src/router.ts`
- `worker/src/api/__tests__/router-contract.test.ts`
- `src/lib/__tests__/api-endpoints.test.ts`
- any consumer relying on `getRouterHandledEndpoints()` or `getRouterHandledPaths()`

**Implementation steps**

1. Preserve the shared responsibilities that are genuinely cross-runtime:
   - `API_PATHS`
   - `validateEndpointMethod()`
   - `getProbePaths()`
   - `getStatusPageActions()`
   - `isCacheBypassPath()`
   - strict-contract path helpers
2. Remove `handlerKey` and `routerHandled` from `EndpointDefinition`.
3. In `worker/src/router.ts`, create a local static route table keyed by path.
   - Use the shared `API_PATHS` builders to avoid path drift.
   - Keep dynamic route matching local.
4. Add one or two tiny local wrappers for the repeated route-binding cases only:
   - plain public handler
   - idempotent admin handler
5. Do not add a route DSL or plugin registry.
6. Rewrite router contract tests so they verify:
   - every shared endpoint path that should be router-served is present in the local worker route table
   - shared method metadata still matches runtime behavior
   - status action/probe lists are unchanged

**Tests and verification**

```bash
npx vitest run src/lib/__tests__/api-endpoints.test.ts
npx vitest run worker/src/api/__tests__/router-contract.test.ts
npx vitest run worker/src/api/__tests__/cache-passthrough.test.ts
npm run lint
cd worker && npx tsc --noEmit
```

**Docs**

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/status-dashboard.md`

**Exit criteria**

- Shared endpoint definitions no longer reference worker handler keys.
- Worker route dispatch is fully owned by worker-local code.
- Probe/action/method metadata stays shared and test-covered.

**Risk**

Medium. This refactor touches route ownership, so tests must land in the same workstream.

---

### [ ] B2. Split and normalize shared contracts from `shared/types/index.ts`

**Audit anchors**

- `shared/types/index.ts:841-1045`
- `shared/types/index.ts:969-988`
- `shared/types/index.ts:1382-1404`
- `shared/types/index.ts:1803-1812`
- `shared/types/index.ts:1915-2039`

**Problem**

`shared/types/index.ts` is a 2,049-line mixed contract hub containing:

- runtime-neutral domain types
- API response DTOs
- Zod schemas
- enum values
- manual interfaces duplicated by adjacent schemas

That creates drift risk and makes contract changes harder to review.

**Target state**

- Contracts are grouped by domain.
- Response types with runtime validation are schema-first wherever practical.
- `shared/types/index.ts` becomes a barrel export, not the implementation home for all contracts.
- Manual interfaces remain only where runtime validation is unnecessary or where schema-first would make the code harder to read.

**Files to change**

- `shared/types/index.ts`
- Add domain files under `shared/types/`, likely:
  - `shared/types/core.ts`
  - `shared/types/market.ts`
  - `shared/types/report-cards.ts`
  - `shared/types/status.ts`
  - `shared/types/yield.ts`
  - `shared/types/mint-burn.ts`
- update import sites across `src` and `worker/src`

**Implementation order**

#### B2.1 Introduce the new file layout

1. Create domain files without changing external imports yet.
2. Move exports by domain, keeping `shared/types/index.ts` as a barrel.
3. Do not chase import-site cleanup until the domain files compile cleanly.

#### B2.2 Convert duplicated response types to schema-first where already validated

Migrate these groups first:

- report cards
- stability index
- health/status responses
- yield responses
- mint/burn responses
- depeg/peg summary responses

Use the rule:

- if a schema already exists and maps cleanly, export `type X = z.infer<typeof XSchema>`
- if a manual interface is genuinely clearer or broader than the schema, keep it, but remove unsafe schema casts

#### B2.3 Remove worker-local or hook-local duplicate DTO definitions

1. Replace any local response copies with imports from `shared/types`.
2. Replace broad casts with precise schema exports.
3. Keep the barrel so consumers can migrate gradually.

**Tests and verification**

```bash
npx vitest run src/lib/__tests__/api-endpoints.test.ts
npx vitest run worker/src/api/__tests__/status.test.ts
npx vitest run worker/src/api/__tests__/report-cards.test.ts
npx vitest run worker/src/api/__tests__/yield-history.test.ts
npm run lint
cd worker && npx tsc --noEmit
npm run build
```

**Docs**

- `docs/architecture.md`
- `docs/api-reference.md`

**Exit criteria**

- `shared/types/index.ts` is primarily a barrel.
- The main validated response DTOs are schema-first or no longer require unsafe casts.
- No worker-local copies of shared response DTOs remain.

**Risk**

Medium. Import churn is high, so keep this as one focused phase with a stable barrel.

---

### [ ] B3. Converge the safety-score changelog onto the shared methodology changelog workflow

**Audit anchors**

- `src/app/methodology/scoring-changelog/page.tsx:25-220`
- `src/app/methodology/changelog-route-factory.tsx`
- `src/components/methodology-changelog-page.tsx`
- `shared/lib/safety-score-version.ts`

**Problem**

Six methodology changelogs use the shared changelog route/data factory. The safety-score changelog is the outlier: it hardcodes route metadata, helper components, section IDs, and version content locally in a large custom page.

**Target state**

- The safety-score changelog uses the same route-level workflow as the other methodology changelogs.
- Shared metadata, version labels, and section lists move into `shared/lib/safety-score-version.ts`.
- Only the genuinely custom rich-content rendering remains custom.

**Files to change**

- `src/app/methodology/scoring-changelog/page.tsx`
- `src/app/methodology/changelog-route-factory.tsx`
- `src/components/methodology-changelog-page.tsx`
- `shared/lib/safety-score-version.ts`
- possibly add one small reusable helper component if it deletes repeated local markup

**Implementation steps**

1. Extend `shared/lib/safety-score-version.ts` so it owns:
   - current version label
   - changelog path
   - ordered version list for navigation
   - summary metadata for the scoring changelog route
2. Refactor `scoring-changelog/page.tsx` to consume the shared route factory or a narrow extension of it.
3. Do not invent a markdown/DSL format for all scoring content unless it clearly deletes more code than it adds.
4. If the current `VersionCard` structure is still needed, extract only the reusable parts that improve clarity.
5. Keep existing anchors and route path stable.

**Tests and verification**

```bash
npm run build
npm run lint
```

Add/update tests only if there are existing route metadata tests covering methodology pages.

**Docs**

- `docs/methodology-page.md`

**Exit criteria**

- The safety-score changelog no longer owns route metadata and section ordering ad hoc inside the page file.
- It follows the same route-level pattern as the other methodology changelogs.
- Existing changelog links and anchors still work.

**Risk**

Low to medium. The main risk is over-engineering the content model. Stay pragmatic.

---

## Phase 3 — Tier-3 Structural Improvements

### [ ] C1. Decompose the compare feature

**Audit anchors**

- `src/app/compare/client.tsx:125-172`
- `src/app/compare/client.tsx:193-257`
- `src/app/compare/client.tsx:270-367`
- `src/app/compare/client.tsx:394-536`

**Problem**

`src/app/compare/client.tsx` currently owns all of the following:

- URL parsing and writing
- selected-coin constraints
- global and per-coin data fetching
- derived comparison view models
- retry behavior
- share/export image preparation
- analytics events

That makes the component hard to reason about and expensive to modify.

**Target state**

- URL/selection state lives in one dedicated hook.
- query orchestration and view-model assembly live in one compare-specific model hook/module.
- share/export actions live in one compare-share module.
- the page component becomes a render orchestrator.

**Files to change**

- `src/app/compare/client.tsx`
- Add likely new files:
  - `src/hooks/use-compare-selection.ts`
  - `src/hooks/use-compare-data-model.ts`
  - `src/hooks/use-compare-share-actions.ts`
  - optionally `src/lib/compare-view-model.ts`
- `src/components/compare-empty-state.tsx` if prop flow changes
- `src/lib/compare-share-image.ts` only if the share-action extraction requires minor helper cleanup

**Implementation steps**

#### C1.1 Extract selection state

Move into `use-compare-selection.ts`:

- parse `coins` and `range` from URL
- canonical ID versus symbol fallback
- `setSelectedIds()`
- `setRange()`
- selection constraints like `MAX_COINS`

Keep analytics event calls in the page or a tiny wrapper if they are tied to user interactions rather than state itself.

#### C1.2 Extract compare data model

Move into `use-compare-data-model.ts`:

- global data hooks
- `useQueries` for detail and flow data
- view-model assembly for:
  - comparison table rows
  - supply series
  - flow series
  - flow cards
  - derived retry function

The hook should return plain data plus loading/error aggregates.

#### C1.3 Extract share/export actions

Move into `use-compare-share-actions.ts`:

- image-preload logic
- `buildShareData()`
- twitter/web/download handlers
- toast/share-loading state if it keeps the component smaller

Preserve:

- existing event names
- output filenames
- current OG/share image rendering path

**Tests and verification**

Add focused tests if they do not already exist:

- `src/lib/__tests__/compare-selection.test.ts`
- `src/lib/__tests__/compare-view-model.test.ts`

Then run:

```bash
npm run test:smoke-ui
npm run build
npm run lint
```

**Docs**

- `docs/cemetery-and-compare.md`
- `docs/architecture.md`

**Exit criteria**

- `src/app/compare/client.tsx` no longer owns selection parsing, query assembly, and share/export internals simultaneously.
- Query keys, URL semantics, and analytics names remain unchanged.

**Risk**

Medium. The main behavioral risks are URL drift and retry/query-key drift.

---

### [ ] C2. Decompose the status frontend

**Audit anchors**

- `src/app/status/client.tsx:280-323`
- `src/app/status/client.tsx:327-430`
- `src/app/status/client.tsx:696-912`

**Problem**

`src/app/status/client.tsx` mixes:

- session-storage admin auth gating
- four independent polling hooks
- countdown/refresh timing
- derived summary/state model construction
- section and card rendering

This is the frontend half of the heaviest current feature.

**Target state**

- admin-key session management is isolated
- dashboard data/model derivation is isolated
- the main component reads like a page composition, not a data-processing file

**Files to change**

- `src/app/status/client.tsx`
- likely add:
  - `src/hooks/use-admin-session-key.ts`
  - `src/hooks/use-status-dashboard-model.ts`
  - optionally `src/lib/status-dashboard-model.ts`
- optionally move local section-presentational helpers if they remain large enough to justify it

**Implementation steps**

#### C2.1 Extract admin-key session management

Move into `use-admin-session-key.ts`:

- read from `sessionStorage`
- submit/save key
- sign-out/remove key

This should leave the page-level auth gate in `StatusClient` but remove storage details from the page file.

#### C2.2 Extract dashboard model assembly

Move into `use-status-dashboard-model.ts` or a sibling lib:

- combined query usage
- `lastUpdated`
- stale-client notice logic
- probe summary
- top causes
- section summaries
- recommended actions

The goal is to make the page primarily declarative.

#### C2.3 Keep rendering helpers only if they are presentation-only

Small render helpers like `SummaryBadge` and `OverviewStat` can stay local if they remain tiny and page-specific. Do not extract them just because they exist.

**Tests and verification**

Add targeted unit coverage for any extracted pure model helpers if practical, then run:

```bash
npx vitest run worker/src/api/__tests__/status.test.ts
npm run test:smoke-ui
npm run build
```

**Docs**

- `docs/status-dashboard.md`
- `docs/architecture.md`

**Exit criteria**

- `src/app/status/client.tsx` clearly separates auth gating, model retrieval, and rendering.
- Session storage logic no longer lives inline in the main page file.

**Risk**

Medium. The main risk is splitting the file without actually reducing cognitive load. Keep the extraction aligned to existing responsibilities.

---

### [ ] C3. Decompose the status worker endpoint

**Audit anchors**

- `worker/src/api/status.ts:165-593`
- `worker/src/api/status.ts:597-720`
- `worker/src/api/status.ts:989-1255`

**Problem**

`worker/src/api/status.ts` mixes:

- raw status computation
- cron/cache/state reconciliation
- discovery candidate loading
- liquidity/price/mint-burn sub-view extraction
- dataset freshness
- telegram stats
- response shaping

It is one of the largest and most behaviorally dense files in the worker.

**Target state**

- one coordinating endpoint file
- section-specific loaders/builders in adjacent modules
- `computeRawStatus()` slimmed down to orchestration over named helpers

**Files to change**

- `worker/src/api/status.ts`
- likely add adjacent modules, for example:
  - `worker/src/api/status/raw-status.ts`
  - `worker/src/api/status/discovery.ts`
  - `worker/src/api/status/liquidity-health.ts`
  - `worker/src/api/status/mint-burn-reconciliation.ts`
  - `worker/src/api/status/dataset-freshness.ts`
  - `worker/src/api/status/telegram-bot-stats.ts`

Exact naming can vary; the decomposition should follow current response sections.

**Implementation steps**

1. Split out pure or mostly pure helpers first:
   - dataset freshness
   - discovery candidate loading
   - liquidity health extraction
   - mint/burn reconciliation
   - telegram stats
2. Only after those are extracted, trim `computeRawStatus()` into smaller loader/evaluator helpers.
3. Keep `handleStatus()` as the final response assembler.
4. Do not move logic into `shared/lib/*`; this endpoint is worker-specific.
5. Preserve response shape exactly.

**Tests and verification**

```bash
npx vitest run worker/src/api/__tests__/status.test.ts
npm run lint
cd worker && npx tsc --noEmit
npm run build
```

**Docs**

- `docs/status-dashboard.md`
- `docs/worker-infrastructure.md`
- `docs/architecture.md`

**Exit criteria**

- `worker/src/api/status.ts` is materially smaller and easier to scan.
- Section-specific data assembly no longer lives inline in one giant endpoint file.
- Response shape and admin behavior are unchanged.

**Risk**

High. This is a heavy worker endpoint with operational significance. Keep tests green at every step.

---

## Phase 4 — Cleanup And Closure

### [ ] D1. Run a deliberate dead-code and export-surface cleanup

**Purpose**

After the structural work lands, several helpers, exports, and compatibility shims should become obviously removable.

**Likely cleanup candidates**

- stale imports after deleting hook proxy files
- route-registry helper exports that only existed for the old router coupling
- now-internal status/compare helpers accidentally left exported
- old changelog helpers if safety-score convergence replaces them

**Implementation steps**

1. Run `ts-prune` after Phase 3, not before.
2. Classify each hit manually:
   - true dead code
   - route/module convention false positive
   - intentionally public/shared API
3. Delete only the clearly dead cases.
4. Re-run `rg` for the old deleted file paths and helper names to ensure no stale references remain.

**Verification**

```bash
npx --yes ts-prune -p tsconfig.json
npm run lint
npm test
npm run build
```

**Exit criteria**

- No obvious wrapper remnants from earlier phases remain.
- Remaining `ts-prune` hits are intentional or framework-related.

---

### [ ] D2. Documentation sync and final simplification pass

**Purpose**

Ensure the codebase documentation matches the new structure and that the simplification work is actually complete, not just compiled.

**Implementation steps**

1. Update the docs listed in each workstream.
2. Re-run the full mandatory phase gate.
3. Re-run a quick final simplification review:
   - confirm no `src`/`shared` import from `worker/src`
   - confirm no deleted hook-wrapper imports remain
   - confirm the router no longer depends on shared handler keys
   - confirm status and compare files are materially smaller and clearer
4. Move this plan to `agents/plans/historical/` only after the implementation is fully complete.

**Final validation checklist**

- [ ] Hook proxy layer removed
- [ ] Boundary leak removed and enforced
- [ ] Client feature pages converged where it reduced net code
- [ ] Worker-only routing metadata removed from shared endpoint definitions
- [ ] Shared contracts split into domain files with a stable barrel
- [ ] Safety-score changelog aligned to the shared methodology workflow
- [ ] Compare feature decomposed
- [ ] Status frontend decomposed
- [ ] Status worker decomposed
- [ ] Dead-code sweep completed
- [ ] Docs updated
- [ ] Full validation gate passed

---

## Explicit Deferred Or Skip Decisions

These were real observations from the audit, but they should stay out of this implementation effort:

- Do not split `shared/lib/stablecoins.ts` just because it is large. It is mostly declarative inventory data, not accidental complexity.
- Do not split `shared/lib/dead-stablecoins.ts` for the same reason.
- Do not rewrite `src/app/methodology/methodology-sections.tsx` into a content DSL just to reduce line count.
- Do not generalize the scheduled slot handlers unless a separate audit finds a concrete operational defect.
- Do not build a universal comparator/table framework; the existing per-table logic modules are simpler.

## Resume Instructions After Context Reset

If implementation starts from a fresh context:

1. Read this file first.
2. Read the current versions of:
   - `docs/architecture.md`
   - `docs/api-reference.md`
   - `docs/status-dashboard.md`
   - `docs/testing.md`
3. Run Phase 0 exactly once.
4. Execute phases in order.
5. Do not skip the phase gates.
6. If a workstream starts adding more abstraction than it removes, stop and re-scope before merging.

