# Pricing Integrity Follow-up Implementation Plan

Date: 2026-03-19

Scope:
- Item 1: replace coarse pool fingerprint dedup
- Item 2: widen depeg challenger coverage beyond visible `top_pools_json`
- Item 3: prevent duplicate staged / fallback observations from overweighting `dex_prices`
- Item 4: remove ambiguous symbol-first stablecoin resolution
- Item 5: normalize Fluid reserve balances before balance-health scoring
- Item 6: fix `sync-fx-rates` freshness correctness and fallback-health semantics

Out of scope for this plan:
- adding new external price providers in the same change

## Success Criteria

1. No DEX pool is deduped across sources unless the identity match is exact or uniquely-derived.
2. No single physical pool can contribute multiple times to `dex_prices`, even if it is seen through staged + fallback + direct paths.
3. Depeg confirmation reads from a dedicated challenger set, not the UI-only top-10 pool list.
4. DEX token resolution becomes chain-aware and never falls back to `symbolToIds.get(sym)?.[0]`.
5. Fluid measured balance ratios are used only when reserve decimals are known and normalized; otherwise Fluid stays on neutral balance.
6. FX usable-sync freshness and FX source-data freshness are durably separated, so neither internal pricing consumers nor `/api/health` / `/api/status` can mistake cached fallback for fresh upstream content.
7. Challenger publication is atomic per stablecoin and safe across migration-absent / mixed-deploy environments.
8. The change is migration-safe, backward-compatible during rollout, and fully covered by tests/docs.

## Deliverables

1. Runtime code changes for all six workstreams.
2. At most one new migration family:
   - `dex_price_challengers` table
   - `dex_price_challenger_snapshots` table
   - mandatory `fx-rates-meta` sidecar cache key; no new FX table required
3. Expanded test coverage for DEX identity, depeg challenger loading/publication, Fluid normalization, FX fallback mode, and health/status semantics.
4. Documentation, methodology, and version updates for liquidity, depeg, FX-reference behavior, and status/health semantics where applicable.

## Refinement Loop

### Draft issues identified and resolved

Previous medium issues in the earlier draft:

1. Pool-identity dedupe was still too eager.
   - Risk: a richer derived fingerprint could still collapse legitimate same-pair pools.
   - Refinement: derived dedupe is now one-way and uniqueness-gated. It is used only to map an identity-poor source onto a known exact pool, never to merge two exact-key-bearing pools with different addresses.

2. Challenger retention was still arbitrary.
   - Risk: a simple top-50 rule could still miss a meaningful non-top pool on high-pool-count assets.
   - Refinement: challenger persistence now uses a coverage rule: retain all qualifying challengers until cumulative retained challenger TVL reaches at least 95% of total qualifying challenger TVL, with hard caps only as a safety valve.

3. The FX fix was underspecified.
   - Risk: blindly refreshing `fx-rates.updated_at` on cached fallback would hide stale upstream data behind a fresh cache timestamp.
   - Refinement: the FX workstream now explicitly separates:
     - sync freshness
     - payload provenance / fallback mode
     - public health semantics
     - operator diagnostics

4. Observation dedupe could still bias price selection.
   - Risk: picking a single “winner” observation per duplicate group could overfit source priority.
   - Refinement: duplicate observations now collapse via per-physical-pool internal median/consensus, while TVL is capped at the maximum credible pool TVL rather than summed.

5. FX freshness semantics still leaked through existing consumers.
   - Risk: refreshing `fx-rates.updated_at` on cached fallback would cause `sync-stablecoins`, chart repair, and price validation to treat stale source data as fresh.
   - Refinement: the plan now requires a mandatory `fx-rates-meta` sidecar with distinct `usableSyncAt` and source-freshness metadata, plus migration of all `fx-rates` freshness consumers to a shared loader.

6. Challenger persistence was only safe on reads.
   - Risk: a partial writer or migration-absent deploy could break `sync-dex-liquidity` or silently reduce challenger coverage.
   - Refinement: challenger publication is now per-stablecoin and atomic via a publish-last snapshot table, with explicit schema-presence gating and per-coin legacy fallback.

7. Post-deploy review thresholds were too qualitative.
   - Risk: regressions could pass on judgment calls during a safety-critical rollout.
   - Refinement: the verification section now defines explicit baseline deltas and abort thresholds for DEX coverage, ambiguity rates, challenger publication, Fluid fallback share, and consecutive FX fallback runs.

