# Remaining Remediation Implementation Plan

Date: 2026-04-07
Repo: `/Users/ahirice/Documents/git/stablecoin-dashboard`
Inputs:
- `agents/audits/2026-04-07-full-codebase-audit.md`
- `agents/plans/2026-04-07-full-codebase-audit-remediation-plan.md`
- current `main` after the landed Tranche 1-4 work

## Purpose

This document turns the remaining audit findings into a low-risk execution program.

It is narrower than the original remediation plan in one way:
- it only covers findings that remain open after the completed Tranche 1-4 work

It is deeper than the original remediation plan in three ways:
- it spells out the exact module seams to use
- it adds pre-refactor test and validation requirements
- it defines rollback boundaries so the larger worker refactors stay shippable

## Completed vs Remaining

Completed already:
- `R-001`, `R-002`, `R-005`
- `QA-001`, `QA-002`, `QA-004`, `QA-005`
- `SUS-03`, `SUS-04`

Remaining:
- `R-003` Structural clones in DEX-liquidity provider fetchers
- `R-004` Repeated optional yield adapter skeletons
- `R-006` Repair scripts reimplement worker backfill logic
- `QA-003` Yield publication coordinator still does too much
- `SUS-01` Hotspot backlog is still large and persistent
- `SUS-02` Route dependency hydration is typed broadly, not precisely
- `SUS-05` Cron trigger budgets are already near the connection ceiling
- `SUS-06` Dependency refresh cadence is drifting

## Current Repo Facts That Matter

### Route typing surface

The remaining route-typing work is smaller than it first appears.

- `shared/lib/api-endpoints/definitions.ts` currently declares route dependency hints on 12 static endpoint definitions.
- The active dependency shapes are limited to:
  - `["coingeckoApiKey"]`
  - `["mintBurnFreshnessConfig"]`
  - `["feedbackEnv"]`
  - `["telegram"]`
  - `["coingeckoApiKey", "cloudflareD1StatusConfig"]`
  - `["apiKeyHashPepper"]`
  - `["anthropicApiKey", "telegram"]`
  - `["chainRpcs"]`
  - `["alchemyApiKey"]`
- Dynamic routes still carry their own dependency declarations in `worker/src/routes/dynamic-routes.ts`.
- `worker/src/routes/shared.ts` still exposes `FullRouteContext` as a wide optional bag, and `worker/src/handlers/http/context.ts` builds that bag eagerly.

This is favorable for a low-risk typed migration because the dependency combinations are few and already centralized.

### Yield subsystem

- `worker/src/cron/yield-sync/sources-optional-protocols.ts` exports 8 optional source families:
  - `fetchBprotocolLqtyOnlySource`
  - `fetchBimaSusbdSource`
  - `fetchHashnoteUsycSource`
  - `fetchOndoUsdyOracleSource`
  - `fetchMorphoVaultSources`
  - `fetchPendleMarketSources`
  - `fetchYearnKongSources`
  - `fetchBeefySources`
- `worker/src/cron/yield-sync/resolve-tracked-sources.ts` still owns protocol-specific branches for tracked special cases.
- `worker/src/cron/sync-yield-data.ts` is already partially decomposed, but the entrypoint still owns:
  - state loading
  - history loading and reshaping
  - on-chain health-state transitions
  - coverage and publish guards
  - persistence and cleanup policy
  - final cron metadata assembly
- Source-specific tests already exist for most optional families and for the overall yield sync.

This means the safest plan is not a rewrite. It is a staged registry extraction plus coordinator phase extraction.

### DEX-liquidity subsystem

- `worker/src/cron/dex-liquidity/orchestrator.ts` is already phase-oriented.
- `worker/src/cron/dex-liquidity/orchestrator-phases.ts` already handles:
  - direct API fetch orchestration
  - subgraph enrichment orchestration
  - fallback crawler orchestration
- `worker/src/cron/dex-liquidity/fetch-primary.ts` still concentrates 7 major exported stages:
  - `fetchDataSources`
  - `buildCurveLookups`
  - `fetchUniV3Data`
  - `fetchAerodromeData`
  - `buildKnownPoolAddresses`
  - `fetchGtTokenBatch`
  - `fetchCgTokenBatchPrices`
- The scheduler still budgets `sync-dex-liquidity` at `4/6` connections on the shared `halfHourlyOffset` lane via `shared/lib/cron-jobs.ts`.

