# Full Codebase Audit Remediation Plan

Date: 2026-04-07
Repo: `/Users/ahirice/Documents/git/stablecoin-dashboard`
Source audit: `agents/audits/2026-04-07-full-codebase-audit.md`

## Goal

Turn all 17 audit findings into an execution-ready remediation program that can be implemented incrementally without losing verification discipline or destabilizing production behavior.

This plan covers:

1. every audit finding (`R-001` to `SUS-06`)
2. the cross-cutting concerns that connect those findings
3. the execution opportunities surfaced while touching the same code
4. the sequencing, validation, and rollout rules needed to land the work safely

This is a planning artifact only. It does not assume all work lands in one branch or one PR.

## Operating Principles

1. Keep behavior-preserving refactors separate from behavior changes whenever possible.
2. Do not grow hotspot files while remediating them. If a tranche needs temporary compatibility code, put it in new helper modules rather than expanding the hotspot.
3. Keep worker/admin refactors, frontend route refactors, and doc/runtime lane fixes in separate delivery tracks unless a finding explicitly requires them to land together.
4. Use the repo’s existing guardrails as tranche gates, not just end-of-program gates.
5. Update docs in the same tranche as any runtime/config behavior change.
6. Do not rebaseline hotspot budgets unless a tranche demonstrably improves structure and the baseline notes are updated to reflect the new target.

## Constraints and Observations

- The repo is already heavily validated. The remediation program should preserve that advantage rather than bypass it.
- The current audit baseline passed:
  - `npm run audit:deps`
  - `npm run lint`
  - `npm run typecheck`
  - `cd worker && npx tsc --noEmit`
  - `npm run build`
  - `npm test`
  - `npm run check:worker-boundary`
  - `npm run check:shared-cycles`
  - `npm run check:duplicate-exports`
  - `npm run check:unused-code`
  - `npm run check:migrations`
  - `npm run check:cron-sync`
  - `npm run check:cron-connections`
  - `npm run check:doc-sync`
  - `npm run check:verified-doc-links`
  - `npm run check:env-contract`
  - `npm run check:sql-safety`
  - `npm run audit:pricing-providers`
- The audit also found local install drift via `npm ls`, so dependency work should start from a clean install state rather than trusting the current `node_modules`.
- The audit run left an untracked `.tmp-jscpd/` directory. Remove or ignore it before starting remediation to keep review noise down.

## Findings-to-Workstream Map

### Workstream A — Worker Admin Surface and Response Infrastructure

Findings:
- `R-001` Overlapping admin route scaffolding
- `R-002` Duplicated response builder utilities
- `SUS-02` Route dependency hydration typed too broadly
- cross-cutting concern `C-001`

Primary files:
- `worker/src/lib/route-wrappers.ts`
- `worker/src/lib/admin-job.ts`
- `worker/src/lib/api-response.ts`
- `worker/src/routes/shared.ts`
- `worker/src/routes/dependency-hydrators.ts`
- `worker/src/handlers/http/context.ts`
- privileged handlers under `worker/src/api/`

### Workstream B — Worker Correctness Quick Wins

Findings:
- `R-005` Exact duplicate day parsing
- `QA-001` N+1 D1 query in resolved depeg alerts
- `QA-002` Freshness lookup silently masks D1 failures

Primary files:
- `worker/src/api/backfill-depegs-window.ts`
- `worker/src/api/backfill-stability-index.ts`
- `worker/src/cron/dispatch-telegram-alerts.ts`
- `worker/src/lib/api-freshness.ts`
- `worker/src/api/yield-history.ts`
- `worker/src/api/mint-burn-flows.ts`

### Workstream C — Frontend Route Efficiency and UI Test Coverage

Findings:
- `QA-004` Chain route recomputes the same dataset three times
- `QA-005` No direct tests for yield detail UI
- partial `SUS-01` hotspot reduction on route clients
- cross-cutting concern `C-004`

Primary files:
- `src/hooks/use-chains.ts`
- `src/app/chains/[chain]/client.tsx`
- `src/components/yield-detail-section.tsx`
- new tests under `src/components/__tests__/` and `src/app/chains/[chain]/`