8. Empty challenger publication could still hide incomplete source coverage.
   - Risk: publishing `has_rows = 0` for a coin whose pool universe was not fully evaluated would suppress both prior challenger data and legacy fallback.
   - Refinement: the plan now requires a per-stablecoin completeness gate. Empty snapshots publish only when the retained pool universe for that coin is known-complete; otherwise the prior published snapshot stays active.

Residual medium issues after this refinement pass: 0

## Design Decisions

1. Ambiguity must fail closed.
   If a token or pool cannot be matched confidently, skip the identity-based optimization instead of guessing.

2. Separate three concepts that are currently conflated:
   - display pools for `/api/dex-liquidity`
   - challenger pools for depeg logic
   - price observations for `dex_prices`

3. Use chain-aware lookups everywhere.
   Address-only lookups are insufficient because identical addresses can exist across chains.

4. Dedup price observations at the physical-pool level, not at the source row level.
   The physical pool should carry weight once.

5. Separate “data content freshness” from “successful sync freshness” where the current semantics conflate them.
   This is required for `sync-fx-rates`, and no consumer may infer one from the other implicitly.

6. Publish challenger data with an explicit publish boundary.
   Readers must never see partially-written challenger state.

7. Keep the public API contract stable unless a new field is required for correctness.
   Internal persistence and cron metadata can expand without changing `/api/dex-liquidity`.

## Sequencing

Execution order:

1. Chain-aware token resolution
2. Pool identity model and dedup rewrite
3. Observation identity + dedupe before `dex_prices`
4. Challenger persistence beyond `top_pools_json`
5. Fluid reserve normalization
6. `sync-fx-rates` freshness/provenance fix
7. Docs, methodology/versioning, verification, rollout

Dependency notes:
- Item 4 is a prerequisite for Items 1, 3, and 5.
- Item 1 is a prerequisite for Item 3.
- Item 2 should consume the post-filter/post-dedup retained pool set from Items 1 and 5.
- Item 6 is logically independent of Items 1-5 and can ship in the same release train or as a tightly-coupled sidecar patch.

## Workstream 1: Chain-Aware Token Resolution

Problem:
- `resolveStablecoinId()` in [dex-api-common.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/dex-api-common.ts) uses address-only lookup and then a first-hit symbol fallback.
- `buildSymbolLookups()` in [pool-helpers.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/pool-helpers.ts) builds `addressToId` without chain context.

Target end state:
- Every DEX token resolution returns either:
  - exact chain-address match,
  - unique chain-scoped symbol match,
  - unresolved / ambiguous
- No first-hit global symbol fallback remains.

Implementation steps:

1. Add a dedicated resolver module.
   Proposed file: `worker/src/cron/dex-liquidity/token-resolution.ts`

2. Replace the current lookup shape with:
   - `chainAddressToId: Map<string, string>` keyed as `${chain}:${address}`
   - `symbolToChainScopedIds: Map<string, Map<string, string[]>>`
   - optional `globalSymbolToIds` only for diagnostics, not final resolution
   - `contractMetaByChainAddress` carrying `decimals`, `source = contract|tradedContract`, and canonical id

3. Replace `resolveStablecoinId(...)` with a structured resolver such as:
   - input: `{ chain, address, symbol }`
   - output:
     - `status: "matched" | "ambiguous" | "unresolved"`
     - `stablecoinId?: string`
     - `matchType?: "chain-address" | "unique-chain-symbol"`

4. Resolution rules:
   - first: exact `${chain}:${address}` lookup across `contracts` + `tradedContracts`
   - second: if symbol exists, use chain-scoped symbol fallback only when exactly one tracked coin with that normalized symbol is deployed/traded on that chain
   - otherwise: unresolved / ambiguous

5. Update all DEX call sites to pass `chain` into token resolution:
   - [dex-api-common.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/dex-api-common.ts)
   - [fetch-primary.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/fetch-primary.ts)
   - [fetch-fallbacks.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/fetch-fallbacks.ts)
   - any discovery/crawler code that still assumes global symbol fallback

6. Add cron diagnostics:
   - `tokenResolutionAmbiguous`
   - `tokenResolutionSymbolFallbackUsed`
   - `tokenResolutionSkipped`

Acceptance criteria:
- No `?.[0]` symbol fallback remains in DEX token matching.
- Same-symbol collisions only resolve when chain-scoped uniqueness exists.
- Same-address-across-chains cases do not collide.

