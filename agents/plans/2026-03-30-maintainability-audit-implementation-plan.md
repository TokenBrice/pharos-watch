# 2026-03-30 Maintainability Audit Implementation Plan

> Execution plan for [2026-03-30-maintainability-audit.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-03-30-maintainability-audit.md).
> Scope covers all `8` findings from the audit and the adjacent validation, docs, and sequencing work needed to land them safely.

## Objective

Execute the maintainability audit in a way that:

- hardens production-critical failure handling first
- removes duplication before adding more local abstractions
- keeps public behavior and methodology semantics stable unless the finding is explicitly a bug
- uses bounded, incremental refactors instead of broad rewrites
- leaves the repo in a state where the original findings are resolved and the next round of changes is easier, not harder

## Execution Status

Status as of `2026-03-30`:

- `WS1` completed
- `WS2` completed
- `WS3` completed
- `WS4` completed
- `WS5` completed
- `WS6` completed
- `WS7` in final validation / documentation closeout

Implemented outcomes:

- DEWS and depeg/liquidity persisted JSON paths now use shared decode observability and degrade appropriately on malformed core inputs.
- Report-card scoring moved behind a stable barrel surface with focused internal modules; hotspot ratchet is back in compliance.
- Yield config exports are now derived from a unified registry view instead of rebuilding manifest state from disconnected collections.
- Supplemental tracked-asset loaders share common price-fetch and priced-asset construction helpers.
- `sync-live-reserves` now delegates per-coin execution to a single helper while keeping breaker/prune orchestration in the outer cron shell.
- Frontend API validation now relies on schema presence plus explicit `contractMode`, and direct hook tests cover the previously untested critical paths.

## Source Findings Covered

| Workstream | Findings |
| --- | --- |
| `WS0` Baseline and control setup | supporting work for all findings |
| `WS1` Persisted-JSON observability hardening | `F1`, `F8` |
| `WS2` Shared report-card decomposition | `F5` |
| `WS3` Yield registry consolidation | `F2` |
| `WS4` Supplemental stablecoin loader deduplication | `F3` |
| `WS5` Live reserves cron-shell decomposition | `F6` |
| `WS6` Frontend query contract and coverage cleanup | `F4`, `F7` |
| `WS7` Documentation and closeout ratchets | cross-cutting completion work |

Where the finding IDs map to the audit as:

- `F1`: malformed persisted JSON in `compute-dews` does not degrade the cron
- `F2`: duplicated yield registry ownership in `worker/src/cron/yield-config.ts`
- `F3`: duplicated commodity/fiat supplemental asset loaders
- `F4`: stale `strictContract` runtime concept
- `F5`: `shared/lib/report-cards.ts` hotspot regression
- `F6`: `sync-live-reserves` single-loop orchestration hotspot
- `F7`: weak direct test coverage for business-critical frontend hooks
- `F8`: bespoke persisted JSON parsing in depeg/liquidity bridge loaders

## Constraints

- Preserve public endpoint contracts unless the finding is explicitly about incorrect or unsafe behavior.
- Do not change methodology math, weights, thresholds, or scoring semantics as part of structural cleanup.
- Keep `shared/lib/report-cards.ts` as the stable public facade while decomposing internals.
- Treat `worker/src/cron/sync-stablecoins.ts`, `worker/src/cron/sync-yield-data.ts`, and `worker/src/cron/sync-live-reserves.ts` as stabilized shells: move logic out instead of regrowing them.
- Update docs only where behavior, operations, validation policy, or developer workflow meaningfully changes.
- Before any branch is pushed, run `npm run test:merge-gate`.

## Non-Goals

- No feature work.
- No architecture rewrite of the worker, router, or frontend query layer.
- No changes to scoring formulas for DEWS, PSI, Safety Scores, liquidity, or yield.
- No destructive migrations or downtime-bearing schema changes.
- No redesign of the UI or content IA.

## Success Criteria