### Workstream D — Yield Ingestion and Publication Decomposition

Findings:
- `R-004` Repeated optional yield adapter skeletons
- `QA-003` Yield publication coordinator too large
- `SUS-01` hotspot backlog for yield files
- cross-cutting concern `C-002`

Primary files:
- `worker/src/cron/yield-sync/sources-optional-protocols.ts`
- `worker/src/cron/sync-yield-data.ts`
- adjacent yield helpers and tests

### Workstream E — DEX Liquidity Fetch Architecture and Cron Capacity

Findings:
- `R-003` Structural clones in provider fetchers
- `SUS-05` cron trigger budgets already near ceiling
- `SUS-01` hotspot backlog for DEX worker files
- cross-cutting concern `C-003`

Primary files:
- `worker/src/cron/dex-liquidity/fetch-primary.ts`
- `shared/lib/cron-jobs.ts`
- scheduled handler docs / limits docs
- relevant DEX tests

### Workstream F — Runtime Lane Integrity, Docs, and Operational Parity

Findings:
- `R-006` repair scripts duplicate worker backfill logic
- `SUS-03` site-data proxy silently falls back to public API
- `SUS-04` docs lag current runtime reality
- `SUS-06` dependency refresh cadence drifting
- cross-cutting concern `C-005`

Primary files:
- `scripts/fix-commodity-depeg-median.ts`
- `scripts/fix-non-usd-depeg-fx.ts`
- `worker/src/api/backfill-fx.ts`
- `functions/lib/site-api-env.ts`
- `functions/_site-data/[[path]].ts`
- `docs/architecture.md`
- `docs/api-reference.md`
- `README.md`
- `package.json`
- `worker/package.json`
- `package-lock.json`

## Recommended Execution Model

Run the remediation in 7 tranches across 3 waves.

### Wave 0 — Baseline and Prep

Tranche 0 prepares the workspace and captures a stable baseline.

### Wave 1 — Quick Wins and Low-Risk Hardening

Parallelizable after Wave 0:
- Tranche 1: Worker correctness quick wins
- Tranche 2: Frontend route efficiency + direct UI tests
- Tranche 3: Docs/runtime lane cleanup

These tranches have low conceptual coupling and provide immediate value.

### Wave 2 — Foundation Refactors

After Wave 1:
- Tranche 4: Admin surface unification
- Tranche 5: Route dependency typing cleanup

These should land before deeper worker subsystem decompositions so the lower layers stabilize first.

### Wave 3 — Large Structural Decompositions

After Wave 2:
- Tranche 6: Yield subsystem decomposition
- Tranche 7: DEX-liquidity subsystem decomposition
- Ongoing program: hotspot reduction and dependency refresh cadence

These are the most invasive changes and should be isolated with strong regression coverage.

## Tranche-by-Tranche Plan

## Tranche 0 — Baseline, Hygiene, and Execution Setup

### Objectives

- start from a clean reproducible environment
- capture a before-state for validation and hotspot budgets
- make later tranche failures attributable

### Tasks

1. Clean local noise:
   - remove or ignore `.tmp-jscpd/`
2. Sync dependencies to the checked-in manifests:
   - root: `npm install` or `npm ci`
   - worker workspace: confirm the workspace install is aligned
3. Re-run baseline validation:

```bash
npm run audit:deps
npm run lint
npm run typecheck
cd worker && npx tsc --noEmit
npm run build
npm test
npm run check:worker-boundary
npm run check:shared-cycles
npm run check:duplicate-exports
npm run check:unused-code
npm run check:migrations
npm run check:cron-sync
npm run check:cron-connections
npm run check:doc-sync
npm run check:verified-doc-links
npm run check:env-contract
npm run check:sql-safety
npm run audit:pricing-providers
```

4. Record whether `npm run check:hotspot-ratchet` still fails after local WIP settles.
5. Create a lightweight tracking board:
   - tranche
   - finding IDs
   - owner
   - branch
   - validation status
   - docs updated yes/no

### Exit Criteria

- clean install state
- repeatable green baseline except for any explicitly documented pre-existing hotspot issue