This is favorable because the orchestration seam already exists; the risk is mainly in extracting source-family runners without changing budget semantics.

### Dependency health

Current package signals:
- `npm audit --omit=dev` is clean
- `npm ls --depth=0 --json` still reports extraneous packages in `node_modules`
- `npm outdated` currently shows mostly patch/minor drift:
  - `@cloudflare/workers-types` `4.20260403.1 -> 4.20260405.1`
  - `@tanstack/react-query` `5.96.1 -> 5.96.2`
  - `@types/node` `25.5.0 -> 25.5.2`
  - `@vitest/coverage-v8` `4.1.2 -> 4.1.3`
  - `jsdom` `29.0.1 -> 29.0.2`
  - `viem` `2.47.6 -> 2.47.10`
  - `vitest` `4.1.2 -> 4.1.3`
  - `wrangler` `4.80.0 -> 4.81.0`
- Major candidates also exist:
  - `eslint` `9.39.4 -> 10.2.0`
  - `typescript` `5.9.3 -> 6.0.2`

This strongly argues for a bounded patch/minor tranche now, with a separate compatibility spike for majors.

## Operating Rules For The Remaining Program

1. Treat every remaining phase as a behavior-preserving refactor unless the phase explicitly says otherwise.
2. Do not mix yield and DEX structural refactors in the same PR. They hit the same worker runtime, test surface, and hotspot program.
3. Add tests before large moves, not after. The remaining risk is regression during extraction, not lack of ideas.
4. Keep `fetch-primary.ts` and `sync-yield-data.ts` as facades during migration. Reduce them gradually; do not delete the entry modules mid-phase.
5. Do not rebaseline hotspot budgets early. Only update baseline or waiver metadata after the code actually gets smaller or simpler.
6. Do not raise any cron connection budgets to “make room” for refactors. If a refactor requires more concurrent fetches, the design is wrong.
7. Respect the worker/shared boundary. `scripts/` should not start importing `worker/src/*`.

## Recommended Execution Order

### Phase 5

- `P5A` Route dependency typing hardening (`SUS-02`)
- `P5B` Repair-script/runtime convergence (`R-006`)
- `P5C` Dependency hygiene and cadence (`SUS-06`)

Rationale:
- these are medium-risk and mostly orthogonal
- they reduce baseline friction before the large cron refactors

### Phase 6

- `P6` Yield subsystem decomposition (`R-004`, `QA-003`, part of `SUS-01`)

Rationale:
- yield already has helper seams, strong tests, and a dedicated trigger
- it is the cleaner of the two large worker decompositions

### Phase 7

- `P7` DEX-liquidity fetch-family decomposition (`R-003`, `SUS-05`, part of `SUS-01`)

Rationale:
- this is the most runtime-sensitive worker refactor
- it should land after the yield lane proves the extraction pattern

### Phase 8

- `P8` Managed hotspot reduction follow-on (`SUS-01`)

Rationale:
- this should consume the lessons from P6 and P7
- some hotspot targets are now frontend-only and can move independently once the worker hotspots are reduced

## P5A - Route Dependency Typing Hardening

Findings:
- `SUS-02`
- closes the remaining type-safety part of `C-001`

### Objective

Keep runtime behavior unchanged while making route dependency requirements explicit at compile time.

The key rule for this phase:
- dependency fields become guaranteed-to-exist properties when declared by the route
- the values themselves may still be nullable or optional if the environment contract allows that

Example:
- `coingeckoApiKey` should become “property definitely present, value may be `string | null`”
- not “property definitely present and definitely non-null”

### Scope

Primary files:
- `shared/lib/api-endpoints/definitions.ts`
- `worker/src/routes/shared.ts`
- `worker/src/routes/dependency-hydrators.ts`
- `worker/src/handlers/http/context.ts`
- `worker/src/routes/public-routes.ts`
- `worker/src/routes/ops-routes.ts`
- `worker/src/routes/admin-routes.ts`
- `worker/src/routes/messaging-routes.ts`
- `worker/src/routes/dynamic-routes.ts`
- `worker/src/api/__tests__/router-contract.test.ts`
- `worker/src/handlers/http/__tests__/request-dispatch.test.ts`

Candidate new files:
- `worker/src/routes/dependency-types.ts`
- `worker/src/routes/__tests__/route-context-typing.test.ts`

### Target end state

