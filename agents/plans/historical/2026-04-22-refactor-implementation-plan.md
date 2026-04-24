# Refactor Implementation Plan

Date: 2026-04-22
Source: `/agents/audits/2026-04-22-maintainability-refactor-audit.md`
Goal: execute the refactoring backlog in low-risk slices that reduce duplication, simplify high-friction code paths, and improve long-term maintainability without changing product behavior.

## Scope and Success Criteria

This plan covers all three implementation tiers from the audit:

- Tier 1: quick wins with low regression risk and high duplication payoff
- Tier 2: medium-size refactors that consolidate drift-prone abstractions
- Tier 3: structural cleanup of scheduler-heavy and policy-heavy code

Success means:

- each workstream ships as an incremental change set with no intended behavior change
- duplicated definitions are replaced by one authoritative source where practical
- validation commands are defined up front for every workstream
- large/high-risk refactors are sliced so they can be reviewed and reverted independently
- no workstream requires a “flag day” rewrite

Non-goals:

- feature work
- methodology changes
- endpoint contract changes
- visual redesign
- broad architecture rewrites

## Constraints and Operating Assumptions

- Prefer the smallest root-cause refactor that removes drift.
- Preserve existing query keys, endpoint payloads, cron budgets, and route paths unless explicitly noted.
- Keep `shared/` runtime-neutral.
- Do not combine structural cleanup with scoring or methodology changes.
- For worker and scheduler work, preserve current timeout, connection, and cursor semantics first; simplify shape second.
- Update docs only if runtime behavior, validation contracts, or developer workflow actually changes.

## Execution Strategy

### Delivery Model

Use small PR-sized workstreams, not one long-lived branch. Recommended cadence:

1. land Tier 1 as independent small PRs
2. land Tier 2 as grouped medium sub-workstreams after Tier 1 stabilizes
3. land Tier 3 as grouped high-risk sub-workstreams with extra reviewer attention

Execution loop for Tier 2 and Tier 3:

1. create one dedicated worktree per workstream from `origin/main`
2. implement and validate inside that worktree
3. merge the worktree branch back into local `main`
4. run the merge gate on local `main`
5. only then push

Reference workflow:

```bash
git fetch origin
git worktree add .worktrees/<feature-name> -b <branch-name> origin/main
# implement in worktree
git checkout main
git pull --ff-only origin main
git merge --no-ff <branch-name>
npm run test:merge-gate
git push origin main
```

### Validation Baseline

Use two validation layers:

- inner-loop targeted checks for fast iteration inside the workstream
- exit gate checks that match the repo’s actual deploy-impacting standard before merge/push

Minimum inner-loop validation for every workstream:

```bash
npm run lint
npm test
```

Add targeted validation by surface:

- Frontend query/hooks/routes:
```bash
npm run lint
npm run typecheck
npm test -- src/hooks src/components src/app
```

- Shared/domain logic:
```bash
npm run lint
npm test -- shared/lib shared/types src/lib
```

- Worker API/routing:
```bash
npm run lint
npm test -- worker/src/api worker/src/routes worker/src/lib
cd worker && npx tsc --noEmit
```

- Route-metadata / API-routing work:
```bash
npm run lint
npm run typecheck
npm test -- src/lib/__tests__/api-endpoints.test.ts worker/src/api/__tests__/router-contract.test.ts worker/src/routes/__tests__/route-context-typing.test.ts worker/src/lib/__tests__/request-source-attribution.test.ts functions/__tests__/site-data-proxy.test.ts functions/__tests__/ops-admin-proxy.test.ts shared/lib/__tests__/site-data-routes.test.ts
cd worker && npx tsc --noEmit
```

- Worker cron/scheduler work:
```bash
npm run lint
npm test -- worker/src/cron worker/src/lib
cd worker && npx tsc --noEmit
npm run check:cron-abort-contract
npm run check:cron-sync
npm run check:cron-connections
```

- Scripts / CI / validation:
```bash
npm run lint
npm test -- scripts/__tests__
npm run test:merge-gate -- --staged
```

Mandatory exit gate for every deploy-impacting workstream in this plan:

```bash
npm run test:merge-gate
```

Additional exit-gate requirement for frontend workstreams touching route files, `generateMetadata`, `generateStaticParams`, or shared route helpers:

```bash
npm run build
npm run seo:check
npm run test:merge-gate
```

