# Simplification Audit: Full Implementation Plan

Date: 2026-04-07
Repo: `/Users/ahirice/Documents/git/stablecoin-dashboard`
Related audit: `agents/2026-04-07-simplification-audit.md`

## Scope

This plan covers every non-deferred finding from the simplification audit:

1. Redundant client-page error boundaries
2. Split table shell / pagination patterns
3. Phantom admin-access abstraction
4. Duplicated main vs fallback stablecoin pricing orchestration
5. Pricing-source semantics split between registry metadata and local string checks
6. Route-registry compatibility facade
7. Query-string state handled with multiple patterns
8. Repeated `FeaturePageShell` props in `status` and `admin`

This is an execution plan only. No runtime behavior should change unless explicitly called out below.

## What Research Confirmed

- `createClientFeaturePage()` already wraps generated clients in `SectionErrorBoundary`, and five generated clients still add a second root boundary:
  - `src/app/liquidity/client.tsx`
  - `src/app/yield/client.tsx`
  - `src/app/coverage/client.tsx`
  - `src/app/compare/client.tsx`
  - `src/app/portfolio/client.tsx`
- The table-stack split is real:
  - `DataTableShell` + `TablePagination` already back `liquidity`, `depeg-tracker`, `yield-leaderboard`, `flow-table`, and `blacklist-table`
  - `chains`, `flow-event-feed`, `depeg-history`, and `stablecoin-table` still use custom variants
  - `EventPaginationFooter` has only two consumers and is a good deletion target
- `AdminAccess` is not stateful. It is the constant literal `"ops-proxy"` and `buildAdminFetchInit()` only clones headers.
- The pricing-pipeline duplication is narrower than “entire cron duplication”:
  - `post-enrichment.ts` already centralizes some shared work
  - the remaining duplication is the validation-state setup, fallback recovery stamping, authoritative override application, and post-enrichment handoff
- The pricing-source cleanup cannot reuse current registry flags blindly:
  - `protocol-redeem` is marked depeg-authoritative in the registry
  - `pool-tvl-weighted` is not depeg-authoritative in the registry, but worker code still grants it publication/bypass exceptions via string checks
  - this requires explicit new metadata, not a naive replacement with `canBeDepegAuthoritative`
- `worker/src/route-registry.ts` is pure re-export indirection. Production code only needs direct imports from `worker/src/routes/registry.ts` and `worker/src/routes/shared.ts`.
- `useUrlFilters()` is already the dominant frontend query-state pattern. The two main outliers are:
  - `src/app/safety-scores/client.tsx`
  - `src/components/yield-detail-section.tsx`
- `docs/status-dashboard.md`, `docs/architecture.md`, and `docs/api-reference.md` still describe `AdminAccess` and `worker/src/route-registry.ts` directly, so the doc sweep is not optional.

## Recommended Execution Order

Do the work in this order:

1. Finding 1: remove duplicate root error boundaries
2. Finding 8: hoist repeated `FeaturePageShell` props
3. Finding 6: delete `worker/src/route-registry.ts` and update imports/docs
4. Finding 2: unify pagination primitives and convert remaining non-virtualized tables
5. Finding 3: flatten admin proxy fetch/query plumbing
6. Finding 7: converge URL state on `useUrlFilters()`
7. Finding 5: centralize pricing-source semantics in shared metadata/helpers
8. Finding 4: extract the remaining shared main/fallback pricing pipeline steps on top of the new source semantics

Rationale:

- 1, 8, and 6 are low-risk deletions that shrink the surface before larger refactors.
- 2, 3, and 7 are frontend-facing but behaviorally shallow.
- 5 must happen before 4 so the extracted worker pipeline does not bake in obsolete string checks.

## Baseline Before Starting

Run this baseline before the first refactor tranche:

```bash
npm run lint
npm run typecheck
npm test
cd worker && npx tsc --noEmit
```

If any baseline failures already exist, record them before landing refactors so they are not misattributed later.

## Finding 1: Redundant Client-Page Error Boundaries

### Confirmed Edit Set

- `src/lib/client-feature-page.tsx`
- `src/app/liquidity/client.tsx`
- `src/app/yield/client.tsx`
- `src/app/coverage/client.tsx`
- `src/app/compare/client.tsx`
- `src/app/portfolio/client.tsx`

### Implementation