1. Static route helpers infer route context from endpoint key.
2. Dynamic route helpers infer route context from declared dependencies.
3. `buildRouteContext(...)` returns a dependency-specific type rather than the all-optional bag.
4. `FullRouteContext` remains available only where truly needed internally, or disappears entirely if the generic route layer makes it unnecessary.
5. Route handlers stop using fallback expressions that exist only to satisfy the overly broad context type.

### Implementation sequence

#### Step 1 - Add type-level dependency field mapping

Create a dependency map that separates:
- core route fields
- dependency-provided field groups

Recommended shape:
- `RouteCoreContext`
- `RouteDependencyFieldMap`
- `RouteContextFor<Deps>`

Important detail:
- `RouteDependencyFieldMap` should preserve current value nullability
- it should only make the property presence precise

#### Step 2 - Expose endpoint-key-to-dependency typing

Current issue:
- `ENDPOINT_DEFINITIONS` is exported as `readonly EndpointDefinition[]`, which loses some literal specificity

Recommended change:
- export a typed route-definition source or typed dependency helper derived from `BASE_ENDPOINT_DEFINITIONS`
- add a type like `RouteDependenciesForEndpoint<K extends EndpointKey>`

Do not duplicate dependency metadata in the worker layer for static routes.

#### Step 3 - Make `defineStaticRoute` generic over endpoint key

Target shape:
- `defineStaticRoute("status", handler)` should infer a handler context that includes:
  - core route fields
  - `coingeckoApiKey`
  - `cloudflareD1StatusBindings`

This change should force route arrays to reveal any route/handler mismatch at compile time.

#### Step 4 - Add typed dynamic-route helpers

Dynamic routes are the one place where dependency declarations still legitimately live in the worker layer.

Add one of:
- `defineDynamicRoute(pattern, deps, handle)`
- `defineDynamicAdminRoute(key, deps, handle)`

Also add a single map for dynamic-admin dependency requirements so `dynamic-routes.ts` stops hard-coding them inline.

Recommended dynamic admin dependency map:
- `discovery-candidate-dismiss -> []`
- `api-key-update -> ["apiKeyHashPepper"]`
- `api-key-deactivate -> []`
- `api-key-rotate -> ["apiKeyHashPepper"]`

#### Step 5 - Narrow `buildRouteContext`

`buildRouteContext` should become generic over `routeDependencies`.

Target behavior:
- when called with `["telegram"]`, the return type includes the telegram field group
- when called with `[]`, the return type is only the core route context

Keep the runtime loop over `ROUTE_DEPENDENCY_HYDRATORS`.
The runtime logic is already fine; the type surface is what needs to change.

#### Step 6 - Migrate route arrays and remove fake fallbacks

Expected cleanup targets:
- `worker/src/routes/messaging-routes.ts`
  - remove `feedbackEnv ?? {}`
- `worker/src/routes/public-routes.ts`
  - make dependency-required handlers receive precise context
- `worker/src/routes/ops-routes.ts`
  - make admin ops routes receive typed dependency context without relying on optional bags
- `worker/src/routes/admin-routes.ts`
  - same for backfills with `chainRpcs`, `alchemyApiKey`, `coingeckoApiKey`

#### Step 7 - Add tests specifically for the type migration

Before broad route edits, add:
- a type-level `expectTypeOf` test for representative endpoints
- a route-dependency alignment test for dynamic admin endpoints
- an assertion that `buildRouteContext` hydrates exactly the requested fields for a small sample of dependency combinations

Suggested coverage cases:
- no deps
- one nullable secret dep
- one object dep
- two-dependency route (`status`)
- dynamic route with `apiKeyHashPepper`

### Risk controls

- Do not rename endpoint keys in this phase.
- Do not change access-gate or auth semantics.
- Do not mix in new admin-route refactors; that work already landed.
- Keep the router contract tests green at every step.

### Validation gate

Required:
```bash
npm run lint
cd worker && npx tsc --noEmit
npm test -- worker/src/api/__tests__/router-contract.test.ts worker/src/handlers/http/__tests__/request-dispatch.test.ts
npm test -- worker/src/api/__tests__/status.test.ts worker/src/api/__tests__/api-keys.test.ts
```

Recommended before merge:
```bash
npm test
```

### Exit criteria

- no route array relies on optional-bag typing for declared dependencies
- dynamic admin routes declare dependencies in one place
- `buildRouteContext` is dependency-specific at the type level
- router and request-dispatch tests remain green

## P5B - Repair Script / Runtime Convergence

Findings:
- `R-006`

### Objective

