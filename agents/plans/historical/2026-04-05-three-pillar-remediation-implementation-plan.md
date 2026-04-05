# Three-Pillar Remediation Implementation Plan

Date: 2026-04-05
Source audit: [`agents/audits/2026-04-05-comprehensive-three-pillar-audit-blueprint.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-04-05-comprehensive-three-pillar-audit-blueprint.md)
Status: proposed

This is the execution plan for the 2026-04-05 three-pillar audit findings only.

The older [`agents/plans/2026-04-03-three-pillar-audit-remediation-plan.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-04-03-three-pillar-audit-remediation-plan.md) is already marked complete and should not be reopened unless a current file proves the earlier fix regressed.

## Objectives

1. Remediate all 13 confirmed findings from the 2026-04-05 audit.
2. Keep behavior stable unless the finding itself requires a semantic change.
3. Expand tests before changing high-blast-radius control paths.
4. Restore all repository guardrails to green and keep them green after each packet.
5. Avoid creating fresh abstraction debt while removing current debt.

## Current Baseline

Verified at planning time:

- Passed: `npm run lint`
- Passed: `npm run typecheck`
- Passed: `npm test`
- Passed: `npm run build`
- Passed: `cd worker && npx tsc --noEmit`
- Passed: `npm run audit:deps`
- Passed: `npm run check:unused-code`
- Passed: `npm run check:shared-cycles`
- Passed: `npm run check:worker-boundary`
- Passed: `npm run check:duplicate-exports`
- Passed: `npm run check:sql-safety`
- Passed: `npm run check:hotspot-ratchet`
- Passed: `npm run check:doc-sync`
- Passed: `npm run check:migrations`
- Passed: `npm run check:cron-sync`
- Passed: `npm run check:cron-connections`
- Passed: `npm run check:stablecoin-data`
- Passed: `npm run check:redemption-backstops`
- Passed: `npm run audit:pricing-providers`
- Failed: `npm run check:doc-counts`
  - cause: docs still claim 32 live-reserve adapters while source now has 33

Implication:

- Packet 0 must restore `check:doc-counts` first.
- No structural refactor should begin while the baseline is knowingly red.

## Execution Principles

- Correctness before cleanup:
  - Expand tests around request ingress and idempotency before changing those paths.
- One concern per packet:
  - Do not mix docs, behavior changes, workflow refactors, and architectural decomposition in the same patch.
- Keep external contracts stable:
  - Preserve HTTP routes, headers, cache behavior, and UI output unless the finding explicitly requires a contract change.
- Prefer extraction over redesign:
  - Where a finding is about duplication or orchestration size, extract helpers first and stop if the helper boundary becomes forced.
- No opportunistic package churn:
  - Patch/minor dependency lag is not part of the finding set. Do not batch package updates into these packets unless a finding cannot be resolved otherwise.
- No guardrail weakening:
  - Do not update ratchet baselines, allowlists, or docs counts to hide regressions.
- Verify twice:
  - Run packet-local targeted validation during implementation.
  - Before push, always run `npm run test:merge-gate`.

## Findings Covered

Redundancy:

- `R1` duplicate metric-tile primitive in status cards
- `R2` repeated chart-shell scaffolding across chart components
- `R3` commodity price-history parsing duplicated in two API paths
- `R4` reserve-adapter bucket-to-slice assembly duplicated
- `R5` Kraken and Bitstamp ticker reducers duplicated
- `R6` duplicate null-guarded `formatCurrency(value, 1)` wrappers

Code quality:

- `Q1` idempotency cleanup can strand a reservation in `PENDING`
- `Q2` core request ingress lacks direct branch-level tests
- `Q3` Telegram bot status aggregation is monolithic and tightly coupled

Sustainability:

- `S1` docs out of sync with live-reserve registry
- `S2` validate-contract docs omit a CI-enforced step
- `S3` workflow scaffolding duplicated across YAML files
- `S4` route registry and dependency hydration form a large manual assembly surface

## Global Sequencing

Recommended execution order:

1. Packet 0: docs and validation-contract alignment (`S1`, `S2`)
2. Packet 1: ingress safety-net expansion (`Q2`)
3. Packet 2: idempotency deterministic failure handling (`Q1`)
4. Packet 3: low-risk UI redundancy cleanup (`R1`, `R6`)
5. Packet 4: Worker commodity-history dedupe (`R3`)
6. Packet 5: CEX reducer dedupe (`R5`)
7. Packet 6: reserve-adapter helper extraction (`R4`)
8. Packet 7: chart-shell extraction (`R2`)
9. Packet 8: Telegram status decomposition (`Q3`)
10. Packet 9: CI workflow scaffolding reuse (`S3`)
11. Packet 10: route-registry and hydration decomposition (`S4`)

