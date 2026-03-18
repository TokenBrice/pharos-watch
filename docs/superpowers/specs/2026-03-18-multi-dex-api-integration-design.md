# Multi-DEX API Integration Design

**Date:** 2026-03-18
**Status:** Draft
**Scope:** Integrate Fluid, Balancer, Raydium, and Orca APIs into both the pricing consensus engine and DEX liquidity scoring pipeline.

## Motivation

Today, DEX data flows primarily through DefiLlama yields aggregation, with dedicated subgraph enrichment only for Uniswap V3 (4 chains) and Aerodrome (Base). This means:

- **Stale/missing pools**: DL may not index every pool from every protocol.
- **No pool-type refinement**: Balancer stable vs weighted classification depends on DL project name string matching.
- **Weak Solana coverage**: Raydium and Orca pools reach us only via DexScreener/CoinGecko-tickers fallback (0.3x quality, Tier 3 confidence).
- **No balance ratio data**: For protocols without dedicated fetchers, we lack token-level balance information.

Four major DEX protocols now offer free, unauthenticated APIs with rich pool data. Integrating them directly gives us fresher data, better price signals, and more accurate liquidity scoring.

## API Summary

| Protocol | Type | Auth | Chains | TVL field | Volume field | Price field | Pool type info | Balance data | Fee data |
|----------|------|------|--------|-----------|-------------|-------------|----------------|-------------|----------|
| **Fluid** | REST | None | 7 (ETH, ARB, Base, Polygon, BSC, Plasma, Solana) | `liquidity_in_usd` | `base_volume` + `target_volume` (token terms) | `last_price` | Single type (fluid-dex) | No | No |
| **Balancer** | GraphQL | None | 17 (ETH, ARB, Base, Polygon, Optimism, Gnosis, Avalanche, Sonic, Plasma, ...) | `dynamicData.totalLiquidity` (USD) | `dynamicData.volume24h` (USD) | Derivable from token `balanceUSD / balance` | STABLE, COMPOSABLE_STABLE, META_STABLE, WEIGHTED, GYRO, GYROE, ... | Yes (`balance`, `balanceUSD`, `weight`) | `swapFee` |
| **Raydium** | REST | None | Solana | `tvl` (USD) | `day.volume` (USD) | `price` (direct) | Concentrated / Standard | `mintAmountA`, `mintAmountB` | `feeRate` |
| **Orca** | REST | None | Solana | `tvlUsdc` (USD) | `stats.24h.volume` (USD) | `price` (direct) | Whirlpool (concentrated) | `tokenBalanceA`, `tokenBalanceB` | `feeRate` |

### API Endpoints

**Fluid:** `GET https://api.fluid.instadapp.io/v2/:chainId/dexes/stats/tickers`
- Chain IDs: `{ ethereum: 1, arbitrum: 42161, base: 8453, polygon: 137, bsc: 56, plasma: TBD, solana: TBD }`
- Returns JSON array of ticker objects per chain. No pagination.

**Balancer:** `POST https://api-v3.balancer.fi/` (GraphQL)
- Query: `poolGetPools` with `first`/`skip` pagination (pages of 1000)
- Filters: `minTvl`, `poolTypeIn`, `chainIn`, `tokensIn`
- Supported chains: MAINNET, ARBITRUM, BASE, POLYGON, OPTIMISM, GNOSIS, AVALANCHE, SONIC, PLASMA, MODE, FRAXTAL, FANTOM, ZKEVM, XLAYER, HYPEREVM

**Raydium:** `GET https://api-v3.raydium.io/pools/info/list`
- Params: `poolType` (concentrated/standard), `poolSortField`, `sortType`, `pageSize` (max 1000), `page`
- Solana only.

**Orca:** `GET https://api.orca.so/v2/solana/pools`
- Params: `sortBy`, `sortDirection`, `minTvl`, `size`
- Cursor-based pagination via `meta.next`
- Rate limit: 429 with backoff. Solana only.

## Architecture

### Cron Trigger Topology

The pricing and DEX liquidity pipelines run on **separate cron triggers**:

- **DEX liquidity** (`syncDexLiquidity`): half-hourly trigger (`runHalfHourlySlot`)
- **Pricing** (`fetchPrimaryPrices`): quarter-hourly trigger (`runQuarterHourlySlot`, inside `sync-stablecoins`)