Remove duplicated interpolation, peg mapping, and SQL batching logic between worker backfill code and checked-in repair scripts without breaking the worker/shared boundary.

### Scope

Primary files:
- `worker/src/api/backfill-fx.ts`
- `scripts/fix-commodity-depeg-median.ts`
- `scripts/fix-non-usd-depeg-fx.ts`

Candidate new files:
- `shared/lib/fx-series.ts`
- `shared/lib/commodity-median.ts`
- `shared/lib/fx-peg-maps.ts`
- `scripts/lib/remote-d1.ts`

Candidate tests:
- `shared/lib/__tests__/fx-series.test.ts`
- `shared/lib/__tests__/commodity-median.test.ts`

### Target end state

1. Pure math and time-series helpers live in `shared/lib`.
2. Script-only remote D1 execution helpers live in `scripts/lib`.
3. Worker backfill code and scripts both consume the same shared interpolation and peg-mapping logic.
4. Repair scripts remain operationally independent and do not import `worker/src/*`.

### Implementation sequence

#### Step 1 - Extract pure time-series helpers to `shared/lib`

Shared helper candidates:
- linear interpolation over sorted `{ timestamp, rate }` arrays
- date-range enumeration
- merge-per-date helper
- peg mapping constants where they are semantically shared:
  - `PEG_TO_FX`
  - `SECONDARY_PEG_TO_FX`
  - `OTHER_COIN_FX`
  - `COMMODITY_PEGS`

Do not move fetch or cache code into shared.

#### Step 2 - Extract commodity median builder to `shared/lib`

The peer-median builder is a good shared candidate because it is pure once the caller provides normalized price histories.

Recommended split:
- shared module receives token metadata plus per-token price histories
- worker keeps the CoinGecko/DefiLlama fetch responsibility
- scripts keep their standalone fetch responsibility

#### Step 3 - Extract script-only remote D1 helpers

Create `scripts/lib/remote-d1.ts` to hold:
- `d1Query`
- `d1QueryParsed`
- `d1ExecFile`
- `d1BatchExec`

This avoids duplicating temp-file and `wrangler d1 execute` logic across both repair scripts.

Do not move remote D1 execution into shared.
It is operational tooling, not runtime-neutral domain logic.

#### Step 4 - Rewrite scripts to consume shared helpers

Expected script simplifications:
- `fix-non-usd-depeg-fx.ts`
  - import shared interpolation
  - import shared peg mapping
  - import `d1BatchExec`
- `fix-commodity-depeg-median.ts`
  - import shared median builder
  - import shared interpolation
  - import `d1BatchExec`

#### Step 5 - Make `backfill-fx.ts` consume the same shared helpers

`worker/src/api/backfill-fx.ts` should become the canonical runtime owner for:
- fetch and cache policy
- API schema validation
- worker-specific D1 cache behavior

It should stop being the owner of pure interpolation and median math.

### Risk controls

- Do not change repair script SQL semantics in the extraction pass.
- Do not run the live repair scripts against the remote DB as tranche validation.
- Keep shared helpers pure and unit-tested so the risk is isolated to refactoring, not remote execution.

### Validation gate

Required:
```bash
npm run lint
cd worker && npx tsc --noEmit
npm test -- worker/src/api/__tests__/backfill-stability-index.test.ts worker/src/cron/__tests__/sync-fx-rates.test.ts
```

Required new unit coverage:
- interpolation parity
- commodity median parity
- script D1 batch helper chunking

### Exit criteria

- both repair scripts import shared domain helpers instead of duplicating them
- D1 remote batch execution exists in one script helper module
- worker backfill FX logic still passes its existing tests

## P5C - Dependency Hygiene And Refresh Cadence

Findings:
- `SUS-06`

### Objective

Remove install drift, land the low-risk patch/minor updates, and establish a bounded refresh routine without dragging major framework upgrades into the same tranche.

### Scope

Primary files:
- `package.json`
- `worker/package.json`
- `package-lock.json`
- optionally `docs/testing.md` or `docs/deployment-process.md` if a documented cadence is adopted

### Target end state

1. `npm ls --depth=0` no longer reports extraneous install drift.
2. Safe patch/minor updates are landed in bounded cohorts.
3. Major upgrades (`eslint@10`, `typescript@6`) are split into an explicit follow-up spike, not smuggled into routine maintenance.
4. The team has a lightweight refresh cadence written down somewhere durable.

### Implementation sequence

#### Step 1 - Restore clean install state