Tests:
- extend [dex-api-common.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/dex-api-common.test.ts)
- extend [dex-liquidity-pool-helpers.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts)
- add cases for:
  - same symbol on multiple chains
  - same address reused on multiple chains
  - chain-unique symbol fallback
  - ambiguous symbol fallback returning unresolved

## Workstream 2: Pool Identity Model and Dedup Rewrite

Problem:
- `buildPoolFingerprint()` in [pool-helpers.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/pool-helpers.ts) uses `chain + normalized protocol + sorted token set`.
- That collapses distinct same-pair pools into one synthetic identity.

Target end state:
- Dedup uses a richer `PoolIdentity` model with exact and derived confidence levels.
- Derived identity is used only when it is uniquely matchable and only to map an identity-poor source onto a known exact pool.

Implementation steps:

1. Introduce a shared `PoolIdentity` helper.
   Proposed file: `worker/src/cron/dex-liquidity/pool-identity.ts`

2. `PoolIdentity` should expose:
   - `exactPoolKey`
     - `${chain}:${poolAddress}` for on-chain pools
     - source-native exact id for orderbook/synthetic pools
   - `derivedMatchKey`
     - normalized chain
     - normalized protocol family
     - normalized token set
     - pool shape family (`stable`, `weighted`, `concentrated`, `generic`, `orderbook`)
     - fee tier bucket when available
     - stable/volatile classification when available
   - `matchConfidence`
     - `exact`
     - `derived_unique`
     - `derived_ambiguous`
     - `none`
   - `identitySource`
     - `address`
     - `native-id`
     - `token-shape-heuristic`

3. Replace `knownPoolAddrs: Set<string>` with a richer lookup object:
   - `exactKeys: Set<string>`
   - `derivedKeyCounts: Map<string, number>`
   - `derivedToExactKeys: Map<string, Set<string>>`
   - helper `isKnownPool(identity)` returning:
     - exact match
     - unique derived match
     - ambiguous derived collision

4. Update all dedup sites to use the new helper:
   - `filterPrimaryPoolsPreferDirectApi()` in [orchestrator.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/orchestrator.ts)
   - direct-API merge path in [orchestrator.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/orchestrator.ts)
   - staged merge in [staging-merge.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/staging-merge.ts)
   - DexScreener fallback dedup in [fetch-fallbacks.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/fetch-fallbacks.ts)
   - any known-pool builders in [fetch-primary.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/fetch-primary.ts)

5. New dedup policy:
   - exact address/source-id match: always dedupe
   - derived match:
     - dedupe only when the incoming pool lacks a trustworthy exact key or the comparison source lacks one
     - dedupe only when the key maps to exactly one exact pool in the known pool set and exactly one candidate in the incoming set
     - otherwise keep both pools and mark as ambiguous
   - never merge two pools that both have distinct exact keys
   - orderbook pools: exact-only

6. Add metadata/logging:
   - `skippedByExactIdentity`
   - `skippedByUniqueDerivedIdentity`
   - `ambiguousDerivedMatchesKept`
   - `derivedIdentityLinkedToExact`

Acceptance criteria:
- Distinct same-pair pools on the same chain/protocol are preserved unless the identity match is exact.
- Direct API no longer suppresses a legitimate second DL pool solely because token set matches.

Tests:
- extend [dex-liquidity-pool-helpers.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts)
- extend [sync-dex-liquidity.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/sync-dex-liquidity.test.ts)
- add cases for:
  - two same-pair pools with different fee tiers
  - two same-pair pools with different pool shapes
  - exact-address duplicate across DL/direct API
  - ambiguous derived key kept, not suppressed

## Workstream 3: Observation Identity and `dex_prices` Dedup

Problem:
- `DexPriceObs` in [types.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/types.ts) only carries `{ price, tvl, chain, protocol }`.
- staged/fallback/direct observations from the same physical pool can all enter `computeDexPrices()` and overweight the median.

Target end state:
- `dex_prices` aggregation sees one observation per physical pool.
- Duplicate source coverage changes source quality, not physical weight.

Implementation steps:

1. Extend `DexPriceObs` with identity metadata:
   - `poolKey?: string`
   - `derivedMatchKey?: string`
   - `identityConfidence: "exact" | "derived_unique" | "derived_ambiguous" | "none"`
   - `sourceFamily`
   - `sourcePriority`

2. Populate these fields at every producer:
   - Curve in [fetch-primary.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/fetch-primary.ts)
   - UniV3 / Aerodrome subgraph helpers
   - direct APIs via [dex-api-common.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/dex-api-common.ts)
   - staged merge in [staging-merge.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/staging-merge.ts)
   - DexScreener / CG ticker fallback in [fetch-fallbacks.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/fetch-fallbacks.ts)