1. Treat `createClientFeaturePage()` as the single route-level boundary for generated feature pages.
2. Remove the root `<SectionErrorBoundary ...>` wrapper from the five client components above.
3. Keep subsection boundaries that isolate part of a page instead of the whole page.
4. Recheck the generated-page list so no remaining `createClientFeaturePage()` consumer re-wraps the root.

### Tests

- Add a focused render test for `src/lib/client-feature-page.tsx` that proves the helper already owns the route-level boundary.
- Smoke existing client render tests if present.
- Run:

```bash
npm test -- src/lib/__tests__/client-feature-page.test.tsx
```

### Risks

- `yield/client.tsx` currently wraps both the “no data” branch and the normal branch in the same boundary. Removing that wrapper is safe only because the page helper still wraps the entire route.
- Do not remove any sub-section boundaries from `/depeg/` or detail pages in this tranche. They are not part of this finding.

### Exit Criteria

- Generated feature pages have one route-level `SectionErrorBoundary`, not two.
- No subsection fault isolation is lost.

## Finding 2: Split Table Shell / Pagination Patterns

### Confirmed Edit Set

- Shared primitives
  - `src/components/data-table-shell.tsx`
  - `src/components/table-pagination.tsx`
  - `src/components/event-pagination-footer.tsx`
  - `src/components/interactive-table-row.tsx`
- Consumers to standardize
  - `src/app/chains/client.tsx`
  - `src/components/flow-event-feed.tsx`
  - `src/components/depeg-history.tsx`
  - `src/components/stablecoin-table.tsx`
- Existing standard-pattern references
  - `src/components/liquidity-table.tsx`
  - `src/components/flow-table.tsx`
  - `src/components/depeg-tracker-table.tsx`
  - `src/components/yield-leaderboard.tsx`

### Implementation

#### 2A. Absorb `EventPaginationFooter` into `TablePagination`

1. Expand `TablePagination` just enough to cover current `EventPaginationFooter` needs:
   - `className`
   - optional border toggle
   - always localized numeric formatting for counts
   - optional supplemental copy block if needed later by `stablecoin-table`
2. Keep the existing prop shape as close as possible to avoid churn in `DataTableShell`.
3. Delete `src/components/event-pagination-footer.tsx`.

The goal is deletion, not a new table framework.

#### 2B. Convert `flow-event-feed` to the standard shell

1. Replace the raw `<Table>` wrapper with `DataTableShell`.
2. Define a static column list at the top of the file.
3. Keep the current badge/amount/tx-cell rendering logic unchanged.
4. Use `TablePagination` directly instead of the deleted footer.

#### 2C. Convert `depeg-history` to the standard shell

1. Replace the raw `<Table>` wrapper with `DataTableShell`.
2. Keep `DepegRow` as the row renderer.
3. Preserve the existing intro, metrics summary, hydration notice, and pagination behavior.
4. Use the shared `TablePagination`.

#### 2D. Convert `chains` leaderboard to the standard shell

1. Keep the hero summary and dominance band outside the table.
2. Replace the manual table with `DataTableShell` plus `InteractiveTableRow`.
3. Preserve:
   - sortable headers
   - sticky header behavior
   - row keyboard activation
   - current hover treatment
   - scroll container sizing
4. If sticky headers do not behave correctly through `DataTableShell` as-is, add the smallest shell prop necessary to support them. Do not reintroduce a custom table stack.

#### 2E. Bring `stablecoin-table` closer to the shared table primitives without breaking virtualization

1. Keep virtualization local. Do not force `stablecoin-table` into `DataTableShell`.
2. Reuse the shared pagination/footer chrome only if the API can support it without adding a second ad hoc footer component.
3. If the shared footer API would become more complex than the code it replaces, stop at:
   - aligning header column metadata with shared `DataTableColumn` typing
   - preserving local virtualization
   - leaving the footer local for now

This is the one place where a narrow local implementation is preferable to a distorted generic API.

### Tests

- Add targeted tests for `TablePagination` and its new options.
- Update `src/components/__tests__/data-table-shell.test.tsx`.
- Add or update consumer tests for:
  - `src/components/__tests__/flow-table.test.tsx` only if shared helper changes affect expectations
  - new tests for `flow-event-feed` and `depeg-history` if the render path becomes non-trivial
  - a new `src/app/chains/client.test.tsx` is worthwhile because that page currently has no leaderboard client test
- Run:

```bash
npm test -- src/components/__tests__/data-table-shell.test.tsx src/components/__tests__/table-pagination.test.tsx
```