They cannot share in-memory state. Communication happens via D1:
- `syncDexLiquidity` writes to `dex_prices` table (including `price_sources_json` with per-protocol breakdown)
- `fetchPrimaryPrices` reads from `dex_prices` via `loadDexPriceRows()`

**The four new fetchers integrate into the half-hourly DEX liquidity cron only.** Their price observations flow into `computeDexPrices()`, which writes per-protocol prices to `dex_prices.price_sources_json`. The pricing pipeline then reads and disaggregates these into individually-weighted consensus sources (see Pricing Pipeline Integration section).

### Shared Type

All four fetchers normalize results into a common `DexApiPool` type defined in `worker/src/lib/dex-api-common.ts`:

```ts
interface DexApiPool {
  source: "fluid" | "balancer" | "raydium" | "orca";
  chain: string;               // internal chain key (e.g., "ethereum", "solana")
  poolAddress: string;
  poolType: string;            // "fluid-dex", "balancer-stable", "raydium-clmm", etc.
  tokens: { address: string; symbol: string; decimals: number }[];
  price: number | null;        // direct pool price if available
  tvlUsd: number;
  volume24hUsd: number;
  feeRate: number | null;      // normalized decimal (e.g., 0.0001 for 1bp)
  balances: number[] | null;   // token balances in native units
}
```

### Fetch Layer

Four new modules in `worker/src/cron/dex-liquidity/`:

> Placement rationale: follows the existing pattern of `fetch-primary.ts`, `fetch-crawlers.ts`, `fetch-fallbacks.ts` in the same directory. The shared type (`dex-api-common.ts`) lives in `worker/src/lib/` alongside `dex-constants.ts` since it's reused by both the fetchers and the pricing pipeline.

**`fetch-fluid.ts`** — `fetchFluidPools(): Promise<DexApiPool[]>`
- Fetches all 7 chains in parallel via `Promise.allSettled()`
- Maps chain names to Fluid API chain IDs
- Probes Plasma/Solana chain IDs during implementation; skips gracefully if unsupported
- Volume conversion: stablecoin side ~$1, counterpart from pricing pipeline

**`fetch-balancer.ts`** — `fetchBalancerPools(): Promise<DexApiPool[]>`
- Single GraphQL endpoint, paginated (first/skip, pages of 1000)
- Filters: `minTvl: 10000`, `poolTypeIn: [STABLE, COMPOSABLE_STABLE, META_STABLE, PHANTOM_STABLE, WEIGHTED, GYRO, GYROE]`
- `chainIn`: all chains overlapping with our tracked stablecoins
- Pool type mapping:
  - STABLE, COMPOSABLE_STABLE, META_STABLE, PHANTOM_STABLE, GYRO, GYROE -> `"balancer-stable"`
  - WEIGHTED -> `"balancer-weighted"`
- Extracts `balance`, `balanceUSD`, `weight` per token for balance ratio

**`fetch-raydium.ts`** — `fetchRaydiumPools(): Promise<DexApiPool[]>`
- Two passes: `poolType=concentrated` then `poolType=standard`
- Paginate by `page` until pool TVL drops below $10K
- Pool type mapping: concentrated -> `"raydium-clmm"`, standard -> `"raydium-amm"`
- Extracts `price`, `tvl`, `day.volume`, `feeRate`, `mintAmountA/B`

**`fetch-orca.ts`** — `fetchOrcaPools(): Promise<DexApiPool[]>`
- Cursor-based pagination via `meta.next`, `minTvl=10000`
- All pools are whirlpools -> `"orca-whirlpool"`
- Extracts `price`, `tvlUsdc`, `stats.24h.volume`, `feeRate`, `tokenBalanceA/B`
- 429 handling with exponential backoff