## Tranche 1 — Worker Correctness Quick Wins

Findings:
- `R-005`
- `QA-001`
- `QA-002`

### Why First

These are small, high-confidence fixes with immediate payoff and low merge risk.

### Implementation

#### 1A. Deduplicate day parsing (`R-005`)

Files:
- `worker/src/api/backfill-depegs-window.ts`
- `worker/src/api/backfill-stability-index.ts`

Steps:
1. Export and reuse `parseDayParam` from `backfill-depegs-window.ts`.
2. Remove the local duplicate in `backfill-stability-index.ts`.
3. If there are similar day-window parsers elsewhere, inspect but only fold them in if they are exact semantic matches.

Validation:
- focused tests for backfill window parsing if missing
- `npm test -- worker/src/api/__tests__/backfill-stability-index.test.ts worker/src/api/__tests__/backfill-depegs.test.ts`
- `cd worker && npx tsc --noEmit`

Execution opportunity:
- If any other admin backfill route uses `startDay` / `endDay` semantics, consider consolidating on the same helper now, but do not widen scope into unrelated query parsing.

#### 1B. Batch resolved-depeg lookup (`QA-001`)

Files:
- `worker/src/cron/dispatch-telegram-alerts.ts`
- corresponding tests in `worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`

Steps:
1. Replace the per-coin latest-resolved query with one batched lookup for all candidate IDs.
2. Preserve current behavior for symbol fallback, duration math, and recovery-price fallback order.
3. Keep abort handling in place.

Validation:
- extend tests to cover more than one resolved depeg in one pass
- `npm test -- worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts`

Execution opportunity:
- While in this file, add a query-shape comment or helper naming that makes the “current active -> latest resolved” transition obvious to future readers.

#### 1C. Stop masking freshness failures as fresh (`QA-002`)

Files:
- `worker/src/lib/api-freshness.ts`
- `worker/src/api/yield-history.ts`
- `worker/src/api/mint-burn-flows.ts`
- relevant API tests

Steps:
1. Change `getLatestSuccessfulCronTimestamp` to return a richer result than a raw number:
   - timestamp
   - source: `ok` / `missing` / `lookup_failed`
2. Update callers to emit degraded or warning metadata instead of treating failures as current time.
3. Preserve non-blocking endpoint behavior unless product requirements say the endpoint should fail closed.

Validation:
- add tests for the lookup-failure path
- `npm test -- worker/src/lib/__tests__/api-freshness.test.ts worker/src/api/__tests__/yield-history.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts`

Execution opportunity:
- If any other endpoint relies on the same freshness contract, migrate it now only if it uses this helper directly.

### Tranche Exit Criteria

- no duplicated `parseDayParam`
- no per-coin resolved-depeg lookup loop
- freshness lookup failures are observable, not silently treated as fresh

## Tranche 2 — Frontend Route Efficiency and Direct UI Tests

Findings:
- `QA-004`
- `QA-005`
- partial `SUS-01` reduction for `src/app/chains/[chain]/client.tsx`

### Why Here

This is a low-risk frontend tranche that yields performance and coverage gains without touching worker architecture.

### Implementation

#### 2A. Build a chain route view model (`QA-004`)

Files:
- `src/hooks/use-chains.ts`
- `src/app/chains/[chain]/client.tsx`
- related tests

Steps:
1. Extract a route-level view model that computes:
   - `coins`
   - `totalUsd`
   - backing totals
   - composition layout inputs
2. Feed this single model into:
   - `CompositionSection`
   - backing breakdown section
   - stablecoin table
3. Keep rendering structure stable. This should be a derivation refactor, not a UI redesign.

Validation:
- add/update route-client tests
- `npm test -- src/app/chains/[chain]/client.test.tsx src/hooks/__tests__/use-chains.test.tsx`
- `npm run build`

Execution opportunity:
- If the new view model meaningfully shrinks `src/app/chains/[chain]/client.tsx`, update the hotspot backlog notes for that file.

#### 2B. Add direct tests for `YieldDetailSection` (`QA-005`)

