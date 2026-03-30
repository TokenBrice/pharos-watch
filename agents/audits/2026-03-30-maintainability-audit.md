# Pharos Maintainability Audit

Date: 2026-03-30

Scope: production-critical maintainability only. This audit focuses on incremental, low-risk changes that simplify the codebase, reduce duplication, and make data-quality failures easier to detect without changing product scope.

## Executive Summary

1. `compute-dews` still treats malformed persisted JSON as an expected condition instead of a degraded input path. In a production-critical scoring pipeline, that is too quiet: it can suppress stress inputs while the cron still reports success. Fixing this is the highest-value hardening change.
2. `shared/lib/report-cards.ts` has already crossed the repo’s own hotspot ratchet and now concentrates too many scoring concerns in one module. It is pure logic, so it is a good candidate for an incremental decomposition with low regression risk.
3. `worker/src/cron/yield-config.ts` is acting as several registries at once. The same stablecoin IDs and strategy metadata are duplicated across multiple maps and lists, which makes yield-coverage edits more fragile than they need to be.
4. `worker/src/cron/sync-stablecoins/supplemental-assets.ts` has three family-specific fetchers with repeated fallback, price-resolution, and asset-construction logic. They have already diverged, which raises the cost of future bug fixes.
5. The frontend has several business-critical query hooks with little or no direct test coverage. Component tests often mock the hooks, which means pagination, normalization, and stale/fallback behavior can regress without obvious failures.

## Critical Findings

### Finding 1