Do this before changing versions.

Validation goal:
- `npm ls --depth=0 --json` returns no extraneous package problems

#### Step 2 - Land patch/minor cohort A: root testing/tooling

Recommended batch:
- `@tanstack/react-query`
- `@types/node`
- `@vitest/coverage-v8`
- `jsdom`
- `vitest`

Reason:
- these are small, local, and easy to validate with the repo’s current gates

#### Step 3 - Land patch/minor cohort B: worker infra

Recommended batch:
- `wrangler`
- `@cloudflare/workers-types`
- `viem`

Reason:
- these change the worker toolchain and should be validated together

#### Step 4 - Explicitly defer major cohort

Create a tracked follow-up item for:
- `eslint@10`
- `typescript@6`

Do not combine those with the patch refresh.

#### Step 5 - Add a light cadence

Minimum acceptable cadence:
- monthly patch/minor refresh
- weekly dependency audit remains advisory for staleness and blocking for vulnerabilities

Recommended lightweight process note:
- patch/minor cohort refresh during the first full week of each month
- framework/tooling major spike once per quarter or when required by upstream support windows

### Risk controls

- never combine dependency refresh with hotspot refactors
- keep root and worker version bumps in separate commits even inside the same branch
- do not accept lockfile churn without a clean-install explanation

### Validation gate

For each cohort:
```bash
npm run lint
npm run typecheck
cd worker && npx tsc --noEmit
npm test
npm run build
npm run audit:deps
npm run check:worker-boundary
npm run check:shared-cycles
```

For the worker infra cohort also run:
```bash
npm run check:migrations
npm run check:cron-sync
npm run check:cron-connections
```

### Exit criteria

- no extraneous package drift
- patch/minor updates landed and validated
- major upgrade spike separated and tracked

## P6 - Yield Subsystem Decomposition

Findings:
- `R-004`
- `QA-003`
- worker portion of `SUS-01`
- closes `C-002`

### Objective

Reduce the yield lane’s structural risk without changing payload schemas, cache keys, or coverage policy.

### Scope

Primary files:
- `worker/src/cron/yield-sync/sources-optional-protocols.ts`
- `worker/src/cron/yield-sync/sources.ts`
- `worker/src/cron/yield-sync/resolve-tracked-sources.ts`
- `worker/src/cron/sync-yield-data.ts`
- `worker/src/cron/sync-yield-supplemental.ts`
- existing yield helper modules under `worker/src/cron/yield-sync/`

Candidate new files:
- `worker/src/cron/yield-sync/optional-source-runtime.ts`
- `worker/src/cron/yield-sync/tracked-optional-source-registry.ts`
- `worker/src/cron/yield-sync/supplemental-source-families.ts`
- `worker/src/cron/yield-sync/coordinator-health.ts`
- `worker/src/cron/yield-sync/coordinator-guards.ts`
- `worker/src/cron/yield-sync/coordinator-persist.ts`

High-value existing tests to keep green:
- `worker/src/cron/__tests__/sync-yield-data.test.ts`
- `worker/src/cron/__tests__/sync-yield-supplemental.test.ts`
- `worker/src/cron/__tests__/yield-bima-source.test.ts`
- `worker/src/cron/__tests__/yield-hashnote-source.test.ts`
- `worker/src/cron/__tests__/yield-morpho-source.test.ts`
- `worker/src/cron/__tests__/yield-ondo-source.test.ts`
- `worker/src/cron/__tests__/yield-pendle-source.test.ts`
- `worker/src/cron/__tests__/yield-yearn-kong-source.test.ts`
- `worker/src/cron/__tests__/yield-beefy-source.test.ts`
- `worker/src/cron/__tests__/yield-publication.test.ts`
- `worker/src/cron/__tests__/yield-resolve.test.ts`

### Target end state

1. Optional source execution uses shared outer runners, not copy-pasted fetch/parse/error skeletons.
2. Tracked special sources are registered, not hard-coded inline in the main tracked-yield loop.
3. Supplemental source families are registered, not wired ad hoc in `sync-yield-supplemental.ts`.
4. `sync-yield-data.ts` becomes a thin phase orchestrator with stable decision helpers underneath.
5. Cache keys, schema validation, and degradation semantics remain unchanged.

### Implementation sequence

#### Step 0 - Add characterization tests before moving code