### Review Gates

Before merging each workstream, confirm:

- file count and scope match the planned slice
- duplicated authority has actually been removed, not just wrapped
- tests cover old and new callsites where contracts were consolidated
- no new local “temporary” registries were introduced

## Tier 1 — Quick Wins

### T1.1 Query Option Builders and Polling Window Helper

Objective: remove duplicated query contracts and make polling cadence reusable outside hook wrappers.

Primary files:

- `src/hooks/use-api-query.ts`
- `src/hooks/use-stablecoins.ts`
- `src/hooks/use-mint-burn-flows.ts`
- `src/hooks/use-prefetch-stablecoin.ts`
- `src/hooks/use-compare-data-model.ts`
- `src/hooks/use-stablecoin-reserves.ts`
- `src/hooks/use-depeg-events.ts`

Steps:

1. Inventory every currently prefetched resource and decide whether each warmed query key is:
   - canonical and should be preserved
   - dead and should be removed
2. Add a tiny non-hook helper in `use-api-query.ts` or a sibling module:
   - `getPollingWindow(cronMs) -> { staleTime, refetchInterval }`
3. For duplicated resources, export reusable `queryOptions` builders from their home hook modules.
   - `supplyHistoryQueryOptions(id, days = 1825)`
   - `mintBurnFlowsCoinQueryOptions(id, hours = 24, opts?)`
   - `stablecoinDetailQueryOptions`
   - `dexLiquidityHistoryQueryOptions`
   - `safetyScoreHistoryQueryOptions`
   - `depegEventsInfiniteQueryOptions` or an explicit decision to remove depeg prefetching if the current key is non-canonical
4. Update `useCompareDataModel()` to use those builders instead of hard-coding query keys, schema, and cadence.
5. Update `usePrefetchStablecoin()` to use the same builders.
6. Replace the fake `createPollingQueryOptions([], ...)` pattern in `useStablecoinReserves()` with `getPollingWindow(CRON_RESERVE_SYNC)`.
7. Update `useInfiniteDepegEvents()` and any other custom query builders to use the shared polling window helper.

Done criteria:

- no duplicated hard-coded query key/path/schema/default blocks remain for the moved resources
- reserve polling no longer depends on fake query args
- compare/prefetch callsites reuse the same builders as primary hooks
- all retained prefetch keys exactly match their consuming hooks/routes

Validation:

```bash
npm run lint
npm run typecheck
npm test -- src/hooks/__tests__ src/lib/__tests__
npm run test:merge-gate
```

Risks:

- accidental query-key changes causing cache misses
- subtle option drift around `enabled`, `retry`, or default `days/hours`

Mitigation:

- keep query key arrays byte-for-byte identical
- add/adjust tests to assert option-builder outputs

### T1.2 Remove Duplicate Supply-History Path

Objective: stop deriving `SupplyHistoryPoint[]` from the heavier stablecoin-detail endpoint when the dedicated history endpoint already exists.

Primary files:

- `src/hooks/use-stablecoin-detail-history.ts`
- `src/components/total-mcap-chart.tsx`
- `src/lib/total-mcap-chart.ts`
- any consumers of `useStablecoinDetailHistory`

Steps:

1. Identify current consumers of `useStablecoinDetailHistory()`.
2. If consumers only need the existing `SupplyHistoryPoint[]` shape, switch them to `useSupplyHistory()`.
3. If one consumer still needs detail-derived history, extract a shared `toSupplyHistoryPoints()` transformer and use it from both sources temporarily.
4. Remove `useStablecoinDetailHistory()` if it becomes unused.

Done criteria:

- one canonical frontend path remains for supply-history data
- no view depends on `/api/stablecoin/:id` only to rebuild a history series already exposed by `/api/supply-history`

Validation:

```bash
npm run lint
npm test -- src/hooks/__tests__ src/app src/components src/lib/__tests__/total-mcap-chart.test.ts
npm run test:merge-gate
```

### T1.3 Taxonomy Route Factory

Objective: collapse repeated page setup in taxonomy route families.

Primary files:

- `src/app/stablecoins/backing/page.tsx`
- `src/app/stablecoins/governance/page.tsx`
- `src/app/stablecoins/infrastructure/page.tsx`
- slug route files under those families
- new taxonomy-specific helper file, likely `src/lib/stablecoin-taxonomy-pages.ts`