1. Location:
   [worker/src/cron/compute-dews.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/compute-dews.ts#L351), [worker/src/cron/compute-dews.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/compute-dews.ts#L441), [worker/src/cron/compute-dews.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/compute-dews.ts#L663), [worker/src/cron/daily-digest/collectors-risk.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/daily-digest/collectors-risk.ts#L304), [worker/src/lib/json-decode-observability.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/json-decode-observability.ts#L1), [worker/src/api/mint-burn-flows-shared.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/mint-burn-flows-shared.ts#L178)
2. Category: Production Risk
3. Severity: Critical
4. Current State:
   `compute-dews` parses `stress_signals.signals_json` and `yield_data.warning_signals` with inline `JSON.parse` blocks. Parse failures only increment `validationFailures`; they do not call the shared malformed-JSON logger, do not mark the source degraded, and do not carry row context into logs. The same repo already has stronger patterns elsewhere: `daily-digest` marks degraded collectors for malformed `warning_signals`, and `mint-burn` API helpers use `decodeJsonString()` plus `logMalformedJsonPath()`. In practice, bad persisted JSON can silently remove DEWS inputs and still leave the cron in an `ok` state.
5. Recommended Change:
   Replace the ad hoc parse blocks in `compute-dews` with the shared decode/observability path already used in `worker/src/api/*`. Treat malformed persisted JSON in `stress_signals` and `yield_data` as a degraded source condition, not just a counter. Preserve availability by keeping partial output, but set cron status to `degraded` when malformed rows are encountered in those source tables. Add explicit tests for malformed `signals_json` and `warning_signals`.
6. Risk Assessment:
   The main risk is operational noise if older rows are already malformed. Mitigate by rolling out with row-count metadata and a bounded threshold, then tightening to strict degraded behavior once the stored data is clean. The change is otherwise low-risk because it hardens an existing failure path instead of changing scoring math.

## Redundancy Report

### Finding 2

1. Location:
   [worker/src/cron/yield-config.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-config.ts#L44), [worker/src/cron/yield-config.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-config.ts#L266), [worker/src/cron/yield-config.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-config.ts#L386), [worker/src/cron/yield-config.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-config.ts#L428), [worker/src/cron/yield-config.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-config.ts#L587), [worker/src/cron/yield-config.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-config.ts#L686), [worker/src/cron/yield-config.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-config.ts#L711), [worker/src/cron/yield-config.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-config.ts#L768)
2. Category: Redundancy
3. Severity: High
4. Current State:
   Yield coverage is defined across several parallel registries: `YIELD_VARIANT_MAP`, `YIELD_POOL_MAP`, `EXPLICIT_YIELD_SOURCE_POOL_MAP`, `ON_CHAIN_RATE_CONFIGS`, `RATE_DERIVED_CONFIGS`, `AUTO_LENDING_POOL_MAP`, `AUTO_LENDING_SAFETY_BYPASS_IDS`, and quarantine/intentional-gap maps. The manifest at the bottom recombines these sources by scanning them repeatedly. This means a single yield-bearing asset often has to be updated in multiple places, and the invariants are mostly conventional rather than structural.
5. Recommended Change:
   Keep the current exported shapes for compatibility, but author the data once in a single per-asset manifest source and derive the current maps/sets from it. As a first incremental step, move only one family at a time, starting with `ON_CHAIN_RATE_CONFIGS` and `YIELD_POOL_MAP`, because those are the most duplicated and the easiest to derive.
6. Risk Assessment:
   The risk is introducing a bad derivation layer and breaking registry lookups. Mitigate with snapshot/invariant tests that compare the derived exports to the current checked-in values during the transition.

### Finding 3

1. Location:
   [worker/src/cron/sync-stablecoins/supplemental-assets.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins/supplemental-assets.ts#L90), [worker/src/cron/sync-stablecoins/supplemental-assets.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins/supplemental-assets.ts#L180), [worker/src/cron/sync-stablecoins/supplemental-assets.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins/supplemental-assets.ts#L333)
2. Category: Redundancy
3. Severity: Medium
4. Current State:
   `fetchSilverTokens`, `fetchGoldTokens`, and `fetchFiatCoinGeckoTokens` all implement similar price-fetch, fallback, mcap-resolution, and asset-construction flows, but they now diverge in structure and edge-case handling. Gold uses protocol TVL history, silver uses CoinGecko circulating supply, and fiat-CG hand-builds `PeggedAsset` rows instead of using `buildSupplementalAsset()`. The family-specific logic is justified; the repeated scaffolding is not.
5. Recommended Change:
   Extract a shared helper for supplemental price resolution and a second helper for common asset construction. Keep only the family-specific mcap and history logic in the three entry points. This is a straightforward incremental refactor because the current tests already exercise commodity supplemental paths.
6. Risk Assessment:
   The risk is accidentally flattening family-specific behavior, especially for gold TVL-history handling and fiat on-chain supply fallback. Mitigate by refactoring around golden fixtures from the existing `sync-stablecoins` test cases and preserving family-specific branches.

### Finding 4

1. Location:
   [shared/lib/api-endpoints.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/api-endpoints.ts#L22), [shared/lib/api-endpoints.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/api-endpoints.ts#L127), [shared/lib/api-endpoints.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/api-endpoints.ts#L685), [src/lib/api.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/api.ts#L3), [src/lib/api.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/api.ts#L19), [src/lib/api.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/api.ts#L97), [src/lib/api.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/api.ts#L140)
2. Category: Redundancy
3. Severity: Medium
4. Current State:
   The repo maintains `strictContract` metadata on endpoint definitions and exports `STRICT_CONTRACT_PATHS_LIST`, but the frontend fetch helper no longer uses that list to decide runtime contract policy. `resolveContractMode()` defaults to `"strict"` whenever a schema exists, regardless of path. That leaves a stale configuration concept in `shared/lib/api-endpoints.ts`, a matching runtime import in `src/lib/api.ts`, and tests around a list that has no current behavioral effect.
5. Recommended Change:
   Either remove the unused `strictContract` runtime concept entirely if “schema means strict” is the intended policy, or rewire `src/lib/api.ts` so the path registry actually governs warn-vs-strict behavior. Do not keep both a global-strict default and an unused per-path registry.
6. Risk Assessment:
   Removing the stale abstraction is low-risk if the current strict-by-default behavior is intentional. If the registry is meant to come back, the safer path is to add a targeted contract-mode test first and then restore the runtime branch.

## Code Quality Findings

### Finding 5

1. Location:
   [shared/lib/report-cards.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/report-cards.ts#L168), [shared/lib/report-cards.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/report-cards.ts#L337), [shared/lib/report-cards.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/report-cards.ts#L480), [shared/lib/report-cards.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/report-cards.ts#L680), [shared/lib/report-cards.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/report-cards.ts#L835), [shared/lib/report-cards.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/report-cards.ts#L928), [shared/lib/report-cards.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/report-cards.ts#L991)
2. Category: Code Quality
3. Severity: High
4. Current State:
   `shared/lib/report-cards.ts` now contains peg scoring, liquidity scoring, resilience defaults, blacklist inference, decentralization, dependency risk, overall grade computation, and stress-test recomputation. It is already failing the repo’s own hotspot ratchet (`fileLines` and `branchCount`), which means the codebase has an objective signal that the module has regrown past its intended maintenance budget.
5. Recommended Change:
   Split the file by scoring family behind a stable facade:
   `report-cards/peg.ts`, `report-cards/liquidity.ts`, `report-cards/resilience.ts`, `report-cards/dependency-risk.ts`, `report-cards/overall.ts`, with `shared/lib/report-cards.ts` kept as a thin export surface. Start with the resilience/blacklist cluster and dependency-risk cluster because they are the most branch-heavy.
6. Risk Assessment:
   This is low-risk relative to most refactors because the module is pure and already well tested. The main risk is accidental export churn. Mitigate by preserving existing named exports and running the existing report-card and API tests after each split.

### Finding 6

1. Location:
   [worker/src/cron/sync-live-reserves.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-live-reserves.ts#L222), [worker/src/cron/sync-live-reserves.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-live-reserves.ts#L284), [worker/src/cron/sync-live-reserves.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-live-reserves.ts#L312), [worker/src/cron/sync-live-reserves.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-live-reserves.ts#L479)
2. Category: Code Quality
3. Severity: High
4. Current State:
   The main per-coin loop in `sync-live-reserves` mixes breaker decisions, adapter lookup, fallback execution, validation, persistence, timeout recovery, state-record building, progress updates, and post-run cleanup in one control path. The logic is defensible, but the current shape makes it hard to reason about which failures are terminal, which are degraded, and which are retryable without tracing the whole loop.
5. Recommended Change:
   Extract a single-coin execution unit, for example `syncReserveCoin()`, that returns a structured outcome object (`ok`, `degraded`, `skipped`, `error`, warnings, breaker outcome, metadata). Leave progress reporting and end-of-run cleanup in the outer shell.
6. Risk Assessment:
   The risk is changing failure categorization during extraction. Mitigate by preserving the current `recordFailure()` and `buildReserveSyncStateRecord()` behavior first, then refactoring around those existing helpers rather than rewriting the workflow.

## Sustainability Roadmap

Ordered by impact-to-effort ratio.

### Finding 7

1. Location:
   [src/hooks/use-depeg-events.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-depeg-events.ts#L1), [src/hooks/use-mint-burn-flows.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-mint-burn-flows.ts#L1), [src/hooks/use-stablecoin-reserves.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-stablecoin-reserves.ts#L1), [src/hooks/use-blacklist-events.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-blacklist-events.ts#L1), [src/hooks/use-chains.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-chains.ts#L1)
2. Category: Sustainability
3. Severity: Medium
4. Current State:
   Several query hooks encode important behavior directly: infinite paging and auto-load retry (`use-depeg-events`), normalization of mint/burn semantics (`use-mint-burn-flows`), live-vs-fallback stale timing (`use-stablecoin-reserves`), and derived chain composition (`use-chains`). Most route/component tests mock these hooks, and a direct search found almost no hook-level coverage for them.
5. Recommended Change:
   Add targeted hook tests rather than more route tests. The minimum useful set is:
   pagination termination and retry behavior for `useInfiniteDepegEvents`,
   response normalization invariants for `useMintBurnFlows`,
   live/fallback stale-time switching for `useStablecoinReserves`,
   query-key stability for the blacklist and chain hooks.
6. Risk Assessment:
   Very low implementation risk. The main cost is test maintenance, but these hooks are exactly where integration logic hides when components mock the data layer.

### Finding 8

1. Location:
   [worker/src/lib/depeg-helpers.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/depeg-helpers.ts#L137), [worker/src/cron/dex-liquidity/challenger-persistence.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/challenger-persistence.ts#L320), [worker/src/cron/__tests__/dex-liquidity-price-bridge.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/dex-liquidity-price-bridge.test.ts#L1)
2. Category: Sustainability
3. Severity: Medium
4. Current State:
   The depeg/liquidity bridge still parses persisted challenger JSON with bespoke `JSON.parse` plus `continue`/`warn` handling. There is no malformed-row test coverage for those paths, even though the same persisted data affects challenger loading for depeg-related price checks.
5. Recommended Change:
   Standardize these loaders on the same `decodeJsonString()` plus malformed-path logging pattern used elsewhere, and add tests for malformed `price_sources_json` and `top_pools_json` rows.
6. Risk Assessment:
   Low. The change narrows behavior around already-invalid rows and should improve diagnosability without changing valid-path logic.

## Quick Wins

1. Remove or reactivate `strictContract` as a runtime concept. Right now it is mostly configuration debt.
2. Add malformed persisted-JSON tests for `compute-dews` and the depeg challenger loaders. Those are high-signal tests with little fixture cost.
3. Replace the repeated ERC-4626 literal fields in `ON_CHAIN_RATE_CONFIGS` with a tiny helper factory. That trims a large amount of duplicated boilerplate without changing behavior.
4. Split the first `report-cards` extraction along existing natural seams, starting with `dependencyRisk` and `overall`. The tests already in place are good enough to support that move.

## Verification

Commands run during the audit:

- `npm run check:unused-code`
- `npm run check:hotspot-ratchet`
- `npm run check:shared-cycles`
- `npm run audit:deps`
- `npm test -- worker/src/cron/__tests__/compute-dews.test.ts worker/src/cron/__tests__/stability-index.test.ts shared/lib/__tests__/report-cards.test.ts worker/src/cron/__tests__/yield-config-registry.test.ts`
- `npm run typecheck`
- `npm run lint`

Observed results:

- `check:unused-code`: passed
- `check:shared-cycles`: passed
- `audit:deps`: passed, `0` production vulnerabilities
- targeted tests: passed, `67/67`
- `typecheck`: passed
- `lint`: passed
- `check:hotspot-ratchet`: failed on `shared/lib/report-cards.ts` (`fileLines` and `branchCount` over baseline)
