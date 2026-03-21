# DEX Liquidity Score & Price Cross-Validation

## DEX Liquidity Score

`syncDexLiquidity()` in `worker/src/cron/dex-liquidity/orchestrator.ts` runs every 30 minutes (on the `10,40 * * * *` cron schedule) and computes a composite liquidity score (0-100) per stablecoin from 5 components:

Cron result status semantics:

- `ok`: all required source families succeeded and coverage is within normal range.
- `degraded`: one or more critical non-fatal source families failed (for example DeFiLlama yields/protocol coverage), or coverage falls near the guardrail band.
- throw/error: catastrophic source failure (for example DL+Curve hard failure) still aborts the run.

Run metadata now includes `failedSources`, `fallbackMode` signals, staged-pool merge counters (`stagedPoolsMerged`, `stagedPoolsSkipped`, `stagedPoolsSkippedByExactIdentity`, `stagedPoolsSkippedByUniqueDerivedIdentity`), challenger publish counters, and detailed `sourceCoverage` values (`currentCoverage`, `previousCoverage`, `minExpectedCoverage`, `nearCoverageGuard`, `currentGlobalTvl`, `previousGlobalTvl`, `nearValueGuard`, `currentTop10CoveredTvl`, `previousTop10CoveredTvl`, `nearMajorCoverageGuard`, `currentCoverageClasses`, `previousCoverageClasses`, `priceObservationCoins`, `dsFallbackCoins`, `cgTickerFallbackCoins`).

| Component           | Weight | Source                     | How Computed                                                                                                           |
| ------------------- | ------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **TVL Depth**       | 35%    | DeFiLlama Yields           | Log-scale using effective TVL (quality-adjusted, metapool-deduped): $100K->20, $1M->40, $10M->60, $100M->80, $1B+->100 |
| **Volume Activity** | 20%    | DeFiLlama Yields           | Log-scale V/T ratio: 33.3*log10(vtRatio/0.005). ~0.5%->0, ~5%->33, ~50%->67                                            |
| **Pool Quality**    | 22.5%  | Curve API + DeFiLlama      | Quality-adjusted TVL using mechanism x balance health x pair quality multipliers (see below)                           |
| **Durability**      | 15%    | DeFiLlama Yields + History | 35% TVL stability, 25% volume consistency, 25% maturity, 15% organic fraction (sqrt curve)                             |
| **Pair Diversity**  | 7.5%   | DeFiLlama Yields           | Pool count, diminishing returns: min(100, poolCount x 5)                                                               |

Primary scoring inputs are DeFiLlama Yields API (single request for all ~18K pools) + Curve Finance API (per-chain requests for A-factor, balance data, registry IDs, and metapool structure) + Uniswap V3 Subgraph (4 chains) + Aerodrome Subgraph (Base) + four direct API fetchers (Fluid, Balancer, Raydium, Orca). The scorer prefers direct-API pools over overlapping DeFiLlama pools via a conservative pool-identity model (exact pool id first, derived token-shape match second) before score computation, but only after those direct-API pools pass the shared TVL sanity gates used elsewhere in the pipeline. After the primary-source merge, the scoring cron reads fresh rows from `dex_pool_staging` (when present), applies freshness confidence decay to staged TVL/volume, skips staged pools already covered by primary sources, and merges the remaining pools before final scoring.

### Direct API Data Sources

Four DEX protocols are fetched directly during the scoring cron (`syncDexLiquidity`), in parallel with existing DL/Curve/Uniswap/Aerodrome fetches. Results are normalized into a shared `DexApiPool` type (`worker/src/lib/dex-api-common.ts`), token-matched against the stablecoin contract registry via `chain + address` first (with chain-scoped symbol fallback only when unique), deduplicated against DL via exact or uniquely derived pool identities, and merged into the pool scoring pipeline before staged and fallback sources. Source family: `direct_api`.

