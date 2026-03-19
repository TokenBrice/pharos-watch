# Multi-DEX API Integration Audit

Date: 2026-03-18

Scope: `Fluid`, `Balancer`, `Raydium`, and `Orca` direct-API integration across the DEX liquidity cron, price bridge into `dex_prices`, and pricing-consensus ingestion.

Related design docs:
- `agents/plans/historical/2026-03-18-multi-dex-api-integration.md`
- `agents/specs/2026-03-18-multi-dex-api-integration-design.md`
- `docs/dex-liquidity.md`

## Verdict

The implementation is not yet reliable enough to trust as a primary production data path.

Three issues materially break accuracy today:

1. `Raydium` currently contributes zero live data.
2. `Orca` currently truncates after the first 200 pools.
3. The pricing bridge does not actually disaggregate to one source per protocol; it reuses the top 5 pool list and can overweight repeated protocols.

On top of that, deduplication and observability are weaker than the design claims, so the system can both double-count pools and silently hide upstream breakage.

## What I Reviewed

Code paths:
- `worker/src/cron/dex-liquidity/fetch-fluid.ts`
- `worker/src/cron/dex-liquidity/fetch-balancer.ts`
- `worker/src/cron/dex-liquidity/fetch-raydium.ts`
- `worker/src/cron/dex-liquidity/fetch-orca.ts`
- `worker/src/lib/dex-api-common.ts`
- `worker/src/cron/dex-liquidity/orchestrator.ts`
- `worker/src/cron/dex-liquidity/scoring.ts`
- `worker/src/lib/depeg-helpers.ts`
- `worker/src/cron/enrich-prices.ts`
- `worker/src/cron/dex-liquidity/fetch-primary.ts`

Tests reviewed:
- `worker/src/cron/__tests__/dex-api-common.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts`
- `worker/src/cron/__tests__/dex-liquidity-price-bridge.test.ts`
- `worker/src/cron/__tests__/sync-dex-liquidity.test.ts`

Live upstream probes:
- `Fluid`: `https://api.fluid.instadapp.io/v2/1/dexes/stats/tickers`
- `Balancer`: `https://api-v3.balancer.fi/`
- `Raydium`: `https://api-v3.raydium.io/pools/info/list`
- `Orca`: `https://api.orca.so/v2/solana/pools`

## Verification Run

Automated checks:
- `npm test -- worker/src/cron/__tests__/dex-api-common.test.ts worker/src/cron/__tests__/dex-liquidity-direct-api.test.ts worker/src/cron/__tests__/dex-liquidity-price-bridge.test.ts worker/src/cron/__tests__/sync-dex-liquidity.test.ts`
  - Passed: `4` files, `73` tests
- `npm run lint`
  - Passed with existing repo-wide warnings only
- `cd worker && npx tsc --noEmit`
  - Passed
- `npm run build`
  - Passed

Key takeaway: the current suite is green while live upstream behavior is broken. The gaps are in contract coverage, not in basic TypeScript/build integrity.

## Findings

### 1. High: `Raydium` is effectively disabled in production

Code:
- `worker/src/cron/dex-liquidity/fetch-raydium.ts:27-35`

Problem:
- The fetcher sends `poolType=Concentrated` and `poolType=Standard`.
- The live API now expects lowercase values: `concentrated` / `standard`.

Live repro:
- `curl 'https://api-v3.raydium.io/pools/info/list?poolType=Concentrated&...'`
  - returns `500` with `{"success":false,"msg":"query poolType type error"}`
- `curl 'https://api-v3.raydium.io/pools/info/list?poolType=concentrated&...'`
  - succeeds
- Running the actual fetcher produced:
  - `[fetch-raydium] standard page 1 returned 500`
  - `[fetch-raydium] concentrated page 1 returned 500`
  - result count `0`