Rationale:

- `S1` is blocking because it already fails a checked guardrail.
- `Q2` must land before `Q1` so the highest-risk request path has direct tests in place.
- `Q1` should land before any other Worker behavior changes because it affects admin retry semantics.
- `S3` and `S4` are the riskiest maintainability packets and should run only after all smaller packets are merged and the baseline is green.

## Packet Plan

### Packet 0 - Restore Source-of-Truth Alignment

Refs:

- `S1`
- `S2`

Goal:

- Make the repo green again on documentation guardrails.
- Align human-readable validate docs with the real command contract before other work starts.

Files:

- [`docs/live-reserves.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/live-reserves.md)
- [`docs/architecture.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/architecture.md)
- [`docs/deployment-process.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/deployment-process.md)
- [`docs/testing.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md)

Implementation steps:

1. Update all verified "32 adapters" references to 33.
2. Update the architecture file-tree comment that describes `reserve-adapters/`.
3. Add `npm run audit:pricing-providers` to the documented validate/merge-gate command list.
4. Keep the fix narrow:
   - do not introduce generated docs
   - do not alter CI behavior
   - do not broaden docs updates to unrelated count claims unless current source proves they are wrong

Validation:

- `npm run check:doc-counts`
- `npm run check:doc-sync`

Exit criteria:

- `check:doc-counts` passes.
- The documented validate contract matches `scripts/lib/validate-contract.mjs` for the command list currently in force.

### Packet 1 - Add Direct Tests for Worker Ingress

Refs:

- `Q2`

Goal:

- Pin the critical branch behavior in the Worker front door before changing adjacent control paths.

Files:

- [`worker/src/handlers/http/request-dispatch.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/http/request-dispatch.ts)
- [`worker/src/handlers/http/request-source.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/http/request-source.ts)
- [`worker/src/lib/request-source-attribution.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/request-source-attribution.ts)
- New tests:
  - `worker/src/handlers/http/__tests__/request-dispatch.test.ts`
  - `worker/src/handlers/http/__tests__/request-source.test.ts`
  - extend `worker/src/lib/__tests__/request-source-attribution.test.ts`

Implementation steps:

1. Add a direct unit test file for `handleHttpRequestImpl`.
2. Cover the branch matrix explicitly:
   - CORS preflight short-circuit
   - maintenance-mode short-circuit
   - access-gate rejection path
   - edge-cache hit path
   - route-dependencies-not-found -> 404
   - route returns `null` -> 404
   - successful route path schedules prune, records source, and writes edge cache
3. Add unit tests for `createRequestSourceRecorder`:
   - admin request -> no-op
   - no request lane -> no-op
   - `site-api` without site proxy -> no-op
   - `site-api` with proxy -> records lane `site-api`, consumer `site`
   - `public-api` with API-key traffic class -> uses provided class
   - `public-api` without API-key class -> falls back to browser classification
4. Extend attribution tests to cover `recordWorkerRequestAttribution` behavior:
   - insert/upsert branch
   - prune scheduling
   - prune failure logging and pending-state reset

Risk controls:

- Do not modify ingress logic in this packet except to expose test seams if absolutely necessary.
- Prefer dependency injection or thin local test doubles over broad mocking of unrelated modules.

Validation:

- `npm test -- worker/src/handlers/http/__tests__/request-dispatch.test.ts worker/src/handlers/http/__tests__/request-source.test.ts worker/src/lib/__tests__/request-source-attribution.test.ts worker/src/__tests__/index.fetch.test.ts`
- `cd worker && npx tsc --noEmit`

Exit criteria:

- The request-dispatch and request-source branch paths are directly covered.
- No production behavior changes are included in the packet.

### Packet 2 - Make Idempotency Failure Handling Deterministic

Refs:

- `Q1`

Goal:

- Prevent failed admin actions from leaving the same idempotency key stranded in an indefinitely in-progress state.

Files:

- [`worker/src/lib/idempotency.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/idempotency.ts)
- [`worker/src/lib/__tests__/idempotency.test.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/idempotency.test.ts)
- Docs to update if semantics change:
  - [`docs/api-reference.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md)
  - [`docs/worker-infrastructure.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/worker-infrastructure.md)
  - optionally [`docs/status-dashboard.md`](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/status-dashboard.md) if operator-facing wording changes

Recommended design:

- Keep the existing table shape.
- Preserve the current success replay and in-flight `409` behavior.
- Use `PENDING` only for actively executing actions.
- Prefer cleanup-first recovery on `execute()` failure so the common path does not gain a new external contract.
- Introduce an explicit terminal failure sentinel such as `FAILED_RESPONSE_STATUS = -2` only as a fallback when cleanup cannot be completed or confirmed.

Implementation steps:

1. Add a terminal failure sentinel constant beside `PENDING_RESPONSE_STATUS` only if the fallback path needs one.
2. On `execute()` throw:
   - attempt the keyed delete cleanup first so normal retry behavior stays unchanged when cleanup succeeds
   - if delete fails or cleanup cannot be confirmed, update the reservation row to a terminal failure state with a small structured JSON body
   - keep the current request hash check
3. Define replay behavior for the terminal-failure fallback state explicitly:
   - return a deterministic non-2xx response with `Idempotency-Key` and `X-Idempotent-Replay`
   - the response body must explain that the previous attempt failed and a new key may be required
   - do not make this fallback replay contract the default path for every execution error unless a route-level review proves same-key retry is unsafe
4. Keep TTL cleanup unchanged.
5. Update docs only if the terminal-failure replay path becomes externally observable.

Required tests:

1. `execute()` throws and cleanup succeeds -> reservation does not remain `PENDING`, and the same key can execute again
2. cleanup failure fallback -> reservation does not remain `PENDING`, and repeat calls receive the deterministic fallback replay response
3. key reuse with different payload still returns `409`
4. fallback path when the failure-state write itself fails still attempts cleanup and logs clearly

Risk controls:

- Do not add a migration for this packet unless the chosen design absolutely requires it.
- Do not turn all execution errors into permanent key exhaustion unless a specific admin route proves same-key retry is unsafe and that decision is documented in the packet PR.
- Preserve existing success replay behavior and in-flight `409` behavior.
- Keep failure semantics explicit in docs if the response contract changes.

Validation:

- `npm test -- worker/src/lib/__tests__/idempotency.test.ts`
- `cd worker && npx tsc --noEmit`
- `npm run check:doc-sync` if docs changed

Exit criteria:

- No code path logs "key may be stuck in PENDING" as the normal recovery strategy.
- Failed executions either remove the reservation or move it to a deterministic fallback state, but never leave it indefinitely `PENDING`.

### Packet 3 - Low-Risk UI Redundancy Cleanup

Refs:

- `R1`
- `R6`

Goal:

- Remove trivial UI duplication without changing visual behavior.

Files:

- [`src/components/status/d1-usage-card.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/status/d1-usage-card.tsx)
- [`src/components/status/liquidity-health.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/status/liquidity-health.tsx)
- [`src/components/metric-stat-card.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/metric-stat-card.tsx)
- [`src/components/status/discovery-candidates.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/status/discovery-candidates.tsx)
- [`src/components/stablecoin-detail/redemption-backstop-card.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/stablecoin-detail/redemption-backstop-card.tsx)

Implementation steps:

1. Compare the local `Metric` tiles against `MetricStatCard` and confirm the class delta.
2. If `MetricStatCard` can express both layouts without style regression:
   - replace both local `Metric` components
3. If not:
   - add a tiny `StatusMetricCard` wrapper around `MetricStatCard`
   - do not clone the full tile implementation again
4. Remove the two `formatCurrency(value, 1)` wrappers by inlining or replacing them with one tiny shared helper.

Risk controls:

- Do not restyle cards while deduplicating them.
- Keep text size, mono number treatment, and spacing stable.
- If a wrapper is needed, keep it local to the status/detail UI layer; do not push presentation-specific helpers into `shared/lib/`.

Validation:

- `npm run build`
- `npm test -- src/components`

Exit criteria:

- The duplicate `Metric` components are gone.
- The duplicate null-guarded currency helpers are gone.
- Visual behavior stays unchanged.

### Packet 4 - Extract Shared Commodity Price-Series Loader

Refs:

- `R3`

Goal:

- Remove copy/paste price-history parsing between the backfill path and the commodity detail path.

Files:

- [`worker/src/api/backfill-supply-history.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-supply-history.ts)
- [`worker/src/api/stablecoin-detail/commodity.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/stablecoin-detail/commodity.ts)
- New helper target:
  - `worker/src/api/stablecoin-detail/shared.ts` if the helper remains API-layer-specific
  - or a new small Worker lib helper if reuse expands beyond commodity detail