**Shared patterns:**
- `Promise.allSettled()` for multi-chain/multi-page fetches — partial failures non-fatal
- Circuit breaker integration: new entries `CIRCUIT_SOURCE.FLUID_DEX_API`, `CIRCUIT_SOURCE.BALANCER_API`, `CIRCUIT_SOURCE.RAYDIUM_API`, `CIRCUIT_SOURCE.ORCA_API` in `worker/src/lib/constants.ts`
- Token matching against stablecoin contract registry (`shared/lib/stablecoins.ts`) + symbol fallback via `DEX_SYMBOL_ALIASES`
- Min TVL $10K for liquidity inclusion, $50K for price observations (stricter to reduce noise)
- Response bodies consumed promptly (Workers 6-connection limit)

### Data Flow

```
Half-hourly cron (syncDexLiquidity)
  |
  +-> fetchDataSources() [existing: DL yields, DL protocols, Curve API]
  +-> fetchFluidPools()       \
  +-> fetchBalancerPools()     |-- all in parallel with existing fetches
  +-> fetchRaydiumPools()      |
  +-> fetchOrcaPools()        /
  |
  +-> DexApiPool[] -> convert to pool metrics + price observations
  |     (token matching, dedup against DL via pool address fingerprint)
  |
  +-> processPoolMetrics() [existing: TVL, volume, quality scoring]
  +-> computeStablecoinScores() [existing: 5-component composite]
  +-> computeDexPrices() [existing: TVL-weighted median]
  |     writes dex_prices table with price_sources_json
  |     (now includes "fluid", "balancer", "raydium", "orca" entries)
  +-> persistScores() + writeHistoricalSnapshots() [existing]

Quarter-hourly cron (fetchPrimaryPrices, inside sync-stablecoins)
  |
  +-> loadDexPriceRows(db) [existing, reads dex_prices]
  +-> loadDexPriceSources(db) [NEW: reads price_sources_json]
  |
  +-> Per asset, assemble sources[] for consensus:
  |     ... existing sources (CoinGecko, Pyth, Binance, etc.) ...
  |     + "dex-promoted" aggregate (weight 1) [existing, unchanged]
  |     + disaggregated per-protocol prices from price_sources_json:
  |         "fluid" entries -> weight 3
  |         "balancer" entries -> weight 3
  |         "raydium" entries -> weight 2
  |         "orca" entries -> weight 2
  |
  +-> computePriceConsensus() [existing, unchanged]
```

## Pricing Pipeline Integration

### Cross-Cron Price Bridge

The four new APIs feed prices into the consensus engine via the existing `dex_prices` D1 table:

1. **Half-hourly**: `computeDexPrices()` in the DEX liquidity pipeline already computes a TVL-weighted median from all pool observations and stores per-protocol breakdown in `price_sources_json` (top 5 sources as `{ protocol, chain, price, tvl }[]`).
2. **Quarter-hourly**: `fetchPrimaryPrices()` reads `dex_prices`. Currently it only uses the aggregate `dex_price_usd` as a single `"dex-promoted"` source (weight 1). **Enhancement:** also parse `price_sources_json` and inject individual per-protocol prices with elevated weights for trusted protocols.

This avoids duplicating API calls across cron triggers and follows the existing D1-bridge pattern.

### New Function: `loadDexPriceSources()`

Add to `worker/src/lib/depeg-helpers.ts` alongside existing `loadDexPriceRows()`:

```ts
// Returns per-stablecoin array of { protocol, price, tvl } from price_sources_json
export async function loadDexPriceSources(db: D1Database): Promise<Map<string, DexPoolSource[]>>
```

### Trust Weights (per-protocol disaggregation)

In `fetchPrimaryPrices()`, after loading `dex_prices`, parse `price_sources_json` for each stablecoin and inject individual protocol prices:

| Protocol in `price_sources_json` | Injected source name | Weight | Min TVL |
|----------------------------------|---------------------|--------|---------|
| `"fluid"` | `"fluid-dex"` | 3 | $50K |
| `"balancer"` | `"balancer-dex"` | 3 | $50K |
| `"raydium"` | `"raydium-dex"` | 2 | $50K |
| `"orca"` | `"orca-dex"` | 2 | $50K |
| any other protocol | skipped (covered by aggregate `"dex-promoted"`) | - | - |

The existing `"dex-promoted"` aggregate (weight 1) is **kept unchanged** for backward compatibility and to cover protocols without elevated weights.

For context, existing weights: Curve on-chain `get_dy` = 3, CoinGecko/CEX = 2, Pyth/RedStone/DL = 1, DEX-promoted aggregate = 1.