Then run the broader frontend suite:

```bash
npm test
```

### Risks

- Sticky headers on `/chains/` are the main UI regression risk.
- `stablecoin-table` has different constraints from the other tables. Do not “standardize” it by deleting virtualization or by adding a generic abstraction that only it uses.

### Exit Criteria

- `EventPaginationFooter` is deleted.
- `chains`, `flow-event-feed`, and `depeg-history` all use the shared table shell/pagination path.
- `stablecoin-table` remains virtualized and does not gain extra complexity.

## Finding 3: Phantom Admin-Access Abstraction

### Confirmed Edit Set

- Core helpers
  - `src/lib/admin-access.ts`
  - `src/hooks/use-admin-polling-query.ts`
  - `src/hooks/use-endpoint-probes.ts`
- Hooks
  - `src/hooks/use-status-dashboard-model.ts`
  - `src/hooks/use-status.ts`
  - `src/hooks/use-status-history.ts`
  - `src/hooks/use-request-source-stats.ts`
  - `src/hooks/use-api-keys.ts`
- Admin/status UI
  - `src/app/admin/client.tsx`
  - `src/app/admin/sections/overview-section.tsx`
  - `src/app/admin/sections/pipeline-section.tsx`
  - `src/app/admin/sections/control-section.tsx`
  - `src/components/status/admin-action-button.tsx`
  - `src/components/status/api-keys-panel.tsx`
  - `src/components/status/discovery-candidates.tsx`
  - `src/components/status/status-facts.tsx`
  - `src/components/status/recommended-action-strip.tsx`
  - any other `adminAccess` prop pass-throughs under `src/components/status/`
- Tests
  - `src/hooks/__tests__/query-polling-policy.test.ts`
  - `src/hooks/__tests__/endpoint-probes.test.ts`
  - `src/app/admin/__tests__/client.test.tsx`

### Implementation

1. Keep `isOpsUiHost()` in `src/lib/admin-access.ts`.
2. Keep `buildAdminApiPath()` unless its call sites become clearer with inline string concatenation. It still provides path validation.
3. Delete:
   - `AdminAccess`
   - `getAdminQueryScope()`
   - `buildAdminFetchInit()`
4. Change `useAdminPollingQuery()` to own its query-key scope internally instead of receiving it as an argument.
5. Drop the `adminAccess` parameter from:
   - `useStatus()`
   - `useStatusHistory()`
   - `useRequestSourceStats()`
   - `useApiKeys()`
   - `useEndpointProbes()`
   - `useStatusDashboardModel()`
6. Replace the remaining `adminAccess` UI props with direct behavior:
   - `AdminActionButton` no longer accepts an unused `adminAccess`
   - `ApiKeysPanel`, `StatusFacts`, `RecommendedActionStrip`, `DiscoveryCandidatesCard`, and admin sections stop threading it through
7. Preserve cache separation by keeping explicit static query-key tokens such as `"admin"` or `"ops-proxy"` inside the hook implementations.
8. For admin probes, replace the optional `adminAccess` argument with an explicit admin-proxy mode flag or with separate internal request builders. The public and admin probe keys must remain distinct.

### Tests

- Update the polling-policy tests to call admin hooks without an argument and keep asserting:
  - same-origin `/api/admin/*` path usage
  - no `X-Admin-Key` header
  - correct query keys
- Update `endpoint-probes.test.ts` to cover the admin/public request-path split without `AdminAccess`.
- Update `src/app/admin/__tests__/client.test.tsx` to stop mocking `getAdminQueryScope()`.

Run:

```bash
npm test -- src/hooks/__tests__/query-polling-policy.test.ts src/hooks/__tests__/endpoint-probes.test.ts src/app/admin/__tests__/client.test.tsx
```

### Docs

Update:

- `docs/status-dashboard.md`
- `docs/architecture.md`

Only update `docs/operator-origin-access.md` if file-path or helper references there still mention `AdminAccess` directly. The transport model itself should remain unchanged.

### Risks

- Query-key collisions between admin and public probes are the main correctness risk.
- This refactor touches many prop signatures. Keep each deletion mechanical and review the remaining `adminAccess` symbols with `rg -n "adminAccess" src`.

### Exit Criteria

- `adminAccess` no longer exists in component props or hook signatures.
- The ops host detection logic still lives in one place.
- Same-origin `/api/admin/*` fetch behavior is unchanged.

## Finding 4: Duplicated Main vs Fallback Stablecoin Pricing Orchestration