Add or extend tests for:
- tracked special sources returning `null` on stale or malformed upstream payloads
- supplemental source family partial failure behavior
- deterministic on-chain failure masked by alternative coverage
- coverage-regression short-circuit before persistence
- previous-cache malformed path
- destructive cleanup disabled when degradation reasons are present

The goal is to lock behavior, not just line coverage.

#### Step 1 - Extract shared optional-source runtime helpers

Create small helpers for the repeated outer skeleton:
- time-budget wiring
- fetch-with-timeout wrapper
- abort propagation policy
- standard warning log shape
- shared “safe number” parsing helpers where useful

Do not build a “magic generic yield source framework”.
Keep the helper layer narrow.

Good abstraction:
- shared outer runner
- source-specific parser and mapping function

Bad abstraction:
- one descriptor format trying to represent every tracked and supplemental source family the same way

#### Step 2 - Split tracked optional sources into a registry

Current tracked special cases in `resolve-tracked-sources.ts`:
- BIMA
- Hashnote
- Ondo
- B.Protocol-style tracked source path

Target:
- `tracked-optional-source-registry.ts` exports entries keyed by stablecoin ID
- each entry owns only:
  - applicability
  - optional pre-read logic
  - runner invocation
  - yield mapping

Result:
- the main tracked resolver loop becomes data-driven
- adding another tracked special source becomes a registry append, not another large inline branch

#### Step 3 - Split supplemental source families into a registry

Current families:
- Morpho
- Pendle
- Yearn Kong
- Beefy
- plus RPC supplemental families already handled elsewhere

Target:
- `sync-yield-supplemental.ts` becomes:
  - source family registry load
  - parallel execution
  - dedupe
  - cache write

Keep `Aave` and `Compound` separate if they are meaningfully different operationally.
The goal is not forced sameness; it is removal of boilerplate orchestration.

#### Step 4 - Decompose `sync-yield-data.ts` by decision stage

Recommended split:

1. `coordinator-health.ts`
   - deterministic on-chain health transitions
   - cooldown computations
   - divergence logging helpers

2. `coordinator-guards.ts`
   - coverage guards
   - previous cache checks
   - publish preflight
   - degradation-reason assembly

3. `coordinator-persist.ts`
   - evaluated-source persistence
   - cache write result handling
   - prune policy decision

4. keep `sync-yield-data.ts` as the orchestrator only
   - load state
   - resolve sources
   - evaluate sources
   - hand off to health, guards, and persistence helpers
   - return final metadata

#### Step 5 - Preserve outward behavior during extraction

Specifically preserve:
- `yield-rankings` cache key
- `yield:supplemental-sources:v1` cache key
- `allowDestructiveCleanup` decision semantics
- benchmark and provenance payload shape
- current degradation-reason vocabulary

If any of those change, split that into a later behavioral tranche.

#### Step 6 - Re-run hotspot ratchet and decide on baseline/waiver updates only after reduction

Expected outcome:
- `sources-optional-protocols.ts` should shrink materially
- `sync-yield-data.ts` should shrink materially

If line counts do not improve enough, do not force a baseline update just to pass the tranche.
Keep the tranche honest.

### Risk controls

- do not change yield ranking schema
- do not change source-key formats
- do not change cache freshness thresholds in the same PR
- do not mix methodology copy updates into this tranche unless a user-visible behavior change actually occurs

### Validation gate

Required targeted suite:
```bash
npm run lint
cd worker && npx tsc --noEmit
npm test -- worker/src/cron/__tests__/sync-yield-data.test.ts worker/src/cron/__tests__/sync-yield-supplemental.test.ts
npm test -- worker/src/cron/__tests__/yield-bima-source.test.ts worker/src/cron/__tests__/yield-hashnote-source.test.ts worker/src/cron/__tests__/yield-morpho-source.test.ts worker/src/cron/__tests__/yield-ondo-source.test.ts worker/src/cron/__tests__/yield-pendle-source.test.ts worker/src/cron/__tests__/yield-yearn-kong-source.test.ts worker/src/cron/__tests__/yield-beefy-source.test.ts worker/src/cron/__tests__/yield-publication.test.ts worker/src/cron/__tests__/yield-resolve.test.ts
npm run check:hotspot-ratchet
```

Recommended before merge:
```bash
npm test
npm run build
```

### Exit criteria

- `resolve-tracked-sources.ts` no longer owns multiple protocol-specific inline branches
- `sync-yield-supplemental.ts` orchestrates registered families rather than hard-coded calls
- `sync-yield-data.ts` is reduced to phase orchestration
- hotspot ratchet either improves or is honestly carried with updated justification