Impact:
- No Raydium pools are reaching liquidity scoring.
- No Raydium prices are reaching `dex_prices`.
- Solana stablecoin coverage is materially worse than intended.

Required fix:
- Switch query params to lowercase.
- Treat non-OK responses or `success:false` as source failures, not successful empty fetches.
- Add a contract test that asserts the outgoing query string, not just the parsed response shape.

### 2. High: `Orca` pagination is stale and truncates coverage after page 1

Code:
- `worker/src/cron/dex-liquidity/fetch-orca.ts:19-22`
- `worker/src/cron/dex-liquidity/fetch-orca.ts:73-74`

Problem:
- The implementation expects `json.meta.next`.
- The live API now returns `json.meta.cursor.next`.
- As a result, the loop stops after the first 200 pools.

Live repro:
- `curl 'https://api.orca.so/v2/solana/pools?sortBy=tvl&sortDirection=desc&minTvl=10000&size=200'`
  - returns `meta.cursor.next`, not `meta.next`
- Running the actual fetcher produced:
  - `[fetch-orca] Fetched 200 pools`
  - exactly `200` pools, which matches the page size rather than the full dataset
- Fetching page 2 directly showed additional stablecoin-relevant pools still exist beyond page 1.

Impact:
- Orca coverage is incomplete.
- Price observations and liquidity scoring are biased toward only the top page.
- Lower-TVL but still valid stablecoin pools never enter the pipeline.

Required fix:
- Parse `meta.cursor.next`.
- Keep paginating until cursor exhaustion.
- Add a contract test for the nested cursor shape.

### 3. High: direct-API failures are being recorded as successes

Code:
- `worker/src/cron/dex-liquidity/orchestrator.ts:67-85`
- `worker/src/cron/dex-liquidity/fetch-fluid.ts:35-40`
- `worker/src/cron/dex-liquidity/fetch-balancer.ts:63-70`
- `worker/src/cron/dex-liquidity/fetch-raydium.ts:33-40`
- `worker/src/cron/dex-liquidity/fetch-orca.ts:34-44`

Problem:
- The fetchers mostly log and return `[]` on HTTP/API-shape failures.
- The orchestrator only records a circuit-breaker failure when the fetcher throws.
- A broken upstream contract therefore becomes a silent “success with zero pools”.

Why this matters:
- This is exactly why the Raydium breakage above is invisible to the health model.
- `failedSources` does not capture it.
- Circuits do not open.
- `/status` and cron result metadata underreport degraded state.

Impact:
- Silent data loss.
- No automatic backoff.
- Operators cannot distinguish “zero pools exist” from “upstream contract broke”.

Required fix:
- Make fetchers return structured outcomes such as `{ pools, ok, errorKind }`, or throw on non-OK API responses.
- Record failure when a source returns an explicit upstream error or parse mismatch.
- Consider rejecting suspicious full-source empty results when the previous run had material coverage.

### 4. High: direct-API dedup does not use the fingerprint set the code builds

Code:
- fingerprint creation: `worker/src/cron/dex-liquidity/fetch-primary.ts:553-568`
- direct-API dedup: `worker/src/cron/dex-liquidity/orchestrator.ts:220-231`

Problem:
- `buildKnownPoolAddresses()` stores both `chain:address` keys and `fp:<chain>:<protocol>:<tokens...>` fingerprints.
- The direct-API merge path only checks `chain:address`.
- It never computes or consults the fingerprint for the incoming direct-API pool.

Impact:
- If DeFiLlama already covers the same physical pool under a UUID rather than an on-chain address, the direct-API copy can still be merged.
- That can double-count TVL and volume.
- The design docs explicitly claim direct-API dedup uses the shared fingerprint mechanism; the implementation currently does not.

Required fix:
- Compute a fingerprint for every `DexApiPool` using its token addresses and normalized protocol.
- Dedup against both `chain:address` and fingerprint keys, exactly as the staged/DexScreener paths already do.