3. Add a new `dedupeDexPriceObservations()` step before `computeDexPrices()`:
   - group by `poolKey` when exact
   - otherwise group by unique `derivedMatchKey`
   - ambiguous/no-identity observations remain separate

4. Within each duplicate group, choose one representative observation using deterministic priority:
   - first compute an internal duplicate-group median price:
     - exact groups: median of duplicate observations weighted by source-priority weights only
     - derived groups: same, but require `derived_unique`
   - then choose a representative label/source using:
     - highest `identityConfidence`
     - highest `sourcePriority`
     - freshest source family when freshness differs
     - largest TVL
     - stable lexical tie-break

5. Representative values:
   - `price`: duplicate-group internal median price
   - `tvl`: maximum credible TVL in the duplicate group, not sum
   - `protocol`: representative protocol/source label
   - `sourceFamily`: representative source family label for metadata/debug only

6. Keep protocol aggregation downstream, but run it on the deduped observation set only.

7. Add cron metadata:
   - `rawDexPriceObservationCount`
   - `dedupedDexPriceObservationCount`
   - `duplicateObservationGroups`
   - `ambiguousObservationCount`

Acceptance criteria:
- One physical pool contributes weight once to `dex_prices`.
- Repeated discovery of the same pool via GT/CG/DS does not move the median more than choosing a better representative.

Tests:
- extend [dex-liquidity-scoring.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/dex-liquidity-scoring.test.ts)
- extend [dex-liquidity-direct-api.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts)
- add cases for:
  - same pool seen in staged + DexScreener
  - same pool seen in DL + direct API
  - ambiguous observations preserved separately
  - representative TVL uses max, not sum

## Workstream 4: Dedicated Challenger Persistence Beyond `top_pools_json`

Problem:
- depeg confirmation currently reads [top_pools_json](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/depeg-helpers.ts) which is a display-oriented top-10 subset.
- large challenger pools outside that visible subset can be missed.

Target end state:
- depeg logic reads from a dedicated challenger dataset built from the retained post-filter pool universe.

Implementation steps:

1. Add one migration family with two tables.
   Proposed migration: `worker/migrations/0069_dex_price_challengers.sql`

2. Schema:

```sql
CREATE TABLE IF NOT EXISTS dex_price_challengers (
  stablecoin_id TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL,
  pool_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  protocol TEXT NOT NULL,
  source_family TEXT NOT NULL,
  price_usd REAL NOT NULL,
  tvl_usd REAL NOT NULL,
  PRIMARY KEY (stablecoin_id, snapshot_at, pool_id)
);

CREATE INDEX IF NOT EXISTS idx_dex_price_challengers_lookup
  ON dex_price_challengers(stablecoin_id, snapshot_at);

CREATE TABLE IF NOT EXISTS dex_price_challenger_snapshots (
  stablecoin_id TEXT PRIMARY KEY,
  snapshot_at INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  has_rows INTEGER NOT NULL CHECK (has_rows IN (0, 1))
);
```

3. Build challenger candidates from the retained pool set after:
   - source dedup
   - bad pool filtering
   - protocol TVL caps
   - Fluid normalization

4. Candidate selection rules:
   - valid pool price present
   - TVL >= `POOL_CHALLENGE_MIN_TVL`
   - retain challengers in descending TVL order until cumulative retained challenger TVL reaches at least 95% of total qualifying challenger TVL
   - always retain at least 10 challengers when 10 qualify
   - hard-cap at 100 rows per stablecoin as a D1/storage safety valve
   - exact `pool_id` persisted for replay/debug

5. Add an explicit table-capability guard before any writer path:
   - detect `dex_price_challengers` + `dex_price_challenger_snapshots` via `sqlite_master` once per run
   - if absent, skip challenger writes, log `challengerPersistenceMode = "legacy-no-table"`, and continue the cron successfully
   - do not rely on deployment ordering alone for writer safety

