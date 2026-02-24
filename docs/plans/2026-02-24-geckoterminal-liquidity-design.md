# GeckoTerminal Liquidity Enrichment

**Date:** 2026-02-24
**Status:** Approved

## Goal

Integrate GeckoTerminal (GT) as a gap-filling DEX data source in the liquidity pipeline. GT covers 1,500+ DEXes across 200+ chains — far more than our current dedicated integrations (Curve, UniV3, Aerodrome). This adds broader pool coverage, better price observations, and replaces DexScreener entirely.

## Approach: Discovery + Dedup

GT runs **after** existing sources (DeFiLlama Yields, Curve API, UniV3 Subgraph, Aerodrome Subgraph) and fills gaps only. Pools already seen from existing sources are skipped for TVL/volume but still yield price observations.

## Data Flow

```
Existing pipeline (unchanged):
  1. DeFiLlama Yields → pool TVL/volume/APY
  2. Curve API → pool mechanism, A-factor, balance, metapool dedup
  3. UniV3 Subgraph → fee tiers, token prices
  4. Aerodrome Subgraph → reserve data, price observations
  5. DexScreener → REMOVED

New step (replaces DexScreener):
  5. GeckoTerminal:
     a. Token-level batch: /tokens/multi/ per chain (~10 requests)
        → aggregate total_reserve_in_usd, volume, price per token
     b. Pool-level crawl: /tokens/{addr}/pools per chain (~250 requests, 2s spacing)
        → individual pool TVL, volume, DEX ID, price observations
     c. Curve exclusion: skip any pool where dex.id matches curve-*
     d. Address dedup: skip TVL/volume for pools already in known set
     e. New pools: add with DEX-ID-based quality multiplier
     f. Price observations: extract from ALL non-Curve GT pools
```

## Pool Matching & Dedup

### Known pools set

Before GT crawl, collect all pool addresses from existing sources into `Set<string>` keyed by `{chain}:{address}` (lowercase):

- DeFiLlama Yields: `pool.pool` field
- Curve API: pool addresses per chain
- UniV3 Subgraph: pool `id` per chain
- Aerodrome Subgraph: pair addresses

### GT network → chain mapping

```
eth → ethereum, base → base, arbitrum → arbitrum,
polygon_pos → polygon, bsc → bsc, avax → avalanche,
optimism → optimism, celo → celo, xdai → gnosis, ftm → fantom
```

### Dedup rules

1. Pool DEX ID matches `curve-*` → **skip entirely** (Curve API handles these with superior data)
2. Pool address is in known set → **skip for TVL/volume**, but **extract price observation**
3. Pool address is NOT in known set → **add as new pool** with GT-sourced metrics

### Token resolution

GT pools include `base_token` and `quote_token` with addresses. Match against `addressToId` map (built from `stablecoins.ts` contracts + address learning from earlier pipeline steps).

## Quality Multipliers for GT-Only Pools

For pools not covered by existing dedicated sources, assign quality based on DEX ID:

| DEX pattern | Quality | Rationale |
|---|---|---|
| `balancer-v2-*` | 0.7 | Stable pools likely but can't distinguish |
| `velodrome-*` | 0.7 | Solidly-fork, stable-optimized |
| `pancakeswap-v3-*` | 0.5 | Concentrated liquidity, unknown fee tier |
| `trader-joe-*` | 0.5 | Liquidity Book (concentrated) |
| `sushiswap-v3-*` | 0.5 | Concentrated liquidity |
| `camelot-v3-*` | 0.5 | Concentrated liquidity |
| `maverick-*` | 0.5 | Concentrated liquidity |
| `ambient-*` | 0.5 | Concentrated liquidity |
| All others | 0.3 | Generic AMM (same as current default) |

**Balance ratio:** GT doesn't provide per-token reserves, so GT-only pools get `balanceRatio = 1.0` (neutral).

**Organic fraction:** GT doesn't provide APY data, so GT-only pools get `organicFraction = 0.5` (neutral default).

**Pool maturity:** GT provides `pool_created_at` timestamp, so we CAN compute maturity days for GT pools.

## Price Observations (Replaces DexScreener)

For every non-Curve GT pool, extract:

```typescript
{
  price: parseFloat(attributes.base_token_price_usd), // or quote, whichever is our stablecoin
  tvl: parseFloat(attributes.reserve_in_usd),
  chain: chainName,
  protocol: dexId,
}
```

**Filters:**
- `reserve_in_usd >= 50,000`
- `price > 0` and `0.5 <= price <= 2.0` for USD pegs
- Token must resolve to a tracked stablecoin

## Request Budget & Timing

### Phase 1 — Token-level batch (~20 seconds)

- 8 chains x ~15 addresses per batch = 8-10 requests
- 2s spacing = ~20 seconds
- Returns: token-level `total_reserve_in_usd`, `volume_usd.h24`, `price_usd`

### Phase 2 — Pool crawl (~7-8 minutes)

- For each chain, for each stablecoin with a contract on that chain:
  - Fetch page 1 of `/networks/{chain}/tokens/{addr}/pools` (20 pools, sorted by TVL desc)
  - Only page 1 — top 20 pools per token per chain captures vast majority of liquidity
- ~250 requests x 2s spacing = ~8.3 minutes
- On 429 (rate limit): back off 60s, retry

### Total: ~9 minutes of 15-minute cron window

Remaining ~6 minutes for existing sources + score computation + DB writes.

### Optimization: Chain filtering

Skip chains where a stablecoin has no contract. Contracts are pre-populated in `stablecoins.ts`.

## Failure Handling

GT is non-fatal. If any GT request fails, existing sources still produce a valid sync. Same pattern as current DexScreener.

```typescript
try {
  gtPools = await fetchGeckoTerminalPools(addressToId, knownPoolAddrs);
  gtPriceObs = await fetchGeckoTerminalPriceObs(...);
} catch (err) {
  console.warn("[dex-liquidity] GeckoTerminal fetch failed (non-fatal):", err);
}
```

## What Changes

| Component | Change |
|---|---|
| `sync-dex-liquidity.ts` | Add GT fetch functions, remove DexScreener, wire into pipeline |
| `sync-dex-liquidity.ts` | Build known-pool-address set from existing sources |
| `sync-dex-liquidity.ts` | GT DEX quality multiplier map |
| No DB changes | GT pools use same `LiquidityMetrics` shape as existing pools |
| No API changes | Frontend sees more pools/chains in existing fields |
| No frontend changes | Existing components already display pool count, chain count, TVL |

## What Doesn't Change

- Curve API integration (unchanged, still primary for Curve pools)
- UniV3 Subgraph integration (unchanged)
- Aerodrome Subgraph integration (unchanged)
- DeFiLlama Yields integration (unchanged, still primary pool source)
- Liquidity score algorithm (unchanged, just more input pools)
- Database schema (no new tables or columns)
- API endpoints (no new endpoints)
- Frontend components (no changes)