Files:
- `src/components/yield-detail-section.tsx`
- new tests in `src/components/__tests__/`

Steps:
1. Cover loading state for yield-bearing assets.
2. Cover error state with no ranking.
3. Cover “should have data but not available yet”.
4. Cover alternative-source selection and URL persistence semantics.
5. Cover chart/source prop selection logic.

Validation:
- run the new focused test file
- run existing adjacent tests:
  - `src/components/__tests__/yield-table-logic.test.ts`
  - `src/components/__tests__/yield-source-sheet.test.tsx`

Execution opportunity:
- If the component is still hard to test because of local state shape, extract one or two pure helpers rather than broad restructuring.

### Tranche Exit Criteria

- chain route derives its main coin model once
- `YieldDetailSection` has direct regression coverage
- no measurable route-level logic duplication remains across the three chain sections

## Tranche 3 — Runtime Lane Integrity and Docs

Findings:
- `SUS-03`
- `SUS-04`
- part of cross-cutting concern `C-005`

### Why Here

The runtime/config fix and the docs correction should land together so the code and docs stop describing different architectures.

### Implementation

#### 3A. Require dedicated site-data origin in production (`SUS-03`)

Files:
- `functions/lib/site-api-env.ts`
- `functions/_site-data/[[path]].ts`
- related tests or env checks

Steps:
1. Split environment behavior into:
   - local/dev fallback allowed
   - production fallback disallowed
2. Make production Pages env validation fail closed when `SITE_API_ORIGIN` is missing.
3. Preserve telemetry labeling so `public-api-fallback` is still visible where fallback is intentionally allowed outside production.

Validation:
- add or update env validation tests
- `npm run check:env-contract`
- `npm run build`

Execution opportunity:
- If the Pages proxy lacks a precise test around fallback-vs-fail-closed behavior, add one now.

#### 3B. Update architecture and API docs (`SUS-04`)

Files:
- `docs/architecture.md`
- `docs/api-reference.md`
- `README.md`

Steps:
1. Replace references to `shared/lib/api-endpoints.ts` with the folderized `shared/lib/api-endpoints/` module surface.
2. Update `site-api` lane descriptions to reflect the live configured topology.
3. Keep docs exact enough to satisfy `check:verified-doc-links` and `check:doc-sync`.

Validation:
- `npm run check:verified-doc-links`
- `npm run check:doc-sync`

Execution opportunity:
- Add a short architecture note clarifying which hosts are external/public, site-internal, and ops-only. This will pay off in future auth and proxy work.

### Tranche Exit Criteria

- production Pages config no longer silently falls back to public API
- docs accurately describe current route metadata location and lane topology

## Tranche 4 — Admin Surface Unification

Findings:
- `R-001`
- `R-002`
- cross-cutting concern `C-001`

### Why Before Typed Context Cleanup

It is easier to tighten route dependency typing once the privileged handler shapes are more uniform.

### Implementation

#### 4A. Consolidate response helpers (`R-002`)

Files:
- `worker/src/lib/api-response.ts`
- `worker/src/api/api-keys.ts`
- `worker/src/api/admin-actions.ts`
- `worker/src/lib/rate-limit.ts`
- `worker/src/lib/api-key-rate-limit.ts`

Steps:
1. Extend shared response helpers to support:
   - status override
   - `Cache-Control: no-store`
   - `Retry-After`
2. Delete local response helper duplicates.
3. Keep public API behavior unchanged.

Validation:
- relevant unit tests for response shape
- `npm test -- worker/src/api/__tests__/api-keys.test.ts worker/src/lib/__tests__/rate-limit.test.ts`

#### 4B. Standardize admin route entry (`R-001`)

Files:
- `worker/src/lib/route-wrappers.ts`
- `worker/src/lib/admin-job.ts`
- admin handlers listed in the audit

Steps:
1. Choose the target privileged route pattern:
   - one route shell for auth + error handling
   - one admin-job helper for query/body parsing and dry-run handling
2. Migrate handlers incrementally:
   - status/status-history/request-source-stats
   - api-keys family
   - backfill/admin-action family
3. Keep genuinely unusual handlers out of the abstraction only if they truly need different behavior.