Steps:

1. Introduce a tiny descriptor shape for taxonomy hubs:
   - title
   - description
   - canonical path
   - breadcrumb labels
   - item list name
   - page registry
2. Move common hub-page rendering into a small factory/helper.
3. Keep `src/lib/static-slug-page.ts` unchanged in this slice unless a taxonomy-specific helper proves impossible.
4. If slug-route consolidation is needed, implement it in a taxonomy-specific helper rather than changing logic shared with `/stablecoins/[peg]/page.tsx`.
5. Migrate backing/governance/infrastructure routes one family at a time.

Done criteria:

- route files become thin descriptor wrappers
- breadcrumb/metadata logic is centralized without changing output
- `/stablecoins/[peg]/page.tsx` behavior remains out of scope and unchanged in this workstream

Validation:

```bash
npm run lint
npm run typecheck
npm test -- src/app src/lib/__tests__
npm run build
npm run seo:check
npm run test:merge-gate
```

### T1.4 Move `/flows` onto Existing Feature Page Shell

Objective: reuse the existing page-shell abstraction instead of hand-building route chrome.

Primary files:

- `src/app/flows/page.tsx`
- `src/app/flows/layout.tsx`
- `src/app/flows/client.tsx` (new)
- `src/components/feature-page-shell.tsx`

Steps:

1. Extract the current stateful page body from `src/app/flows/page.tsx` into `src/app/flows/client.tsx`.
2. Use `FeaturePageShell` directly for this route.
   - Do not adopt `createClientFeaturePage` in this slice, because that would introduce different loading/error semantics.
3. Map current `/flows` sections to `FeaturePageShell` inputs.
4. Preserve:
   - methodology badge
   - scope label
   - sync warning banner
   - stale-data banner placement
5. Make an explicit ownership decision for structured data:
   - either keep `src/app/flows/layout.tsx` for metadata + FAQ only and avoid duplicate breadcrumb JSON-LD
   - or remove breadcrumb output from layout if the shell becomes the sole breadcrumb JSON-LD owner
6. Use `headerSupplement` or equivalent rather than adding page-specific abstractions unless necessary.
7. Add regression coverage for route-level behavior:
   - spinner fallback preserved
   - no unexpected section-error copy is introduced
   - breadcrumb JSON-LD emitted once
   - FAQ JSON-LD retained

Done criteria:

- `/flows` uses the same shell pattern as similar feature pages
- no route-specific behavior changes
- breadcrumb JSON-LD is emitted exactly once
- FAQ JSON-LD remains present if currently required

Validation:

```bash
npm run lint
npm run typecheck
npm test -- src/app/flows src/components
npm run build
npm run seo:check
npm run test:merge-gate
```

### T1.5 Shared Admin Mutation Helper

Objective: remove repeated context types and boilerplate from the small operator/admin mutation endpoints.

Primary files:

- `worker/src/lib/route-wrappers.ts`
- `worker/src/api/admin-reset-cron-lease.ts`
- `worker/src/api/admin-reset-circuit-breaker.ts`
- `worker/src/api/admin-kill-cron-in-flight.ts`
- `worker/src/api/admin-bulk-dismiss-discovery-candidates.ts`

Steps:

1. Export a shared admin route context type from the routing layer.
2. Add a narrow helper that centralizes only:
   - typed context
   - auth/idempotency wrapper behavior
   - no-store response defaults
3. Leave endpoint-local request parsing, status codes, and audit payload construction local to each endpoint.
4. Migrate the four small mutation endpoints.

Done criteria:

- local `AdminRouteContext` copies removed from those files
- auth/idempotency/no-store wrapper behavior is centralized without flattening endpoint-specific semantics

Validation:

```bash
npm run lint
npm test -- worker/src/api/__tests__ worker/src/lib/__tests__
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

## Tier 2 — High-Value Refactors

### T2.1a Shared Dynamic Descriptor Table and Parity Tests

Objective: add a shared declarative-only dynamic route descriptor table without switching runtime authority yet.

Primary files:

- `shared/lib/api-endpoints/validation.ts`
- `shared/lib/api-endpoints/definitions.ts` or new sibling module
- `shared/lib/request-attribution.ts`
- `worker/src/routes/dynamic-routes.ts`
- `functions/api/admin/[[path]].ts`

Steps:

1. Introduce a shared dynamic endpoint descriptor table with declarative metadata only:
   - route key
   - regex or matcher
   - allowed methods
   - public/site-data/admin policy
   - dependency keys
2. Keep handler binding, URI decoding, canonical ID resolution, malformed-URI responses, and positive-int admin ID parsing in worker-local adapters.
3. Add parity tests covering every current dynamic route for:
   - allowed methods
   - `publicApiAccess`
   - `siteDataAccess`
   - `isAdminPath`
   - dependency keys
   - request attribution ignoring dynamic admin paths
4. Leave existing authority in place in this sub-slice; the goal is only to introduce the new declarative table plus parity coverage.

Done criteria:

- the new shared table exists and is test-covered
- existing runtime behavior is unchanged
- dynamic route dependency maps remain unchanged for stablecoin detail/summary/reserves, OG, discovery dismiss, and API-key update/deactivate/rotate routes

Validation:

```bash
npm run lint
npm run typecheck
npm test -- src/lib/__tests__/api-endpoints.test.ts worker/src/api/__tests__/router-contract.test.ts worker/src/routes/__tests__/route-context-typing.test.ts worker/src/lib/__tests__/request-source-attribution.test.ts functions/__tests__/site-data-proxy.test.ts functions/__tests__/ops-admin-proxy.test.ts shared/lib/__tests__/site-data-routes.test.ts
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

### T2.1b Switch Validation and Routing to the New Dynamic Authority

Objective: replace the duplicate dynamic matchers only after parity tests exist.

Primary files:

- `shared/lib/api-endpoints/validation.ts`
- `shared/lib/request-attribution.ts`
- `worker/src/routes/dynamic-routes.ts`
- `functions/api/admin/[[path]].ts`

Steps:

1. Switch `validation.ts` to the new shared dynamic descriptor table.
2. Switch `dynamic-routes.ts` dependency lookup to the same authority.
3. Remove old duplicated matchers only after parity passes.
4. Keep worker-local decoding/dispatch semantics unchanged.

Done criteria:

- regex/method/access/dependency authority lives in one place
- malformed encoded paths still return `400`
- unknown stablecoin IDs still return `404`
- invalid dynamic admin IDs still do not route
- dynamic admin paths still resolve to `null` attribution

Validation:

```bash
npm run lint
npm run typecheck
npm test -- src/lib/__tests__/api-endpoints.test.ts worker/src/api/__tests__/router-contract.test.ts worker/src/routes/__tests__/route-context-typing.test.ts worker/src/lib/__tests__/request-source-attribution.test.ts functions/__tests__/site-data-proxy.test.ts functions/__tests__/ops-admin-proxy.test.ts shared/lib/__tests__/site-data-routes.test.ts
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

### T2.2 Extend Shared Cache Handler

Objective: migrate the special cache-backed GET endpoints onto one shared cache-read/freshness/meta pipeline.

Primary files:

- `worker/src/lib/api-cache-read.ts`
- `worker/src/api/cache-handlers.ts`

Steps:

1. Extend `createCacheHandler()` with optional hooks:
   - schema validator
   - transform function
   - custom `_meta` injection behavior
2. Migrate `handleBluechipRatings`.
3. Migrate `handleYieldRankings`.
4. Migrate `handleStablecoinCharts` only if array-body handling stays simple and readable.

Done criteria:

- missing-cache, malformed-cache, freshness-header, and `_meta` behavior live in one shared path
- special handlers retain only domain-specific logic

Validation:

```bash
npm run lint
npm test -- worker/src/api/__tests__/cache-passthrough.test.ts worker/src/api/__tests__/yield-rankings.test.ts
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

### T2.3 Blacklist Page Support Data Hoist

Objective: compute blacklist support data once per route instead of once per child component.

Primary files:

- `src/app/blacklist/page.tsx`
- `src/app/blacklist/view-model.ts`
- `src/components/blacklist-stats.tsx`
- `src/components/blacklist-status-charts.tsx`
- `src/components/blacklist-status-drilldown.tsx`

Steps:

1. Split support data into:
   - always-on route support data
   - drilldown-only support data that must stay gated by `statusBucket`
2. Add an always-on route-scoped support-data section to the blacklist page model:
   - stablecoin data
   - report card map
   - derived blacklist bucket inputs
