# DEX Liquidity Expansion Plan

Date: 2026-03-24

Scope:

- Implement protocol-native liquidity sources for:
  - Meteora DLMM
  - PancakeSwap
  - Aerodrome Slipstream
  - Velodrome Slipstream

Goal:

- Increase primary-grade stablecoin DEX coverage.
- Reduce dependence on `cg_onchain`, `gecko_terminal`, and `dexscreener` for major venues.
- Preserve current scoring, dedupe, and challenger semantics.

## Architecture Decision

Use two integration styles:

1. **Meteora DLMM** as a new `direct_api` fetcher
2. **PancakeSwap / Aerodrome Slipstream / Velodrome Slipstream** as new **subgraph-backed direct pool sources**

Why:

- The current direct-source path already knows how to:
  - normalize protocol-native pools into `DexApiPool`
  - hydrate balances / fees / prices
  - convert them into scoreable `GtNewPool` rows
  - extract `DexPriceObs`
  - dedupe them against DeFiLlama and staged pools before scoring
- The current `fetchUniV3Data()` / `fetchAerodromeData()` path is enrichment-only. It improves fee tiers and price observations, but it does **not** add missing pools into `metrics`.
- For actual coverage expansion, Pancake and Slipstream need to land in the **direct pool path**, not only the enrichment path.

Resulting target model:

- DeFiLlama remains the broad baseline
- Curve remains special-cased
- UniV3 and legacy Aerodrome enrichment stay in place for existing logic
- New sources produce `DexApiPool[]` and enter the same merge path as Fluid / Balancer / Raydium / Orca

## Current Code Touchpoints

Primary orchestration:

- `worker/src/cron/dex-liquidity/orchestrator.ts`

Direct-source utilities:

- `worker/src/lib/dex-api-common.ts`
- `worker/src/lib/dex-api-types.ts`

Existing direct fetchers:

- `worker/src/cron/dex-liquidity/fetch-fluid.ts`
- `worker/src/cron/dex-liquidity/fetch-balancer.ts`
- `worker/src/cron/dex-liquidity/fetch-raydium.ts`
- `worker/src/cron/dex-liquidity/fetch-orca.ts`

Subgraph helpers:

- `worker/src/cron/dex-liquidity/fetch-primary.ts`
- `worker/src/cron/dex-liquidity/subgraph-helpers.ts`
- `worker/src/cron/dex-liquidity/constants.ts`

Pool typing / quality:

- `worker/src/cron/dex-liquidity/pool-helpers.ts`
- `worker/src/lib/dex-constants.ts`

Token matching / identity dedupe:

- `worker/src/cron/dex-liquidity/token-resolution.ts`
- `worker/src/cron/dex-liquidity/pool-identity.ts`

Tests:

- `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`
- `worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts`
- `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-persistence.test.ts`

Docs to update:

- `docs/dex-liquidity.md`
- `docs/liquidity-score-timeline.md`
- `src/app/methodology/sections/core-sections.tsx`
- `src/app/methodology/sections/core-sections-pricing.tsx`

## Pre-Implementation Decisions

Make these decisions before coding:

1. **Pancake scope**
   - Phase 1: `Pancake V3` + `Pancake StableSwap`
   - Optional Phase 2: `Pancake V2`
   - Rationale: V3 and StableSwap are the highest-value stablecoin venues; V2 adds breadth but lower quality.

2. **Slipstream scope**
   - Implement `Aerodrome Slipstream` and `Velodrome Slipstream` as separate sources, even if they share schema.
   - Keep existing legacy Aerodrome pair enrichment until Slipstream is verified in prod.

3. **Source family**
   - All four new integrations should publish as `sourceFamily: "direct_api"` in the current model.
   - This avoids adding a new coverage class unless the existing `direct_api` semantics become misleading.

