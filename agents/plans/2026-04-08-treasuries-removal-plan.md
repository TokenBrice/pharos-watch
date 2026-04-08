# Treasuries Feature Removal Plan

## Objective

Remove the public `/treasuries/` page and the full treasury stable-exposure feature slice behind it:

- frontend route, hook, components, and route discovery
- public API route `GET /api/treasury-stable-exposure`
- worker cron publisher `sync-treasury-stable-exposure`
- shared treasury contracts, seed registry, and Sim integration code
- live database state associated with the feature
- verified documentation, env-contract references, and smoke / contract tests

This plan is based on the current live implementation in:

- `src/app/treasuries/*`
- `src/hooks/use-treasury-stable-exposure.ts`
- `src/components/treasury-stable-exposure-table.tsx`
- `src/lib/treasury-table-utils.ts`
- `src/lib/treasury-debank.ts`
- `scripts/build-treasury-seeds.ts`
- `shared/types/treasury-stable-exposure.ts`
- `shared/lib/treasury-stable-exposure.ts`
- `shared/lib/treasury-seeds.ts`
- `shared/data/treasury-seeds.json`
- `worker/src/api/treasury-stable-exposure.ts`
- `worker/src/cron/sync-treasury-stable-exposure.ts`
- `worker/src/lib/sim-balances.ts`

## Important Constraint

The repo’s deploy contract matters here:

1. Standard deploys apply D1 migrations before the new Worker is live.
2. New migrations must be backward-compatible.
3. The migration checker rejects obvious destructive drop / rename patterns.

That means this work should be split into:

- **Cutover deploy:** remove the page, API, cron, and code paths first.
- **Post-cutover data cleanup:** delete stale rows after the new worker is live.
- **Optional schema eradication:** drop the now-unused history table only in a separate coordinated maintenance rollout, not in the same standard deploy.

If the goal is “remove runtime feature + remove stored rows”, one deploy plus a follow-up D1 cleanup is sufficient. If the goal is “remove every trace including schema objects”, schedule a separate destructive DB task.

## Current Feature Inventory

### Frontend

- Route shell: `src/app/treasuries/page.tsx`
- Route client: `src/app/treasuries/client.tsx`
- Route error boundary: `src/app/treasuries/error.tsx`
- Data hook: `src/hooks/use-treasury-stable-exposure.ts`
- Table component: `src/components/treasury-stable-exposure-table.tsx`
- Table helpers: `src/lib/treasury-table-utils.ts`
- DeBank link helper: `src/lib/treasury-debank.ts`
- Nav entry: `src/lib/nav-config.ts`
- Sitemap entry: `src/app/sitemap.ts`
- Generated sitemap date artifact: `src/generated/sitemap-dates.json`

### Shared contract layer

- Seed build script: `scripts/build-treasury-seeds.ts`
- API path helper: `shared/lib/api-endpoints/paths.ts`
- Endpoint registry entry + strict-contract list: `shared/lib/api-endpoints/definitions.ts`
- Frontend freshness constant: `shared/lib/api-freshness.ts`
- Treasury schemas and types: `shared/types/treasury-stable-exposure.ts`
- Barrel export: `shared/types/index.ts`
- Treasury normalization logic: `shared/lib/treasury-stable-exposure.ts`
- Seed loader: `shared/lib/treasury-seeds.ts`
- Seed asset: `shared/data/treasury-seeds.json`

### Worker/API/runtime

- Public route registration: `worker/src/routes/public-routes.ts`
- API handler: `worker/src/api/treasury-stable-exposure.ts`
- Daily cron job: `worker/src/cron/sync-treasury-stable-exposure.ts`
- Daily slot wiring: `worker/src/handlers/scheduled/daily-0800.ts`
- Cron metadata: `shared/lib/cron-jobs.ts`
- Cron timeout: `worker/src/lib/cron-lease.ts`
- Worker freshness thresholds: `worker/src/lib/constants.ts`
- Sim env binding: `worker/src/lib/env.ts`
- Sim integration helper: `worker/src/lib/sim-balances.ts`
- Circuit source enum entry: `worker/src/lib/constants.ts`
- Public health circuit completion surface: `worker/src/lib/public-health-assessment.ts`

