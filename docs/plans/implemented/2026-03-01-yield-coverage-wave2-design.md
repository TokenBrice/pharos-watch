# Yield Coverage Wave 2: Automatic Lending Pool Discovery

**Date:** 2026-03-01
**Status:** Approved

## Goal

Extend yield intelligence to non-yield-bearing stablecoins by automatically discovering the best lending pool from a curated protocol allowlist. Combined with fxUSD native yield, this brings total yield coverage from 23 to ~39 coins.

## Two Parts

### Part A: fxUSD Native Yield

fxUSD (ID 168) has a protocol-native Stability Pool on f(x) Protocol. This is a wave 1-style addition — static pool map + variant-free (direct pool, like ZCHF).

- **DL Pool:** `abd6c9e1-3b52-459a-a31b-9022a4dcf7e2` (FXUSDSTABILITYPOOLV2.0, fx-protocol, Ethereum, $33.9M TVL, ~4.0% APY)
- **yieldType:** `governance-set` (yield rate determined by protocol revenue distribution)
- **yieldSource:** "f(x) Protocol Stability Pool"
- No wrapper token — direct protocol staking.

Note: The DL pool symbol is `FXUSDSTABILITYPOOLV2.0`, not `fxUSD`, so it **must** use a static `YIELD_POOL_MAP` entry — auto-discovery would not find it.

### Part B: Automatic Lending Pool Discovery

For stablecoins that are not intrinsically yield-bearing, discover the best lending pool from a curated protocol allowlist at sync time.

#### Protocol Allowlist (12 protocols)

**Tier 1 (battle-tested, $1B+ historical TVL):**
- `aave-v3` — multi-chain lending, gold standard
- `compound-v3` — Ethereum-focused lending
- `sparklend` — MakerDAO/Sky ecosystem lending
- `spark-savings` — MakerDAO/Sky savings vaults
- `maple` — institutional-grade lending
- `yearn-finance` — OG DeFi vault aggregator

**Tier 2 (established, well-audited):**
- `fluid-lending` — Instadapp lending
- `euler-v2` — permissionless lending markets
- `venus-core-pool` — BSC blue-chip lending
- `kamino-lend` — Solana blue-chip lending
- `morpho-v1` — permissionless lending optimizer
- `pendle` — yield tokenization protocol

#### Discovery Logic

During each sync run, for coins without a static `YIELD_POOL_MAP` entry and not flagged `yieldBearing`:

1. Filter DL pools response (already fetched) by: `exposure === "single"`, `stablecoin === true`, `project` in allowlist
2. Match by coin symbol (case-insensitive)
3. Pick the pool with the highest TVL
4. Use that pool's APY data for the coin

No reward filtering — show total APY (base + reward). Users can see the split in the leaderboard.

#### Eligibility

Not every tracked stablecoin gets auto-discovery. Only coins meeting **all** of:
- Report card grade C+ or above (safety score >= 60)
- Not already flagged `yieldBearing` (those use the existing pipeline)
- Not dead/cemetery coins

This is evaluated dynamically at sync time using the safety scores already computed inline.

#### New Yield Type

Add `"lending-opportunity"` to the `YieldType` union. This distinguishes native yield coins from coins where yield comes from depositing into an external lending protocol.

- Frontend label: "Lending"
- Semantics: "you can earn this APY by depositing this coin on [protocol]"

#### Data Source Tag

Auto-discovered pools use data source `"defillama-auto"` (vs. `"defillama"` for static map matches). This lets the frontend and API distinguish manually curated from auto-discovered pools.

### Coins Covered by Auto-Discovery

With the 12-protocol allowlist, 15 coins gain yield data:

| Coin | ID | Best Protocol | Chain | TVL | APY |
|------|-----|---------------|-------|-----|-----|
| USDC | 2 | maple | Ethereum | $3.2B | 4.57% |
| USDT | 1 | aave-v3 | Ethereum | $2.1B | 1.94% |
| RLUSD | 250 | aave-v3 | Ethereum | $423M | 0.86% |
| PYUSD | 120 | aave-v3 | Ethereum | $189M | 1.65% |
| EURC | 50 | aave-v3 | Ethereum | $35M | 2.22% |
| USDG | 286 | kamino-lend | Solana | $16M | 2.68% |
| AUSD | 205 | yearn-finance | Katana | $3.1M | 12.80% |
| meUSD | 303 | morpho-v1 | Base | $2.7M | 0.94% |
| FDUSD | 119 | venus-core-pool | BSC | $2.3M | 7.07% |
| LUSD | 8 | aave-v3 | Ethereum | $2.3M | 0.31% |
| USD1 | 262 | kamino-lend | Solana | $1.0M | 2.62% |
| USDf | 246 | pendle | Ethereum | $0.1M | 4.33% |
| USR | 197 | euler-v2 | Ethereum | $0.1M | 0.98% |
| FRAX | 6 | aave-v3 | Arbitrum | $0.1M | 0.72% |
| MUSD | 313 | euler-v2 | Linea | $0.1M | 1.03% |

### Coins Still Uncovered (12)

These have no pools on allowlisted protocols or are gold/non-lendable:

- **Gold tokens (0% APY):** XAUT, PAXG
- **No DL pools anywhere:** EURR, SBC, XSGD, GYD, FIDD, DEURO
- **Only on non-allowlisted protocols:** HYUSD, USDH, XUSD
- **fxUSD** — covered by Part A (native yield), not auto-discovery

These coins get picked up automatically if a pool appears on an allowlisted protocol in the future.

## Changes by File

### `src/lib/types.ts`

Add `"lending-opportunity"` to the `YieldType` union.

### `src/lib/classification.ts`

Add label and style for `"lending-opportunity"` yield type.

### `src/lib/stablecoins.ts`

Add `yieldBearing: true` and `yieldConfig` for fxUSD (Part A only). Auto-discovered coins do NOT get `yieldBearing` flag — they're discovered dynamically.

### `worker/src/cron/yield-config.ts`

- Add fxUSD to `YIELD_POOL_MAP`
- Add `LENDING_PROTOCOL_ALLOWLIST` constant (Set of 12 protocol slugs)
- Update GATE comment

### `worker/src/cron/sync-yield-data.ts`

Main logic change. After processing `yieldBearing` coins, add a second pass:

1. Compute safety scores for all tracked coins (already done inline)
2. Filter to coins with score >= 60, not `yieldBearing`, not dead
3. For each, search DL pools by symbol within allowlisted protocols
4. Pick highest-TVL match
5. Resolve APY and compute PYS (same as existing pipeline)
6. Write to `yield_data` and `yield_history` with `data_source = "defillama-auto"` and `yield_type = "lending-opportunity"`

### `worker/src/lib/constants.ts`

Add `MIN_SAFETY_SCORE_FOR_YIELD = 60` constant.

### `docs/yield-intelligence.md`

Update tracked coin count, add auto-discovery section, document the allowlist.

### Frontend (no structural changes)

The leaderboard and scatter plot already render all coins from the yield-rankings API. The new `"lending-opportunity"` yield type badge will appear automatically via `YIELD_TYPE_LABELS` / `YIELD_TYPE_STYLES`.

## What Does NOT Change

- No DB schema changes (yield_data and yield_history tables unchanged)
- No new API endpoints
- No new cron jobs (auto-discovery runs within existing sync-yield-data)

## Risk Assessment

- **Zero additional API calls** — auto-discovery filters the DL pools response already fetched
- **DB impact** — ~15 more coins × 48 points/day × 365 ≈ 263K additional rows/year
- **Pool flipping** — the best pool for a coin may change between runs if TVL shifts. This is expected and correct — the system always shows the current best option. Historical yield_history records preserve the data_source for each point.
- **Safety score dependency** — if a coin drops below C+ between runs, it stops getting yield data. This is intentional — we only show yield for coins we consider safe enough.