4. **Feature flag rollout**
   - Strongly recommended: add per-source enable flags in code or env so rollout can be staged.
   - At minimum, gate each source by circuit breaker and tolerate partial failure.

## Phase 1: Shared Plumbing

### 1. Add new pool types and quality multipliers

Files:

- `worker/src/lib/dex-constants.ts`
- `worker/src/cron/dex-liquidity/pool-helpers.ts`

Changes:

- Add explicit pool types for:
  - `meteora-dlmm`
  - `pancakeswap-v3-1bp`
  - `pancakeswap-v3-5bp`
  - `pancakeswap-v3-30bp`
  - `pancakeswap-stableswap`
  - `pancakeswap-v2`
  - `aerodrome-slipstream-1bp`
  - `aerodrome-slipstream-5bp`
  - `aerodrome-slipstream-30bp`
  - `velodrome-slipstream-1bp`
  - `velodrome-slipstream-5bp`
  - `velodrome-slipstream-30bp`

- Map quality multipliers:
  - CL 1bp -> same as Uni V3 1bp
  - CL 5bp -> same as Uni V3 5bp
  - CL 30bp+ -> same as Uni V3 30bp
  - Pancake StableSwap -> same as Balancer/Curve stable-ish tier (`0.85`)
  - Pancake V2 -> generic AMM / volatile tier (`0.3` or `0.4` if justified)
  - Meteora DLMM -> concentrated-liquidity tier (`0.85`)

### 2. Extend circuit-breaker source keys

Files:

- `worker/src/lib/constants.ts`

Add:

- `METEORA_API`
- `PANCAKESWAP_API` or separate:
  - `PANCAKESWAP_V3_SUBGRAPH`
  - `PANCAKESWAP_STABLESWAP_SUBGRAPH`
  - `PANCAKESWAP_V2_SUBGRAPH` if included
- `AERODROME_SLIPSTREAM_SUBGRAPH`
- `VELODROME_SLIPSTREAM_SUBGRAPH`

### 3. Optional: centralize CL fee-tier classification

Files:

- `worker/src/lib/dex-api-common.ts`
- or a new helper under `worker/src/cron/dex-liquidity/`

Add helper:

- `classifyConcentratedPoolType(protocol, feeTierBps)`

Reason:

- Uni, Pancake, Aerodrome Slipstream, and Velodrome Slipstream will all need the same fee-bucket logic.

## Phase 2: Meteora DLMM

### Implementation approach

Build a new direct fetcher using Meteora's public DLMM API and normalize results into `DexApiPool`.

### New file

- `worker/src/cron/dex-liquidity/fetch-meteora.ts`

### Expected input mapping

From the Meteora DLMM API, map:

- pool id/address -> `poolAddress`
- token mints -> `tokens[].address`
- token symbols -> `tokens[].symbol`
- token decimals -> `tokens[].decimals` if exposed, otherwise resolve later
- TVL -> `tvlUsd`
- 24h volume -> `volume24hUsd`
- pool price -> `price`
- token amounts / reserves -> `balances`
- dynamic/base fee -> `feeRate` if derivable

### Integration work

Files:

- `worker/src/cron/dex-liquidity/orchestrator.ts`

Steps:

1. Import `fetchMeteoraPools`
2. Add Meteora to `directApiFetchers`
3. Register circuit-breaker usage
4. Include failure telemetry in the existing degraded-source reporting

### Special handling

- Solana address normalization must match current Raydium/Orca behavior.
- If token decimals are absent, rely on `hydrateDirectApiPoolMetadata()`.
- If the API exposes `tvl` and per-token amounts but price fields are inconsistent, prefer:
  - token-level reserve-derived balances for balance health
  - explicit pool price only for price observations

### Tests

Add to:

- `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`

Cover:

- happy-path pagination
- malformed/null TVL rows skipped
- token amount normalization
- fee mapping
- partial page failure -> degraded but non-fatal
- price extraction for tracked stablecoin on both token sides