### Database state

The feature currently writes or can leave rows in:

- `cache`
  - `key = 'treasury-stable-exposure'`
  - `key = 'circuit:sim-balances'`
- `treasury_stable_exposure_history`
- `cron_runs`
  - `job = 'sync-treasury-stable-exposure'`
- `cron_run_progress`
  - `job = 'sync-treasury-stable-exposure'`
- `cron_leases`
  - `job = 'sync-treasury-stable-exposure'`

Schema object dedicated to the feature:

- `worker/migrations/0086_treasury_stable_exposure_history.sql`
- `worker/migrations/MANIFEST.md`
- table `treasury_stable_exposure_history`
- indexes:
  - `idx_treasury_stable_exposure_history_slug_snapshot`
  - `idx_treasury_stable_exposure_history_snapshot`

### Tests and smoke coverage

- `src/components/__tests__/treasury-stable-exposure-table.test.tsx`
- `src/lib/__tests__/treasury-debank.test.ts`
- `src/lib/__tests__/treasury-table-utils.test.ts`
- `shared/lib/__tests__/treasury-stable-exposure.test.ts`
- `worker/src/api/__tests__/treasury-stable-exposure.test.ts`
- `worker/src/cron/__tests__/sync-treasury-stable-exposure.test.ts`
- `worker/src/lib/__tests__/sim-balances.test.ts`
- `src/lib/__tests__/api-endpoints.test.ts`
- `scripts/smoke-api.mjs`
- fixture-based health/status/api-utils tests that currently include the cache key:
  - `worker/src/api/__tests__/health.test.ts`
  - `worker/src/api/__tests__/status.test.ts`
  - `worker/src/lib/__tests__/api-utils.test.ts`

### Verified docs and config references

- `docs/api-reference.md`
- `docs/architecture.md`
- `docs/worker-infrastructure.md`
- `docs/worker-and-api-limits.md`
- `docs/portfolio-page.md`
- `docs/about-page.md`
- `docs/README.md`
- `docs/superpowers/specs/2026-04-05-treasury-issuer-expansion-design.md`
- `docs/superpowers/plans/2026-04-05-treasury-issuer-expansion-plan.md`
- `docs/superpowers/plans/2026-04-05-collapsible-nav-plan.md`
- `README.md`
- `.env.example`

There is already documentation drift:

- `docs/portfolio-page.md`
- `docs/about-page.md`

still describe the treasury surface as living under `/portfolio/`, while the runtime feature is only mounted on `/treasuries/`.

## Recommended Rollout Shape

### Deploy A: code and public-surface removal

Ship all code, docs, registry, and test removals first, but do **not** drop the history table in this deploy.

### Cleanup B: post-cutover data purge

After Deploy A is live and stable, delete the now-orphaned cache rows and history / telemetry rows from D1.

### Optional Maintenance C: schema destruction

If you want the dedicated history table gone too, do that in a separate coordinated maintenance task. Do not couple it to the main feature-removal PR.

## Detailed Implementation Plan

## Phase 0: Decide route retirement behavior

Before editing code, make one explicit product decision for `/treasuries/`:

- **Recommended default:** retire the route with no redirect if there is no real successor page.
- **Alternative:** add a Cloudflare Pages redirect in `public/_redirects` only if you intentionally want to funnel legacy inbound traffic somewhere meaningful.

Recommendation rationale:

- Redirecting to `/portfolio/` is only correct if portfolio will actually contain the treasury surface again.
- A silent redirect to an unrelated page will look like a broken information architecture fix-up rather than a real successor.
- If no successor exists, deleting the route and removing it from sitemap/nav is cleaner.

If redirecting, implement it in `public/_redirects` because the app is a static export and runtime redirects are not the deployment model here.

