# DEX Liquidity Score & Price Cross-Validation

## DEX Liquidity Score

`syncDexLiquidity()` in `worker/src/cron/dex-liquidity/orchestrator.ts` runs every 30 minutes (on the `10,40 * * * *` cron schedule) and computes a composite liquidity score (0-100) per stablecoin from 6 components:

Cron result status semantics:

- `ok`: all required source families succeeded and coverage is within normal range.
- `degraded`: one or more critical non-fatal source families failed (for example DeFiLlama yields/protocol coverage), or coverage falls near the guardrail band.
- throw/error: catastrophic source failure (for example DL+Curve hard failure) still aborts the run.

Run metadata now includes `failedSources`, `fallbackMode` signals, staged-pool merge counters (`stagedPoolsMerged`, `stagedPoolsSkipped`, `stagedPoolsSkippedByAddress`, `stagedPoolsSkippedByFingerprint`), and detailed `sourceCoverage` values (`currentCoverage`, `previousCoverage`, `minExpectedCoverage`, `nearCoverageGuard`).

| Component           | Weight | Source                     | How Computed                                                                                                           |
| ------------------- | ------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **TVL Depth**       | 30%    | DeFiLlama Yields           | Log-scale using effective TVL (quality-adjusted, metapool-deduped): $100K->20, $1M->40, $10M->60, $100M->80, $1B+->100 |
| **Volume Activity** | 20%    | DeFiLlama Yields           | Volume/TVL ratio. 0->0, 0.5->100                                                                                       |
| **Pool Quality**    | 20%    | Curve API + DeFiLlama      | Quality-adjusted TVL using mechanism x balance health x pair quality multipliers (see below)                           |
| **Durability**      | 15%    | DeFiLlama Yields + History | 35% organic fraction, 25% TVL stability, 20% volume consistency, 15% maturity, 5% locked liquidity                     |
| **Pair Diversity**  | 7.5%   | DeFiLlama Yields           | Pool count, diminishing returns: min(100, poolCount x 5)                                                               |
| **Cross-chain**     | 7.5%   | DeFiLlama Yields           | 1 chain→15, then +12 per chain, capped at 100 (e.g. 2→27, 5→63, 9+→100)                                                |

Primary scoring inputs are DeFiLlama Yields API (single request for all ~18K pools) + Curve Finance API (per-chain requests for A-factor, balance data, registry IDs, and metapool structure) + Uniswap V3 Subgraph (4 chains) + Aerodrome Subgraph (Base). After primary-source pool matching, the scoring cron also reads fresh rows from `dex_pool_staging` (when present), applies freshness confidence decay to staged TVL/volume, skips staged pools already covered by primary sources, and merges the remaining pools before final scoring.

After pool filtering and protocol-level TVL caps are applied, the scorer rebuilds every aggregate (`total_tvl_usd`, `total_volume_24h_usd`, `effective_tvl_usd`, balance/organic/stress weights, protocol/chain breakdowns) from the retained pool set before computing the final score. Filtered or capped pools cannot continue influencing the score through stale pre-filter aggregates.

`dex_pool_staging` is the handoff point for discovery-only sources (CoinGecko Onchain, GeckoTerminal, DexScreener, CoinGecko Tickers). The scoring cron does not call those discovery APIs directly anymore; it consumes staged rows refreshed within the last 24 hours and gracefully falls back to primary-only scoring when the staging table is absent or empty.

Data sources are split across two cron families: scoring remains on `10,40 * * * *`, while discovery sources (CoinGecko Onchain, GeckoTerminal, DexScreener, CoinGecko Tickers) now run only on `3,23,43 * * * *` and write to `dex_pool_staging` for later merge.

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
| Generic AMM               | 0.3x       | fallback                                                  |
| Orderbook                 | 0.6x       | CoinGecko tickers fallback (centralized exchange, no AMM) |

### Pool Quality Adjustments

- **Balance health**: Continuous `Math.pow(balanceRatio, 1.5)` instead of binary threshold
- **Pair quality**: Co-token scored using Pharos governance classification (CeFi->1.0, DeFi->0.9, CeFi-Dep->0.8) + static map for volatile assets (WETH->0.65, WBTC->0.6, unknown->0.3). Known quote aliases such as `USD₮0`, `USDT0`, `aUSDC`, `aUSDT`, `USDbC`, and `.e` bridged variants are normalized to canonical symbols before scoring. Multi-asset pools use best co-token score
- **MetaPool TVL dedup**: Uses `usdTotalExcludingBasePool` to prevent double-counting base pool liquidity across ~322 Curve metapools
- **Effective TVL**: `poolTvl x mechanismMultiplier x balanceHealth x pairQuality`, summed across all pools

### Data Quality Filters

- `isBroken === true` Curve pools: skipped
- Dead/rugged/deprecated protocols: excluded from `dexProjects` set
- `exposure === "single"` pools (lending deposits, not DEX liquidity): skipped
- CryptoSwap pools: correctly classified via `registryId`