1. Malformed persisted JSON in DEWS-critical inputs becomes observable and operator-visible, and is covered by regression tests.
2. Depeg/liquidity persisted JSON loaders use the shared decode/observability pattern instead of bespoke `JSON.parse` loops.
3. `shared/lib/report-cards.ts` returns under hotspot control through internal decomposition, with no export churn.
4. Yield coverage stops being maintained across multiple manually synchronized registries.
5. Commodity and fiat supplemental loaders share common scaffolding instead of repeating fetch and asset-construction logic.
6. `sync-live-reserves` has a single-coin execution unit and a thinner outer orchestration shell.
7. The frontend query layer has direct tests for the current hidden logic in critical hooks.
8. The stale `strictContract` runtime concept is either removed or restored to actual use; it no longer exists as dead policy metadata.
9. Final validation is green, including the hotspot ratchet for `shared/lib/report-cards.ts`.

## Required Validation Baseline

Run on every implementation branch unless the touched surface clearly allows a smaller targeted set:

```bash
npm run lint
npm run typecheck
npm test
npm run build
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

Keep these additional checks attached when relevant:

```bash
npm run check:unused-code
npm run check:shared-cycles
npm run check:hotspot-ratchet
npm run check:doc-sync
npm run check:cron-sync
npm run check:cron-connections
```

## Program Shape

Recommended merge sequence:

```text
PR-00 Baseline fixtures, characterization tests, and execution controls
PR-01 Persisted JSON hardening for DEWS + depeg/liquidity bridge
PR-02 Report-card decomposition tranche A
PR-03 Report-card decomposition tranche B + hotspot closeout
PR-04 Yield registry consolidation
PR-05 Supplemental asset loader deduplication
PR-06 Live reserves cron-shell decomposition
PR-07 Frontend query contract cleanup and hook coverage
PR-08 Documentation, backlog refresh, and final validation closeout
```

Parallelism guidance:

- `PR-01` should land first because it changes production-risk visibility.
- `PR-02` and `PR-04` can run in parallel after `PR-01`; their write scopes do not overlap.
- `PR-05` should follow `PR-04` because yield-registry changes and supplemental-loader changes both touch the stablecoin ingestion mental model and should not compete for review attention.
- `PR-06` should stay isolated because it touches a heavy cron shell.
- `PR-07` can run in parallel with `PR-06` if the hook test additions avoid touching the same shared utilities.
- `PR-08` is the final convergence branch.

## Phase 0 - Baseline And Control Setup

### `PR-00` Characterization and rollout controls

Goal:

- capture current behavior before structural changes
- add missing regression tests for the riskiest currently-untested paths
- convert the audit findings into branch-sized execution units

Primary files:

- [2026-03-30-maintainability-audit.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/audits/2026-03-30-maintainability-audit.md)
- new or expanded tests under:
  - `worker/src/cron/__tests__/compute-dews.test.ts`
  - `worker/src/cron/__tests__/dex-liquidity-price-bridge.test.ts`
  - `src/hooks/__tests__/`
  - `shared/lib/__tests__/report-cards.test.ts`

Tasks:

1. Add characterization tests for malformed `signals_json` and `warning_signals` in `compute-dews` before changing behavior.
2. Add characterization tests for malformed `price_sources_json` and `top_pools_json` in the depeg/liquidity bridge.
3. Add a line in the hotspot backlog noting that `shared/lib/report-cards.ts` is no longer only deferred; it is now on the active remediation path.
4. Create branch boundaries and file locks for the execution train.

Validation:

```bash
npm test -- worker/src/cron/__tests__/compute-dews.test.ts worker/src/cron/__tests__/dex-liquidity-price-bridge.test.ts shared/lib/__tests__/report-cards.test.ts
npm run lint
npm run typecheck
```

Docs:

- no user-facing docs required
- update planning docs only if execution boundaries change

## Phase 1 - Production-Risk Hardening

### `PR-01` Persisted JSON observability hardening

Findings covered:

- `F1`
- `F8`

Objective:

Make malformed persisted JSON in production-critical worker paths visible, consistently classified, and regression-tested.

Primary files:

- [worker/src/cron/compute-dews.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/compute-dews.ts)
- [worker/src/lib/depeg-helpers.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/depeg-helpers.ts)
- [worker/src/cron/dex-liquidity/challenger-persistence.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/challenger-persistence.ts)
- [worker/src/lib/cache-json.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/cache-json.ts)
- [worker/src/lib/json-decode-observability.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/json-decode-observability.ts)
- targeted tests in:
  - `worker/src/cron/__tests__/compute-dews.test.ts`
  - `worker/src/cron/__tests__/dex-liquidity-price-bridge.test.ts`
  - any new tests under `worker/src/lib/__tests__/` if helper extraction is needed

Implementation tasks:

1. Introduce a shared helper for decode-with-log behavior if `decodeJsonString()` plus `logMalformedJsonPath()` still causes too much call-site boilerplate in cron code.
2. Replace inline `JSON.parse` blocks in `compute-dews` for:
   - previous stress signal payloads
   - yield warning payloads
   - any similar persisted JSON reads in the same cron path
3. Treat malformed core source rows as degraded source input, not only `validationFailures`.
4. Preserve partial output availability:
   - keep per-row skip behavior
   - do not fail the entire cron unless the dataset becomes unusable
5. Apply the same decode/log pattern to:
   - `loadDexPriceSources()`
   - legacy challenger loading in `challenger-persistence.ts`
6. Ensure metadata carries enough context for operators:
   - source name
   - malformed row count
   - whether status was downgraded because of malformed persisted JSON

Explicit non-goals:

- no scoring formula changes
- no schema change to persisted tables
- no behavior change for valid rows

Testing additions:

1. malformed `signals_json` increments malformed count and produces degraded metadata
2. malformed `warning_signals` increments malformed count and produces degraded metadata
3. malformed challenger JSON is logged and skipped, not fatal
4. mixed valid and invalid persisted rows still produce usable output

Validation:

```bash
npm test -- worker/src/cron/__tests__/compute-dews.test.ts worker/src/cron/__tests__/dex-liquidity-price-bridge.test.ts worker/src/api/__tests__/stress-signals.test.ts
cd worker && npx tsc --noEmit
npm run lint
```

Docs:

- [docs/worker-and-api-limits.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/worker-and-api-limits.md)
  - only if malformed persisted JSON now explicitly downgrades cron status
- [docs/testing.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md)
  - add the new regression coverage if the test surface materially changes

Rollback notes:

- if production starts surfacing too many degraded runs due to old corrupt rows, keep the new logging and metadata but temporarily gate the status downgrade behind a malformed-row threshold while data is cleaned

## Phase 2 - Shared Scoring Hotspot

### `PR-02` Report-card decomposition tranche A

Findings covered:

- `F5`

Objective:

Start reducing `shared/lib/report-cards.ts` without changing exports or methodology behavior.

Primary files:

- [shared/lib/report-cards.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/report-cards.ts)
- new internal modules, for example:
  - `shared/lib/report-cards/resilience.ts`
  - `shared/lib/report-cards/blacklist.ts`
  - `shared/lib/report-cards/dependency-risk.ts`
- tests:
  - `shared/lib/__tests__/report-cards.test.ts`
  - `src/lib/__tests__/report-cards.test.ts`
  - `worker/src/api/__tests__/report-cards.test.ts`

Implementation tasks:

1. Extract blacklist inference and reserve blacklist helpers into their own module.
2. Extract resilience scoring and its default-factor resolution into a separate module.
3. Keep `shared/lib/report-cards.ts` re-exporting the same public functions.
4. Avoid moving constants that are intentionally shared outside the report-card domain unless they are clearly local to the extracted module.

Validation:

```bash
npm test -- shared/lib/__tests__/report-cards.test.ts src/lib/__tests__/report-cards.test.ts worker/src/api/__tests__/report-cards.test.ts
npm run typecheck
npm run check:shared-cycles
```

Docs:

- no methodology docs update expected if behavior is unchanged
- update [2026-03-29-hotspot-decomposition-backlog.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-03-29-hotspot-decomposition-backlog.md) to reflect the active split and next tranche

### `PR-03` Report-card decomposition tranche B and hotspot closeout

Findings covered:

- `F5`

Objective:

Finish the highest-value decomposition so the hotspot ratchet passes again.

Primary files:

- same facade plus new internal modules:
  - `shared/lib/report-cards/liquidity.ts`
  - `shared/lib/report-cards/peg.ts`
  - `shared/lib/report-cards/overall.ts`
  - `shared/lib/report-cards/stress.ts`

Implementation tasks:

1. Extract dependency risk if not completed in tranche A.
2. Extract overall grade and stressed-grade recomputation.
3. Extract peg and liquidity scorers only if the ratchet still fails after the first splits.
4. Re-run hotspot ratchet and update backlog metadata.
5. Only update the hotspot baseline if the file is intentionally reduced and the backlog note is updated in the same branch.

Validation:

```bash
npm test -- shared/lib/__tests__/report-cards.test.ts src/lib/__tests__/report-cards.test.ts worker/src/api/__tests__/report-cards.test.ts
npm run check:hotspot-ratchet
npm run typecheck
```

Docs:

- [2026-03-29-hotspot-decomposition-backlog.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-03-29-hotspot-decomposition-backlog.md)
- hotspot baseline only if justified

## Phase 3 - Registry And Loader Deduplication

### `PR-04` Yield registry consolidation

Findings covered:

- `F2`

Objective:

Stop maintaining yield coverage across multiple parallel registries.

Primary files:

- [worker/src/cron/yield-config.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/yield-config.ts)
- [worker/src/cron/__tests__/yield-config-registry.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/yield-config-registry.test.ts)
- any yield sync tests that depend on the exported maps

Implementation shape:

- author data once in a single manifest-style structure
- derive the currently-exported maps/sets/arrays from that structure
- preserve current public exports during the transition so downstream code changes stay small

Implementation tasks:

1. Define a canonical per-stablecoin manifest entry type covering:
   - variant wrapper
   - native pool
   - explicit pool overrides
   - on-chain rate source
   - rate-derived fallback
   - price-derived fallback
   - auto-lending override
   - safety bypass
   - quarantine reason
   - intentional-gap reason
2. Rebuild the existing exports from the manifest.
3. Keep `YIELD_ADAPTER_MANIFEST` derived from the same source instead of independently scanning multiple maps.
4. Maintain stable ordering where tests or output depend on it.
5. Do not change the behavior of the yield selection pipeline in this branch.

Testing additions:

1. equality/invariant tests that the derived exports contain the same IDs and key associations as before
2. manifest completeness tests for every yield-bearing coin
3. stable ordering tests if any downstream serialization depends on order

Validation:

```bash
npm test -- worker/src/cron/__tests__/yield-config-registry.test.ts worker/src/cron/__tests__/yield-resolve.test.ts worker/src/cron/__tests__/sync-yield-data.test.ts
cd worker && npx tsc --noEmit
npm run lint
```

Docs:

- [docs/yield-intelligence.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/yield-intelligence.md)
  - only if the developer-facing explanation of coverage sources needs simplification
- [docs/testing.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md)
  - if new invariant tests are added

### `PR-05` Supplemental asset loader deduplication

Findings covered:

- `F3`

Objective:

Collapse repeated supplemental-asset loader scaffolding while preserving the family-specific market-cap logic.

Primary files:

- [worker/src/cron/sync-stablecoins/supplemental-assets.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins/supplemental-assets.ts)
- [worker/src/cron/__tests__/sync-stablecoins.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/sync-stablecoins.test.ts)

Implementation tasks:

1. Extract shared helper(s) for:
   - DefiLlama price fetch plus CoinGecko fallback preparation
   - supplemental asset row construction
   - common mcap/price resolution where behavior truly matches
2. Keep family-specific logic separate for:
   - gold protocol TVL history and divergence checks
   - silver CoinGecko circulating supply handling
   - fiat CoinGecko on-chain totalSupply fallback
3. Prefer `buildSupplementalAsset()` consistently where possible.
4. Preserve current source labels and `supplySource` semantics.

Validation:

```bash
npm test -- worker/src/cron/__tests__/sync-stablecoins.test.ts worker/src/cron/__tests__/enrich-prices.test.ts
cd worker && npx tsc --noEmit
npm run lint
```

Docs:

- [docs/pricing-pipeline.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/pricing-pipeline.md) only if source-selection documentation becomes clearer or needs wording updates
- [docs/supply-snapshot.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/supply-snapshot.md) only if fallback-source wording changes

## Phase 4 - Worker Cron Shell Decomposition

### `PR-06` Live reserves cron-shell decomposition

Findings covered:

- `F6`

Objective:

Turn `sync-live-reserves` into a thin orchestration shell with a dedicated single-coin execution unit.

Primary files:

- [worker/src/cron/sync-live-reserves.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-live-reserves.ts)
- new helper modules as needed, for example:
  - `worker/src/cron/live-reserves/run-coin.ts`
  - `worker/src/cron/live-reserves/fallbacks.ts`
  - `worker/src/cron/live-reserves/outcomes.ts`
- tests:
  - `worker/src/cron/__tests__/sync-live-reserves.test.ts`

Implementation tasks:

1. Extract a structured per-coin execution function that owns:
   - breaker gate decision
   - adapter lookup
   - primary/fallback adapter execution
   - validation and warning classification
   - finalize success/failure decision
2. Keep the outer shell responsible for:
   - progress reporting
   - total counters
   - breaker outcome recording
   - end-of-run cleanup and history prune
3. Define a typed outcome object so failure categories are explicit instead of encoded across many branches.
4. Preserve current persistence helpers and failure metadata semantics during the extraction.

Validation:

```bash
npm test -- worker/src/cron/__tests__/sync-live-reserves.test.ts
cd worker && npx tsc --noEmit
npm run check:cron-connections
```

Docs:

- [docs/live-reserves.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/live-reserves.md) only if operator/developer workflow wording needs to reflect the new helper boundaries
- [docs/testing.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md) if the reserve-sync test surface materially expands

## Phase 5 - Frontend Query Contract And Coverage Cleanup

### `PR-07` Frontend query contract cleanup and hook coverage

Findings covered:

- `F4`
- `F7`

Objective:

Make the query layer easier to reason about and directly test the hidden logic that components currently mock away.

Primary files:

- [src/lib/api.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/lib/api.ts)
- [shared/lib/api-endpoints.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/api-endpoints.ts)
- [src/hooks/use-depeg-events.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-depeg-events.ts)
- [src/hooks/use-mint-burn-flows.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-mint-burn-flows.ts)
- [src/hooks/use-stablecoin-reserves.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-stablecoin-reserves.ts)
- [src/hooks/use-blacklist-events.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-blacklist-events.ts)
- [src/hooks/use-chains.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-chains.ts)
- new tests under `src/hooks/__tests__/`

Implementation tasks, part A: `strictContract`

1. Decide one policy and encode it consistently:
   - preferred: remove `strictContract` as dead runtime metadata if schema-driven strict validation is the real policy
2. Remove the unused runtime import and any dead branches/tests around that concept.
3. Keep endpoint metadata only if it still serves CI coverage or documentation generation; otherwise remove it there too.

Implementation tasks, part B: hook coverage

1. Add direct tests for `useInfiniteDepegEvents`:
   - page accumulation
   - termination at `total`
   - `autoLoadAll` retry ceiling
2. Add direct tests for `useMintBurnFlows` normalization:
   - intensity semantic normalization
   - `pressureShiftState` fallback
   - `netFlowDirection24h` fallback
   - baseline field normalization
3. Add direct tests for `useStablecoinReserves`:
   - live mode stale/refetch interval
   - fallback mode stale/refetch interval
   - 404 null behavior
4. Add at least light tests for query-key stability and parameter shaping in blacklist and chain hooks.

Validation:

```bash
npm test -- src/hooks/__tests__/query-polling-policy.test.ts src/hooks/__tests__/*.test.ts src/app/chains/[chain]/client.test.tsx
npm run build
npm run lint
```

Docs:

- [docs/testing.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md)
  - update hook test surface description if new suites are added
- no API-reference change expected unless contract-mode semantics are externally documented and need cleanup

## Phase 6 - Documentation And Final Closeout

### `PR-08` Documentation, backlog refresh, and final convergence

Goal:

- close documentation gaps created by the implementation work
- reconcile hotspot/backlog metadata
- run the full repo validation surface once the train is merged locally

Primary files:

- [docs/testing.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md)
- [docs/worker-and-api-limits.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/worker-and-api-limits.md)
- optional:
  - `docs/yield-intelligence.md`
  - `docs/pricing-pipeline.md`
  - `docs/live-reserves.md`
- [2026-03-29-hotspot-decomposition-backlog.md](/Users/ahirice/Documents/git/stablecoin-dashboard/agents/plans/2026-03-29-hotspot-decomposition-backlog.md)
- hotspot ratchet baseline if intentionally refreshed

Tasks:

1. Update test-surface documentation for the new regression suites.
2. Update operator/developer docs if degraded-status semantics changed for malformed persisted JSON.
3. Update the hotspot backlog note with the new report-card status and any remaining deferred splits.
4. Only refresh hotspot baselines if the intended decomposition work is complete and documented.
5. Run full final validation and record the results in the closeout note or PR description.

Final validation:

```bash
npm run check:unused-code
npm run check:shared-cycles
npm run check:hotspot-ratchet
npm run audit:deps
npm run lint
npm run typecheck
npm test
npm run build
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

## Risk Management By Workstream

### `WS1` Persisted-JSON hardening

- Risk:
  degraded-status noise if old bad rows already exist
- Mitigation:
  land observability first, use row-count metadata, and only escalate to degraded once the rate is known or bounded

### `WS2` Report-card decomposition

- Risk:
  accidental export churn or hidden methodology change
- Mitigation:
  keep facade stable, move pure logic only, run report-card tests after each split

### `WS3` Yield registry consolidation

- Risk:
  bad derivation logic causing missing coverage
- Mitigation:
  derive exports from a manifest while snapshot-testing old vs new registry outputs

### `WS4` Supplemental asset deduplication

- Risk:
  flattening family-specific edge cases
- Mitigation:
  preserve gold/silver/fiat-specific helpers and refactor only the repeated scaffolding

### `WS5` Live reserves decomposition

- Risk:
  changed failure categorization in a critical cron
- Mitigation:
  preserve current persistence helpers and build the new outcome object around existing semantics

### `WS6` Frontend query cleanup

- Risk:
  low immediate risk, but possible over-refactoring of the query layer
- Mitigation:
  keep the code change small; bias toward test additions and dead-policy removal, not abstraction churn

## Suggested Commit Boundaries

Use these within each PR to keep review focused:

1. tests or characterization first
2. helper extraction without behavior change
3. call-site migration
4. docs/backlog sync

Do not mix:

- worker cron hardening with report-card decomposition
- yield registry consolidation with live reserves refactor
- docs-only cleanup with runtime changes unless the doc explains the exact behavior changed in that branch

## Deliverables

At the end of the execution train, the repo should contain:

1. hardened persisted-JSON decode behavior in production-critical cron paths
2. decomposed report-card scoring modules behind the same facade
3. a single-source yield registry manifest with derived exports
4. deduplicated supplemental asset loader scaffolding
5. a thinner live-reserves orchestration shell
6. direct tests for the previously under-tested critical hooks
7. updated testing/operations/backlog docs where needed