Implementation steps:

1. Extract the repeated "read CoinGecko payload -> select `coingecko:${geckoId}` -> normalize/sort price list" logic.
2. Make the helper return an empty array for missing or malformed payloads instead of throwing unexpectedly.
3. Keep upstream failure logging at the call sites if the two call paths need different context labels.
4. Replace both local implementations with the shared helper.

Risk controls:

- Do not conflate TVL history merging with price-series loading.
- Keep the helper narrow; it should not become a generic history orchestrator.

Validation:

- `npm test -- worker/src/api/__tests__/backfill-supply-history.test.ts worker/src/api/__tests__/stablecoin-detail-commodity.test.ts`
- `cd worker && npx tsc --noEmit`

Exit criteria:

- The two price-parsing blocks collapse into one helper.
- Backfill and detail behavior remain unchanged under existing tests.

### Packet 5 - Deduplicate CEX Ticker Reduction Logic

Refs:

- `R5`

Goal:

- Remove duplicate provider-row reduction logic in the CEX price collector without altering provider-specific fetch behavior.

Files:

- [`worker/src/lib/cex-tickers.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/cex-tickers.ts)

Implementation steps:

1. Extract a small reducer helper that:
   - iterates normalized rows
   - resolves symbol
   - computes midpoint-or-last
   - populates the result map
2. Keep provider-specific transport parsing outside the helper.
3. Apply the helper to Kraken and Bitstamp only in this packet.
4. Do not broaden the packet to Binance/Coinbase unless the extracted API fits cleanly with no shape bending.

Risk controls:

- The helper should encode the shared reduction pattern only, not a fake cross-provider schema.
- Preserve current warning and abort behavior per provider.

Validation:

- `npm test -- worker/src/lib/__tests__/cex-tickers.test.ts`
- `cd worker && npx tsc --noEmit`

Exit criteria:

- Kraken and Bitstamp share one reduction path.
- Provider-specific fetch/request behavior stays unchanged.

### Packet 6 - Add a Shared Reserve-Adapter Bucket Helper

Refs:

- `R4`

Goal:

- Remove duplicated bucket-to-slice assembly logic in the reserve adapters without over-generalizing the adapter layer.

Files:

- [`worker/src/cron/reserve-adapters/ethena.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/ethena.ts)
- [`worker/src/cron/reserve-adapters/falcon.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/falcon.ts)
- [`worker/src/cron/reserve-adapters/slice-math.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/slice-math.ts)

Implementation steps:

1. Add a helper that accepts:
   - bucket values
   - display labels
   - risk levels
   - the bucket that defines `immediateRedeemableUsd`
2. Keep adapter-specific parsing, bucket classification, and freshness metadata in the adapter files.
3. Migrate Ethena first.
4. Migrate Falcon second using the same helper.
5. Stop if the abstraction begins to encode adapter-specific exceptions; in that case, keep the helper limited to shared slice construction only.

Risk controls:

- Do not merge metadata policy between the adapters.
- Do not change bucket taxonomy or risk labels.
- Preserve warning semantics.

Validation:

- `npm test -- worker/src/cron/reserve-adapters/__tests__/ethena.test.ts worker/src/cron/reserve-adapters/__tests__/falcon.test.ts`
- `cd worker && npx tsc --noEmit`

Exit criteria:

- The repeated slice-construction pattern lives in one helper.
- Adapter-specific business logic remains readable in the adapter files.

### Packet 7 - Extract Shared Chart-Shell Hook

Refs:

- `R2`

Goal:

- Remove repeated animation/container shell logic across the four chart components without forcing a heavy wrapper component.

Files:

