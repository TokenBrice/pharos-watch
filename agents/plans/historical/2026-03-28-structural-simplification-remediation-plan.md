# Structural Simplification Remediation Plan — 2026-03-28

## Goal

Remediate all six findings from the 2026-03-28 structural simplification audit without changing public product behavior, methodology semantics, or API contracts.

Primary goals:

- remove duplicated structural glue
- converge outliers onto existing shared patterns
- reduce file size in current hotspots
- preserve current runtime behavior and docs-visible methodology semantics

Non-goals:

- redesigning UI/UX
- changing methodology formulas, weights, thresholds, or public scoring semantics
- changing endpoint paths or auth policy
- broad dependency churn

## Repo State Assumption

Current worktree is clean except for the untracked audit note:

- `agents/audits/2026-03-28-structural-simplification-audit.md`

No partial implementation changes from the interrupted attempt need cleanup.

## Success Criteria

1. Worker routing uses a single registry path for exact and dynamic routes.
2. Safety Score changelog no longer duplicates shared changelog metadata.
3. Methodology section files shrink materially by using shared diagram/layout primitives.
4. Scheduled slot wrappers no longer reimplement the same leased-job helper in each file.
5. Repeated API query/response patterns converge on shared helpers where the shape is already common.
6. Stablecoin sync price-enrichment modules live under the same pipeline boundary as the rest of sync-stablecoins.
7. Validation passes:
   - `npm run lint`
   - `npm test`
   - `npm run build`
   - `cd worker && npx tsc --noEmit`
   - targeted worker/router/methodology tests as needed during each phase

## Implementation Order

Implement in five phases to keep regressions localized and reviewable.

### Phase 1 — Worker Route Registry Consolidation

Why first:

- highest-impact structural finding
- isolated from frontend work
- simplifies later API-helper cleanup

Files in scope:

- `worker/src/router.ts`
- `worker/src/route-registry.ts`
- `worker/src/handlers/http.ts`
- `worker/src/handlers/http/context.ts`
- worker route tests

Concrete tasks:

1. Move dynamic route definitions out of `worker/src/router.ts` and into `worker/src/route-registry.ts`.
2. Introduce a unified route definition type in `route-registry.ts`:
   - exact path routes
   - pattern-matched routes
   - shared dependency metadata
   - shared resolve function returning handler + match payload
3. Change `router.ts` into a thin adapter:
   - method validation
   - route resolution through a single registry API
   - no local dynamic route table
4. Keep `ROUTER_STATIC_PATHS` export for current tests, but make it derived from the same unified registry.
5. Preserve exact behavior for:
   - `/api/stablecoin/:id`
   - `/api/stablecoin-summary/:id`
   - `/api/stablecoin-reserves/:id`
   - `/api/discovery-candidates/:id/dismiss`
   - `/api/og/*`

Validation:

- `npm test -- worker/src/api/__tests__/router-contract.test.ts worker/src/__tests__/trigger-digest-route.test.ts`
- `npm test -- worker/src/api/__tests__/stablecoin-detail.test.ts worker/src/api/__tests__/stablecoin-summary.test.ts worker/src/api/__tests__/stablecoin-reserves.test.ts`

Risks:

- route dependency hydration regressions
- admin auth bypass on dismiss/admin routes
- dynamic path decoding regressions

Mitigation:

- do not change endpoint definitions or request contract wording in this phase
- keep route resolution API small and explicit

### Phase 2 — Cron Slot Wrapper Standardization + API Pattern Convergence

Why second:

- low-risk line-count reduction
- lets worker-side structural cleanup happen before frontend content refactors

Files in scope:

- `worker/src/handlers/scheduled/*.ts`
- `worker/src/lib/api-utils.ts`
- selected API handlers:
  - `worker/src/api/blacklist.ts`
  - `worker/src/api/mint-burn-events.ts`
  - `worker/src/api/depeg-events.ts`
  - `worker/src/api/yield-history.ts`
  - optionally `worker/src/api/discovery.ts` and `worker/src/api/status-history.ts`