## Phase 3: PancakeSwap

### Implementation approach

Treat Pancake as a direct pool source backed by official subgraphs, not as a `processPoolMetrics()` enrichment-only path.

### Recommended scope

Phase 3A:

- Pancake V3
- Pancake StableSwap

Phase 3B:

- Pancake V2, only if Phase 3A leaves meaningful BSC stablecoin gaps

### New file

- `worker/src/cron/dex-liquidity/fetch-pancakeswap.ts`

### Constants work

Files:

- `worker/src/cron/dex-liquidity/constants.ts`

Add:

- Pancake subgraph IDs/endpoints by chain for:
  - BSC
  - Base
  - Arbitrum
  - Ethereum
  - zkSync Era
  - Linea
  - Polygon zkEVM
  - opBNB

Add query strings for:

- V3 pools
- StableSwap pools
- V2 pairs if included

### Fetcher shape

The fetcher should:

1. Query each configured chain sequentially or in a bounded fan-out
2. Parse into `DexApiPool`
3. Preserve:
   - pool address
   - chain
   - token addresses / symbols
   - fee tier for V3
   - reserves / balances
   - TVL / reserve USD
   - volume
   - stable-vs-volatile designation
4. Classify pool type:
   - V3 fee buckets -> CL types
   - StableSwap -> `pancakeswap-stableswap`
   - V2 -> `pancakeswap-v2`

### Orchestrator integration

Files:

- `worker/src/cron/dex-liquidity/orchestrator.ts`

Add Pancake fetcher to `directApiFetchers` after Balancer or before Raydium.

Recommendation:

- Order as:
  - Fluid
  - Balancer
  - Pancake
  - Meteora
  - Raydium
  - Orca
  - Slipstream fetchers

This keeps heavy EVM subgraph/API work before Solana APIs and makes fetch logs easier to reason about.

### Dedupe expectations

- Exact pool IDs should dedupe many overlapping DL Pancake rows.
- Derived token-shape matches should only collapse when unique, consistent with current identity rules.
- Pancake StableSwap should not accidentally collapse into non-stable Pancake V2/V3 pools sharing the same token pair.

### Tests

Add / extend:

- `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`
- possibly `worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts` if reusing subgraph helpers

Cover:

- chain-specific V3 pagination
- fee-tier to pool-type mapping
- StableSwap pool parsing
- duplicate same-pair pools with different fee tiers remain distinct identities
- BSC stablecoin address matching
- pools with one tracked stablecoin and one USD reference price correctly emit `DexPriceObs`

## Phase 4: Aerodrome Slipstream

### Implementation approach

Add a dedicated Slipstream fetcher that emits direct pools.

Do **not** replace current `fetchAerodromeData()` immediately.

Instead:

- keep legacy Aerodrome pair enrichment running
- add Slipstream as a separate higher-fidelity direct source
- remove or reduce legacy overlap only after production verification

### New file

- `worker/src/cron/dex-liquidity/fetch-aerodrome-slipstream.ts`

### Constants work

Files:

- `worker/src/cron/dex-liquidity/constants.ts`

Add:

- Aerodrome Slipstream subgraph endpoint(s)
- CL query for pools / positions / fee tier / liquidity / token metadata

### Parsing goals

Map to `DexApiPool`:

- `source: "aerodrome-slipstream"` or `"aerodrome"` if you want one protocol key
- `poolAddress`
- `tokens`
- `tvlUsd`
- `volume24hUsd`
- `feeRate`
- `balances`
- `price`
- `poolType` from fee tier bucket

Recommendation:

- Use protocol key `aerodrome-slipstream` initially.

Reason:

- It keeps identity and telemetry separate from the legacy Aerodrome source.
- It makes rollout safer.

Later, if desired, alias it back into `aerodrome` for UI grouping after validation.

### Existing legacy interaction

Files:

- `worker/src/cron/dex-liquidity/fetch-primary.ts`
- `worker/src/cron/dex-liquidity/process-pools.ts`

Plan:

- leave current `fetchAerodromeData()` and `aerodromeIsStable` logic untouched in the first release
- once Slipstream proves complete, decide whether to:
  - retire legacy Aerodrome enrichment, or
  - keep it only for older non-Slipstream pools

### Tests

Cover:

- fee bucket mapping
- CL pool balance parsing
- direct-source precedence over overlapping DL rows
- exact-vs-derived dedupe against legacy Aerodrome rows

## Phase 5: Velodrome Slipstream

### Implementation approach

Mirror Aerodrome Slipstream using the same fetcher structure, but keep source identity separate.

### New file

- `worker/src/cron/dex-liquidity/fetch-velodrome-slipstream.ts`

### Shared helper recommendation

Because Aerodrome and Velodrome Slipstream will likely share schema:

- create a common helper:
  - `worker/src/cron/dex-liquidity/fetch-slipstream-shared.ts`

This helper should own:

- subgraph request loop
- parsing of CL pools
- fee tier conversion
- token reserve extraction
- mapping into `DexApiPool`

Then the Aerodrome/Velodrome files become thin wrappers that supply:

- source name
- subgraph IDs
- chain map

### Protocol key

Use separate keys:

- `aerodrome-slipstream`
- `velodrome-slipstream`

This keeps protocol TVL and price-source attribution honest.

### Tests

Reuse the same shared test vectors as Aerodrome, with protocol-specific assertions.

## Phase 6: Orchestrator and Dedupe Integration

### Orchestrator

Files:

- `worker/src/cron/dex-liquidity/orchestrator.ts`

Changes:

1. Import all new fetchers
2. Add them to `directApiFetchers`
3. Ensure failures append to:
   - `failedSources`
   - degraded metadata
4. Preserve current sequencing:
   - DL + Curve
   - Uni/Aerodrome enrichment
   - direct sources
   - staging merge
   - fallback sources

### Identity / dedupe review

Files:

- `worker/src/cron/dex-liquidity/pool-identity.ts`
- `worker/src/lib/dex-api-common.ts`

Validation tasks:

- confirm CL fee tier is part of identity for Pancake / Slipstream
- confirm same pair on same protocol but different fee tiers does not over-collapse
- confirm Pancake StableSwap does not collapse into Pancake V3
- confirm Aerodrome Slipstream and Velodrome Slipstream do not collapse into each other on derived token-only keys unless exact identity says they are the same physical pool

If the current identity model is too coarse, extend it before rollout.

This is the highest-risk correctness area.

## Phase 7: Coverage / Confidence / UI Semantics

### Coverage confidence

Files:

- scoring / coverage code under `worker/src/cron/dex-liquidity/`
- `shared/types` if needed

Expectation:

- All four sources should count as `direct_api` and therefore primary-grade coverage under current rules.

Need to verify:

- measurement flags are set accurately:
  - `tvlMeasured`
  - `volumeMeasured`
  - `balanceMeasured`
  - `priceMeasured`
  - `synthetic`

If these flags are sloppy, coverage confidence will overstate quality.

### UI naming

Files:

- API serialization / frontend liquidity components if source labels are surfaced

Need to ensure the new protocol keys render cleanly:

- `meteora`
- `pancakeswap`
- `aerodrome-slipstream`
- `velodrome-slipstream`

If protocol names are normalized elsewhere, add aliases there instead of formatting ad hoc in UI.

## Phase 8: Documentation

Update:

- `docs/dex-liquidity.md`
  - add the four new sources
  - document endpoints, chains, extracted fields, quality multipliers
  - explain Pancake/Slipstream as protocol-native CL sources

- `docs/liquidity-score-timeline.md`
  - new version entry for coverage expansion