6. Persistence behavior must publish per stablecoin, never by “table has any rows”:
   - build all challenger rows for a stablecoin in memory first
   - compute `sourceCoverageComplete` for that stablecoin from the retained-pool build:
     - true only when the coin’s eligible pool universe was fully evaluated under the run’s fetch/degradation rules
     - false when any required source path for that coin failed, timed out, or returned an indeterminate partial result
   - insert rows for `snapshot_at = runStartSec`
   - only after inserts succeed, upsert `dex_price_challenger_snapshots(stablecoin_id, snapshot_at, published_at, has_rows)` for that stablecoin
   - publish `has_rows = 0` only when `sourceCoverageComplete = true`
   - if `sourceCoverageComplete = false`, do not publish a new snapshot row for that stablecoin; keep the prior published snapshot active and emit `challengerPublishSkippedIncomplete`
   - cleanup of older snapshots/rows is best-effort and happens only after publish
   - readers trust only the published snapshot row for each stablecoin

7. Update [depeg-helpers.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/depeg-helpers.ts):
   - `loadDexPoolChallengers()` reads published challenger snapshots per stablecoin
   - if no snapshot row exists for a stablecoin, fall back for that stablecoin only
   - if a published snapshot says `has_rows = 1` but no rows are returned, log and fall back for that stablecoin only
   - keep current `top_pools_json` / `price_sources_json` readers as backward-compatible per-coin fallback until the new path has been stable for at least one release cycle

8. Update docs / methodology:
   - depeg detection docs should state that challenger confirmation now reads a dedicated challenger set, not the UI top-10 slice

Acceptance criteria:
- Challenger selection is no longer constrained by the visible `top_pools_json` truncation.
- `detectDepegEvents()` and `confirmPendingDepegs()` behave identically on old deployments, and prefer published challenger-snapshot data on migrated deployments.
- Partial challenger writes are not visible to readers.
- Missing challenger tables do not break `sync-dex-liquidity`.
- Incomplete per-coin pool builds do not publish false empty challenger snapshots.

Tests:
- extend [detect-depegs.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/detect-depegs.test.ts)
- extend [confirm-pending-depegs.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/confirm-pending-depegs.test.ts)
- add cases for:
  - challenger exists outside visible top 10 and confirms depeg
  - published challenger snapshot preferred over `top_pools_json`
  - pre-migration fallback remains functional
  - absent challenger tables do not fail the writer
  - partially-inserted unpublished rows are ignored
  - published snapshot with missing rows falls back per stablecoin
  - incomplete pool coverage keeps the previous snapshot instead of publishing `has_rows = 0`

## Workstream 5: Fluid Reserve Normalization

Problem:
- [fetch-fluid.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dex-liquidity/fetch-fluid.ts) currently writes raw resolver balances as `Number(bigint)` with token `decimals: 0`.
- those balances can be misinterpreted as normalized inventory and distort balance-health scoring.

Target end state:
- Fluid balance metrics are computed only from normalized reserves.
- Unsupported or unknown decimals fall back to neutral balance rather than bad measured balance.

Implementation steps:

1. Add a chain-aware token metadata resolver used by Fluid:
   - first source: tracked stablecoin contract metadata from `contracts` / `tradedContracts`
   - second source: static known quote-token metadata if already maintained in repo
   - third source: on-chain `decimals()` RPC read with per-run memoization
   - fourth source: long-lived cache-table memoization keyed by `token-decimals:${chain}:${address}` with conservative TTL, only if RPC lookup exists and succeeds

2. Keep raw reserves as `bigint` until normalization is complete.

3. Normalize balances before writing to `DexApiPool.balances`:
   - `normalized = raw / 10^decimals`
   - only convert to `number` after normalization and finite-range guard
   - reject values outside safe numeric range before any ratio math

4. If either token decimals cannot be resolved safely:
   - keep `balances = null`
   - log a measured-balance skip counter
   - do not attempt partial measured-balance scoring
   - do not block the rest of the Fluid pool from contributing liquidity / price observations

5. Add diagnostics:
   - `fluidMeasuredBalancePools`
   - `fluidNeutralBalanceFallbackPools`
   - `fluidUnknownDecimalsPools`
   - `fluidDecimalsResolvedFromTrackedMeta`
   - `fluidDecimalsResolvedFromRpc`
   - `fluidDecimalsResolvedFromCache`

6. Recheck fee handling separately from reserve normalization, but do not couple them.

Acceptance criteria:
- Fluid pools on resolver-backed chains only contribute measured balance ratios when decimals are known.
- Resolver-backed pools no longer pass raw reserve magnitudes into balance-health scoring.

Tests:
- extend [dex-liquidity-direct-api.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts)
- extend [dex-api-common.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/dex-api-common.test.ts)
- add cases for:
  - 6-decimal vs 18-decimal normalization
  - unknown decimals forcing neutral-balance fallback
  - very large bigint reserves normalized safely

## Workstream 6: `sync-fx-rates` Freshness Correctness and Fallback Semantics