Concrete tasks:

1. Add one shared helper in `worker/src/handlers/scheduled/` for best-effort leased job execution.
2. Replace local wrappers in:
   - `quarter-hourly.ts`
   - `half-hourly.ts`
   - `daily-0800.ts`
   - `daily-0805.ts`
3. Keep per-slot orchestration explicit; only remove wrapper duplication.
4. Extend `api-utils.ts` with small shared helpers only where there are 3+ concrete call sites:
   - enum parsing helper
   - required stablecoin filter parsing helper
   - shared paginated event response assembly where already near-identical
5. Refactor `blacklist.ts` and `mint-burn-events.ts` first, since both already use `parseQueryParams` plus `fetchPaginatedEvents`.
6. Leave oddball handlers alone unless the abstraction clearly reduces code.

Validation:

- `npm test -- worker/src/api/__tests__/blacklist.test.ts worker/src/api/__tests__/mint-burn-events.test.ts worker/src/api/__tests__/depeg-events.test.ts worker/src/api/__tests__/yield-history.test.ts`
- `npm test -- worker/src/__tests__/index.scheduled.test.ts`

Risks:

- contract-test failures from changed 400 messages
- accidental over-abstraction making handlers harder to follow

Mitigation:

- keep existing error strings where already tested
- only extract helpers after first rewriting one handler against them

### Phase 3 — Methodology Changelog and Diagram Consolidation

Why third:

- self-contained frontend/content refactor
- largest line-count reduction outside worker

Files in scope:

- `src/app/methodology/scoring-changelog/page.tsx`
- `shared/lib/safety-score-version.ts`
- `src/app/methodology/changelog-route-factory.tsx`
- `src/components/methodology-changelog-page.tsx`
- `src/app/methodology/methodology-shared.tsx`
- `src/app/methodology/sections/core-sections.tsx`
- `src/app/methodology/sections/monitoring-sections.tsx`
- `src/app/methodology/sections/core-sections-pricing.tsx`

Concrete tasks:

1. Convert Safety Score changelog to the same route/factory pattern used by other changelog pages.
2. Decide one of two acceptable content strategies:
   - preferred: shared changelog metadata plus keyed rich-content fragments
   - fallback: shared changelog metadata plus a smaller custom renderer that consumes the shared entries instead of retyping metadata
3. Delete local duplicate card/title/date helpers from `scoring-changelog/page.tsx` unless promoted into a shared primitive reused elsewhere.
4. Add a small methodology diagram primitive in `methodology-shared.tsx` for repeated card-grid + arrow-stack patterns.
5. Replace repeated desktop/mobile diagram blocks in:
   - PSI section
   - Safety Score section
   - Liquidity section
   - Mint/Burn section
   - Pricing section
   - Yield section
   - DEWS section
6. Keep prose inline unless layout duplication is the only repeated part.

Validation:

- `npm test -- src/components/__tests__/top-fold-copy.test.ts src/components/__tests__/longform-scrollspy-nav.test.ts`
- `npm run build`

Risks:

- breaking in-page anchors or nav section IDs
- accidental content drift between shared changelog data and rendered detail blocks

Mitigation:

- preserve existing anchor naming
- lift metadata first, then convert layout second

### Phase 4 — Stablecoin Sync Boundary Cleanup

Why fourth:

- highest-effort internal refactor
- easier once worker helper patterns are already stable

Files in scope:

- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/enrich-prices.ts`
- `worker/src/cron/enrich-prices-primary.ts`
- `worker/src/cron/enrich-prices-passes.ts`
- `worker/src/cron/enrich-prices-shared.ts`
- `worker/src/cron/sync-stablecoins/*`
- imports in tests and dependent modules

Concrete tasks:

1. Move `enrich-prices*.ts` into `worker/src/cron/sync-stablecoins/`.
2. Make `worker/src/cron/sync-stablecoins.ts` a thin orchestrator entrypoint, or convert it into `index.ts` in the folder if that yields cleaner imports.
3. Keep exported function names stable where possible:
   - `enrichMissingPrices`
   - `fetchPrimaryPrices`
   - `runGtProbePass`
4. Co-locate shared `PeggedAsset`-related helpers with the rest of the sync-stablecoins pipeline.
5. Update all imports and test paths.
6. Do not change runtime stage ordering or logging semantics in the same phase.

Validation:

- `npm test -- worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/enrich-prices.test.ts worker/src/cron/__tests__/sync-fx-rates.test.ts`
- `cd worker && npx tsc --noEmit`

Risks:

- import path churn causing broad test breakage
- accidental behavior changes while moving files

Mitigation:

- perform pure moves first
- only then remove now-redundant barrel/re-export code

### Phase 5 — Final Cleanup and Merge-Gate Validation

Files in scope:

- touched files only
- docs only if implementation changes any documented surface unexpectedly

Concrete tasks:

1. Remove any leftover compatibility wrappers created during intermediate phases.
2. Re-run the audit note against the final diff and mark findings as addressed or intentionally partial.
3. Only update docs if a public/internal workflow changed enough to make current docs inaccurate.

Validation:

- `npm run lint`
- `npm test`
- `npm run build`
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

## Work Breakdown by Audit Finding

### Finding 1 — Parallel route registries

Deliverable:

- one worker route registry API for exact and dynamic routes

Completion check:

- `router.ts` no longer declares its own `DYNAMIC_ROUTE_DEFINITIONS`

### Finding 2 — Safety Score changelog duplication

Deliverable:

- shared metadata is rendered once; page no longer retypes version title/date/summary metadata

Completion check:

- `scoring-changelog/page.tsx` drops well below current size and consumes shared changelog data

### Finding 3 — Methodology section layout duplication

Deliverable:

- repeated responsive flow/diagram markup replaced with a small shared primitive

Completion check:

- both `core-sections.tsx` and `monitoring-sections.tsx` shrink materially

### Finding 4 — Cron slot wrapper duplication

Deliverable:

- local `run*Job()` wrappers removed from scheduled slot files

Completion check:

- at least four slot files use a shared helper instead of private near-identical closures

### Finding 5 — API query/response inconsistency

Deliverable:

- common event/history handler patterns converge on shared helpers

Completion check:

- `blacklist.ts` and `mint-burn-events.ts` share the same style of parsing and response assembly

### Finding 6 — Stablecoin sync boundary leak

Deliverable:

- all sync-stablecoins price-enrichment stages live under the same module boundary

Completion check:

- no `sync-stablecoins` stage imports from sibling top-level `enrich-prices*.ts` files because those files no longer live outside the folder

## Suggested Commit / PR Structure

Prefer multiple commits in this order:

1. `worker: unify route registry`
2. `worker: standardize scheduled slot wrappers`
3. `worker: converge repeated api parsing patterns`
4. `frontend: unify methodology changelog and diagram primitives`
5. `worker: colocate stablecoin sync enrichment pipeline`
6. `chore: remove transitional glue and rerun validation`

If split into PRs instead of one branch stack:

- PR 1: routing + slot wrappers
- PR 2: API helper convergence
- PR 3: methodology content/layout consolidation
- PR 4: sync-stablecoins boundary cleanup

## Exit Criteria Before Merge

- all findings addressed or explicitly documented as intentionally deferred
- no public API route, status auth, or methodology semantics changed
- full validation passes locally
- line count reduced in the targeted hotspot files

## Expected Outcome

If executed cleanly, this plan should:

- remove a meaningful amount of worker glue
- shrink the largest methodology outliers
- make stablecoin sync easier to navigate
- reduce the number of places engineers have to touch for common structural changes