- `src/app/methodology/sections/core-sections.tsx`
- `src/app/methodology/sections/core-sections-pricing.tsx`
  - update source tables and narrative text
  - mention Pancake / Meteora / Slipstream in protocol DEX API lists

If price-source promotion behavior changes materially, also update the pricing methodology copy.

## Phase 9: Test Plan

### Unit / parser tests

- new fetcher test coverage for each integration
- shared slipstream parser tests
- fee tier classification tests
- token-side price inversion tests

### Dedupe / merge tests

- exact identity dedupe against DL rows
- derived unique dedupe with same token pair
- multi-pool same-pair same-protocol different-fee-tier separation
- staged merge coexistence

### Scoring regression tests

Run and extend:

- `worker/src/cron/__tests__/dex-liquidity-process-pools.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-price-sanity.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-fallbacks.test.ts`

Add cases for:

- BSC stablecoin pools now classified as primary via Pancake
- Solana coins with Meteora-only liquidity no longer fall to staged/fallback-only
- Base/OP coins with Slipstream pools gain better direct coverage

### End-to-end validation

Run:

- `npm run lint`
- `npm test`
- `npm run build`
- `cd worker && npx tsc --noEmit`
- `npm run test:merge-gate`

## Rollout Order

Recommended order:

1. Meteora
2. Pancake V3 + StableSwap
3. Aerodrome Slipstream
4. Velodrome Slipstream
5. Pancake V2, only if still justified after measuring coverage gain

Why:

- Meteora has the cleanest public API and immediate Solana impact.
- Pancake has the biggest BSC coverage upside.
- Slipstream work is structurally similar but higher ambiguity/risk.
- Velodrome can reuse most of the Slipstream plumbing once Aerodrome is proven.

## Risk Register

### 1. Over-deduping CL pools

Risk:

- same token pair, same protocol, different fee tiers or pool variants collapse incorrectly.

Mitigation:

- include fee tier in identity everywhere for CL sources
- add explicit tests for same-pair multi-fee pools

### 2. Under-deduping against DL

Risk:

- new sources duplicate TVL already present in DL rows.

Mitigation:

- review exact and derived identity outputs for sample pools on each new source
- add protocol-specific dedupe fixtures

### 3. Balance-health overconfidence

Risk:

- some APIs expose partial reserves or virtual liquidity that does not equal usable inventory.

Mitigation:

- mark `balanceMeasured` only when reserve semantics are trustworthy
- otherwise fall back to neutral balance instead of forcing synthetic ratios

### 4. Subgraph fragility / paging drift

Risk:

- Graph schemas drift or time out.

Mitigation:

- keep strict per-chain timeout
- treat each chain as non-fatal
- log degraded source family precisely

### 5. Methodology drift without docs

Risk:

- implementation lands but methodology pages still understate source coverage.

Mitigation:

- doc updates included in same branch as implementation

## Concrete Deliverables

Code:

- `worker/src/cron/dex-liquidity/fetch-meteora.ts`
- `worker/src/cron/dex-liquidity/fetch-pancakeswap.ts`
- `worker/src/cron/dex-liquidity/fetch-aerodrome-slipstream.ts`
- `worker/src/cron/dex-liquidity/fetch-velodrome-slipstream.ts`
- optional `worker/src/cron/dex-liquidity/fetch-slipstream-shared.ts`

Updated:

- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `worker/src/cron/dex-liquidity/constants.ts`
- `worker/src/lib/constants.ts`
- `worker/src/lib/dex-constants.ts`
- `worker/src/lib/dex-api-common.ts`
- tests and methodology docs listed above

## Suggested Execution Split

If implemented in multiple PRs:

1. PR 1: shared plumbing + Meteora
2. PR 2: Pancake V3 + StableSwap
3. PR 3: Aerodrome Slipstream + shared Slipstream helper
4. PR 4: Velodrome Slipstream + docs cleanup + optional Pancake V2

This keeps each change set reviewable and reduces rollback blast radius.