## P7 - DEX-Liquidity Fetch-Family Decomposition

Findings:
- `R-003`
- `SUS-05`
- worker portion of `SUS-01`
- closes `C-003`

### Objective

Extract duplicated provider-family loops from `fetch-primary.ts` without changing the trigger budget, failure semantics, or partial-result behavior.

### Scope

Primary files:
- `worker/src/cron/dex-liquidity/fetch-primary.ts`
- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `worker/src/cron/dex-liquidity/orchestrator-phases.ts`
- `worker/src/cron/dex-liquidity/subgraph-helpers.ts`
- `worker/src/cron/dex-liquidity/token-price-observations.ts`
- `shared/lib/cron-jobs.ts`
- `docs/worker-and-api-limits.md`

Candidate new files:
- `worker/src/cron/dex-liquidity/subgraph-family-runner.ts`
- `worker/src/cron/dex-liquidity/subgraph-source-families.ts`
- `worker/src/cron/dex-liquidity/token-batch-runner.ts`
- `worker/src/cron/dex-liquidity/fetch-data-sources.ts`

High-value tests to keep green:
- `worker/src/cron/__tests__/sync-dex-liquidity.test.ts`
- `worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts`
- `worker/src/cron/dex-liquidity/__tests__/orchestrator-phases.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-fallbacks.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-series-stability.test.ts`

### Target end state

1. `fetch-primary.ts` is a facade or a small aggregation module, not the home of every provider-family loop.
2. UniV3 and Aerodrome use a shared subgraph outer runner with family-specific mapping logic.
3. GT and CG batch token fetches use a shared token-batch outer runner with provider-specific fetch callbacks and throttle logic.
4. Trigger-budget assumptions remain unchanged.
5. Partial-result and non-fatal source failure behavior remains unchanged.

### Implementation sequence

#### Step 0 - Add characterization tests for the duplicated outer loops

Before extraction, add tests for:
- per-chain subgraph timeout remains non-fatal
- partial price observations are still merged when one chain fails
- batch deadline returns partial token-batch results rather than throwing
- rate-limit sleeps and request counting remain consistent enough to preserve budget semantics

#### Step 1 - Extract a shared subgraph family runner

The duplicated outer loop between `fetchUniV3Data` and `fetchAerodromeData` is the safest first extraction.

Shared concerns to centralize:
- iterate configured subgraphs
- per-chain timeout composition
- fatal vs non-fatal abort handling
- entity fetch and merge
- aggregate logging

Keep family-specific logic separate:
- query
- entity type
- fee-tier vs stable-flag mapping
- price math
- pool identity construction

The common runner should accept family-specific callbacks, not generic data bags with weak typing.

#### Step 2 - Move family-specific subgraph mapping beside the runner

Recommended split:
- `subgraph-source-families.ts`
  - UniV3 family mapping
  - Aerodrome family mapping

This reduces the chance that `fetch-primary.ts` immediately regrows after the first extraction.

#### Step 3 - Extract a shared token-batch runner

The duplicated outer loop between `fetchGtTokenBatch` and `fetchCgTokenBatchPrices` should become:
- one batch iteration runner
- provider-specific rate limit hook
- provider-specific fetch callback
- shared observation append step

Shared concerns to centralize:
- chain loop
- 30-token chunking
- deadline short-circuit
- abort handling
- request counting and summary logging

Keep provider-specific concerns separate:
- URL construction
- sleep strategy (`sleepWithSignal` vs `onchainRateLimit`)
- fetch transport
- response shape

#### Step 4 - Consider extracting `fetchDataSources` only after the family runners land

`fetchDataSources` mixes:
- DL yields/protocols loading
- fallback DEX project recovery
- Curve batch fetches
- catastrophic-failure decision

This can be extracted, but it should be a second move.
Do not make this the first move; it has the highest coordination surface with the orchestrator.

#### Step 5 - Reconfirm scheduler budget invariants

After structural changes:
- keep `sync-dex-liquidity` at `4/6`
- do not change `halfHourlyOffset` job packing unless a measured budget issue forces a separate scheduling tranche

If a design change seems to require extra concurrency:
- stop and redesign the runner
- do not solve it by changing `shared/lib/cron-jobs.ts`

#### Step 6 - Update limits docs only if the enforced budget or orchestration assumptions change

Most likely outcome:
- no doc change needed

If request pacing or source-family scheduling changes materially:
- update `docs/worker-and-api-limits.md`