> **Note on weight 3 for Fluid/Balancer**: These are API-reported prices, not direct on-chain observations like Curve `get_dy`. However, both protocols are mature, high-TVL, and their APIs reflect current pool state. The weight 3 reflects the user's confidence in these protocols' pricing quality. If production data shows divergence, weights can be adjusted without architectural changes.

### Price Derivation (within DEX liquidity pipeline)

Price observations are extracted from `DexApiPool[]` and fed into the existing `priceObservations: Map<string, DexPriceObs[]>` used by `computeDexPrices()`:

**Fluid:** `last_price` is base/target ratio. Match token addresses against stablecoin contract registry. If stablecoin is base, use as-is; if target, invert. Only produce observation when counterpart is USD-denominated or has known price from existing pipeline.

**Balancer:** Derive from `balanceUSD / balance` per token. Cross-validate within pool (e.g., USDC price sanity-checks GHO derivation in same pool).

**Raydium/Orca:** `price` field is direct base/quote ratio. Match Solana token mint addresses against stablecoin contract registry. Invert if stablecoin is on quote side.

All observations use existing plausibility filtering (`isPlausibleDexObservationPrice()`) and peg-aware validation.

### Price Confidence (within DEX liquidity pipeline)

Update `dexPriceConfidenceForProtocol()` in `worker/src/cron/dex-liquidity/constants.ts`:
- Add `"fluid"`, `"balancer"`, `"raydium"`, `"orca"` to Tier 1 (1.0) alongside `"curve"`, `"uniswap-v3"`, `"aerodrome"`

This means the TVL-weighted median in `computeDexPrices()` gives full confidence weight to these protocols' observations.

> **Quality multiplier hierarchy note**: Direct API pools get `QUALITY_MULTIPLIERS` (e.g., 0.85 for `balancer-stable`), while GT-discovered Balancer pools get `GT_DEX_QUALITY` (0.7). This is intentional: direct API data has better metadata and classification confidence.

## DEX Liquidity Pipeline Integration

### Integration Point

In `worker/src/cron/dex-liquidity/orchestrator.ts`, the four fetchers are called in parallel during Step 1 (data source fetching), alongside existing DL/Curve/Uniswap/Aerodrome fetches. Results are then:

1. **Token-matched**: each `DexApiPool` token is matched against our stablecoin contract registry (address match) + symbol fallback (via `DEX_SYMBOL_ALIASES`)
2. **Converted to price observations**: extracted `DexPriceObs` entries feed into the existing `priceObservations` map consumed by `computeDexPrices()`
3. **Converted to pool metrics**: `DexApiPool` data merges into the pool scoring pipeline via `mergeGtPools()` (the existing mechanism for non-DL pools from GeckoTerminal/DexScreener/CG-tickers)

> **Why `mergeGtPools()`?** This function already handles the pattern of "pools discovered outside DL that need fingerprint-based dedup and staged integration." The `DexApiPool` conversion produces the same `GtNewPool` shape that `mergeGtPools()` expects.

### Deduplication

DL may already index the same pools. Dedup via `buildPoolFingerprint()` (existing mechanism):
- Fingerprint format: `fp:chain:protocol:sorted_token_addresses`
- `normalizeProtocol()` already handles `"fluid"`, `"balancer"`, `"raydium"`, `"orca"` (verified in `pool-helpers.ts`)
- When both DL and direct API have the same pool: **prefer the direct API data** (fresher, richer metadata)
- DL data serves as fallback/validation

**Solana dedup note**: Token mint addresses from Raydium/Orca APIs should match DL's addresses for the same tokens, but wrapped/unwrapped variants (e.g., native SOL vs WSOL) may differ. The token matching step normalizes known aliases via `DEX_SYMBOL_ALIASES` before fingerprinting.

### Enrichment Advantages

**Balancer** (biggest upgrade from current DL-only path):
- Token `weight` field -> accurate balance ratio (vs. generic 50/50 assumption)
- `swapFee` -> direct instead of inferred
- Pool `type` from API -> precise stable vs weighted (vs. DL project name matching)
- Per-token `balanceUSD` -> direct balance ratio: `min(balancesUSD) / max(balancesUSD)`