### 5. High: the price bridge does not actually inject one source per protocol

Code:
- write side: `worker/src/cron/dex-liquidity/scoring.ts:525-560`
- read side: `worker/src/lib/depeg-helpers.ts:116-143`
- injection side: `worker/src/cron/enrich-prices.ts:382-396`

Problem:
- `computeDexPrices()` stores the top 5 individual pool observations by TVL in `price_sources_json`.
- `loadDexPriceSources()` returns those raw per-pool entries.
- `fetchPrimaryPrices()` injects each one independently as `fluid-dex`, `balancer-dex`, `raydium-dex`, or `orca-dex`.

Why this diverges from the design:
- The design called for one aggregated per-protocol source.
- The current implementation can inject the same protocol multiple times if several top pools share that protocol.

Impact:
- Repeated Balancer pools can give Balancer multiple weight-3 votes instead of one.
- A protocol outside the top 5 can disappear from the bridge entirely.
- Consensus weights are materially distorted relative to the stated design.

Required fix:
- Persist an explicit per-protocol aggregate in `dex_prices`, or aggregate `price_sources_json` by protocol before injecting into consensus.
- Ensure at most one `fluid-dex`, one `balancer-dex`, one `raydium-dex`, and one `orca-dex` source per asset.

### 6. Medium: fallback crawlers run before direct-API pools are merged

Code:
- fallbacks run first: `worker/src/cron/dex-liquidity/orchestrator.ts:167-204`
- direct APIs merged later: `worker/src/cron/dex-liquidity/orchestrator.ts:206-245`

Problem:
- `getFallbackTargets()` decides “missing coverage” before direct-API results are applied.
- Coins that would have been covered by Raydium/Orca/Fluid/Balancer still trigger DexScreener or CG tickers fallback.

Impact:
- Unnecessary fallback traffic and budget consumption.
- Lower-confidence fallback pools/prices can be merged even when a richer direct source exists.
- In the DexScreener path, the fallback adds the pool address to `knownPoolAddrs` first, which means the later direct-API copy can be skipped by address and lose the tie-break.

Required fix:
- Await and merge direct-API results before deciding fallback targets.
- Prefer source ordering: `DL/subgraphs -> direct_api -> staged -> DexScreener -> CG tickers`.

### 7. Medium: direct-API-only coverage is still classified as `fallback`

Code:
- `worker/src/cron/dex-liquidity/scoring.ts:204-223`

Problem:
- `classifyCoverage()` only treats `sourceMix.dl` as primary.
- `direct_api` pools therefore land in `fallback` with confidence `0.55`.

Impact:
- Coins covered only by these new fetchers are under-trusted in persisted coverage metadata.
- Historical stability/durability logic that depends on confident rows is penalized.
- This conflicts with the design positioning direct APIs as primary scoring inputs and Tier-1 price sources.

Required fix:
- Update coverage classification to treat `direct_api` as primary-grade, or at least distinguish it from true late-stage fallbacks.

### 8. Medium: Fluid volume normalization is not actually USD-normalized

Code:
- `worker/src/cron/dex-liquidity/fetch-fluid.ts:45-50`

Problem:
- The code sets `volume24hUsd = base_volume + target_volume`.
- Those fields are token amounts, not USD.
- This is only approximately valid for stable/stable pools.

Live evidence:
- The live ETH-side pool `USDC / ETH` exposes approximately:
  - `base_volume ≈ 7.97M USDC`
  - `target_volume ≈ 3625 ETH`
  - code interprets this as roughly `7.97M + 3.6K`
  - the ETH leg is really worth millions of USD, not `3.6K`

Impact:
- Fluid pools against non-stable counterparts materially undercount 24h volume.
- Volume activity scores and top-pool ordering are biased downward for those pools.

Required fix:
- Convert both sides into USD before summing.
- If only one side is reliably dollarized, prefer that side instead of summing mixed units.
- At minimum, suppress non-stable counterpart volume until proper USD conversion exists.