Problem:
- [sync-fx-rates.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-fx-rates.ts) has cached-fallback early returns that reuse prior rates without refreshing `fx-rates.updated_at`.
- the optional OXR branch can fail before the final `fx-rates` write because its cache/circuit side effects are not fully isolated from the main cache write path.
- [buildCacheStatuses()](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/api-utils.ts) currently interprets `fx-rates` freshness from cache-row age alone, so public health conflates “last successful sync” with “last content write”.

Target end state:
- `sync-fx-rates` always records a successful usable-sync outcome when it has a valid rate set to serve, even when the values came from cached fallback.
- FX pricing consumers use source-data freshness, not cache-row freshness, when deciding whether a peg reference is fresh enough to trust.
- public health/status no longer go stale solely because the FX job reused still-valid cached rates.
- operator surfaces still expose when FX is running in fallback mode or when source freshness is lagging.
- optional OXR telemetry/cache writes cannot fail the whole FX cron after a usable rate set has already been assembled.

Implementation steps:

1. Introduce a shared FX-state loader/writer helper.
   Proposed file: `worker/src/lib/fx-rate-state.ts`

2. Persist two durable FX records:
   - `fx-rates`: latest usable rate payload
   - `fx-rates-meta`: mandatory sidecar cache key storing:
     - `usableSyncAt`
     - `mode: "live" | "cached-fallback"`
     - `sourceUpdatedAtByPeg: Record<string, number | null>`
     - `sourceModeByPeg: Record<string, "live" | "cached" | "hardcoded">`
     - `sources`
     - `ecbDate`
     - `previousCacheUpdatedAt`
     - `consecutiveFallbackRuns`

3. Split FX runtime state into two concepts in code and in persistence:
   - `usableRates`: the rate set downstream pricing may consume
   - `sourceFreshness`: per-peg source freshness/provenance for the values inside `usableRates`

4. Replace the two early-return branches with a single unified write path:
   - when Frankfurter transport or payload validation fails and prior cached rates exist, build a degraded result object instead of returning before the write block
   - continue through the standard metadata + write path using the cached rate set as `usableRates`
   - on cached fallback, inherit `sourceUpdatedAtByPeg` and `sourceModeByPeg` from the previous metadata rather than rewriting them to `syncStartSec`

5. Update all FX freshness consumers to use the shared loader instead of `getCache(db, "fx-rates")` directly:
   - [price-validation.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/price-validation.ts)
   - [sync-stablecoins/shared.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins/shared.ts)
   - [sync-stablecoin-charts.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoin-charts.ts)
   - any additional direct `fx-rates` readers found by repo-wide search during implementation
   - bootstrap rule: when `fx-rates-meta` is absent or corrupt but `fx-rates` exists, synthesize compatibility metadata using `fx-rates.updated_at` as both `usableSyncAt` and conservative source freshness until the first successful new-format `sync-fx-rates` run writes canonical metadata

6. Extend `PriceValidationReferences` if needed so pricing can use per-peg freshness rather than one global FX timestamp:
   - add `updatedAtByPeg?: Record<string, number | null>`
   - add `typeByPeg?: Record<string, PriceReferenceType>`
   - keep current global fields as conservative defaults for callers not yet migrated
   - update validation helpers to prefer per-peg freshness when available

7. Do not let public cache freshness infer source freshness:
   - `buildCacheStatuses()` must use `fx-rates-meta.usableSyncAt` for the `fx-rates` cache health lane
   - extend [shared/types/status.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/types/status.ts) `CacheStatus` shape if needed to expose:
     - `mode`
     - `sourceUpdatedAt`
     - `sourceAgeSeconds`
     - `warning`
   - update both [health.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/health.ts) and [status.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/status.ts) so they agree on FX semantics

8. Define explicit health/status policy for fallback mode:
   - healthy cache lane: `usableSyncAt` is within freshness threshold
   - warning metadata: any run in `cached-fallback`
   - degrade overall status after 4 consecutive cached-fallback runs or if any non-USD peg source age exceeds 6 hours
   - treat FX as stale only when no usable sync exists within threshold or when source freshness for a required peg exceeds 24 hours

9. Isolate OXR side effects:
   - wrap `fx-oxr-last-fetch` writes in best-effort handling
   - wrap `recordOutcome(FX_REALTIME, ...)` in best-effort handling or replace with `recordOutcomeSafe(...)`
   - ensure a D1 failure in OXR telemetry does not abort the main `fx-rates` / `fx-rates-meta` writes after `usableRates` already exists
   - add a hard request timeout to [fetchRealtimeFxRates()](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/fx-realtime.ts) rather than raw unbounded `fetch`

