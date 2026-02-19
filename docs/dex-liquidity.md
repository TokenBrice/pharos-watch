# DEX Liquidity Score & Price Cross-Validation

## DEX Liquidity Score

`syncDexLiquidity()` in `sync-dex-liquidity.ts` runs every 10 minutes and computes a composite liquidity score (0-100) per stablecoin from 6 components:

| Component | Weight | Source | How Computed |
|-----------|--------|--------|-------------|
| **TVL Depth** | 30% | DeFiLlama Yields | Log-scale using effective TVL (quality-adjusted, metapool-deduped): $100K->20, $1M->40, $10M->60, $100M->80, $1B+->100 |
| **Volume Activity** | 20% | DeFiLlama Yields | Volume/TVL ratio. 0->0, 0.5->100 |
| **Pool Quality** | 20% | Curve API + DeFiLlama | Quality-adjusted TVL using mechanism x balance health x pair quality multipliers (see below) |
| **Durability** | 15% | DeFiLlama Yields + History | 40% organic fraction, 25% TVL stability, 20% volume consistency, 15% maturity |
| **Pair Diversity** | 7.5% | DeFiLlama Yields | Pool count, diminishing returns: min(100, poolCount x 5) |
| **Cross-chain** | 7.5% | DeFiLlama Yields | 1 chain->15, 2->40, 3->60, 5->80, 8+->100 |

Data sources: DeFiLlama Yields API (single request for all ~18K pools) + Curve Finance API (per-chain requests for A-factor, balance data, registry IDs, and metapool structure).

### Quality Multipliers (v2)

| Pool Type | Multiplier | Detection |
|-----------|-----------|-----------|
| Curve StableSwap A>=500 | 1.0x | `registryId` not containing `crypto` + A>=500 |
| Curve StableSwap A<500 | 0.85x | `registryId` not containing `crypto` + A<500 |
| Curve CryptoSwap | 0.5x | `registryId` containing `crypto`/`twocrypto`/`tricrypto` |
| Uniswap V3 1bp | 1.1x | fee tier <= 100 |
| Uniswap V3 5bp | 0.85x | fee tier <= 500 |
| Uniswap V3 30bp+ | 0.4x | fee tier > 500 |
| Fluid DEX | 0.85x | project contains `fluid` |
| Balancer Stable | 0.85x | project contains `balancer` + stable pattern |
| Balancer Weighted | 0.4x | project contains `balancer`, non-stable |
| Generic AMM | 0.3x | fallback |

### Pool Quality Adjustments

- **Balance health**: Continuous `Math.pow(balanceRatio, 1.5)` instead of binary threshold
- **Pair quality**: Co-token scored using Pharos governance classification (CeFi->1.0, DeFi->0.9, CeFi-Dep->0.8) + static map for volatile assets (WETH->0.65, WBTC->0.6, unknown->0.3). Multi-asset pools use best co-token score
- **MetaPool TVL dedup**: Uses `usdTotalExcludingBasePool` to prevent double-counting base pool liquidity across ~322 Curve metapools
- **Effective TVL**: `poolTvl x mechanismMultiplier x balanceHealth x pairQuality`, summed across all pools

### Data Quality Filters

- `isBroken === true` Curve pools: skipped
- Dead/rugged/deprecated protocols: excluded from `dexProjects` set
- `exposure === "single"` pools (lending deposits, not DEX liquidity): skipped
- CryptoSwap pools: correctly classified via `registryId`

### Pool Stress Index (0-100)

Per-pool stress metric: `35x(1-balanceRatio) + 25x(1-organicFraction) + 20xImmaturityPenalty + 20x(1-pairQuality)`. TVL-weighted average stored as `avg_pool_stress`.

### Durability Score (0-100)

Per-stablecoin durability metric combining: organic fee fraction (40%), TVL stability from 30-day CV (25%), volume consistency from 30-day CV (20%), and oldest pool maturity (15%). Stored as `durability_score`.

### Storage

Stored in D1 `dex_liquidity` table (migration 0009 + 0012) with per-stablecoin aggregate metrics, protocol/chain TVL breakdowns, top 10 pools as JSON columns, plus v2 columns: `avg_pool_stress`, `weighted_balance_ratio`, `organic_fraction`, `effective_tvl_usd`, `durability_score`, `score_components_json`. Stablecoins with no DEX presence get score 0.

### Additional Liquidity Metrics

- **Concentration HHI**: Herfindahl-Hirschman Index computed from pool TVL shares before top-10 truncation. Range 0-1 (1.0 = single pool). Stored as `concentration_hhi`.
- **Depth Stability**: Coefficient of variation of daily TVL over 30-day rolling window, inverted to 0-1 scale. Requires >=7 days of data. Stored as `depth_stability`.
- **TVL Trends**: 24h and 7d percentage changes computed from daily history snapshots. Returned as `tvlChange24h`/`tvlChange7d`.
- **Daily Snapshots**: One snapshot per stablecoin per day in `dex_liquidity_history` table (migration 0010). Written on first sync after UTC midnight.

---

## DEX Price Cross-Validation

`dex_prices` table (migration 0011) stores DEX-implied USD prices extracted from Curve StableSwap pools. Updated every 10 minutes during `syncDexLiquidity()` at zero additional API cost.

**Price extraction pipeline:**
1. During Curve API parsing, collect price observations for each tracked stablecoin from pools with TVL >= $50K and balance ratio >= 0.3
2. Compute TVL-weighted median per stablecoin (robust against single distorted pool)
3. Compare with primary price from D1 cache to compute `deviation_from_primary_bps`
4. Store in `dex_prices` with top 5 source pools as JSON

**Confirmation gate in `detectDepegEvents()`:**
- When primary price shows depeg (>=100bps), check DEX price
- If DEX price is fresh (<20 min) and shows coin at peg (<100bps): **suppress** new depeg event (likely false positive)
- If DEX unavailable, stale, or confirms depeg: open event normally
- Only affects **opening new** events — existing event updates/closures unchanged
- ~30-40 stablecoins covered by Curve; ~80 fall through to primary-only detection

**API exposure:**
- `/api/dex-liquidity`: adds `dexPriceUsd`, `dexDeviationBps`, `priceSourceCount`, `priceSourceTvl`, `priceSources`
- `/api/peg-summary`: adds optional `dexPriceCheck` per coin

**Frontend:**
- `dex-liquidity-card.tsx`: shows DEX-implied price section when available
- `peg-heatmap.tsx`: amber "!" badge on tiles where DEX disagrees with primary