### Confirmed Edit Set

- Main path
  - `worker/src/cron/sync-stablecoins/stages.ts`
  - `worker/src/cron/sync-stablecoins.ts`
- Fallback path
  - `worker/src/cron/sync-stablecoins/fallback.ts`
- Shared helpers
  - `worker/src/cron/sync-stablecoins/post-enrichment.ts`
  - `worker/src/cron/sync-stablecoins/shared.ts`
  - `worker/src/cron/sync-stablecoins/pricing.ts`

### Implementation

Do not build a giant generic “pricing pipeline” abstraction. Extract only the duplicated steps that already have the same behavior.

#### 4A. Add regression coverage first

Before moving code, pin these invariants with tests:

- freshly recovered prices that were missing before enrichment get fallback metadata stamped
- authoritative protocol overrides still apply after main-path GT probing
- fallback-path authoritative overrides still apply before post-enrichment validation
- both paths keep their distinct stage/progress labels

#### 4B. Extract shared validation-state setup

Create a narrow helper that centralizes:

- `createValidationContextResolver()`
- replay-cache loading
- `buildPreviousTrustedPriceLookup(...)`

This should remove duplicated setup without changing path-specific control flow.

#### 4C. Extract recovered-fallback stamping

Both paths do:

- snapshot `missingBefore`
- run enrichment
- stamp recovered prices as fallback when they were previously missing and still lack confidence

Move that into one shared helper.

#### 4D. Extract authoritative-override + post-enrichment handoff

Create a small helper that runs:

- authoritative override fetch
- `applyProtocolPriceOverrides(...)`
- `runPostEnrichmentPricePipeline(...)`

Inputs should be explicit. Do not hide stage names or path-specific metadata inside the helper.

#### 4E. Keep metadata/result construction path-specific

- Main path still owns the rich `buildStablecoinsSyncResult(...)` metadata assembly.
- Fallback path still owns its fallback-mode result block.
- Progress stage names remain different:
  - `"price-enrichment"` vs `"fallback-price-enrichment"`
  - `"depeg-pipeline"` vs `"fallback-depeg-pipeline"`

### Tests

Use existing worker pricing tests as the base:

- `worker/src/cron/__tests__/sync-stablecoins-post-enrichment.test.ts`
- `worker/src/lib/__tests__/price-publish-policy.test.ts`
- `worker/src/cron/__tests__/sync-stablecoins.test.ts`

At minimum run:

```bash
npm test -- worker/src/cron/__tests__/sync-stablecoins-post-enrichment.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts
cd worker && npx tsc --noEmit
```

If the extraction touches price-validation semantics, also run:

```bash
npm test -- worker/src/lib/__tests__/price-publish-policy.test.ts
```

### Docs

Behavior should stay constant. Update docs only if:

- file-path references in `docs/pricing-pipeline.md` become misleading
- progress-stage naming changes
- methodology-visible fallback behavior changes

If methodology-visible behavior changes at all, update:

- `docs/pricing-pipeline.md`
- `src/app/methodology/sections/core-sections-pricing.tsx`
- `docs/pricing-pipeline-timeline.md`

### Risks

- The status dashboard and cron telemetry read stage names and metadata. Do not collapse them into generic labels.
- Avoid callback-based helper designs that make the two paths harder to read than they are now.

### Exit Criteria

- Shared pre/post-enrichment work is implemented once.
- Main vs fallback path order, labels, and result metadata remain intentionally distinct.

## Finding 5: Pricing-Source Semantics Split Between Registry Metadata and Local String Checks

### Confirmed Edit Set

- Shared source metadata
  - `shared/lib/pricing-source-registry.ts`
  - `shared/lib/pricing-sources.ts`