## Phase 1: Remove the frontend route and all direct UI dependencies

Delete the dedicated route implementation:

- `src/app/treasuries/page.tsx`
- `src/app/treasuries/client.tsx`
- `src/app/treasuries/error.tsx`

Delete the route-only UI layer:

- `src/hooks/use-treasury-stable-exposure.ts`
- `src/components/treasury-stable-exposure-table.tsx`
- `src/lib/treasury-table-utils.ts`
- `src/lib/treasury-debank.ts`

Remove route discoverability:

- delete the `Treasuries` item from `src/lib/nav-config.ts`
- remove `/treasuries/` from `src/app/sitemap.ts`
- regenerate `src/generated/sitemap-dates.json` via the normal prebuild/build flow

About-page cleanup:

- remove the `Protocol Treasury Stable Exposure` card from `src/app/about/page.tsx`
- remove Sim / DefiLlama treasury-adapter source copy from the about page source-group text if it only exists for this feature

Expected result after Phase 1:

- `/treasuries/` no longer builds as an application route
- no top-level nav entry points to it
- sitemap no longer advertises it
- no about-page feature card markets it

## Phase 2: Remove the shared contract surface

Delete treasury-specific shared types and logic:

- `scripts/build-treasury-seeds.ts`
- `shared/types/treasury-stable-exposure.ts`
- `shared/lib/treasury-stable-exposure.ts`
- `shared/lib/treasury-seeds.ts`
- `shared/data/treasury-seeds.json`

Update shared exports:

- remove treasury exports from `shared/types/index.ts`

Remove endpoint contract references:

- remove `treasuryStableExposure()` from `shared/lib/api-endpoints/paths.ts`
- remove endpoint definition `treasury-stable-exposure` from `shared/lib/api-endpoints/definitions.ts`
- remove it from the strict-contract path list in the same file
- remove `treasuryStableExposure` from `shared/lib/api-freshness.ts`

This phase matters because the endpoint registry drives:

- route method validation
- smoke/probe coverage
- public/site-data access policies
- frontend path helpers

Expected result after Phase 2:

- the treasury feature has no remaining shared public contract
- any attempt to reference the old endpoint path should fail at compile/test time rather than linger silently

## Phase 3: Remove the worker API and cron publisher

Delete feature-specific worker code:

- `worker/src/api/treasury-stable-exposure.ts`
- `worker/src/cron/sync-treasury-stable-exposure.ts`
- `worker/src/lib/sim-balances.ts`

Remove route/scheduler wiring:

- remove `handleTreasuryStableExposure` from `worker/src/routes/public-routes.ts`
- remove `syncTreasuryStableExposure` from `worker/src/handlers/scheduled/daily-0800.ts`
- remove job metadata from `shared/lib/cron-jobs.ts`
- remove the timeout entry from `worker/src/lib/cron-lease.ts`

Remove worker config/env/circuit references that become dead after the cron/API deletion:

- remove `SIM_API_KEY` from `worker/src/lib/env.ts`
- remove Sim API constants from `worker/src/lib/constants.ts`
- remove `CIRCUIT_SOURCE.SIM_BALANCES` from `worker/src/lib/constants.ts`
- remove the cache freshness threshold entry for `treasury-stable-exposure` from `worker/src/lib/constants.ts`

Circuit-state nuance:

- removing `CIRCUIT_SOURCE.SIM_BALANCES` stops default hydration of a missing `sim-balances` circuit state
- it does **not** automatically hide an already-persisted `cache.key = 'circuit:sim-balances'` row, because `getCircuitStates()` reads every `circuit:*` cache key
- therefore `/health` and `/status` may continue to show a stale `sim-balances` circuit until Cleanup B deletes that cache row
- if you want that circuit to disappear immediately at code cutover, add an explicit filter for unknown circuit keys; otherwise the cleanup SQL is sufficient