| Protocol | API Endpoint | Chains | Pool Types | Quality Multipliers | Fields Extracted |
|----------|-------------|--------|------------|--------------------:|------------------|
| **Fluid** | `GET https://api.fluid.instadapp.io/v2/:chainId/dexes/stats/tickers` + official DexReservesResolver on Ethereum/Arbitrum/Base/Polygon | Ethereum, Arbitrum, Base, Polygon, BSC, Plasma | `fluid-dex` | 0.85x | TVL (`liquidity_in_usd`), one-sided USD volume (normalized from `base_volume` / `target_volume`), price (`last_price`), balances (collateral + debt real reserves), fee (`getPoolFee`) |
| **Balancer** | `POST https://api-v3.balancer.fi/` (GraphQL `poolGetPools`) | 14 mapped chains (ETH, ARB, Base, Polygon, Optimism, Gnosis, Avalanche, Sonic, Fantom, Monad, HyperEVM, Plasma, Mode, zkEVM) | `balancer-stable`, `balancer-weighted` | stable 0.85x, weighted 0.4x | TVL (`totalLiquidity`), volume (`volume24h`), price (derived from `balanceUSD / balance`), balances (`balance`, `balanceUSD`, `weight`), fees (`swapFee`) |
| **Raydium** | `GET https://api-v3.raydium.io/pools/info/list` | Solana | `raydium-clmm`, `raydium-amm` | clmm 0.85x, amm 0.4x | TVL (`tvl`), volume (`day.volume`), price (`price`), balances (`mintAmountA/B`), fees (`feeRate`) |
| **Orca** | `GET https://api.orca.so/v2/solana/pools` | Solana | `orca-whirlpool` | 0.85x | TVL (`tvlUsdc`), volume (`stats.24h.volume`), price (`price`), balances (`tokenBalanceA/B`), fees (`feeRate`) |

All four fetchers now surface partial/total upstream failure explicitly to the cron, use circuit breakers (`CIRCUIT_SOURCE.FLUID_DEX_API`, `BALANCER_API`, `RAYDIUM_API`, `ORCA_API`), and apply min TVL thresholds ($10K for liquidity inclusion, $50K for price observations). When both DL and a direct API cover the same physical pool, the direct API data is preferred only when the identity match is exact or uniquely derived; ambiguous same-pair pools remain separate instead of being collapsed.

Balancer, Raydium, Orca, and resolver-backed Fluid pools now preserve richer metadata through `top_pools_json`: measured `balanceRatio`, per-token `balanceDetails`, and normalized `feeTier` badges in basis points. Balancer weighted pools compare actual USD composition versus target token weights before deriving balance health; Raydium and Orca derive inventory balance from token balances plus per-token USD prices; Fluid derives inventory from the official DexReservesResolver by summing collateral and debt real reserves per token. Fluid pools on chains without that resolver deployment, or on any chain where token decimals cannot be resolved safely, fall back to neutral balance.

After pool filtering and protocol-level TVL caps are applied, the scorer rebuilds every aggregate (`total_tvl_usd`, `total_volume_24h_usd`, `total_volume_7d_usd`, `effective_tvl_usd`, balance/organic/stress weights, protocol/chain breakdowns, and source-family mix) from the retained pool set before computing the final score. Filtered or capped pools cannot continue influencing the score through stale pre-filter aggregates.

`dex_pool_staging` is the handoff point for discovery-only sources (CoinGecko Onchain, GeckoTerminal, DexScreener, CoinGecko Tickers). The scoring cron does not call those discovery APIs directly anymore; it consumes staged rows refreshed within the last 24 hours and gracefully falls back to primary-only scoring when the staging table is absent or empty.

Shared source-specific helpers now own the duplicate discovery/liquidity normalization rules:

- GeckoTerminal request construction, pool parsing, and pool-type normalization: `worker/src/cron/dex-liquidity/geckoterminal-shared.ts`
- CoinGecko onchain parsing, fee-bucket classification, balance-ratio inference, and locked-liquidity parsing: `worker/src/cron/dex-liquidity/coingecko-onchain-shared.ts`
- CoinGecko tickers filtering, exchange aggregation, synthetic orderbook TVL, and price-observation gating: `worker/src/cron/dex-liquidity/coingecko-tickers-shared.ts`
- GT/CG token-batch observation mapping: `worker/src/cron/dex-liquidity/token-price-observations.ts`

Data sources are split across two cron families: scoring remains on `10,40 * * * *`, while discovery sources (CoinGecko Onchain, GeckoTerminal, DexScreener, CoinGecko Tickers) now run only on `6,36 * * * *` (every 30 minutes) and write to `dex_pool_staging` for later merge.