- Worker semantics
  - `worker/src/lib/pricing-source-policy.ts`
  - `worker/src/lib/price-publish-policy.ts`
  - `worker/src/cron/sync-stablecoins/post-enrichment.ts`
  - `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- Frontend consumers
  - `src/hooks/use-coverage-matrix-model.ts`
  - `src/components/stablecoin-detail/price-transparency-card.tsx`

### Implementation

#### 5A. Add explicit source-semantic metadata

Do not overload `canBeDepegAuthoritative`. It does not cover all current exceptions.

Add only the fields needed by real call sites. Based on current code, likely required semantics are:

- publication lane: primary vs fallback-validation
- severe-downside corroboration exemption
- temporal-jump quarantine exemption
- native-peg hardening bypass
- coverage-page override grouping
- transparency exclusivity for protocol-style overrides

Use explicit booleans or a small enum. Do not add a generic policy object with speculative fields.

#### 5B. Move shared helper logic into `shared/lib`

Best target: consolidate semantics into a shared runtime-neutral policy module under `shared/lib/`.

Recommended end state:

- frontend and worker both import the same semantic helpers
- `worker/src/lib/pricing-source-policy.ts` is deleted, or reduced to a temporary re-export and then deleted in the same tranche if feasible

This is the one place where adding a shared file is justified because both `src/` and `worker/` need the same semantics.

#### 5C. Replace local string checks with metadata-backed helpers

Refactor:

- `worker/src/lib/price-publish-policy.ts`
- `worker/src/cron/sync-stablecoins/post-enrichment.ts`
- `src/hooks/use-coverage-matrix-model.ts`
- `src/components/stablecoin-detail/price-transparency-card.tsx`

Keep semantics identical on the first pass. The goal is centralization, not policy change.

#### 5D. Preserve the current `pool-tvl-weighted` exception intentionally

This is the highest-risk nuance in the whole audit.

Current state:

- `pool-tvl-weighted` is not marked depeg-authoritative in the registry
- worker publication logic still special-cases it

That means the new registry metadata must represent the actual intended policy explicitly. Do not “fix” this by deleting the exception unless there is a separate product decision to change behavior.

### Tests

Expand or add tests that pin the exact exception behavior:

- `worker/src/lib/__tests__/price-publish-policy.test.ts`
  - protocol-redeem exemption
  - pool-tvl-weighted exemption
  - fallback-validation lane selection
- `worker/src/cron/__tests__/sync-stablecoins-post-enrichment.test.ts`
  - native-peg hardening bypass rules
- `src/components/stablecoin-detail/__tests__/price-transparency-card.test.tsx`
  - protocol-redeem remains exclusive in the transparency card
- add a focused frontend test for the coverage pricing-source split if the model logic changes materially

Run:

```bash
npm test -- worker/src/lib/__tests__/price-publish-policy.test.ts worker/src/cron/__tests__/sync-stablecoins-post-enrichment.test.ts src/components/stablecoin-detail/__tests__/price-transparency-card.test.tsx
cd worker && npx tsc --noEmit
```

### Docs

If this refactor is behavior-preserving, doc updates can stay minimal.

If any visible source grouping, transparency labeling, or methodology wording changes, update:

- `docs/pricing-pipeline.md`
- `docs/stablecoin-detail-page.md`
- `src/app/methodology/sections/core-sections-pricing.tsx`
- `docs/pricing-pipeline-timeline.md`

### Risks

- This refactor is easy to get wrong if it treats all “authoritative” meanings as the same concept.
- Keep the semantics dimension-specific.

### Exit Criteria

- No production logic relies on raw source-name string checks where shared metadata already defines the meaning.
- Frontend and worker use the same semantic helpers.

## Finding 6: Route-Registry Compatibility Facade

### Confirmed Edit Set

- `worker/src/router.ts`
- `worker/src/route-registry.ts`

Docs with confirmed references:

- `docs/architecture.md`
- `docs/api-reference.md`
- `docs/status-dashboard.md`
- `docs/feedback-pipeline.md`
- `docs/digest-pipeline.md`
- `docs/blacklist-tracker.md`

### Implementation

1. Change `worker/src/router.ts` to import directly from:
   - `worker/src/routes/registry.ts`
   - `worker/src/routes/shared.ts`
2. Delete `worker/src/route-registry.ts`.
3. Sweep docs for the old file path and update them to the split `routes/` structure.

### Tests

This is mostly compile-time safety:

```bash
cd worker && npx tsc --noEmit
npm test
```

If docs change:

```bash
npm run check:doc-sync
npm run check:verified-doc-links
```

### Risks

- Code risk is low. Documentation drift is the main failure mode.

### Exit Criteria

- The facade file is deleted.
- No docs describe it as the current worker routing locus.

## Finding 7: Query-String State Handled With Multiple Patterns

### Confirmed Edit Set

- `src/hooks/use-url-filters.ts`
- `src/app/safety-scores/client.tsx`
- `src/components/yield-detail-section.tsx`
- supporting model/hook logic to verify initial-state parsing:
  - `src/hooks/use-stress-test.ts`

### Implementation

Convergence target: `useUrlFilters()`.

#### 7A. Clean up `useUrlFilters()`

1. Fix the stale comment that still claims `router.replace()` when the hook actually uses `window.history.replaceState(...)`.
2. Keep the current hook API unless a real missing capability blocks migration.
3. Do not add an array-param abstraction just for one `sources=` use case.

#### 7B. Migrate `/safety-scores/`

1. Replace the direct `router.replace()` effect with `useUrlFilters().setParams(...)` or `replaceParams(...)`.
2. Keep `useStressTest()` as the initial-state parser unless the refactor reveals a real bug.
3. Preserve the current `stress` and `grade` param names and encoding.

#### 7C. Migrate `yield-detail-section`

1. Replace `useSearchParams()` + `useRouter()` writes with `useUrlFilters()`.
2. Serialize the source selection as the existing comma-joined `sources=` value.
3. Preserve the “max 4 selected sources” logic.

### Tests

Expand `src/hooks/__tests__/use-url-filters.test.ts` to cover:

- param reads
- param writes
- batch writes
- `replaceParams`
- `popstate` synchronization

Keep `use-stress-test` parsing tests green.

Run:

```bash
npm test -- src/hooks/__tests__/use-url-filters.test.ts src/hooks/__tests__/use-stress-test.test.ts
```

### Docs

No user-facing docs are likely required if param names and behavior stay unchanged.

If `docs/architecture.md` still describes `use-url-filters.ts` in a way that becomes inaccurate after the cleanup, update that summary line.

### Risks

- The main risk is stale query-state reads during migration if some writers still use `router.replace()` while others use `useUrlFilters()`.
- Avoid mixed patterns within the same screen.

### Exit Criteria

- `safety-scores` and `yield-detail-section` use the shared URL-state hook.
- The shared hook comments match the actual implementation.

## Finding 8: Repeated `FeaturePageShell` Props in `status` and `admin`

### Confirmed Edit Set

- `src/app/status/client.tsx`
- `src/app/admin/client.tsx`

### Implementation

1. Compute the shared shell props once per page.
2. Branch only on the inner content.
3. Preserve the genuinely different lead copy on `/admin/` when the user is off the ops host.

For `status/client.tsx`, this should reduce three repeated shell wrappers to one.

For `admin/client.tsx`, this should reduce three repeated shell wrappers to one while keeping:

- auth-gated variant
- public-host explanatory copy
- loading state
- private-surface message

### Tests

- Update `src/app/admin/__tests__/client.test.tsx`.
- Add a small `src/app/status/client.test.tsx` if the refactor becomes non-trivial. This page currently has enough branch complexity to justify one.

Run:

```bash
npm test -- src/app/admin/__tests__/client.test.tsx
```

### Risks

- Very low. The main risk is accidentally changing lead copy or wrapper variant.

### Exit Criteria

- Each page renders `FeaturePageShell` once.
- Inner-state branches remain readable.

## Recommended PR / Tranche Breakdown

Do not land all eight findings in one branch unless there is no review bottleneck. The cleaner rollout is:

1. `frontend-shell-cleanups`
   - Findings 1 and 8
2. `worker-route-facade-delete`
   - Finding 6 plus docs
3. `table-stack-convergence`
   - Finding 2
4. `ops-proxy-fetch-flattening`
   - Finding 3
5. `query-state-convergence`
   - Finding 7
6. `pricing-source-semantics-centralization`
   - Finding 5
7. `stablecoin-pricing-pipeline-dedup`
   - Finding 4

This keeps regression surfaces narrow and lets worker pricing changes review independently from frontend cleanup.

## Validation Matrix

### After each frontend tranche

```bash
npm run lint
npm run typecheck
npm test
```

### After each worker/pricing tranche

```bash
npm run lint
npm run typecheck
npm test
cd worker && npx tsc --noEmit
```

### After doc-heavy tranches

```bash
npm run check:doc-sync
npm run check:verified-doc-links
```

### Before any push

```bash
npm run test:merge-gate
```

## Final Notes

- The highest-risk implementation area is not the table work or the admin fetch cleanup. It is pricing-source semantics. Land the explicit metadata and tests before touching the main/fallback pipeline extraction.
- The safest simplification pattern in this repo is: centralize an already-proven primitive, delete pass-throughs, and keep path-specific orchestration readable.
- If any tranche starts needing a generalized abstraction with callbacks/options just to keep multiple special cases alive, stop and split the work smaller instead.