Validation:
- focused handler tests for migrated endpoints
- `npm test -- worker/src/api/__tests__/status.test.ts worker/src/api/__tests__/api-keys.test.ts worker/src/api/__tests__/request-source-stats.test.ts`
- `cd worker && npx tsc --noEmit`

Execution opportunities:
- standardize no-store behavior across admin GETs
- standardize parse errors and dry-run summary envelopes
- add comments documenting the chosen privileged-handler contract

### Tranche Exit Criteria

- no remaining unjustified duplicate admin wrapper patterns
- shared response semantics used consistently across privileged handlers

## Tranche 5 — Route Dependency Typing Tightening

Findings:
- `SUS-02`
- remainder of cross-cutting concern `C-001`

### Why Here

This tranche benefits from the admin surface being more consistent first.

### Implementation

Files:
- `worker/src/routes/shared.ts`
- `worker/src/routes/dependency-hydrators.ts`
- `worker/src/handlers/http/context.ts`
- static route definitions and handlers as needed
- `shared/lib/api-endpoints/definitions.ts`

Steps:
1. Replace the broad optional field-bag model with a more precise route-context strategy. Acceptable implementations:
   - dependency-keyed generic context types
   - per-route context factory types
   - typed builder helpers that narrow context before handler invocation
2. Ensure route definitions continue to declare dependencies in one source of truth.
3. Make missing required dependencies a compile-time problem where practical.

Validation:
- `cd worker && npx tsc --noEmit`
- route contract tests
- `npm test -- worker/src/api/__tests__/router-contract.test.ts`

Execution opportunity:
- While touching route definitions, make sure endpoint metadata comments and type names clearly distinguish shared metadata from worker-only hydration concerns.

### Tranche Exit Criteria

- route handlers no longer rely on wide optional context bags for required dependencies
- route dependency requirements are tighter and easier to reason about at compile time

## Tranche 6 — Yield Subsystem Decomposition

Findings:
- `R-004`
- `QA-003`
- yield-related `SUS-01`
- cross-cutting concern `C-002`

### Why Isolated

This is a large, behavior-sensitive subsystem with both worker and UI implications. It should land in dedicated branches/PRs.

### Implementation

#### 6A. Build an adapter harness for optional protocols (`R-004`)

Files:
- `worker/src/cron/yield-sync/sources-optional-protocols.ts`
- new helper modules under `worker/src/cron/yield-sync/`

Steps:
1. Identify the repeated phases across adapters:
   - fetch with timeout/budget
   - response shape validation
   - source-specific extraction
   - normalization to `ResolvedYield` or candidate shape
   - abort/error logging policy
2. Extract these into a shared adapter harness.
3. Reduce each protocol implementation to a small parser/mapper.

Validation:
- retain or extend source-specific tests
- add harness-level tests for abort and error behavior
- `npm test -- worker/src/cron/__tests__/yield-*.test.ts worker/src/cron/__tests__/sync-yield-data.test.ts`

#### 6B. Split the yield publication coordinator (`QA-003`)

Files:
- `worker/src/cron/sync-yield-data.ts`
- adjacent yield helpers

Steps:
1. Split into explicit phases:
   - state load
   - source resolution
   - history/context load
   - evaluation/policy decisions
   - publishability preflight
   - persistence/cache write
   - cleanup/pruning
   - metadata synthesis
2. Preserve current degraded behavior and coverage guards.
3. Do not mix this with methodology changes. This is a structural refactor.

Validation:
- full yield test surface
- `npm test -- worker/src/cron/__tests__/sync-yield-data.test.ts worker/src/cron/__tests__/yield-resolve.test.ts`
- `cd worker && npx tsc --noEmit`

Execution opportunities:
- add small internal phase metrics/log labels if they improve observability without changing external behavior
- reduce hotspot size for both `sync-yield-data.ts` and `sources-optional-protocols.ts`

### Tranche Exit Criteria

- optional yield adapters use shared plumbing
- `sync-yield-data.ts` is no longer the single owner of all publication phases
- hotspot notes for yield files can be tightened or partially retired