10. Add a narrow helper layer instead of expanding ad-hoc branching:
   - `buildFxSyncResult(...)`
   - `persistFxRatesAndMetadata(...)`
   - `loadFxRateState(...)`
   - `buildFxHealthMetadata(...)`

11. Extend docs/API contracts if health/status output changes:
   - document that usable-sync freshness and source-data freshness are separate
   - document any new warnings/metadata fields for `/api/health` and `/api/status`

Acceptance criteria:
- a Frankfurter 503 with valid cached FX rates results in:
  - fresh `usableSyncAt` in `fx-rates-meta`
  - cron status `degraded`, not `error`
  - explicit fallback provenance in metadata
- cached fallback does not cause `loadFreshFxRates()` or `loadPriceValidationReferences()` to treat old source data as newly fresh
- an OXR side-effect write failure does not prevent the main `fx-rates` cache update
- `/api/health` no longer turns `stale` solely because FX stayed in cached-fallback mode while usable rates were still available
- `/api/status` and `/api/health` agree on FX freshness/provenance semantics
- operator-visible warnings still make persistent upstream fallback obvious

Tests:
- extend [sync-fx-rates.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/sync-fx-rates.test.ts)
- extend [health.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/health.test.ts)
- extend [status.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/status.test.ts)
- extend [api-utils.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/api-utils.test.ts) if cache-status semantics change
- extend [fx-realtime.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/fx-realtime.test.ts)
- extend [price-validation.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/__tests__/price-validation.test.ts)
- extend [sync-stablecoin-charts.test.ts](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/__tests__/sync-stablecoin-charts.test.ts)
- add cases for:
  - Frankfurter transport failure + cached fallback still refreshes usable-sync freshness without changing source freshness
  - Frankfurter invalid payload + cached fallback still refreshes usable-sync freshness without changing source freshness
  - no cached fallback still throws
  - OXR telemetry/cache write failure does not abort the final FX cache write
  - `/api/health` exposes fallback warning/provenance as designed
  - `/api/status` exposes the same FX warning/provenance semantics
  - `loadFreshFxRates()` rejects stale source freshness even when `usableSyncAt` is fresh
  - chart FX repair skips stale per-peg FX references

## Migration and Rollout Plan

1. Ship the challenger migration family first where possible, but do not trust ordering alone.
   The runtime must still tolerate absent challenger tables by skipping writes and using per-coin legacy fallback.

2. Land runtime changes in one branch/PR sequence, but keep deploy-safe ordering:
   - token resolution + pool identity helpers
   - observation dedupe
   - challenger persistence + reader
   - Fluid normalization
   - `sync-fx-rates` freshness/provenance fix

3. Do not remove the legacy fallback readers in the same release that introduces the challenger tables.
   Likewise, do not remove any FX fallback warning path in the same release that changes cache freshness semantics.

4. Replace all direct `getCache(db, "fx-rates")` freshness decisions before relying on `fx-rates-meta`.
   Implementation is not complete until repo-wide search shows no freshness-sensitive FX caller still bound to raw cache-row timestamps.

5. Add log/metadata instrumentation in the same change so post-prod validation can compare:
   - raw vs deduped observation counts
   - exact vs derived dedup counts
   - ambiguous match counts
   - published challenger snapshots and rows written
   - Fluid measured vs skipped balance counts
   - FX fallback-mode runs
   - FX source-provenance warnings
   - OXR side-effect failures that were downgraded to best-effort

## Documentation and Versioning Updates Required

When implemented, update all affected docs in the same change:

- [docs/pricing-pipeline.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/pricing-pipeline.md)
- [docs/dex-liquidity.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/dex-liquidity.md)
- [docs/depeg-detection.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/depeg-detection.md)
- [docs/classification.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/classification.md)
- [docs/data-pipeline.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/data-pipeline.md)
- [docs/worker-infrastructure.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/worker-infrastructure.md)
- [docs/api-reference.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/api-reference.md) if `/api/health` or FX warnings gain fields
- [shared/types/status.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/types/status.ts) if cache/status metadata expands
- [docs/liquidity-score-timeline.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/liquidity-score-timeline.md)
- [docs/depeg-dews-timeline.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/depeg-dews-timeline.md)
- [src/app/methodology/methodology-sections.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/methodology/methodology-sections.tsx)
- [shared/lib/liquidity-score-version.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/liquidity-score-version.ts)
- [shared/lib/depeg-dews-version.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/depeg-dews-version.ts)
- [shared/lib/pricing-pipeline-version.ts](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/pricing-pipeline-version.ts) if the primary-price bridge semantics change materially
- [src/app/about/page.tsx](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/about/page.tsx) and [docs/about-page.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/about-page.md) only if the external FX/reference source list changes