### Risk controls

- keep `orchestrator.ts` stable while extracting provider-family internals
- do not combine discovery-crawler refactors with this tranche
- do not change scoring or persistence policy while touching fetch families
- keep `fetch-primary.ts` as a re-export/facade during the transition

### Validation gate

Required targeted suite:
```bash
npm run lint
cd worker && npx tsc --noEmit
npm test -- worker/src/cron/__tests__/sync-dex-liquidity.test.ts worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts worker/src/cron/dex-liquidity/__tests__/orchestrator-phases.test.ts
npm test -- worker/src/cron/__tests__/dex-liquidity-fallbacks.test.ts worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts
npm run check:cron-connections
npm run check:hotspot-ratchet
```

Recommended before merge:
```bash
npm run test:critical-contracts
npm test
```

### Exit criteria

- the duplicated subgraph and token-batch outer loops are gone
- `fetch-primary.ts` is materially smaller and more focused
- cron connection budgets remain unchanged and green

## P8 - Managed Hotspot Reduction Follow-On

Findings:
- `SUS-01`

### Objective

Convert the remaining hotspot ledger into an owned, explicit burn-down program instead of leaving it as a passive waiver list.

### Immediate candidates after P6/P7

Frontend:
- `src/app/chains/[chain]/client.tsx`
- `src/components/contagion-graph.tsx`
- `src/app/methodology/sections/core/safety-scores-section.tsx`
- `src/app/methodology/sections/monitoring/pegscore-dews-section.tsx`

Worker:
- `worker/src/cron/dex-discovery/crawl-sources.ts`
- `worker/src/cron/sync-stablecoins/enrich-prices-primary.ts`
- any yield or DEX facade that remains above target after P6/P7

### Recommended governance rules

1. One hotspot per PR unless the second file is a brand-new helper module created to shrink the hotspot.
2. Every hotspot PR must declare:
   - starting metrics
   - target metrics
   - final metrics
3. If the file is still above target after the tranche, update the note honestly rather than pretending the work is finished.
4. Do not widen a hotspot waiver while touching the file for unrelated feature work.

### Recommended first frontend order

1. `src/app/chains/[chain]/client.tsx`
   - continue the route-shell split started in Tranche 2
   - next likely extractions:
     - hero section
     - health breakdown section
     - filter/table coordination hook

2. `src/components/contagion-graph.tsx`
   - split graph math, legend/controls, and render shell

3. methodology long-form sections
   - split content-heavy tables and reference blocks from narrative section shells

### Validation gate

For any hotspot tranche:
```bash
npm run lint
npm run typecheck
cd worker && npx tsc --noEmit
npm run check:hotspot-ratchet
npm test
npm run build
```

## Parallelism Guidance

Safe to run in parallel:
- `P5A` route typing
- `P5B` repair script convergence
- `P5C` dependency hygiene

Not recommended in parallel:
- `P6` yield decomposition with `P7` DEX decomposition

Reason:
- both touch worker cron internals
- both will stress the same validation lanes
- both are likely to collide with hotspot ratchet work

Can overlap after worker refactors settle:
- `P8` frontend hotspot follow-ons

## PR Segmentation Recommendation

Keep the remaining work in these PR-sized slices:

1. `P5A-1` typed route helper scaffolding and tests
2. `P5A-2` route-array migration
3. `P5B` shared FX helpers + script D1 helper extraction
4. `P5C-1` clean install + patch root cohort
5. `P5C-2` worker infra cohort
6. `P6-1` optional-source runtime helpers + tracked registry
7. `P6-2` supplemental source-family registry
8. `P6-3` `sync-yield-data` coordinator extraction
9. `P7-1` subgraph family runner
10. `P7-2` token-batch family runner
11. `P7-3` optional `fetchDataSources` extraction if still needed
12. `P8-*` hotspot follow-ons one file family at a time

This keeps rollback boundaries clean and review load reasonable.

## Final Recommendation

If the goal is to minimize implementation risk, the next execution order should be:

1. `P5A` Route dependency typing
2. `P5B` Repair-script/runtime convergence
3. `P5C` Patch-level dependency hygiene
4. `P6` Yield subsystem decomposition
5. `P7` DEX-liquidity decomposition
6. `P8` Hotspot follow-on program

This order front-loads type safety and install hygiene, then tackles the large cron hotspots one at a time, with the scheduler-sensitive DEX work deliberately last.