### CoinGecko Onchain Integration

CoinGecko Onchain is now a discovery-stage source rather than a direct scoring-cron fetch. Its outputs are written into `dex_pool_staging` and later merged by `syncDexLiquidity()` if the staged rows are fresh.

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
3. **Locked liquidity**: Weighted into durability scoring at 5% weight.

### DexScreener Fallback

DexScreener is now a discovery-stage source rather than an in-cron fallback pass. It populates `dex_pool_staging`, and the scoring cron merges those staged pools after primary-source processing.

After the primary pipeline (DeFiLlama + CG/GT + Curve + UniV3 + Aerodrome), any tracked stablecoin that still has zero pools or no usable DEX price observation is queried via DexScreener's `/tokens/v1/{chainId}/{address}` endpoint. This covers 30+ chains including Solana, Berachain, Monad, MegaETH, Plume, and other exotic chains.

Address matching uses both canonical `contracts` and optional `tradedContracts` metadata. `tradedContracts` is reserved for wrapper / secondary-market token addresses that are meaningfully used for DEX discovery even when issuer metadata points to a different canonical deployment.

Quality gates:

- Pool TVL must exceed $1,000
- Pool must have 24h volume > 0 or TVL > $10,000
- Only pools where our token is the base token are counted
- Pools already discovered by the primary pipeline are deduplicated by `chainId:pairAddress`
- Generic quality multiplier (0.3x) unless the DEX ID matches a known protocol (same `GT_DEX_QUALITY` lookup)

DexScreener pools are merged using the same `mergeGtPools()` logic — no balance ratio data, neutral organic fraction default (0.5).

### CoinGecko Tickers Fallback (Orderbook DEXes)

CoinGecko Tickers is now a discovery-stage source rather than a direct scoring-cron fallback pass. Its synthetic orderbook pools enter scoring through `dex_pool_staging`.

After DexScreener, any coin that still has zero pools or no usable DEX price observation and has a `geckoId` is queried via CoinGecko's `/coins/{id}/tickers` endpoint. This covers coins whose primary liquidity lives on orderbook exchanges not tracked by DeFiLlama or DexScreener (e.g. KAG and KAU on Kinesis Exchange).

Ticker filtering: `!is_stale && !is_anomaly && trust_score !== null && convertedVolumeUsd >= 1,000`. Only USD-equivalent quote assets are accepted (USD, USDT, USDC, DAI, C1USD, etc.).

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

Per-stablecoin durability metric combining: organic fee fraction (35%), TVL stability from 30-day CV (25%), volume consistency from 30-day CV (20%), oldest pool maturity (15%), and locked liquidity fraction (5%). Stored as `durability_score`.

### Pool Identity (`poolId`)

Each `PoolEntry` carries a `poolId` field formatted as `chain:address` (lowercase). This uniquely identifies a physical pool across stablecoins. A single pool (e.g., USDC/USDT on Raydium) may appear under multiple stablecoin entries — `poolId` enables deduplication for global aggregates.

### Cross-Source Deduplication

DeFiLlama's yields API uses opaque UUIDs as pool identifiers (e.g., `6b6de6c7-...`), while CoinGecko/GeckoTerminal/DexScreener return on-chain pool addresses. Since these formats never match, `buildKnownPoolAddresses()` also stores **token-pair fingerprints** in the format `fp:<chain>:<normalized_protocol>:<sorted_token_addresses>`. When CG/GT/DS discover a pool, they compute the same fingerprint from their base/quote token addresses and check against the known set. This prevents the same physical pool from being counted twice across data sources.

The scoring cron applies the same fingerprint dedup during staged-pool merge, so a discovery-stage row cannot be re-counted when DeFiLlama already covers the same physical pool under a UUID. `/status` exposes this split directly via `stagedPoolsSkippedByFingerprint` versus `stagedPoolsSkippedByAddress`.

### Storage

Stored in D1 `dex_liquidity` table (created in migration 0009; extended in 0010, 0012, 0024, and 0036) with per-stablecoin aggregate metrics, protocol/chain TVL breakdowns, top 10 pools as JSON columns, plus v2 columns: `avg_pool_stress`, `weighted_balance_ratio`, `organic_fraction`, `effective_tvl_usd`, `durability_score`, `score_components_json`, `locked_liquidity_pct`, and `methodology_version`. Stablecoins with no DEX presence store `liquidity_score = NULL` (NR semantics).

Both `dex_liquidity` and `dex_liquidity_history` also carry `methodology_version` (migration 0036), reconstructed from commit-history version windows in `shared/lib/liquidity-score-version.ts`.