See the [Discovery Cron](#discovery-cron) section below for the full discovery pipeline architecture.

### Quality Multipliers (v2)

| Pool Type                 | Multiplier | Detection                                                 |
| ------------------------- | ---------- | --------------------------------------------------------- |
| Curve StableSwap A>=500   | 1.0x       | `registryId` not containing `crypto` + A>=500             |
| Curve StableSwap A<500    | 0.85x      | `registryId` not containing `crypto` + A<500              |
| Curve CryptoSwap          | 0.5x       | `registryId` containing `crypto`/`twocrypto`/`tricrypto`  |
| Uniswap V3 1bp            | 1.1x       | fee tier <= 100                                           |
| Uniswap V3 5bp            | 0.85x      | fee tier <= 500                                           |
| Uniswap V3 30bp+          | 0.4x       | fee tier > 500                                            |
| Fluid DEX                 | 0.85x      | project contains `fluid`                                  |
| Aerodrome Stable (sAMM)   | 0.85x      | project contains `aerodrome` + `isStable` flag            |
| Aerodrome Volatile (vAMM) | 0.4x       | project contains `aerodrome`, non-stable                  |
| Balancer Stable           | 0.85x      | project contains `balancer` + stable pattern              |
| Balancer Weighted         | 0.4x       | project contains `balancer`, non-stable                   |
| Raydium CLMM              | 0.85x      | concentrated liquidity (direct API or DL)                 |
| Raydium AMM               | 0.4x       | standard AMM, wider spreads                               |
| Orca Whirlpool            | 0.85x      | concentrated liquidity (direct API or DL)                 |
| Generic AMM               | 0.3x       | fallback                                                  |
| Orderbook                 | 0.6x       | CoinGecko tickers fallback (centralized exchange, no AMM) |

### Pool Quality Adjustments

- **Balance health**: Continuous `Math.pow(balanceRatio, 1.5)` instead of binary threshold
- **Pair quality**: Co-token scored using Pharos governance classification (CeFi->1.0, DeFi->0.9, CeFi-Dep->0.8) + static map for volatile assets (WETH->0.65, WBTC->0.6, unknown->0.3). Known quote aliases such as `USD₮0`, `USDT0`, `aUSDC`, `aUSDT`, `USDbC`, and `.e` bridged variants are normalized to canonical symbols before scoring. Multi-asset pools use best co-token score
- **MetaPool TVL dedup**: Uses `usdTotalExcludingBasePool` to prevent double-counting base pool liquidity across ~322 Curve metapools
- **Effective TVL**: `poolTvl x mechanismMultiplier x balanceHealth x pairQuality`, summed across all pools

For direct APIs, balance health is no longer uniformly neutral. Balancer, Raydium, Orca, and resolver-backed Fluid pools now contribute measured balance ratios when their APIs provide enough token-balance and pricing context. Fluid pools still default to `1.0` balance when the official resolver is unavailable or token decimals cannot be resolved safely.

### Data Quality Filters

- `isBroken === true` Curve pools: skipped
- Dead/rugged/deprecated protocols: excluded from `dexProjects` set
- `exposure === "single"` pools (lending deposits, not DEX liquidity): skipped
- CryptoSwap pools: correctly classified via `registryId`

### CoinGecko Onchain Integration

CoinGecko Onchain is now a discovery-stage source rather than a direct scoring-cron fetch. Its outputs are written into `dex_pool_staging` and later merged by `syncDexLiquidity()` if the staged rows are fresh. Pool parsing, fee-tier classification, balance-ratio inference, and locked-liquidity parsing are shared between discovery and liquidity through `worker/src/cron/dex-liquidity/coingecko-onchain-shared.ts`.

Chain resolution is registry-backed in `worker/src/lib/chain-registry.ts`: the worker keeps one canonical internal chain id per deployment (`bob`, `worldchain`, `plasma`, etc.) and maps it to provider-specific network slugs (`bob-network`, `world-chain`, `plasma`, ...). When `COINGECKO_API_KEY` is configured, pool discovery uses CoinGecko `/onchain` for chains with a `coingecko` mapping and still runs GeckoTerminal for chains that only have a `geckoTerminal` mapping. This avoids the old all-or-nothing mode switch where enabling CoinGecko could silently drop GT-only chains.

| Feature          | GeckoTerminal (fallback)                                                                                                                | CoinGecko Onchain (paid)                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Rate limit       | 30 req/min                                                                                                                              | ~240 req/min                                                                                                                        |
| Chain coverage   | Registry-backed GT network slugs for canonical chains, including slug aliases such as `bob-network`, `manta-pacific`, and `world-chain` | Registry-backed CG network ids for chains with explicit CG support; GT-only chains still flow through GeckoTerminal in the same run |
| Balance data     | Not available (defaults to 1.0)                                                                                                         | Approximated from token prices                                                                                                      |
| Fee tier         | DEX-prefix lookup only                                                                                                                  | `pool_fee_percentage` field                                                                                                         |
| Locked liquidity | Not available                                                                                                                           | `locked_liquidity_percentage` field                                                                                                 |

The CG integration extracts three signals unavailable from GeckoTerminal:

1. **Balance ratio approximation**: Computed from `base_token_price_usd`/`quote_token_price_usd` for stable pairs. Feeds into `balanceHealth`, `balanceRatioWeightedSum`, and pool stress.
2. **Fee tier classification**: `pool_fee_percentage` enables proper quality multipliers for non-Uniswap concentrated liquidity pools (PancakeSwap V3, SushiSwap V3, etc.).
3. **Locked liquidity**: Persisted for pool-quality context and API observability, but not currently included in the live durability score.

### DexScreener Fallback

DexScreener runs in two complementary paths:

1. **Discovery cron** (`sync-dex-discovery`): Populates `dex_pool_staging` with pool data for later merge during scoring.
2. **Scoring-cron fallback** (`sync-dex-liquidity`, step 5b): After primary sources and staged-pool merge, any tracked stablecoin that still has zero pools or no usable DEX price observation is queried directly via DexScreener's `/tokens/v1/{chainId}/{address}` endpoint. This covers 30+ chains including Solana, Berachain, Monad, MegaETH, Plume, and other exotic chains. The fallback shares a 2-minute time budget with the CG tickers fallback.

Address matching uses both canonical `contracts` and optional `tradedContracts` metadata. `tradedContracts` is reserved for wrapper / secondary-market token addresses that are meaningfully used for DEX discovery even when issuer metadata points to a different canonical deployment.

Quality gates:

- Pool TVL must exceed $1,000
- Pool must have 24h volume > 0 or TVL > $10,000
- Pools are accepted when the tracked token is either the base or quote asset
- Quote-side pools still require an explicit tracked-token USD derivation before they can contribute a DEX price observation
- Pools already discovered by the primary pipeline are deduplicated by exact or uniquely derived pool identity
- Generic quality multiplier (0.3x) unless the DEX ID matches a known protocol (same `GT_DEX_QUALITY` lookup)

DexScreener pools are merged using the same `mergeGtPools()` logic — no balance ratio data, neutral organic fraction default (0.5).

### CoinGecko Tickers Fallback (Orderbook DEXes)

CoinGecko Tickers runs in two complementary paths:

1. **Discovery cron** (`sync-dex-discovery`): Synthetic orderbook pools enter scoring through `dex_pool_staging`.
2. **Scoring-cron fallback** (`sync-dex-liquidity`, step 5b): After DexScreener fallback, any coin that still has zero pools or no usable DEX price observation and has a `geckoId` is queried via CoinGecko's `/coins/{id}/tickers` endpoint. This covers coins whose primary liquidity lives on orderbook exchanges not tracked by DeFiLlama or DexScreener (e.g. KAG and KAU on Kinesis Exchange). Shares the 2-minute fallback time budget.

Ticker filtering: `!is_stale && !is_anomaly && trust_score !== null && convertedVolumeUsd >= 1,000`. Only USD-equivalent quote assets are accepted (USD, USDT, USDC, DAI, C1USD, etc.). Filtering, exchange aggregation, synthetic TVL construction, and orderbook price-observation gating are shared between discovery and liquidity through `worker/src/cron/dex-liquidity/coingecko-tickers-shared.ts`.

Per-exchange aggregation: all valid tickers from the same exchange are combined into one synthetic pool entry:

- `syntheticTvl = totalVolume × 3` (assumes ~33% daily turnover — conservative for precious-metals orderbooks)
- `poolType: "orderbook"`, quality multiplier 0.6x
- `priceUsd = volume-weighted average` across accepted tickers on that exchange
- Maturity defaults to 365 days (established exchange)

The 0.6x quality multiplier reflects that orderbook exchanges are legitimate but centralized (not fully on-chain), placing them between Aerodrome volatile (0.4x) and Balancer stable (0.85x).

Uses the same `mergeGtPools()` merge path — no new data structures required.

### Pool Stress Index (0-100)

Per-pool stress metric: `35x(1-balanceRatio) + 25x(1-organicFraction) + 20xImmaturityPenalty + 20x(1-pairQuality)`. TVL-weighted average stored as `avg_pool_stress`.

### Durability Score (0-100)

Per-stablecoin durability metric combining: TVL stability from 30-day CV (35%), volume consistency from 30-day CV (25%), oldest pool maturity (25%), and organic fee fraction with sqrt curve (15%). Locked liquidity removed — no reliable data source. Stored as `durability_score`.

#### Pool Quality Formula

Pool Quality uses the same log-scale formula as TVL Depth, applied to quality-adjusted TVL:

`poolQuality = min(100, max(0, 20 * log10(max(qualityAdjustedTvl, 1) / 100_000) + 20))`

Where `qualityAdjustedTvl` applies mechanism, balance health, and pair quality multipliers to raw TVL. Examples: $100K→20, $1M→40, $10M→60, $100M→80.

#### Durability Sub-Component Weights

- **35%** TVL stability — `1 - min(1, CV)` over 30-day snapshots (CV = coefficient of variation)
- **25%** Volume consistency — same CV formula over 30-day volume snapshots
- **25%** Maturity — oldest pool age, capped at 365 days: `min(1, oldestDays / 365) × 100`
- **15%** Organic fraction — `sqrt(organicFraction) × 100` (diminishing returns past 50%; 25% organic → 50 score, 50% → 71 score, 100% → 100 score)

### Pool Identity (`poolId`)

Each `PoolEntry` carries a `poolId` field formatted as `chain:address` (lowercase). This uniquely identifies a physical pool across stablecoins. A single pool (e.g., USDC/USDT on Raydium) may appear under multiple stablecoin entries — `poolId` enables deduplication for global aggregates.

### Cross-Source Deduplication

DeFiLlama's yields API often uses opaque UUIDs as pool identifiers (for example `6b6de6c7-...`), while CoinGecko/GeckoTerminal/DexScreener and direct protocol APIs usually expose on-chain pool addresses. The scorer therefore tracks a **pool identity** with two layers:

- `exactPoolKey`: `chain:poolId` when the id is trustworthy (EVM address, Solana-style address, or orderbook-native id)
- `derivedMatchKey`: `chain + normalized protocol + sorted tokens + pool shape + fee bucket + stable/volatile flag`

Dedup rules are intentionally conservative:

- exact ids always win when both sides expose the same real pool id
- derived matches only deduplicate when the match is unique on both sides
- ambiguous same-pair pools stay separate, so legitimate parallel pools are not collapsed

The scoring cron applies the same identity logic during staged-pool merge and DexScreener fallback intake. `/status` exposes the split directly via `stagedPoolsSkippedByExactIdentity` versus `stagedPoolsSkippedByUniqueDerivedIdentity`.

### Coverage Confidence

Every scored row now persists:

- `coverage_class`: `primary`, `mixed`, `fallback`, `legacy`, or `unobserved`
- `coverage_confidence`: current trust score for the row (`1.0`, `0.85`, `0.55`, `0.5`, or `0`)
- `source_mix_json`: compact source-family composition for the retained pool set

`primary` coverage now includes both pure-`dl` rows and pure-`direct_api` rows. `fallback` is reserved for rows built entirely from staged / DexScreener / CoinGecko-tickers style recovery sources.

Current rows also persist:

- `balance_measured_tvl_usd`
- `organic_measured_tvl_usd`

These measurement-denominator fields let the frontend weight balance/organic aggregates only by TVL that actually had measured inputs.

### Storage

Stored in D1 `dex_liquidity` table (created in migration 0009; extended in 0010, 0012, 0024, 0036, and 0061) with per-stablecoin aggregate metrics, protocol/chain TVL breakdowns, top 10 pools as JSON columns, plus v2/v3 columns: `avg_pool_stress`, `weighted_balance_ratio`, `organic_fraction`, `effective_tvl_usd`, `durability_score`, `score_components_json`, `locked_liquidity_pct`, `coverage_class`, `coverage_confidence`, `source_mix_json`, `balance_measured_tvl_usd`, `organic_measured_tvl_usd`, and `methodology_version`. Stablecoins with no observed DEX presence store `liquidity_score = NULL` (NR semantics) and `coverage_class = 'unobserved'`.

Both `dex_liquidity` and `dex_liquidity_history` also carry `methodology_version` (migration 0036), reconstructed from commit-history version windows in `shared/lib/liquidity-score-version.ts`. Historical rows also persist `coverage_class`, `coverage_confidence`, and `source_mix_json`. Legacy pre-0061 rows are backfilled as `coverage_class = 'legacy'` and `coverage_confidence = 0.5`.

Discovery and merge staging tables are documented in the [Discovery Cron](#discovery-cron) section below.

## Discovery Cron

`worker/src/cron/dex-discovery/orchestrator.ts` runs every 30 minutes (`6,36 * * * *`) and is responsible for pool discovery only. Scored TVL continues on the 30-minute cadence; discovery data is merged during the scoring run.

- **Architecture**: two dedicated cron tracks feed discovery from scratch:
  - Scoring cron: `syncDexLiquidity()` every 30 minutes (`10,40 * * * *`).
  - Discovery cron: `syncDexDiscovery()` every 30 minutes (`6,36 * * * *`).
  - Discovery writes normalized candidates to `dex_pool_staging`; scoring cron consumes and merges them.
- **Discovery staging schema**: `dex_pool_staging` includes `pool_id`, `stablecoin_id`, `source`, `chain`, `protocol`, `dex_id`, `symbol`, `tvl_usd`, `volume_24h`, `quality_multiplier`, `pool_type`, `fee_tier`, `balance_ratio`, `is_stable`, `base_token`, `quote_token`, `quote_symbol`, `price_usd`, `locked_liq_pct`, `raw_json`, `discovered_at`, `refreshed_at`; PK is `(pool_id, stablecoin_id)`.
- **Discovery meta schema**: `dex_discovery_meta` stores `stablecoin_id` (PK), `consecutive_misses`, `last_crawl_at`, `last_hit_at`.
- **Tiered priority**:
  - T1: coins with 0 pools (or effectively eligible baseline), every run.
  - T2: 1–4 pools or 1 chain, every 3rd run.
  - T3: `>=5` pools on `>=2` chains, every 10th run.
  - Global scheduling is tier-first (`T1 -> T2 -> T3 -> dormant`), with staleness used only as the tie-breaker inside a tier.
- **Exponential backoff** (applied as a tier floor from `consecutiveMisses`; effective tier is `max(baseTier, backoffTier)`):
  - 0–2 misses: no backoff override (base tier from pool/chain counts determines placement)
  - 3–5: floor T2
  - 6–9: floor T3
  - 10+: dormant (daily gate)
  - Any discovery hit resets `consecutiveMisses` to 0, removing the backoff floor; the coin's tier is then recomputed from its pool/chain counts on the next run.
- **Chain-aware source routing**: discovery only queries chains with defined entries in a stablecoin’s `contracts` plus optional `tradedContracts` metadata; this avoids unnecessary API calls against un-deployed chains while preserving wrapper/secondary-market discovery addresses.
- **Freshness confidence decay**: staged pool effective TVL is multiplied by `max(0.5, 1 - ageHours / 48)`; rows older than 24h are excluded from scoring merge.
- **Staged pool defaults**: `organic_fraction = 0.5`, `balanceRatio = 1.0`, `lockedLiquidity = null`, `maturity = min(daysSinceDiscovered, 30)`, `isStable` inferred from normalized `quoteSymbol`.
- **Source order and transport**: `CG Onchain -> GeckoTerminal -> DexScreener -> CG Tickers`, executed sequentially with one active fetch at a time (`1` connection).
- **Failure telemetry**: cron metadata records both `failedCoins` and `failedCoinErrors`; DexScreener malformed-pair or per-target errors are downgraded to warnings so a single bad fallback payload does not fail the whole coin crawl.

### Global Deduped Aggregates (`__global__`)

A sentinel row with `stablecoin_id = '__global__'` stores cross-stablecoin aggregates where each physical pool is counted only once (deduped by `poolId`). This prevents double-counting when a pool contains multiple tracked stablecoins (e.g., a USDT/USDC pool would otherwise add its full TVL to both USDT and USDC rows).

The `__global__` row contains deduped `total_tvl_usd`, `total_volume_24h_usd`, `total_volume_7d_usd`, `pool_count`, `chain_count`, `protocol_tvl_json`, and `chain_tvl_json`. 24h and 7d volumes are deduped by `poolId` the same way TVL is. Score-related fields (`liquidity_score`, `concentration_hhi`, etc.) are NULL.

The frontend reads `__global__` for overview stats (total DEX TVL, 24h volume, protocol/chain breakdown bars) instead of naively summing per-stablecoin values. The constant `DEX_GLOBAL_KEY` (`shared/types/index.ts`) provides the key.
The liquidity overview's `Protocol TVL Breakdown` legend is capped at 10 entries total: the top 9 protocols render individually, and the remainder is grouped into `Other`.

### Additional Liquidity Metrics

- **Concentration HHI**: Herfindahl-Hirschman Index computed from the full retained pool set after filtering/caps but before top-10 display truncation. Range 0-1 (1.0 = single pool). Stored as `concentration_hhi`.
- **Depth Stability**: Coefficient of variation of daily TVL over 30-day rolling window, inverted to 0-1 scale. Requires >=7 days of data. Stored as `depth_stability`.
- **TVL Trends**: 24h and 7d percentage changes computed from daily history snapshots, but only when a baseline exists within a tolerance window (`12h` for 24h, `36h` for 7d) and that snapshot has `coverage_confidence >= 0.5`. Otherwise the API returns `null`.
- **Depth Stability / Volume Consistency inputs**: durability history uses only snapshots with `coverage_confidence >= 0.75`; fewer than 7 confident rows fall back to neutral durability defaults.
- **Daily Snapshots**: One snapshot per stablecoin per day in `dex_liquidity_history` table (migration 0010, confidence fields added in 0061). Written on first sync after UTC midnight.

---

## DEX Price Cross-Validation

`dex_prices` table (migration 0011) stores DEX-implied USD prices extracted from multiple DEX sources. Updated every 30 minutes during `syncDexLiquidity()`.

**Price observation sources:**

| Source               | Tier | Chains                            | Method                                                                | Filter                                                                                                                                               |
| -------------------- | ---- | --------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Curve StableSwap** | 1 (1.0) | Ethereum, Base, Arbitrum, Polygon | Curve Finance API `usdPrice` per coin                                 | TVL >= $50K, balance ratio >= 0.3                                                                                                                    |
| **Uniswap V3**       | 1 (1.0) | Ethereum, Base, Arbitrum, Polygon | Subgraph `token0Price`/`token1Price` relative to USD reference tokens | TVL >= $50K, one side must be USDC/USDT/DAI/etc. (after alias normalization such as `USD₮0` -> `USDT`), peg-aware price sanity against the shared validation engine |
| **Aerodrome**        | 1 (1.0) | Base                              | Subgraph `token0Price`/`token1Price` + `reserveUSD`                   | TVL >= $50K, balance ratio >= 0.3, peg-aware price sanity against the shared validation engine                                                        |
| **Fluid**            | 1 (1.0) | Ethereum, Arbitrum, Base, Polygon, BSC, Plasma | Direct API `last_price` (base/target ratio)                           | TVL >= $50K, peg-aware price sanity against the shared validation engine                                                                              |
| **Balancer**         | 1 (1.0) | 14 mapped chains (ETH, ARB, Base, Polygon, Optimism, Gnosis, Avalanche, Sonic, Fantom, Monad, HyperEVM, Plasma, Mode, zkEVM) | Derived from `balanceUSD / balance` per token                         | TVL >= $50K, peg-aware price sanity against the shared validation engine                                                                              |
| **Raydium**          | 1 (1.0) | Solana                            | Direct API `price` field (base/quote ratio)                           | TVL >= $50K, peg-aware price sanity against the shared validation engine                                                                              |
| **Orca**             | 1 (1.0) | Solana                            | Direct API `price` field (base/quote ratio)                           | TVL >= $50K, peg-aware price sanity against the shared validation engine                                                                              |
| **DexScreener**      | lower | 30+ chains (universal fallback)   | Token pools API `priceUsd`                                            | Pair liquidity >= $50K for price observations, >= $1K for pool discovery, peg-aware price sanity against the shared validation engine                |

**Price extraction pipeline:**

1. Collect price observations from all source families during data fetching phase
2. Merge all observations into a single map keyed by stablecoin ID
3. Collapse duplicate observations of the same physical pool (exact pool id or unique derived identity) so one pool only carries weight once
4. Compute TVL-weighted median per stablecoin (robust against distorted pools from any single source)
5. Compare with primary price from D1 cache to compute `deviation_from_primary_bps`
6. Store in `dex_prices` with one aggregated JSON entry per protocol in `price_sources_json`
7. Publish qualifying challenger pools from the full retained pool set into `dex_price_challenger_snapshots` and `dex_price_challengers`
8. Retire any pre-existing `dex_prices` rows whose stablecoin has no observations in the latest successful scoring run, so the table reflects current DEX coverage rather than last-seen coverage

DEX observation validation now loads the current FX / gold / silver references **once per cron entrypoint** and passes them through the scoring and discovery paths. In normal operation this means:

- fiat pegs validate against live FX references, not only hardcoded fallback ranges
- gold/silver pegs validate against live spot references, scaled by `commodityOunces` for fractional tokens

The primary-pricing bridge now reads `dex_prices.price_sources_json` as a per-protocol aggregate (`fluid`, `balancer`, `raydium`, `orca`, etc.) rather than as repeated individual pool rows. Individual pool challenge reads instead come from the dedicated challenger tables published from the full retained pool set, so consensus promotion, depeg confirmation, and UI top-pool display no longer share the same storage shape.

Every source family now uses the same minimum liquidity rule for DEX prices: a pool must contribute at least `$50K` of liquidity at observation time. For staged discovery rows, the floor is applied after freshness confidence decay.

**Confirmation gate in `detectDepegEvents()`:**

- When primary price shows depeg (>=100bps), check DEX price
- Only **trusted** DEX rows are used for depeg suppression/confirmation: freshness `<20 min` and aggregate source TVL `>= $1M`
- If a trusted DEX price shows coin at peg (<100bps): **suppress** new depeg event (likely false positive)
- If DEX unavailable, stale, or confirms depeg: open event normally
- Only affects **opening new** events — existing event updates/closures unchanged
- ~80-100 stablecoins covered by multi-source observations; remainder fall through to primary-only detection

**API exposure:**

- `/api/dex-liquidity`: adds `dexPriceUsd`, `dexDeviationBps`, `priceSourceCount`, `priceSourceTvl`, `priceSources`, `coverageClass`, `coverageConfidence`, `sourceMix`, `balanceMeasuredTvlUsd`, `organicMeasuredTvlUsd`
- `/api/dex-liquidity`: adds a `Warning` header when the latest `sync-dex-liquidity` run was degraded or failed and the endpoint is serving the last successful dataset
- `/api/peg-summary`: adds optional `dexPriceCheck` per coin when the row passes a UI trust gate (fresh within 60 minutes and aggregate source TVL `>= $250K`)

**Frontend:**

- `dex-liquidity-card.tsx`: shows DEX-implied price section when available plus coverage badges (`Primary`, `Mixed`, `Fallback`, `NR`)
- `/liquidity`: shows coverage badges and a separate unrated/unobserved section instead of silently dropping NR assets
- Detail and overview liquidity surfaces now attach contextual methodology hints to the score label, `Effective TVL`, and key summary stats, with score-card footer links back to `/methodology/#liquidity-methodology`
- `peg-heatmap.tsx`: amber "!" badge on tiles where DEX disagrees with primary