## Tranche 7 — DEX Liquidity Decomposition and Capacity Governance

Findings:
- `R-003`
- `SUS-05`
- DEX-related `SUS-01`
- cross-cutting concern `C-003`

### Why Last

This is high-risk worker infrastructure and is already coupled to connection budgets and provider diversity. It should only start once the admin and yield foundations are stable.

### Implementation

#### 7A. Introduce provider-family runners (`R-003`)

Files:
- `worker/src/cron/dex-liquidity/fetch-primary.ts`
- new helper modules under `worker/src/cron/dex-liquidity/`

Steps:
1. Extract a shared subgraph fetch runner for sources like Uni V3 and Aerodrome.
2. Extract a shared token-batch runner for sources like GeckoTerminal and CoinGecko.
3. Keep provider-specific mapping logic small and data-driven.
4. Preserve current per-provider logging and non-fatal error policy.

Validation:
- DEX-liquidity test surface
- `npm test -- worker/src/cron/__tests__/sync-dex-liquidity.test.ts worker/src/api/__tests__/dex-liquidity.test.ts`

#### 7B. Formalize cron-capacity guardrails (`SUS-05`)

Files:
- `shared/lib/cron-jobs.ts`
- scheduled handler docs
- `docs/worker-and-api-limits.md`
- possibly scripts/check-cron-connection-budget.ts if policy needs strengthening

Steps:
1. Add a design rule for new network-heavy jobs:
   - must declare expected connection use
   - must choose a lane intentionally
   - must declare time budget and degradation behavior
2. If worthwhile, extend the connection-budget checker or cron metadata to track these decisions more explicitly.

Validation:
- `npm run check:cron-connections`
- `npm run check:cron-sync`
- docs verification

Execution opportunities:
- If `fetch-primary.ts` shrinks materially, update the hotspot waiver note for that file.
- Add a short maintainer checklist for new cron jobs in docs or comments.

### Tranche Exit Criteria

- provider fetch duplication is materially reduced
- DEX-liquidity fetch architecture is easier to extend
- cron capacity is treated as an explicit design constraint, not tribal knowledge

## Ongoing Program — Hotspot Reduction and Dependency Cadence

Findings:
- `SUS-01`
- `SUS-06`

These are not one-time patches. They require ongoing operating rules.

### Hotspot Program (`SUS-01`)

Actions:
1. Maintain a quarterly or per-major-feature hotspot review.
2. For each queued/deferred hotspot, define:
   - owner
   - target budget
   - next planned tranche
   - “do not grow further” rule
3. When touching a waived hotspot, require one of:
   - net line-count reduction
   - function count reduction
   - extraction of at least one coherent helper/module
4. Only update hotspot baselines when a tranche actually improves the structure.

Priority hotspot order:
1. `worker/src/cron/sync-yield-data.ts`
2. `worker/src/cron/yield-sync/sources-optional-protocols.ts`
3. `worker/src/cron/dex-liquidity/fetch-primary.ts`
4. `src/app/chains/[chain]/client.tsx`
5. `src/components/contagion-graph.tsx`
6. methodology section hotspots

### Dependency Cadence (`SUS-06`)

Actions:
1. Adopt a light dependency refresh cadence:
   - monthly small-batch updates for root frontend/tooling packages
   - monthly small-batch updates for worker tooling/runtime packages
2. Keep lockstep sets together:
   - `next` + `eslint-config-next`
   - `vitest` + `@vitest/coverage-v8`
   - `wrangler` + `@cloudflare/workers-types`
3. Use clean install state before evaluating drift.
4. Treat dependency refresh as a maintenance lane, not an opportunistic add-on to refactor PRs.

Validation:

```bash
npm outdated
npm ls --depth=0
npm run audit:deps
npm run lint
npm run typecheck
npm test
cd worker && npx tsc --noEmit
```

## Parallelization Guidance

Safe parallel combinations after Tranche 0:

- Tranche 1 and Tranche 2
- Tranche 2 and Tranche 3

Safe parallel combinations after Wave 1:

- Tranche 4 and dependency-cadence housekeeping

Do not parallelize:

- Tranche 4 and Tranche 5 if they touch the same route handler signatures
- Tranche 6 and Tranche 7 if both need the same worker reviewer bandwidth or if they both modify shared cron/helper contracts

Suggested file ownership split:

- Worker admin/routing owner: `worker/src/lib/**`, `worker/src/routes/**`, admin handlers
- Frontend owner: `src/app/chains/**`, `src/hooks/use-chains.ts`, `src/components/yield-detail-section.tsx`
- Yield worker owner: `worker/src/cron/yield-sync/**`, `worker/src/cron/sync-yield-data.ts`
- DEX worker owner: `worker/src/cron/dex-liquidity/**`, `shared/lib/cron-jobs.ts`
- Docs/runtime/config owner: `functions/**`, `docs/**`, `README.md`, package manifests

## Validation Matrix by Tranche

### Minimum per-tranche validation

#### Tranche 1

```bash
npm test -- worker/src/api/__tests__/backfill-stability-index.test.ts worker/src/api/__tests__/backfill-depegs.test.ts worker/src/cron/__tests__/dispatch-telegram-alerts.test.ts worker/src/api/__tests__/yield-history.test.ts worker/src/api/__tests__/mint-burn-flows.test.ts
cd worker && npx tsc --noEmit
```

#### Tranche 2

```bash
npm test -- src/app/chains/[chain]/client.test.tsx src/hooks/__tests__/use-chains.test.tsx src/components/__tests__/yield-detail-section.test.tsx
npm run build
```

#### Tranche 3

```bash
npm run check:env-contract
npm run check:verified-doc-links
npm run check:doc-sync
npm run build
```

#### Tranche 4

```bash
npm test -- worker/src/api/__tests__/status.test.ts worker/src/api/__tests__/api-keys.test.ts worker/src/api/__tests__/request-source-stats.test.ts
cd worker && npx tsc --noEmit
```

#### Tranche 5

```bash
cd worker && npx tsc --noEmit
npm test -- worker/src/api/__tests__/router-contract.test.ts
```

#### Tranche 6

```bash
npm test -- worker/src/cron/__tests__/sync-yield-data.test.ts worker/src/cron/__tests__/yield-resolve.test.ts
cd worker && npx tsc --noEmit
```

#### Tranche 7

```bash
npm test -- worker/src/cron/__tests__/sync-dex-liquidity.test.ts worker/src/api/__tests__/dex-liquidity.test.ts
npm run check:cron-connections
npm run check:cron-sync
```

### Full-suite gates before merging any wave

```bash
npm run audit:deps
npm run lint
npm run typecheck
cd worker && npx tsc --noEmit
npm run build
npm test
npm run check:worker-boundary
npm run check:shared-cycles
npm run check:duplicate-exports
npm run check:unused-code
npm run check:migrations
npm run check:cron-sync
npm run check:cron-connections
npm run check:doc-sync
npm run check:verified-doc-links
npm run check:env-contract
npm run check:sql-safety
npm run audit:pricing-providers
npm run test:merge-gate
```

## Completion Criteria

The remediation program is complete when all of the following are true:

1. every finding in `agents/audits/2026-04-07-full-codebase-audit.md` has been closed or explicitly deferred with a fresh, justified note
2. the worker admin surface uses a single coherent privileged-handler pattern
3. route dependency requirements are tighter than the current optional `FullRouteContext`
4. yield and DEX hotspots are materially decomposed instead of merely re-waived
5. the Pages site-data lane fails safely in production and docs describe the live architecture accurately
6. chain-route duplicate derivation and missing yield-detail UI coverage are resolved
7. repair scripts stop reimplementing worker backfill logic in drift-prone ways
8. a recurring hotspot/dependency maintenance cadence exists instead of a one-off cleanup

## Recommended Starting Tranche

Start with Tranche 1 and Tranche 2 in parallel.

Reason:
- they are high-value and low-risk
- they reduce open findings immediately
- they improve correctness and coverage before larger worker refactors
- they avoid premature coupling to the deeper admin/yield/DEX architecture work

If only one tranche should begin first, start with Tranche 1.