Discovery and merge staging tables are documented in the [Discovery Cron](#discovery-cron) section below.

## Discovery Cron

`worker/src/cron/dex-discovery/orchestrator.ts` runs every 20 minutes (`3,23,43 * * * *`) and is responsible for pool discovery only. Scored TVL continues on the 30-minute cadence; discovery data is merged during the scoring run.

- **Architecture**: two dedicated cron tracks feed discovery from scratch:
  - Scoring cron: `syncDexLiquidity()` every 30 minutes (`10,40 * * * *`).
  - Discovery cron: `syncDexDiscovery()` every 20 minutes (`3,23,43 * * * *`).
  - Discovery writes normalized candidates to `dex_pool_staging`; scoring cron consumes and merges them.
- **Discovery staging schema**: `dex_pool_staging` includes `pool_id`, `stablecoin_id`, `source`, `chain`, `protocol`, `dex_id`, `symbol`, `tvl_usd`, `volume_24h`, `quality_multiplier`, `pool_type`, `fee_tier`, `balance_ratio`, `is_stable`, `base_token`, `quote_token`, `quote_symbol`, `price_usd`, `locked_liq_pct`, `raw_json`, `discovered_at`, `refreshed_at`; PK is `(pool_id, stablecoin_id)`.
- **Discovery meta schema**: `dex_discovery_meta` stores `stablecoin_id` (PK), `consecutive_misses`, `last_crawl_at`, `last_hit_at`.
- **Tiered priority**:
  - T1: coins with 0 pools (or effectively eligible baseline), every run.
  - T2: 1–4 pools or 1 chain, every 3rd run.
  - T3: `>=5` pools on `>=2` chains, every 10th run.
  - Global scheduling is tier-first (`T1 -> T2 -> T3 -> dormant`), with staleness used only as the tie-breaker inside a tier.
- **Exponential backoff**:
  - `consecutiveMisses` 0: T1
  - 3–5: T2
  - 6–9: T3
  - 10+: dormant (daily gate)
  - Any discovery hit resets `consecutiveMisses` to 0 and returns the coin to T1 immediately.
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
- **TVL Trends**: 24h and 7d percentage changes computed from daily history snapshots. Returned as `tvlChange24h`/`tvlChange7d`.
- **Daily Snapshots**: One snapshot per stablecoin per day in `dex_liquidity_history` table (migration 0010). Written on first sync after UTC midnight.

---

## DEX Price Cross-Validation

`dex_prices` table (migration 0011) stores DEX-implied USD prices extracted from multiple DEX sources. Updated every 30 minutes during `syncDexLiquidity()`.

**Price observation sources:**

| Source               | Chains                            | Method                                                                | Filter                                                                                                                                               |
| -------------------- | --------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Curve StableSwap** | Ethereum, Base, Arbitrum, Polygon | Curve Finance API `usdPrice` per coin                                 | TVL >= $50K, balance ratio >= 0.3                                                                                                                    |
| **Uniswap V3**       | Ethereum, Base, Arbitrum, Polygon | Subgraph `token0Price`/`token1Price` relative to USD reference tokens | TVL >= $50K, one side must be USDC/USDT/DAI/etc. (after alias normalization such as `USD₮0` -> `USDT`), peg-aware price sanity (`isReasonablePrice`) |
| **Aerodrome**        | Base                              | Subgraph `token0Price`/`token1Price` + `reserveUSD`                   | TVL >= $50K, balance ratio >= 0.3, peg-aware price sanity                                                                                            |
| **DexScreener**      | 30+ chains (universal fallback)   | Token pools API `priceUsd`                                            | Pair liquidity >= $50K for price observations, >= $1K for pool discovery, peg-aware price sanity                                                     |

**Price extraction pipeline:**

1. Collect price observations from all four source families during data fetching phase
2. Merge all observations into a single map keyed by stablecoin ID
3. Compute TVL-weighted median per stablecoin (robust against distorted pools from any single source)
4. Compare with primary price from D1 cache to compute `deviation_from_primary_bps`
5. Store in `dex_prices` with top 5 source pools as JSON (shows mixed protocols)

Every source family now uses the same minimum liquidity rule for DEX prices: a pool must contribute at least `$50K` of liquidity at observation time. For staged discovery rows, the floor is applied after freshness confidence decay.

**Confirmation gate in `detectDepegEvents()`:**

- When primary price shows depeg (>=100bps), check DEX price
- Only **trusted** DEX rows are used for depeg suppression/confirmation: freshness `<20 min` and aggregate source TVL `>= $1M`
- If a trusted DEX price shows coin at peg (<100bps): **suppress** new depeg event (likely false positive)
- If DEX unavailable, stale, or confirms depeg: open event normally
- Only affects **opening new** events — existing event updates/closures unchanged
- ~80-100 stablecoins covered by multi-source observations; remainder fall through to primary-only detection

**API exposure:**

- `/api/dex-liquidity`: adds `dexPriceUsd`, `dexDeviationBps`, `priceSourceCount`, `priceSourceTvl`, `priceSources`
- `/api/peg-summary`: adds optional `dexPriceCheck` per coin when the row passes a UI trust gate (fresh within 60 minutes and aggregate source TVL `>= $250K`)

**Frontend:**

- `dex-liquidity-card.tsx`: shows DEX-implied price section when available
- `peg-heatmap.tsx`: amber "!" badge on tiles where DEX disagrees with primary