### 9. Medium: Balancer query is broader than the design and can admit unsupported pool types

Code:
- query: `worker/src/cron/dex-liquidity/fetch-balancer.ts:26-40`
- classification: `worker/src/cron/dex-liquidity/fetch-balancer.ts:81-82`

Problem:
- The design specified filtering to supported `poolTypeIn` values and relevant chains.
- The current query fetches every pool above `$10K` TVL.
- Every non-stable type is collapsed into `balancer-weighted`.

Live evidence:
- The live API currently returns unsupported types such as `COW_AMM`, `QUANT_AMM_WEIGHTED`, `RECLAMM`, `LIQUIDITY_BOOTSTRAPPING`, `ELEMENT`, and `FX`.
- Some of those have stablecoin legs and can therefore survive token matching.

Impact:
- Unsupported Balancer pool types can leak into scoring/pricing with the wrong quality model.
- Coverage can include pools the design never intended to trust.

Required fix:
- Apply the explicit `poolTypeIn` filter from the design.
- Restrict to the supported chain set.
- Refuse unknown pool types instead of silently calling them weighted.

## Secondary Improvement Areas

These are not the main correctness breaks, but they are still worth fixing:

- `worker/src/cron/dex-liquidity/fetch-fluid.ts:7-13`
  - The implementation only wires `ethereum`, `arbitrum`, `base`, `polygon`, and `bsc`.
  - The docs/specs describe `Plasma` and `Solana` coverage as part of the target design.
  - Current state: the implementation under-delivers relative to the documented scope.

- `worker/src/cron/dex-liquidity/fetch-balancer.ts:7-20`
  - The chain map is narrower than Balancer's current live chain surface.
  - Missing chains are silently skipped today.

- `worker/src/cron/dex-liquidity/fetch-orca.ts:34-36`
  - The design called for 429 backoff.
  - The implementation simply stops pagination on rate limit.
  - That is survivable, but it creates avoidable partial runs.

- `worker/src/cron/dex-liquidity/fetch-orca.ts:46-70`
  - Orca exposes 7d/30d stats and locked-liquidity metadata that are currently ignored.
  - That is acceptable for a first pass, but it means the integration is still leaving durability-quality signal on the table.

## Testing Gaps

The current tests are too mock-driven for this class of integration.

Observed gaps:
- No test asserts the actual outgoing Raydium query string.
- No test covers the live Orca `meta.cursor.next` response shape.
- No test covers direct-API fingerprint dedup against DeFiLlama UUID pools.
- No test covers the price bridge’s intended per-protocol aggregation semantics.
- No test covers the coverage-class semantics for `direct_api`.
- No contract snapshot or periodic live smoke probe exists for these four upstreams.

That is why all 73 feature tests passed while live Raydium and Orca behavior was already wrong.

## Recommended Remediation Order

1. Fix Raydium request params and make HTTP/API-shape failures count as source failures.
2. Fix Orca cursor parsing and paginate fully.
3. Reorder the orchestrator so direct APIs merge before fallback crawlers.
4. Implement fingerprint dedup for direct APIs.
5. Rework the `dex_prices` bridge to store and inject one aggregate per protocol.
6. Reclassify `direct_api` coverage confidence so it is not treated like DexScreener/CG fallback.
7. Correct Fluid volume USD normalization.
8. Tighten Balancer query filters to the supported pool types/chains only.
9. Add contract-smoke coverage for all four upstreams.

## Bottom Line

The integration is conceptually good, but the current implementation is still in a “looks green locally, breaks against live providers” state.

The biggest immediate problems are:
- Raydium is broken now.
- Orca is partial now.
- The price bridge weighting is not doing what the design says.
- Direct-API failure handling and dedup are too weak for a production data pipeline.

I would not treat the new direct APIs as reliable production-grade inputs until the High findings above are fixed.