Keep the daily `0 8 * * *` slot itself unchanged. Only remove the treasury job from the slot chain and its docs/comments.

Expected result after Phase 3:

- `/api/treasury-stable-exposure` becomes an unknown route and should return the worker’s normal 404/not-found behavior
- no daily cron writes treasury cache/history rows anymore
- no worker secret or Sim client code remains for this feature

## Phase 4: Remove tests and smoke coverage

Delete dedicated tests:

- `src/components/__tests__/treasury-stable-exposure-table.test.tsx`
- `src/lib/__tests__/treasury-debank.test.ts`
- `src/lib/__tests__/treasury-table-utils.test.ts`
- `shared/lib/__tests__/treasury-stable-exposure.test.ts`
- `worker/src/api/__tests__/treasury-stable-exposure.test.ts`
- `worker/src/cron/__tests__/sync-treasury-stable-exposure.test.ts`
- `worker/src/lib/__tests__/sim-balances.test.ts`

Update shared assertions and smoke coverage:

- remove `/api/treasury-stable-exposure` from `src/lib/__tests__/api-endpoints.test.ts`
- remove its assertion block from `scripts/smoke-api.mjs`

Update fixture-style health/status tests that currently mention the cache key:

- `worker/src/api/__tests__/health.test.ts`
- `worker/src/api/__tests__/status.test.ts`
- `worker/src/lib/__tests__/api-utils.test.ts`

These tests are likely to fail even if the runtime change is correct, because they currently hard-code:

- the `treasury-stable-exposure` cache key
- the public probe list
- the number or identity of expected status-tracked jobs

## Phase 5: Update verified docs and env examples

Update verified docs to remove the public surface:

- `docs/api-reference.md`
  - remove the endpoint row from freshness tables
  - remove the full `GET /api/treasury-stable-exposure` section
- `docs/architecture.md`
  - remove the endpoint from the API inventory
  - remove the `/treasuries/` route from the file tree
  - remove the component/hook/worker file references
- `docs/worker-infrastructure.md`
  - remove `SIM_API_KEY`
  - remove `sync-treasury-stable-exposure` from the 08:00 slot section
  - update any cron count totals affected by job removal
- `docs/worker-and-api-limits.md`
  - remove the treasury-specific deadline/budget rows
  - remove the Sim treasury-snapshot request budget row
- `docs/README.md`
  - remove `/treasuries/` from route coverage
- `docs/about-page.md`
  - remove treasury-specific copy and correct the stale `/portfolio/` mention
- `docs/portfolio-page.md`
  - remove the stale treasury leaderboard/API contract section
- `docs/superpowers/specs/2026-04-05-treasury-issuer-expansion-design.md`
  - remove or archive the treasury expansion design, because it becomes documentation for a deleted feature
- `docs/superpowers/plans/2026-04-05-treasury-issuer-expansion-plan.md`
  - remove or archive the treasury issuer expansion implementation plan for the same reason
- `docs/superpowers/plans/2026-04-05-collapsible-nav-plan.md`
  - remove the `/treasuries` nav example line if the document is expected to stay current
- `README.md`
  - remove `/treasuries/` from project structure
  - remove treasury sync from the cron overview
  - remove `treasury_stable_exposure_history` from the D1 table list
  - remove `SIM_API_KEY` from the worker secrets list
- `.env.example`
  - remove `SIM_API_KEY=`

Non-canonical historical records should usually stay:

- `src/data/changelogs/*`
- `/agents/` historical plans/audits

Those are historical artifacts, not live product contracts.

Non-canonical assistant-facing inventories may also contain stale route mentions:

- `CLAUDE.md`

Updating those is optional for deploy safety, but recommended if you want zero stale internal route inventories after removal.

## Phase 6: Safe post-cutover D1 cleanup

Run this only after Deploy A is live.

### Required row cleanup

Delete live cache/circuit/data rows that no code should use anymore:

```sql
DELETE FROM cache
WHERE key IN ('treasury-stable-exposure', 'circuit:sim-balances');

DELETE FROM treasury_stable_exposure_history;

DELETE FROM cron_runs
WHERE job = 'sync-treasury-stable-exposure';

DELETE FROM cron_run_progress
WHERE job = 'sync-treasury-stable-exposure';

DELETE FROM cron_leases
WHERE job = 'sync-treasury-stable-exposure';
```

Operationally, this can be executed with Wrangler against the configured D1 database (`stablecoin-db`) after the new worker is live.

### Why not do this in the same deploy?

- The old worker may still be live when migrations run.
- The migration checker is designed to reject destructive schema changes.
- The safest order is: stop reads/writes first, purge rows second.

## Phase 7: Optional schema destruction

If “remove database entries” also means “remove the dedicated table and indexes”, treat that as a separate maintenance task.

Recommended approach:

1. Complete Deploy A and Cleanup B first.
2. Confirm no runtime code, tests, docs, or env contracts still reference the feature.
3. Schedule a controlled maintenance window if production DDL is going to be destructive.
4. Drop:
   - `treasury_stable_exposure_history`
   - its two indexes
5. Reflect that schema change in the repo in a way that matches the project’s migration policy.
6. Update `worker/migrations/MANIFEST.md` if a new maintenance migration is introduced for schema destruction.

This is intentionally not part of the main removal deploy because:

- dropping the table is destructive
- the repo’s migration safety checks are designed to block exactly that in the standard path
- the normal deploy order applies DB changes before the new code is fully live

If the team does **not** want to open a maintenance path for destructive DDL, it is acceptable to leave the empty unused table in place after Cleanup B. That still fully removes the product/API/runtime feature and its stored rows.

## Verification Plan

### Local validation

Run the normal deploy-surface checks:

```bash
npm run lint
npm test
npm run build
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

### Targeted behavior checks

Verify:

- `/treasuries/` behaves as intended
  - absent/404 if retired with no redirect
  - redirected if a redirect policy was chosen
- `/api/treasury-stable-exposure` no longer appears in:
  - endpoint registry tests
  - smoke API strict contract list
  - docs/api-reference
- the daily 08:00 slot still runs cleanly without the treasury job
- `/status` and `/health` no longer treat `treasury-stable-exposure` as a freshness dependency
- `/status` and `/health` may still show `sim-balances` under circuits until Cleanup B removes `cache.key = 'circuit:sim-balances'`
- the site builds with no broken nav or sitemap references

### Post-deploy verification

After production cutover:

1. Hit the retired route and confirm the expected response.
2. Hit `/api/treasury-stable-exposure` and confirm 404/not-found behavior.
3. Check `/status` and `/admin` for missing-job regressions.
4. Confirm no new `cron_runs` rows are being created for `sync-treasury-stable-exposure`.
5. Run the D1 cleanup SQL.
6. Re-check `/status` after cleanup.

## Risk Notes

### 1. Documentation drift is already present

The current docs still describe treasury content on `/portfolio/`, so this removal can accidentally leave stale copy behind unless docs are cleaned deliberately.

### 2. Status and smoke coverage are shared-registry driven

If the endpoint or cron job is removed incompletely, failures will show up in:

- probe path tests
- smoke-api coverage assertions
- status/health freshness tests

### 3. Sim secret cleanup should happen after code removal

Do not remove the production `SIM_API_KEY` binding first. Ship code removal first, then remove the secret from Cloudflare after the new worker is live.

### 4. Full schema destruction is the only part that is not standard-path friendly

Feature removal is straightforward. Table dropping is the part that conflicts with the repo’s rollout-safety rules.

## Recommended PR split

### PR 1: feature removal

- frontend route/UI deletion
- shared contract deletion
- worker/API/cron deletion
- docs/test/env cleanup

### PR 2 or maintenance task: database cleanup

- post-cutover D1 row purge
- optional table/index drop if the team decides to do destructive cleanup

This split keeps the primary removal reviewable and minimizes rollout risk.