3. Keep drilldown-only queries gated unless an explicit behavior change is accepted later.
4. Convert the child components to accept prepared props.
5. Remove internal `useStablecoins()` / `useReportCards()` calls from those children where the data is now hoisted.

Done criteria:

- support data is fetched/prepared once
- sibling components no longer rebuild lookup maps independently
- initial page render still does not start drilldown-only queries unless `statusBucket` is active

Validation:

```bash
npm run lint
npm run typecheck
npm test -- src/app/blacklist src/components
npm run test:merge-gate
```

### T2.4a Validate / Deploy / LTS Gap Audit

Objective: confirm current-state ownership and drift before changing validation-plan authority.

Primary files:

- `package.json`
- `scripts/lib/validate-contract.mjs`
- `scripts/lib/deploy-impact.mjs`
- `scripts/run-node-lts-validation.mjs`
- `docs/testing.md`
- `docs/deployment-process.md`
- relevant tests under `scripts/__tests__`

Steps:

1. Audit current ownership:
   - what `validate-contract.mjs` already owns
   - what still lives only in `package.json`
   - what deploy-impact classification misses
   - what `validate:lts` duplicates manually
2. Write down the exact remaining gaps before changing ownership.
   - deliverable: `/agents/audits/2026-04-22-validate-deploy-lts-gap-audit.md`
3. Add or update tests that capture those gaps explicitly.
4. Keep `docs/testing.md` and `docs/deployment-process.md` unchanged in this slice unless the audit proves a current doc mismatch.

Done criteria:

- the workstream produces a current-state gap inventory
- subsequent registry cleanup is based on verified drift, not stale assumptions

Validation:

```bash
npm run lint
npm test -- scripts/__tests__
npm run validate:lts -- --pages-changed=true --worker-changed=true # run only in a Node 24 environment; otherwise verify via the CI validate-lts job
npm run test:merge-gate -- --staged
```

### T2.4b Validate Contract Ownership Cleanup

Objective: make validation, deploy-impact, CI parity, and LTS validation consume one shared contract.

Primary files:

- `package.json`
- `scripts/lib/validate-contract.mjs`
- `scripts/test-merge-gate.mjs`
- `docs/testing.md`
- `docs/deployment-process.md`
- relevant tests under `scripts/__tests__`

Steps:

1. Move only the remaining validate-plan ownership gaps from `package.json` into shared JS data.
2. Make `package.json` scripts delegate to that shared registry.
3. Update merge-gate and CI parity tests to read the registry directly.
4. Update `docs/testing.md` and `docs/deployment-process.md` to point at the actual registry owner.

Done criteria:

- the validate contract no longer exists only inside `package.json`
- parity tooling validates the real underlying command list

Validation:

```bash
npm run lint
npm test -- scripts/__tests__
npm run validate:lts -- --pages-changed=true --worker-changed=true # run only in a Node 24 environment; otherwise verify via the CI validate-lts job
npm run test:merge-gate -- --staged
```

### T2.4c Deploy Classification and LTS Alignment

Objective: clean up deploy-impact classification and align `validate:lts` only after validate-plan ownership is settled.

Primary files:

- `scripts/lib/deploy-impact.mjs`
- `scripts/run-node-lts-validation.mjs`
- `scripts/check-shared-cycles.mjs`
- `docs/testing.md`
- `docs/deployment-process.md`
- relevant tests under `scripts/__tests__`

Steps:

1. Fix any verified deploy-impact drift, including artifact-generating scripts that should count as Pages-impacting.
2. Make `check-shared-cycles` LTS-safe.
3. Align `validate:lts` with the shared plan except for explicit blockers that remain justified.
4. Update docs for any workflow/process changes.

Done criteria:

- deploy-impact classification matches the intended generator/build ownership
- `validate:lts` is no longer a hand-maintained fork except for explicit documented blockers

Validation:

```bash
npm run lint
npm test -- scripts/__tests__
npm run validate:lts -- --pages-changed=true --worker-changed=true # run only in a Node 24 environment; otherwise verify via the CI validate-lts job
npm run test:merge-gate -- --staged
```

### T2.5 Stablecoin Domain Schema Consolidation

Objective: reduce hand-maintained drift between `StablecoinMeta` and its ingest schema, and clean up type/runtime boundaries.

Primary files:

- `shared/types/core.ts`
- `shared/lib/stablecoins/schema.ts`
- destination shared-lib modules for moved runtime helpers, likely `shared/lib/filter-tags.ts` or `shared/lib/stablecoin-taxonomy.ts`
- new shared schema/type helper modules as needed