**Raydium + Orca** (replaces DexScreener/CG-tickers fallback path):
- Token balances -> balance ratio for Solana pools (currently unavailable)
- `feeRate` -> future fee-tier quality refinement
- Orca multi-period stats (7d, 30d) -> better volume consistency signal for durability scoring

### New Quality Multipliers

Add to `worker/src/lib/dex-constants.ts` `QUALITY_MULTIPLIERS`:

```
"raydium-clmm": 0.85    // concentrated liquidity
"raydium-amm": 0.4      // standard AMM, wider spreads
"orca-whirlpool": 0.85   // concentrated liquidity
```

Existing multipliers unchanged: `"fluid-dex": 0.85`, `"balancer-stable": 0.85`, `"balancer-weighted": 0.4`.

### Pool Type Classification

**Two distinct flows:**

1. **DL-sourced pools** (existing path): `classifyPoolType(project)` in `pool-helpers.ts` matches on DL project name strings. Add cases for DL pools that arrive with project names containing "raydium" or "orca":
   - `proj.includes("raydium")` -> `"raydium-amm"` (DL doesn't distinguish concentrated vs standard)
   - `proj.includes("orca")` -> `"orca-whirlpool"` (DL Orca pools are all whirlpools)

2. **Direct API pools** (new path): The fetcher sets `poolType` directly on `DexApiPool` based on API metadata:
   - Raydium concentrated -> `"raydium-clmm"`, standard -> `"raydium-amm"`
   - Orca -> `"orca-whirlpool"`
   - Fluid -> `"fluid-dex"` (already handled)
   - Balancer STABLE/COMPOSABLE_STABLE/META_STABLE/PHANTOM_STABLE/GYRO/GYROE -> `"balancer-stable"`, WEIGHTED -> `"balancer-weighted"`

The fetcher-set pool type takes precedence during dedup (direct API has better metadata).

## Operational Concerns

### Cron Budget

| Fetcher | Requests/cycle | Est. time | Payload |
|---------|---------------|-----------|---------|
| Fluid | 7 | ~2s | Small JSON per chain |
| Balancer | 2-4 | ~3s | Rich GraphQL pages |
| Raydium | 4-6 | ~3s | Paginated pool lists |
| Orca | 2-3 | ~2s | Cursor-paginated |
| **Total** | **~15-20** | **~5-8s** | Negligible in 30-min window |

### Failure Modes

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| Single fetcher down | 3 of 4 still work; DL fills gaps | Circuit breaker per source |
| Single chain fails (Fluid) | Other 6 chains still work | `Promise.allSettled()` |
| Bad price data | Consensus engine filters outliers | 50bps clustering + pool challenge |
| TVL anomaly | Coverage guard detects spike/crash | Existing prior-coverage validation |
| Rate limited (Orca 429) | Partial data for cycle | Backoff + circuit breaker |
| All four down | Zero regression | DL + existing sources unchanged |
| Double-counted TVL | Same pool from DL + direct API | `buildPoolFingerprint()` dedup; direct API preferred |

**Key principle:** Purely additive. All existing data paths remain untouched. If all four APIs fail simultaneously, the system behaves exactly as it does today.

### Circuit Breakers

Add new entries to `CIRCUIT_SOURCE` in `worker/src/lib/constants.ts`:
- `FLUID_DEX_API: "fluid-dex-api"`
- `BALANCER_API: "balancer-api"`
- `RAYDIUM_API: "raydium-api"`
- `ORCA_API: "orca-api"`

Each fetcher calls `shouldAttemptFetch()` / `recordOutcome()` using its circuit source key, following the pattern in `geckoterminal-price-probe.ts`.

### Monitoring

- Add `"fluid"`, `"balancer"`, `"raydium"`, `"orca"` to `source_mix_json` in `dex_liquidity` table
- Log per-source: pool count, matched stablecoin count, total TVL on each cycle
- Circuit breaker state in existing cron logs

### Frontend

All display constants (protocol names, icons, colors) **already exist** in `src/lib/dex-constants.ts` for all four protocols:
- Fluid: "Fluid", `/dexes/fluid.png`, `bg-cyan-500`
- Balancer: "Balancer", `/dexes/balancer.png`, `bg-violet-500`
- Raydium: "Raydium", `/dexes/raydium.png`, `bg-purple-500`
- Orca: "Orca", `/dexes/orca.png`, `bg-teal-400`

No frontend changes needed. Protocol TVL breakdowns and pool displays auto-populate from the scored data.

### Database

No migrations required. Existing tables handle everything:
- `dex_liquidity` — scores, source_mix_json
- `dex_prices` — pool-level price observations, price_sources_json
- `dex_liquidity_history` — daily snapshots

## File Changes

### New Files (5)

| File | Responsibility |
|------|---------------|
| `worker/src/cron/dex-liquidity/fetch-fluid.ts` | Fluid REST fetcher |
| `worker/src/cron/dex-liquidity/fetch-balancer.ts` | Balancer GraphQL fetcher |
| `worker/src/cron/dex-liquidity/fetch-raydium.ts` | Raydium REST fetcher |
| `worker/src/cron/dex-liquidity/fetch-orca.ts` | Orca REST fetcher |
| `worker/src/lib/dex-api-common.ts` | `DexApiPool` type, shared token-matching, DexApiPool-to-DexPriceObs conversion |

### Modified Files (7)

| File | Change |
|------|--------|
| `worker/src/cron/dex-liquidity/orchestrator.ts` | Call 4 fetchers in parallel in Step 1, convert results to price observations + pool metrics via `mergeGtPools()` |
| `worker/src/cron/dex-liquidity/constants.ts` | Add fluid/balancer/raydium/orca to Tier 1 in `dexPriceConfidenceForProtocol()` |
| `worker/src/cron/dex-liquidity/pool-helpers.ts` | Add raydium/orca cases to `classifyPoolType()` for DL-sourced pools |
| `worker/src/lib/dex-constants.ts` | Add quality multipliers: `raydium-clmm`, `raydium-amm`, `orca-whirlpool` |
| `worker/src/lib/constants.ts` | Add `CIRCUIT_SOURCE` entries for the four APIs |
| `worker/src/lib/depeg-helpers.ts` | Add `loadDexPriceSources()` to read `price_sources_json` per stablecoin |
| `worker/src/cron/enrich-prices.ts` | Call `loadDexPriceSources()`, disaggregate per-protocol prices into individually-weighted consensus sources |

### Unchanged

- `worker/src/lib/price-consensus.ts` — already handles arbitrary sources with weights
- Scoring formula in `pool-helpers.ts` — same 5-component composite
- DB schema — zero migrations
- All existing data sources and cron triggers — untouched
- `src/lib/dex-constants.ts` — all display constants already present

## Phase 2 (Future)

- **Ekubo**: Starknet + EVM DEX with unique depth data (`depth0`, `depth1`, `min_depth_percent`). Lower priority due to limited Starknet stablecoin coverage. Rich API at `https://prod-api.ekubo.org`.
- **Uniswap V3 chain expansion**: BSC, Optimism, Avalanche available via The Graph. Deprioritized because Balancer's free multi-chain API now covers those chains, and The Graph costs GRT per query.
- **Fee-tier quality refinement**: Use Raydium/Orca fee rates for finer-grained quality multipliers (similar to Uniswap V3 1bp/5bp/30bp differentiation).

## Testing Strategy

- Unit tests for each fetcher: mock API responses, verify DexApiPool conversion and token matching
- Unit tests for price derivation: verify correct inversion, TVL weighting, $50K threshold filtering
- Unit tests for `loadDexPriceSources()`: verify per-protocol disaggregation from `price_sources_json`
- Unit tests for per-protocol weight injection in `fetchPrimaryPrices()`: verify fluid=3, balancer=3, raydium=2, orca=2
- Integration test: verify dedup logic when same pool appears from both DL and direct API (fingerprint match)
- Integration test: Solana token address normalization for cross-source dedup (wrapped/unwrapped variants)
- Error path tests: malformed JSON responses, empty arrays, HTTP 500, HTTP 429, timeouts
- Cron budget test: verify total fetch time stays within acceptable bounds (~5-8s for all 4 sources)
- Existing test suite must continue passing (pricing consensus, liquidity scoring, pool helpers)