## Verification Plan

Required local gate:

- `npm run lint`
- `npm run build`
- `npm test`
- `cd worker && npx tsc --noEmit`
- targeted suites:
  - `worker/src/cron/__tests__/dex-api-common.test.ts`
  - `worker/src/cron/__tests__/dex-liquidity-pool-helpers.test.ts`
  - `worker/src/cron/__tests__/dex-liquidity-scoring.test.ts`
  - `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`
  - `worker/src/cron/__tests__/detect-depegs.test.ts`
  - `worker/src/cron/__tests__/confirm-pending-depegs.test.ts`
  - `worker/src/cron/__tests__/sync-fx-rates.test.ts`
  - `worker/src/api/__tests__/health.test.ts`
  - `worker/src/api/__tests__/status.test.ts`
  - `worker/src/lib/__tests__/api-utils.test.ts`
  - `worker/src/lib/__tests__/fx-realtime.test.ts`
  - `worker/src/lib/__tests__/price-validation.test.ts`
  - `worker/src/cron/__tests__/sync-stablecoin-charts.test.ts`

Required post-deploy checks:

1. Establish a baseline from the last 3 successful pre-deploy runs for:
   - stablecoins with `dex_prices`
   - raw and deduped observation counts
   - ambiguous observation count
   - challenger rows/snapshots published
   - challenger TVL coverage ratio (`published challenger TVL / qualifying challenger TVL`)
   - Fluid neutral-balance fallback share on resolver-backed chains
   - FX consecutive fallback run count
2. Confirm successful `sync-dex-liquidity` run with published challenger snapshots.
   Abort threshold: any stablecoin with qualifying challengers but no published snapshot row.
3. Confirm challenger coverage did not collapse while snapshots continued publishing.
   Abort threshold: median challenger TVL coverage ratio falls below 95%, or any top-25 stablecoin with qualifying challengers publishes below 90% challenger TVL coverage without an explained upstream-source outage.
4. Confirm `dex_prices` coverage did not regress materially.
   Abort threshold: more than 2% drop vs baseline in stablecoins with `dex_prices`, or any top-25 stablecoin losing `dex_prices` unexpectedly.
5. Confirm observation dedupe stayed within expected bounds.
   Abort threshold: deduped observation count > raw count, deduped/raw < 0.50, or ambiguous/raw > 0.15 and >2x baseline.
6. Confirm `sync-stablecoins` and `confirm-pending-depegs` complete without new depeg false positives on a spot sample.
   Abort threshold: any false positive on a top-25 stablecoin attributable to missing challenger coverage.
7. Inspect a small sample of same-pair pools previously vulnerable to coarse fingerprint collapse.
   Abort threshold: any pair of distinct exact-key pools incorrectly collapsed.
8. Inspect a sample of Fluid pools on resolver-backed chains and verify measured balance ratios only appear when decimals were resolved.
   Abort threshold: neutral-balance fallback share rises by more than 10 percentage points vs baseline or exceeds 30% absolute without an explained metadata-source outage.
9. Confirm `sync-fx-rates` completes through one live-success path and one forced/degraded fallback path in staging or controlled test conditions.
   Abort threshold: cached fallback marks source freshness fresh, or `fx-rates-meta` fails to publish.
10. Confirm both `/api/health` and `/api/status` show the intended FX semantics:
   - fresh usable-sync status
   - explicit fallback warning/provenance when applicable
   - matching interpretation across both endpoints
11. Monitor the next two `sync-dex-liquidity` runs, next two quarter-hour depeg cycles, and next two `sync-fx-rates` runs.
    Abort threshold: 4 consecutive FX cached-fallback runs without a corresponding warning/degraded status, or any source-freshness age exceeding 24 hours without escalation.

## Residual Risks After This Plan

Expected low residual risks:
- some staged/fallback observations will remain intentionally unresolved when identity is ambiguous
- challenger storage increases D1 write volume modestly, but only on the half-hour scoring lane
- Fluid non-resolver chains will remain on neutral balance until a trustworthy resolver path exists

Residual medium issues after implementing this plan: 0