- [`src/components/psi-history-chart.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/psi-history-chart.tsx)
- [`src/components/total-mcap-chart.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/total-mcap-chart.tsx)
- [`src/components/non-usd-share-chart.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/non-usd-share-chart.tsx)
- [`src/components/peg-diversity-chart.tsx`](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/peg-diversity-chart.tsx)
- New helper target:
  - `src/hooks/use-chart-shell.ts` or similarly narrow hook file

Implementation steps:

1. Extract a hook for the shared shell concerns:
   - animation gating
   - animation-end handler
   - chart container readiness
   - width/height passthrough
2. Migrate one chart first, preferably `non-usd-share-chart.tsx`, because its shell is simple and representative.
3. If the API remains clean, migrate the other three charts.
4. If one chart diverges materially, stop at a smaller helper boundary rather than twisting all four into one abstraction.

Risk controls:

- Prefer a hook over a component wrapper to avoid overfitting card layout and tooltip structure.
- Do not change chart card markup, legend wording, or skeleton layout while extracting the shell.

Validation:

- `npm run build`
- `npm test -- src/components`

Exit criteria:

- Shared shell logic is centralized.
- The resulting hook API is small and obvious.
- No chart-specific rendering logic is forced into the shared helper.

### Packet 8 - Decompose Telegram Status Aggregation

Refs:

- `Q3`

Goal:

- Make Telegram bot status metrics easier to evolve and test without changing the status API contract.

Files:

- [`worker/src/lib/status/derived-data.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/status/derived-data.ts)
- New helper targets:
  - `worker/src/lib/status/telegram-bot-stats.ts`
  - or split helpers under `worker/src/lib/status/`
- Preferred new tests:
  - `worker/src/lib/__tests__/telegram-bot-stats.test.ts`

Implementation steps:

1. Split `getTelegramBotStats` into discrete pieces:
   - aggregate-query SQL constant
   - pending rows loaders
   - top-stablecoins loader
   - row coercion/mapping helpers
2. Keep the public return type unchanged.
3. Add focused tests around the new pure mapping helpers.
4. Keep the status endpoint tests as contract protection, not the only safety net.

Risk controls:

- Do not change the status response shape.
- Do not rewrite the SQL semantics while decomposing.
- If the SQL needs readability improvements, isolate them after helper extraction rather than mixing semantic changes with file movement.

Validation:

- `npm test -- worker/src/lib/__tests__/telegram-bot-stats.test.ts worker/src/api/__tests__/status.test.ts`
- `cd worker && npx tsc --noEmit`

Exit criteria:

- `getTelegramBotStats` becomes a thin orchestrator or is replaced by smaller helpers.
- Metric derivation is directly unit-testable.

### Packet 9 - Extract Shared GitHub Actions Setup Scaffolding

Refs:

- `S3`

Goal:

- Reduce YAML drift without changing release semantics.

Files:

- [` .github/workflows/validate-ci.yml `](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/validate-ci.yml)
- [` .github/workflows/pages-prepare.yml `](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/pages-prepare.yml)
- [` .github/workflows/pages-publish.yml `](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/pages-publish.yml)
- [` .github/workflows/deploy-cloudflare.yml `](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/deploy-cloudflare.yml)
- [` .github/workflows/pages-release.yml `](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/pages-release.yml)
- [` .github/workflows/rebuild-pages.yml `](/Users/ahirice/Documents/git/stablecoin-dashboard/.github/workflows/rebuild-pages.yml)
- New helper target:
  - prefer `.github/actions/setup-workspace/action.yml`
  - optionally a second smoke helper only if it removes real duplication cleanly

Implementation steps:

1. Extract the repeated Node/cache/npm-ci setup into a composite action.
2. Keep `actions/checkout` at the job level unless there is a clean reason to wrap it.
3. Adopt the composite action in one workflow first, preferably `validate-ci.yml`.
4. After the first adoption is stable, migrate the other workflows.
5. Do not change:
   - triggers
   - concurrency rules
   - environment wiring
   - smoke target URLs
   - deploy order

Risk controls:

- Keep this packet separate from all runtime code.
- Do not combine with docs or route refactors.
- Because the repo does not currently carry a dedicated GitHub Actions linter, require a dedicated PR and rely on CI validation before merge.

Validation:

- Local:
  - `npm run check:doc-sync` if docs are touched
  - `npm run test:merge-gate`
- PR/CI:
  - the changed workflows must execute successfully in GitHub Actions before merge

Exit criteria:

- Common setup steps live in one reusable unit.
- Workflow semantics are unchanged.
- No deployment path is merged without live CI confirmation.

### Packet 10 - Split Route Registration and Dependency Hydration by Domain

Refs:

- `S4`

Goal:

- Reduce the manual API assembly surface while preserving all route contracts.

Files:

- [`worker/src/route-registry.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/route-registry.ts)
- [`worker/src/router.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/router.ts)
- [`worker/src/handlers/http/context.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/http/context.ts)
- likely new modules under:
  - `worker/src/routes/`
  - `worker/src/handlers/http/`
- contract protection:
  - [`worker/src/api/__tests__/router-contract.test.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/router-contract.test.ts)
  - [`worker/src/__tests__/index.fetch.test.ts`](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/__tests__/index.fetch.test.ts)

Recommended design:

- Keep `route-registry.ts` as a composition root and compatibility facade.
- First extract route registry primitives and shared types into a small cycle-safe module so new domain route modules do not need to import `route-registry.ts`.
- Move route families into smaller arrays by domain.
- Move dependency hydrator definitions into a dedicated dependency module or grouped maps.
- Do not attempt code generation in the same packet.

Implementation steps:

1. Extract shared route types and route-definition helpers into a cycle-safe module first, for example under `worker/src/routes/`.
2. Update `worker/src/router.ts`, `worker/src/handlers/http/context.ts`, and any direct test imports to use the new shared module or compatibility re-exports without changing their runtime behavior.
3. Introduce domain route modules, for example:
   - public read routes
   - admin mutation routes
   - status/ops routes
   - messaging/telegram routes
4. Move `STATIC_ROUTES` population into those modules while preserving the existing exported types and helper APIs from `route-registry.ts`.
5. Split `ROUTE_DEPENDENCY_HYDRATORS` into a dedicated module or grouped maps that `context.ts` composes.
6. Keep `shared/lib/api-endpoints.ts` unchanged initially unless a moved module proves it needs a metadata cleanup.
7. Update architecture docs if the route module layout becomes materially different.

Risk controls:

- No route path, method, auth, or dependency semantics may change in this packet.
- Keep handler signatures unchanged.
- Avoid new circular imports between `route-registry.ts`, `router.ts`, `context.ts`, tests, and the new domain route modules.
- Preserve `route-registry.ts` re-exports until all current callers have a stable import path.
- Preserve the existing route and router contract tests as the source of truth.
- If a family split starts forcing handler rewrites, stop and split the packet further by domain.

Validation:

- `npm test -- worker/src/api/__tests__/router-contract.test.ts worker/src/__tests__/index.fetch.test.ts`
- `cd worker && npx tsc --noEmit`
- `npm run check:doc-sync` if docs change

Exit criteria:

- Route registration is distributed by domain.
- Dependency hydration is no longer one large hand-maintained object in `context.ts`.
- No new route module imports `route-registry.ts` for shared types/helpers in a way that reintroduces a cycle.
- All route contracts remain unchanged under tests.

## Cross-Packet Risk Controls

### Change-Slice Boundaries

- Do not combine `Q1` with `S4`.
- Do not combine `S3` with any runtime TypeScript changes.
- Do not combine `R2` with unrelated visual redesigns.
- Do not combine `R4` with reserve methodology changes.

### Documentation Rules

- If `Q1` changes observable idempotency failure semantics, update docs that mention `Idempotency-Key` support.
- If `S4` changes route module layout materially, update `docs/architecture.md`.
- For all Worker/API behavior changes, re-run `npm run check:doc-sync`.

### Validation Rules

For every packet:

1. Run packet-local targeted tests first.
2. Run the relevant build or Worker typecheck depending on touched files.
3. Before push, run `npm run test:merge-gate`.

For packets touching only docs:

- still run `npm run check:doc-sync`
- still run `npm run check:doc-counts` if count-bearing docs changed

For packets touching CI workflows:

- require live GitHub Actions validation before merge

## Success Criteria

The remediation program is complete when all of the following are true:

- All 13 findings from the 2026-04-05 audit are closed or explicitly superseded by merged changes.
- `npm run check:doc-counts` is green again.
- High-risk admin idempotency behavior is deterministic under tests.
- Worker ingress branch behavior has direct tests.
- The duplicated UI and Worker helper islands are consolidated without contract drift.
- Workflow reuse and route decomposition land without changing deploy or API behavior.
- `npm run test:merge-gate` passes on the final branch.

## Recommended PR / Branch Strategy

Use one PR per packet.

Recommended PR titles:

1. `docs: restore audit source-of-truth counts and validate contract wording`
2. `test(worker): pin request ingress and attribution branches`
3. `fix(worker): harden admin idempotency failure handling`
4. `refactor(ui): dedupe status metric tiles and null currency wrappers`
5. `refactor(worker): share commodity price-series loader`
6. `refactor(worker): dedupe Kraken and Bitstamp ticker reducers`
7. `refactor(worker): extract reserve-adapter bucket assembly helper`
8. `refactor(ui): share chart-shell animation and sizing hook`
9. `refactor(worker): split Telegram status aggregation helpers`
10. `ci: extract shared workflow setup scaffolding`
11. `refactor(worker): split route registration and dependency hydration by domain`

This ordering minimizes execution risk and keeps each review focused on one class of change.