Steps:

1. Establish and document a one-way ownership boundary:
   - `shared/types/**` owns reusable domain contracts, literal value sets, and Zod schemas
   - `shared/lib/**` owns loaders, labels, tag/filter derivation, and other runtime behavior
2. Identify nested structures that can become shared reusable schemas:
   - flags
   - link
   - reserve slice
   - live reserve config
   - notice
   - yield config
   - launch metadata
3. Compose `StablecoinMetaAssetSchema` from those nested pieces instead of restating the full tree.
4. Make `shared/lib/stablecoins/schema.ts` compose or re-export type-owned schemas rather than define parallel shapes.
5. Move runtime taxonomy/filter/tag helpers out of `shared/types/core.ts` into `shared/lib/*`.

Done criteria:

- the top-level stablecoin schema is assembled from shared nested pieces
- `shared/types/core.ts` becomes domain-contract focused instead of mixed type/runtime logic
- all checked-in assets parse to the same effective methodology-driving `StablecoinMeta` projection as before the refactor

Validation:

```bash
npm run lint
npm run check:worker-boundary
npm run check:shared-cycles
npm run check:stablecoin-data
npm test -- shared/lib/__tests__ shared/types/__tests__ src/lib/__tests__
npm run test:merge-gate
```

## Tier 3 — Structural Improvements

### T3.1a Blacklist Budget Helper and Threading

Objective: centralize budget/deadline policy first without changing scan shape or row processing.

Primary files:

- `worker/src/cron/sync-blacklist.ts`
- `worker/src/cron/blacklist/amount-recovery.ts`
- `worker/src/cron/blacklist/evm-source.ts`
- `worker/src/cron/blacklist/tron-source.ts`

Steps:

1. Introduce a shared `BlacklistRunBudget` helper that wraps:
   - deadline reached
   - subrequest budget exhausted
   - minimum remaining config window
2. Thread it through the existing blacklist pipeline without changing result shapes or post-fetch structure.

Done criteria:

- budget/deadline policy is centralized
- behavior is otherwise unchanged and covered by parity tests

Validation:

```bash
npm run lint
npm test -- worker/src/cron/__tests__/sync-blacklist.test.ts worker/src/cron/blacklist/__tests__ worker/src/lib/__tests__
cd worker && npx tsc --noEmit
npm run check:cron-abort-contract
npm run check:cron-connections
npm run test:merge-gate
```

### T3.1b Blacklist Shared Scan Result and Unified Post-Fetch Path

Objective: converge EVM and Tron onto a common scan-result/update path only after budget threading is stable.

Primary files:

- `worker/src/cron/sync-blacklist.ts`
- `worker/src/cron/blacklist/post-fetch.ts`
- `worker/src/cron/blacklist/evm-source.ts`
- `worker/src/cron/blacklist/tron-source.ts`

Steps:

1. Introduce a shared `BlacklistScanResult` shape.
2. Extract a common fetch -> process -> cursor/update pipeline.
3. Leave row enrichment/cache update passes unchanged in this phase.

Done criteria:

- EVM and Tron branches share one result/update path
- no row-pass collapse happens yet

Validation:

```bash
npm run lint
npm test -- worker/src/cron/__tests__/sync-blacklist.test.ts worker/src/cron/blacklist/__tests__
cd worker && npx tsc --noEmit
npm run check:cron-abort-contract
npm run check:cron-connections
npm run test:merge-gate
```

### T3.1c Blacklist Row-Preparation and Pass Collapse

Objective: collapse redundant row passes only after the scan/update path has parity coverage.

Primary files:

- `worker/src/cron/blacklist/current-balance-cache.ts`
- `worker/src/cron/blacklist/amount-recovery.ts`
- `worker/src/cron/blacklist/post-fetch.ts`

Steps:

1. Extract a shared row-preparation context for price lookup and latest-row indexing.
2. Collapse redundant enrichment/cache update passes only if parity tests from `T3.1a` and `T3.1b` are green.

Done criteria:

- redundant row passes are reduced
- price lookup/latest-row prep is shared

Validation:

```bash
npm run lint
npm test -- worker/src/cron/__tests__/sync-blacklist.test.ts worker/src/cron/blacklist/__tests__
cd worker && npx tsc --noEmit
npm run check:cron-abort-contract
npm run check:cron-connections
npm run test:merge-gate
```

### T3.2a Live Reserve Sync Orchestration Extraction

Objective: split `syncLiveReserves()` into smaller phases without changing persisted snapshot or scoring-eligibility semantics.

Primary files:

- `worker/src/cron/sync-live-reserves.ts`
- `worker/src/cron/sync-live-reserves-core.ts`
- worker live-reserve store helpers

Steps:

1. Extract `createReserveAdapterRunner()`.
2. Extract `runReserveCoinQueue()`.
3. Extract `finalizeReserveSyncRun()`.

Policy-safety constraints:

- preserve the persisted snapshot contract exactly
- preserve scoring-eligibility rules, including `evidenceClass`, `freshnessMode`, warning/unknown-exposure handling, and the `reserve_sync_state.last_status = "ok"` gate
- preserve the exact set of scoring-eligible vs detail-only feeds

Done criteria:

- top-level function reads as orchestration, not as a monolith
- before/after fixtures prove unchanged behavior for:
  - one independent scoring-eligible adapter
  - one `weak-live-probe`
  - one `unverified` or warning-bearing feed

Validation:

```bash
npm run lint
npm test -- worker/src/cron/__tests__/sync-live-reserves.test.ts worker/src/lib/__tests__/live-reserves-store.test.ts
cd worker && npx tsc --noEmit
npm run check:cron-abort-contract
npm run test:merge-gate
```

### T3.2b Live Reserve Cleanup Relocation and Chunk-Semantics Fix

Objective: move stale-artifact cleanup closer to the store layer only after orchestration extraction has parity coverage.

Primary files:

- `worker/src/cron/sync-live-reserves.ts`
- live-reserve store helpers

Steps:

1. Relocate stale-artifact cleanup into the store layer.
2. Replace chunk-sensitive deletion logic with a provably correct keep-list strategy.

Done criteria:

- cleanup logic is isolated and testable
- chunk semantics are explicitly proven by tests

Validation:

```bash
npm run lint
npm test -- worker/src/cron/__tests__/sync-live-reserves.test.ts worker/src/lib/__tests__/live-reserves-store.test.ts
cd worker && npx tsc --noEmit
npm run check:cron-abort-contract
npm run test:merge-gate
```

### T3.3 Classification and Blacklist Policy Authority Cleanup

Objective: reduce policy sprawl without changing scores or labels.

Primary files:

- `shared/lib/report-card-resilience.ts`
- `shared/lib/report-card-governance.ts`
- `shared/lib/reserve-templates.ts`
- `shared/lib/report-card-blacklist-matchers.ts`
- `shared/lib/report-card-blacklist-resolver.ts`

Steps:

1. Keep `shared/lib/classification.ts` as the display-label/color authority.
2. Introduce a separate policy module that owns only methodology/scoring default tables.
3. Move dependency derivation out of `reserve-templates.ts` into a curated-only helper.
   - authority remains `meta.dependencies` plus curated `meta.reserves`
   - never derive dependencies from template fallback or live reserve snapshots
4. Make one blacklist-resolution API authoritative; batch wrappers should call through it.
5. Preserve these blacklist-resolution invariants exactly:
   - fixed-point convergence across the tracked graph
   - input-order independence
   - `variantOf` parent inheritance
   - parity between singleton and batch callers
6. Update report-card and snapshot builders to consume the new policy helpers without changing output.

Done criteria:

- classification defaults and blacklist resolution authority are clearer
- reserve presentation and dependency derivation are separate concerns
- display-label/color authority is still isolated from policy authority
- full-registry and shuffled-order golden tests prove blacklist-resolution invariants remain unchanged

Validation:

```bash
npm run lint
npm test -- shared/lib/__tests__/report-cards.test.ts src/lib/__tests__/report-cards.test.ts worker/src/lib/__tests__/report-cards-snapshot.test.ts worker/src/lib/__tests__/report-cards-snapshot-topo.test.ts
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

### T3.4a Stability Index and Safety Scores Module Decomposition

Objective: reduce review surface area in the largest stateful analytics pages without mixing unrelated surfaces.

Primary files:

- `src/app/stability-index/client.tsx`
- `src/app/safety-scores/client.tsx`

Steps:

1. Extract pure presentational subcomponents first.
2. Keep route-level data/state orchestration in the page client files.

Done criteria:

- both analytics pages are composition-focused
- no behavioral contract changes are mixed into this slice

Validation:

```bash
npm run lint
npm run typecheck
npm test -- src/app/stability-index src/app/safety-scores src/components src/hooks src/lib/__tests__
npm run build
npm run seo:check
npm run test:merge-gate
```

### T3.4b Stablecoin Detail Hero Decomposition

Primary files:

- `src/components/stablecoin-detail/hero-card.tsx`

Steps:

1. Extract pure presentational sections only.
2. Leave the stablecoin-detail view-model contract unchanged in this slice.

Done criteria:

- `hero-card.tsx` is materially smaller
- no view-model input changes are mixed into this workstream

Validation:

```bash
npm run lint
npm run typecheck
npm test -- src/components/stablecoin-detail src/app/stablecoin src/lib/__tests__
npm run build
npm run seo:check
npm run test:merge-gate
```

### T3.4c Static-Content Page Decomposition

Primary files:

- `src/app/about/page.tsx`
- `src/app/telegram/page.tsx`

Steps:

1. Move large static content/config arrays into adjacent `*-content.ts` modules.
2. Extract repeated presentational blocks where useful.

Done criteria:

- copy/config edits no longer require touching large route modules

Validation:

```bash
npm run lint
npm run typecheck
npm test -- src/app/about src/app/telegram src/components src/lib/__tests__
npm run build
npm run seo:check
npm run test:merge-gate
```

### T3.4d Stablecoin Detail View-Model Contract Cleanup

Primary files:

- `src/lib/stablecoin-detail-view-model.ts`
- `src/hooks/use-stablecoin-detail-view-model.ts`
- affected tests

Steps:

1. Inventory all remaining callers and tests using the legacy flat input shape.
2. Migrate them to the structured `{ core, queries, supplemental }` contract.
3. Remove the legacy union input path only after no mixed-input caller remains.

Done criteria:

- view-model input contract is singular and explicit
- no caller depends on the legacy shape

Validation:

```bash
npm run lint
npm run typecheck
npm test -- src/app src/components src/hooks src/lib/__tests__
npm run build
npm run seo:check
npm run test:merge-gate
```

## Dependency Order

Recommended implementation order:

1. `T1.1` query option builders
2. `T1.2` duplicate supply-history removal
3. `T1.3` taxonomy factory
4. `T1.4` flows page shell migration
5. `T1.5` admin mutation helper
6. `T2.1a` dynamic descriptor table + parity tests
7. `T2.1b` switch validation/routing to the new authority
8. `T2.2` cache handler extension
9. `T2.3` blacklist support-data hoist
10. `T2.4a` validate/deploy/LTS gap audit
11. `T2.4b` validate contract ownership cleanup
12. `T2.4c` deploy classification and LTS alignment
13. `T2.5` stablecoin schema consolidation
14. `T3.1a` blacklist budget helper/threading
15. `T3.1b` shared blacklist scan result/update path
16. `T3.1c` blacklist row-pass collapse
17. `T3.2a` live reserve orchestration extraction
18. `T3.2b` live reserve cleanup relocation
19. `T3.3` classification/blacklist authority cleanup
20. `T3.4a` analytics page decomposition
21. `T3.4b` stablecoin detail hero decomposition
22. `T3.4c` static-content page decomposition
23. `T3.4d` stablecoin detail view-model contract cleanup

## Risk Register

Highest-risk workstreams:

- `T3.1a-c` blacklist scheduler refactor sequence
- `T3.2a-b` live reserve sync decomposition sequence
- `T3.3` classification / blacklist authority cleanup
- `T2.1b` dynamic route authority switch

Risk controls:

- land these behind small PR boundaries
- expand targeted tests before collapsing duplicated code
- avoid combining structural change with output changes
- compare serialized output snapshots before and after where feasible

## Rollback Strategy

- Tier 1 and Tier 2 workstreams should each be revertable as single PRs.
- Tier 3 workstreams should be split so a failed phase can be reverted without undoing unrelated cleanup.
- For worker scheduler changes, keep behavior-preserving helper extraction separate from logic consolidation wherever possible.

## Review Loop Status

Draft version: v3
Reviewer loop status: revised after round 3
Acceptance target: fewer than 3 minor issues remaining after reviewer loop
