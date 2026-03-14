# Pricing Pipeline Improvement Research

**Date:** 2026-03-13
**Scope:** Assess current pipeline, identify improvements, evaluate new sources, evaluate on-chain pricing routes
**Sample:** 30 stablecoins of varied nature and size

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Pipeline Assessment](#2-current-pipeline-assessment)
3. [Identified Weaknesses](#3-identified-weaknesses)
4. [New Pricing Sources Evaluation](#4-new-pricing-sources-evaluation)
5. [On-Chain Pricing Route Assessment](#5-on-chain-pricing-route-assessment)
6. [30-Stablecoin Evaluation Matrix](#6-30-stablecoin-evaluation-matrix)
7. [Prioritized Recommendations](#7-prioritized-recommendations)
8. [Implementation Considerations](#8-implementation-considerations)

---

## 1. Executive Summary

Pharos currently runs a **two-source cross-validated primary pipeline** (CoinGecko + DefiLlama) with a **4-pass enrichment cascade** (DL contract, multi-chain DL, CoinMarketCap, DexScreener) and a **24-hour price cache fallback**. This architecture is already more sophisticated than most dashboards.

However, our research across 30 stablecoins of varied nature reveals **five systemic gaps** that can cause depeg detection inaccuracies:

1. **Two-source ceiling on cross-validation** -- when CG and DL both source from the same upstream exchange feed, their "agreement" gives false confidence
2. **Non-USD peg pricing fragility** -- exotic currencies (JPY, RUB, IDR, ZAR, BRL) depend on a single FX rate provider with stale fallbacks
3. **Commodity token pricing opacity** -- gold/silver tokens use CoinGecko market prices with no oracle or redemption-based cross-check
4. **No direct exchange-level corroboration** -- we aggregate aggregators but never directly verify prices against primary exchange order books
5. **DEX price observations exist but are underutilized** -- we collect TVL-weighted DEX prices for depeg cross-validation but don't feed them into the primary price pipeline

Three new sources stand out as high-value, low-cost additions:
- **Pyth Network Hermes API** -- free, sub-second oracle prices with confidence intervals
- **RedStone API** -- free, per-exchange venue breakdown (20+ sources per asset)
- **Direct CEX tickers** (Binance + Coinbase) -- free, no auth, the actual exchange prices that aggregators ultimately source from

Together these would upgrade our pipeline from a 2-source to a **5+ source cross-validation system** and enable **exchange-level depeg triangulation** -- detecting which venue depegs first.

---

## 2. Current Pipeline Assessment

### 2.1 Architecture Overview

```
Every 15 minutes (*/15 * * * *):

  STEP 1: DefiLlama List API → supply data + basic prices
          ↓ (circuit breaker: 3 failures → 30min probe)
          fallback → CoinGecko market cap for supply

  STEP 2: Primary Price Fetch (parallel)
          ├─ CoinGecko /simple/price (batches of 250)
          └─ DefiLlama coins API (/prices/current/coingecko:{id})
          → Cross-validate within 50 bps
          → If agree: "high" confidence, use CG price
          → If diverge: "low" confidence, use closer-to-peg-reference
          → If one missing: "single-source"

  STEP 3: Authoritative Overrides
          └─ Protocol redemption quotes via eth_call (cUSD, iUSD)

  STEP 4: Price Validation (peg-aware bounds per currency)

  STEP 5: Enrichment Cascade (for still-missing prices)
          ├─ Pass 1: Contract address → DL coins API
          ├─ Pass 1b: Multi-chain contract fallback
          ├─ Pass 2: CoinMarketCap (1 call/hour, rate-limited)
          └─ Pass 3: DexScreener search (max 10, 45s budget)

  STEP 6: Price Cache (24h TTL fallback)

  STEP 7: Depeg Detection (two-stage: detect → confirm)
          └─ DEX cross-validation for false positive suppression
```

### 2.2 Strengths

| Strength | Detail |
|----------|--------|
| **Dual-source cross-validation** | CG + DL compared within 50 bps; divergence triggers peg-reference selection |
| **Peg-aware validation** | Different bounds per currency (22 peg types), commodity scaling by troy ounce |
| **Protocol redemption quotes** | Direct on-chain pricing for wrapper assets (cUSD, iUSD) |
| **Circuit breakers** | 16 sources individually tracked; 3-failure open, 30-min probe |
| **Two-phase depeg confirmation** | Large-cap ($1B+) and low-confidence prices require multi-source agreement |
| **DEX cross-validation** | TVL-weighted median from DEX pools suppresses false positives |
| **Price staleness detection** | >95% unchanged prices flagged; >30min prices require confirmation |
| **Concurrent cron safety** | Compare-and-swap via setCacheIfNewer() prevents race conditions |

### 2.3 Key Numbers

- **156 tracked stablecoins** + 2 shadow assets
- **~150 have a geckoId** (eligible for primary CG+DL cross-validation)
- **~140 have a llamaId** (eligible for DL supply data)
- **2 have authoritative protocol quotes** (cUSD, iUSD)
- **1 has a cmcSlug** configured for Pass 2 enrichment
- **~25 use CoinGecko-only detail** (no DL detail endpoint)
- **~10 use commodity detail** (gold/silver pricing path)
- **22 distinct peg currencies** (USD, EUR, GBP, CHF, BRL, RUB, JPY, IDR, SGD, TRY, AUD, ZAR, CAD, CNY, CNH, PHP, MXN, UAH, ARS, GOLD, SILVER, VAR)

---

## 3. Identified Weaknesses

### 3.1 Same-Upstream Agreement Problem

**Severity: High** -- Directly affects depeg detection confidence

CoinGecko and DefiLlama both aggregate from many of the same exchange feeds (Binance, Coinbase, Kraken, etc.). When both return the same price, our system classifies confidence as "high." But if the underlying exchange itself has a stale/wrong price, both aggregators will agree on the wrong number.

**Example scenario:** If Binance's USDT/USD feed freezes at $1.00 during a real depeg to $0.97, both CG and DL may still report ~$1.00 because Binance dominates their volume-weighted aggregation. Our cross-validation would show "high confidence" for a stale price.

**Fix:** Add sources that aggregate differently -- oracle networks (Pyth), venue-level breakdowns (RedStone), or direct exchange reads (Binance/Coinbase APIs).

### 3.2 Non-USD Peg Pricing Fragility

**Severity: High** -- Affects 30 non-USD stablecoins across 16 currencies

The FX rate pipeline depends on:
1. **Frankfurter API (ECB)** -- primary for 14 currencies, but only updates once daily (ECB publishes at 16:00 CET)
2. **Secondary API** (fawazahmed0) -- for CNH, RUB, UAH, ARS; community-maintained, no SLA
3. **Hardcoded fallback constants** -- last resort

For stablecoins like GYEN (JPY), A7A5 (RUB), BRZ (BRL), IDRT (IDR), and ZARP (ZAR):
- **Intraday FX moves are invisible** -- ECB publishes daily; a 2% JPY move during Asian hours won't update until the next day
- **Weekends have no updates** -- FX reference prices are stale for 48+ hours every weekend
- **The secondary API for exotic currencies has no availability guarantee**

This means a real depeg of GYEN or A7A5 during intraday FX volatility could be masked, or a normal FX move could trigger a false depeg.

### 3.3 Commodity Token Pricing Opacity

**Severity: Medium** -- Affects 10 gold/silver tokens

Gold and silver tokens use:
1. **gold-api.com** for spot reference (2 requests per 15 min, limited history)
2. **Peer-median pricing** from tracked gold/silver stablecoins with >$1M supply
3. **CoinGecko market prices** for individual token valuations

Problems:
- **DGLD consistently prices ~2x gold spot** on CoinGecko (excluded from peer median)
- **KAU and KAG have zero on-chain deployments** -- pricing is purely CoinGecko-derived with no DEX cross-validation possible
- **gold-api.com has no historical API** -- backfill relies on reconstructing from CG market chart data
- **Fractional-ounce tokens** (GGBR at 0.001 oz) have extreme price sensitivity -- 1 cent of noise on a $3 token is 33 bps

### 3.4 Enrichment Pipeline Underutilization

**Severity: Medium** -- Affects pipeline depth

- **CoinMarketCap Pass 2:** Only 1 stablecoin has a `cmcSlug` configured. The pass exists but barely fires. Switching to the `listings/latest?cryptocurrency_type=stablecoins` endpoint would cover all CMC-listed stablecoins in a single call.
- **DexScreener Pass 3:** Capped at 10 searches per run (to stay within budget). Coins beyond position 10 in the missing queue never get DexScreener coverage.

### 3.5 DEX Price Underutilization

**Severity: Medium** -- Missed opportunity for primary pipeline

The DEX liquidity scoring system already collects TVL-weighted median prices from:
- DeFiLlama yield pools
- Curve Finance API
- Uniswap V3 subgraphs
- Aerodrome subgraphs
- GeckoTerminal / DexScreener (discovery)

These observations are stored in `dex_prices` table and used for **depeg cross-validation only** (suppressing false positives, confirming true positives). They are NOT fed back into the primary price pipeline.

For coins with deep DEX liquidity ($1M+ TVL across multiple pools), the DEX median is often more accurate than CoinGecko for detecting real-time depegs because:
- DEX prices update with every trade (seconds, not minutes)
- DEX prices reflect actual on-chain tradeable value
- Manipulation requires moving real capital (especially Curve StableSwap with A=500+)

### 3.6 Missing Test Coverage

Several price pipeline edge cases lack test coverage:
- Thin peg group fallback behavior (< 3 coins for a peg type)
- BRL-to-REAL remapping during divergence analysis
- gold-api.com fallback cascade (cache → peer median → hardcoded)
- RUB hardcoded constant usage when both FX APIs fail

---

## 4. New Pricing Sources Evaluation

### 4.1 Tier 1: High Value, Low Cost

#### Pyth Network Hermes API

| Attribute | Detail |
|-----------|--------|
| **Endpoint** | `https://hermes.pyth.network/v2/updates/price/latest` |
| **Auth** | None required (free public API) |
| **Rate limit** | 30 req/10s |
| **Freshness** | 1-2 seconds (sub-second on-chain, 1-2s via HTTP) |
| **Stablecoin coverage** | ~11-15 (USDT, USDC, DAI, FRAX, TUSD, BUSD, LUSD, USDD, GHO, PYUSD, crvUSD + EUR stablecoins) |
| **Unique value** | **Confidence intervals** -- every price includes a +/- band. Widening confidence = increased market uncertainty. This is a depeg early-warning signal no other source provides |
| **Historical** | Yes, via Benchmarks API |
| **CF Worker compatible** | Yes (stateless HTTP) |

**Why it matters:** Pyth aggregates from 90+ first-party data providers (exchanges, market makers) who push prices on-chain. The confidence interval is genuinely unique -- a USDT price of $1.00 +/- $0.006 (60 bps confidence band) signals stress even when the point estimate looks fine.

**Integration cost:** Low. Single HTTP call with comma-separated price feed IDs. Response is binary (protobuf) or JSON. Need to maintain a mapping of stablecoin ID → Pyth price feed ID.

#### RedStone Oracle API

| Attribute | Detail |
|-----------|--------|
| **Endpoint** | `https://api.redstone.finance/prices` |
| **Auth** | None required |
| **Rate limit** | Undocumented (risk factor) |
| **Freshness** | ~10 seconds |
| **Coverage** | Major stablecoins (USDT, USDC, DAI, FRAX, LUSD, etc.) |
| **Unique value** | **Per-exchange venue breakdown** -- returns 20+ individual exchange prices per asset (Binance, Coinbase, Kraken, Curve, Uniswap, etc.) |
| **CF Worker compatible** | Yes |

**Why it matters:** No other source gives us per-venue price data in a single call. During a depeg, we can see *which exchange depegs first* and *which exchanges still show peg*. This is gold for depeg detection accuracy:
- If 18/20 exchanges show $1.00 and 2 show $0.97 → likely a localized liquidity issue, not a true depeg
- If 15/20 show $0.97 → true depeg with high confidence

**Integration cost:** Low. Simple REST API. But undocumented rate limits mean we'd need to build in fallback behavior if they throttle us.

#### Direct CEX Tickers (Binance + Coinbase)

| Attribute | Binance | Coinbase |
|-----------|---------|----------|
| **Endpoint** | `GET /api/v3/ticker/price` | `GET /products/{pair}/ticker` |
| **Auth** | None | None |
| **Rate limit** | 6,000 weight/min (all-prices call = weight 4) | 10 req/sec |
| **Freshness** | Real-time (exchange tick) | Real-time |
| **Coverage** | 8-12 stablecoins | 10-15 stablecoins |
| **Unique value** | Largest exchange globally; USDCUSDT cross-pair | Primary USDC venue; regulated |
| **CF Worker compatible** | Yes | Yes |

**Why it matters:** Every aggregator (CG, DL, CMC) ultimately sources from exchanges. Going direct gives us:
1. **Faster data** -- no aggregation delay
2. **Source-of-truth** for specific coins (Coinbase for USDC, Binance for USDT)
3. **Cross-stablecoin relative pricing** -- the USDCUSDT pair on Binance directly measures stablecoin-to-stablecoin value
4. **CEX-vs-DEX spread** -- comparing exchange price to our DEX median reveals arbitrage opportunities and stress

### 4.2 Tier 2: Moderate Value

#### CryptoCompare (CCData)

| Attribute | Detail |
|-----------|--------|
| **Endpoint** | `https://min-api.cryptocompare.com/data/pricemulti` |
| **Auth** | API key (free tier) |
| **Rate limit** | 100,000 calls/month |
| **Coverage** | Broad (5,700+ coins) |
| **Unique value** | Third independent aggregator (CCCAGG index); batch endpoint handles all 156 coins in ~3 calls |
| **CF Worker compatible** | Yes |

Worth adding as a third aggregator voice, but provides the same type of data as CG/DL (aggregated price). Less transformative than oracle or exchange-direct sources.

#### CoinMarketCap Optimization

Current state: 1 stablecoin has a `cmcSlug`. The `listings/latest?cryptocurrency_type=stablecoins` endpoint could cover all CMC-listed stablecoins in one call. Rate-limited at 1 call/hour on the free tier (10K credits/month), but could serve as a periodic full-universe cross-check.

#### Curve Finance REST API

| Attribute | Detail |
|-----------|--------|
| **Endpoint** | `https://api.curve.finance/v1/getPools/all/{chain}` |
| **Auth** | None |
| **Coverage** | 30+ stablecoin pools |
| **Unique value** | **Pool balance ratios** as depeg indicators -- a 3pool shifting from 33/33/33 to 50/25/25 signals relative value shifts even before prices move |
| **CF Worker compatible** | Yes |

We already use Curve API in the DEX liquidity scoring cron. The incremental value is feeding Curve pool balance ratios into the primary price pipeline as an early-warning signal.

### 4.3 Not Recommended

| Source | Reason |
|--------|--------|
| **Chainlink on-chain feeds** | USDT/USDC heartbeats are 24 hours -- far too stale for stablecoin monitoring |
| **Chainlink Data Streams** | Enterprise subscription required, no public pricing |
| **Chronicle Protocol** | Whitelist-gated, no HTTP API |
| **API3/dAPI** | High discovery friction, per-provider responses |
| **Kaiko** | $9,500+/year, cost-prohibitive |
| **Messari** | Not a pricing source, 20 req/min limit |
| **CoinPaprika** | Free tier non-commercial restriction; 10-min update ceiling |
| **LiveCoinWatch** | No clear advantage over CC/CP |
| **Circle/Tether APIs** | No pricing API exists |

---

## 5. On-Chain Pricing Route Assessment

### 5.1 Current On-Chain Capabilities

We already make `eth_call` RPC calls for two protocol redemption quotes:
- **cUSD (Cap):** `getBurnAmount()` on Ethereum
- **iUSD (infiniFi):** `receiptToAsset()` on Ethereum

Both use Alchemy RPC (via `rpcMode: "alchemy"` in live reserves config). The pattern is proven and fits within our Cloudflare Worker architecture.

### 5.2 Viable On-Chain Routes

#### 5.2a DEX Aggregator Quotes (Recommended)

**0x `/price` endpoint:**
- 10 RPS free tier, 18+ EVM chains
- Returns a simulated swap quote without requiring tokens
- Includes RFQ from professional market makers (higher quality than pure AMM)
- Single integration covers all EVM stablecoins

**Jupiter Quote API (Solana):**
- Covers all Solana DEX liquidity
- Single API for Raydium, Orca, Meteora, etc.
- ~10-30 req/min free

These aggregator quote APIs effectively answer: "If I wanted to sell 10,000 units of this stablecoin for USDC right now, what would I get?" This is the most honest real-time price signal available.

#### 5.2b Direct Pool Reads

| Method | Best For | Manipulation Risk | Latency |
|--------|----------|-------------------|---------|
| **Curve `get_dy()`** | Stablecoin-to-stablecoin pricing | Very low (A=500-5000 makes manipulation expensive) | 1 RPC call (~200ms) |
| **Uniswap V3 `observe()` TWAP** | Manipulation-resistant reference | Very low (30-min window) | 1 RPC call, ~15 min lag |
| **Uniswap V3 `QuoterV2.quoteExactInputSingle()`** | Real-time swap simulation | Moderate (no flash-loan risk for view calls) | 1 RPC call |
| **Aerodrome `getAmountOut()`** | Base/Optimism L2 pricing | Low (stable pools) | 1 RPC call |

**Curve `get_dy()` is the single best on-chain price signal for stablecoins.** StableSwap's amplification factor makes pool manipulation extremely expensive, and the function is a simple view call. For any stablecoin with a Curve pool, this gives us a highly reliable third price reference.

#### 5.2c Expanding Protocol Redemption Quotes

Beyond cUSD and iUSD, several stablecoins have on-chain redemption mechanisms we could query:

| Stablecoin | Redemption Function | Chain | Feasibility |
|------------|---------------------|-------|-------------|
| **LUSD** | `fetchPrice()` on PriceFeed | Ethereum | High -- Liquity V1 has an immutable Chainlink-based price feed |
| **BOLD** | Branch manager redemption | Ethereum | Medium -- multiple collateral types, needs per-branch query |
| **crvUSD** | `price_oracle()` on controller | Ethereum | High -- Curve has built-in oracle functions |
| **GHO** | Fixed $1 (overcollateralized, no redemption) | N/A | Low value -- always reports $1 |
| **FRAX** | `redemptionPrice()` | Ethereum | Medium -- depends on AMO state |
| **sUSD** | `effectiveValue()` on Synthetix | Ethereum | Medium -- requires SNX oracle integration |

### 5.3 On-Chain vs. Off-Chain Trade-offs

| Dimension | On-Chain (RPC/DEX) | Off-Chain (API aggregators) |
|-----------|--------------------|-----------------------------|
| **Freshness** | Real-time (block-by-block) | 1-5 min delay |
| **Manipulation resistance** | Varies (TWAP: very high; spot: lower) | High (aggregated across venues) |
| **Coverage** | Only coins with on-chain liquidity | All listed coins |
| **Cost** | RPC calls (free tier: 1.2M/mo Alchemy) | API calls (varies) |
| **Reliability** | Chain-dependent; RPC provider uptime | API provider uptime |
| **Value for depeg detection** | Highest for deep-liquidity coins | Broader but shallower |

**Recommendation:** Use on-chain routes as a **high-confidence cross-validation layer** for the ~30 largest stablecoins with deep DEX liquidity, not as a replacement for the off-chain pipeline.

---

## 6. 30-Stablecoin Evaluation Matrix

### Sample Selection Rationale

The 30 stablecoins were selected to cover:
- All market cap tiers (top 5, mid-cap, small-cap, micro-cap)
- All peg types (USD, EUR, JPY, RUB, BRL, IDR, ZAR, GOLD, VAR)
- All backing types (fiat, crypto, algorithmic, RWA/yield)
- All governance types (centralized, centralized-dependent, decentralized)
- The 5 user-specified coins (gyen, lusd, a7a5, brz, eure)
- Known edge cases (commodity tokens, NAV tokens, protocol-redeemable)

### Legend

- **Current Path:** Primary price source path today
- **CG+DL:** Both CoinGecko and DefiLlama return prices
- **CG-only:** Only CoinGecko returns price (no DL coverage)
- **Enrich:** Falls to enrichment pipeline
- **Conf:** Current typical price confidence level

### Matrix

| # | ID | Symbol | Peg | Mcap Tier | Current Path | Conf | Weaknesses | Pyth | RedStone | CEX Direct | DEX On-Chain | Net Improvement |
|---|-----|--------|-----|-----------|-------------|------|------------|------|----------|------------|--------------|-----------------|
| 1 | usdt-tether | USDT | USD | Mega | CG+DL | High | Same-upstream risk | Yes | Yes (23 venues) | Binance USDTUSD | Curve 3pool, Uni V3 | **Major** -- 5+ independent sources |
| 2 | usdc-circle | USDC | USD | Mega | CG+DL | High | Same-upstream risk | Yes | Yes (22 venues) | Coinbase (primary venue) | Curve 3pool, Uni V3 | **Major** -- Coinbase is the source of truth |
| 3 | dai-maker | DAI | USD | Large | CG+DL | High | Same-upstream risk | Yes | Yes | Coinbase, Binance | Curve 3pool, Uni V3 | **Major** -- oracle + DEX cross-check |
| 4 | usds-sky | USDS | USD | Large | CG+DL | High | Newer, fewer exchanges | Yes | Likely | Kraken has USDS | Curve, Uni V3 | **Significant** -- adds oracle layer |
| 5 | usde-ethena | USDe | USD | Large | CG+DL | High | Synthetic; basis trade risk | Yes | Likely | Binance | Curve, multiple L2 DEXes | **Major** -- synthetic needs extra validation |
| 6 | frax-frax | FRAX | USD | Mid | CG+DL | High | AMO complexity | Yes | Yes | Limited CEX | Curve (deep pool) | **Significant** -- Curve is authoritative |
| 7 | gho-aave | GHO | USD | Mid | CG+DL | High | Thin CEX liquidity | Yes | Likely | Limited | Uni V3, Balancer | **Moderate** -- DEX is primary venue |
| 8 | crvusd-curve | crvUSD | USD | Mid | CG+DL | High | Price from own ecosystem | No | Likely | Limited | **Curve `price_oracle()`** | **Significant** -- native oracle available |
| 9 | pyusd-paypal | PYUSD | USD | Mid | CG+DL | High | Concentrated on few exchanges | Yes | Likely | Coinbase, Kraken | Curve, Uni V3 | **Significant** -- CEX adds depth |
| 10 | fdusd-firstdigital | FDUSD | USD | Mid | CG+DL | High | Binance-concentrated | No | Likely | Binance (dominant) | Pancake, Uni V3 | **Significant** -- Binance is the venue |
| 11 | **lusd-liquity** | LUSD | USD | Small | CG+DL | High | Thin CEX, premium bias | Yes | Yes | Limited | Curve, Uni V3 | **Major** -- LUSD premiums need DEX validation |
| 12 | bold-liquity | BOLD | USD | Small | CG+DL | High | New; thin liquidity | No | No | None | Curve, branch redemption | **Moderate** -- on-chain redemption route |
| 13 | susd-synthetix | sUSD | USD | Small | CG+DL | High | Synthetix oracle dependency | No | Likely | Limited | Curve, Velodrome | **Moderate** -- already DEX-dependent |
| 14 | cusd-cap | cUSD | USD | Micro | Protocol-redeem | High | Single RPC source | No | No | None | Protocol `getBurnAmount()` | **Low** -- already has authoritative source |
| 15 | iusd-infinifi | iUSD | USD | Micro | Protocol-redeem | High | Single RPC source | No | No | None | Protocol `receiptToAsset()` | **Low** -- already has authoritative source |
| 16 | usdd-tron | USDD | USD | Mid | CG+DL | High | Tron-isolated liquidity | No | No | Limited (HTX) | Tron DEXes (no EVM) | **Low** -- Tron RPC adds complexity |
| 17 | **gyen-gyen** | GYEN | JPY | Small | CG+DL | Varies | **ECB daily FX rate stale for JPY; intraday FX invisible** | No | No | None | No DEX liquidity | **High potential via FX API upgrade** |
| 18 | **a7a5-old-vector** | A7A5 | RUB | Small | CG+DL | Varies | **Secondary FX API for RUB; hardcoded fallback; weekend gaps** | No | No | None | No DEX liquidity | **High potential via FX API upgrade** |
| 19 | **brz-transfero** | BRZ | BRL | Small | CG+DL | Varies | **ECB daily FX stale for BRL; 4-decimal precision** | No | No | None | Minimal DEX | **High potential via FX API upgrade** |
| 20 | idrt-rupiah-token | IDRT | IDR | Micro | CG-only detail | Varies | **CG-only; ECB daily for IDR; 2-decimal; low-nominal currency** | No | No | None | No DEX | **High potential via FX API upgrade** |
| 21 | zarp-zarp | ZARP | ZAR | Micro | CG-only detail | Varies | **CG-only detail; ECB daily for ZAR; thin liquidity** | No | No | None | No DEX | **High potential via FX API upgrade** |
| 22 | **eure-monerium** | EURE | EUR | Small | CG+DL | High | **ECB daily FX; limited DEX depth** | No | No | None | Curve EUR pools, Gnosis DEXes | **Moderate** -- EUR is ECB's home currency, so rate is less stale |
| 23 | eurc-circle | EURC | EUR | Mid | CG+DL | High | Less exchange coverage than USD stablecoins | No | Likely | Coinbase has EURC | Curve, Uni V3 | **Moderate** -- Coinbase for EURC |
| 24 | xaut-tether | XAUT | GOLD | Mid | CG+DL commodity | Varies | **gold-api.com dependency; peer-median from thin group** | No | Yes | Binance has XAUT | No deep DEX | **Moderate** -- RedStone + Binance |
| 25 | paxg-paxos | PAXG | GOLD | Mid | CG+DL commodity | Varies | **gold-api.com dependency; peer-median** | No | Yes | Coinbase, Binance | Uni V3 (thin) | **Moderate** -- CEX prices directly |
| 26 | kau-kinesis | KAU | GOLD | Micro | CG-only commodity | Single | **Zero chain deployments; no DEX; CG is sole source** | No | No | No CEX | None | **Critical gap** -- no improvement path without new exchange listing |
| 27 | fpi-frax | FPI | VAR | Micro | CG+DL | Varies | **NAV token; CPI-indexed; no peg reference to validate against** | No | No | None | Curve FPI/FRAX | **Low** -- NAV tokens are intentionally un-anchored |
| 28 | usdy-ondo-finance | USDY | NAV | Mid | CG+DL | High | **NAV token; appreciating price; false depeg risk on price drops** | No | No | None | Minimal DEX | **Low** -- already excluded from depeg detection |
| 29 | buidl-blackrock | BUIDL | NAV | Large | CG+DL | High | **NAV token; dividend model; price doesn't reflect yield** | No | No | None | None | **Low** -- institutional product, CG is fine |
| 30 | usdtb-ethena | USDTB | USD | Mid | CG+DL | High | Backed by BUIDL; wrapper dynamics | No | No | Limited | Curve | **Moderate** -- wrapper redemption route possible |

### Key Observations from the Matrix

**Group A: Major USD stablecoins (USDT, USDC, DAI, USDe, FRAX, PYUSD)** -- All benefit massively from adding Pyth, RedStone, and direct CEX tickers. These are the coins where depeg detection accuracy matters most (by market cap) and where the richest data is available.

**Group B: Non-USD fiat pegs (GYEN, A7A5, BRZ, IDRT, ZARP, EURE)** -- The biggest improvement comes not from new price sources but from **upgrading FX rate freshness**. Adding a real-time FX API (e.g., exchangerate.host, openexchangerates.org, or Twelve Data) that updates more frequently than ECB's daily publication would transform depeg detection for these coins.

**Group C: Commodity tokens (XAUT, PAXG, KAU)** -- RedStone and direct CEX prices help XAUT and PAXG. KAU remains a critical gap -- with zero chain deployments and CoinGecko as the sole price source, there's no independent cross-validation available.

**Group D: DeFi/algorithmic (LUSD, BOLD, crvUSD, GHO, sUSD)** -- These benefit most from on-chain DEX reads and protocol-specific queries. LUSD in particular trades at persistent premiums that aggregators handle poorly -- Curve `get_dy()` would give us the most accurate real-time price.

**Group E: NAV/yield tokens (FPI, USDY, BUIDL, USDTB)** -- Already excluded from depeg detection or treated as NAV tokens. Low improvement potential because the "right" price is intentionally different from peg.

---

## 7. Prioritized Recommendations

### P0: Upgrade FX Rate Freshness (Non-USD Pegs)

**Impact:** High -- directly fixes depeg detection for 30 stablecoins across 16 currencies
**Effort:** Low-Medium
**Cost:** Free tier available

**Problem:** ECB rates update once daily at 16:00 CET. For JPY (GYEN), RUB (A7A5), BRL (BRZ), IDR (IDRT), ZAR (ZARP), intraday FX moves are invisible.

**Solution:** Add a real-time FX data source that updates more frequently:

| Provider | Free Tier | Update Frequency | Coverage |
|----------|-----------|------------------|----------|
| **exchangerate.host** | 100 req/mo (very tight) | Hourly | 170+ currencies |
| **Open Exchange Rates** | 1,000 req/mo | Hourly | 170+ currencies |
| **Twelve Data** | 800 req/day | Real-time (1 min for forex) | 1,300+ forex pairs |
| **Alpha Vantage** | 25 req/day | 1-5 min for forex | Major currencies |
| **Fixer.io** | 100 req/mo | Hourly | 170+ currencies |

**Recommended approach:**
1. Add **Twelve Data** or **Open Exchange Rates** as a second FX source alongside Frankfurter
2. Poll every 15 minutes (same as main cron)
3. Cross-validate both FX sources; use fresher data when available
4. Particularly valuable for **JPY** (high-frequency trading currency) and **RUB** (sanctions-related volatility)

### P1: Add Pyth Network as Third Cross-Validation Source

**Impact:** High -- adds oracle-grade prices with confidence intervals
**Effort:** Low
**Cost:** Free

**Implementation:**
1. Maintain a mapping of `stablecoinId → pythPriceFeedId` for covered coins (~15)
2. Single HTTP call to Hermes API returns all prices
3. Use Pyth confidence interval as an early-warning metric: `confidenceBps = (confidence / price) * 10000`
4. Add to primary price validation: 3-way cross-validation (CG, DL, Pyth) for covered coins
5. Surface confidence-interval widening in status dashboard and depeg detection

**Unique signal:** A Pyth confidence interval widening from 5 bps to 50+ bps is a **leading indicator** of depeg stress, even before the point estimate moves.

### P2: Add Direct CEX Tickers (Binance + Coinbase)

**Impact:** High -- source-of-truth prices for top 10-15 stablecoins
**Effort:** Low
**Cost:** Free (no auth required)

**Implementation:**
1. **Binance:** Single `GET /api/v3/ticker/price` returns all pairs (weight 4). Filter for stablecoin/USD pairs.
2. **Coinbase:** `GET /products/{pair}/ticker` for each stablecoin pair. ~10 calls per poll.
3. Store as named exchange-level observations in a new structure alongside existing DEX prices
4. Use for depeg confirmation: if Binance and Coinbase both show depeg, confidence is very high
5. **Special case:** The Binance USDCUSDT pair is a direct stablecoin-to-stablecoin measure

**Depeg detection upgrade:** Currently Stage 2 confirmation uses CG or DL as "secondary source." Adding Binance/Coinbase gives a genuinely independent secondary voice that's also the fastest to reflect real market conditions.

### P3: Add RedStone for Venue-Level Breakdown

**Impact:** High for diagnostics, medium for detection accuracy
**Effort:** Low
**Cost:** Free (undocumented rate limits -- risk factor)

**Implementation:**
1. Fetch RedStone prices for top ~20 stablecoins
2. Parse per-venue breakdown (20+ exchanges per asset)
3. Compute venue agreement metrics: what percentage of exchanges show depeg?
4. Use as a depeg severity classifier:
   - 1-2 venues: localized issue
   - 5-10 venues: spreading stress
   - 15+ venues: systemic depeg

**Risk:** Undocumented rate limits. Build with fallback behavior (circuit breaker, graceful degradation).

### P4: Promote DEX Prices to Primary Pipeline

**Impact:** Medium-High -- leverages existing infrastructure
**Effort:** Medium
**Cost:** Zero (already collecting the data)

**Implementation:**
1. For coins with trusted DEX price observations (TVL ≥ $1M, freshness < 20 min), include DEX median as a third voice in primary cross-validation
2. Upgrade from 2-source to 3-source validation for ~40 top coins
3. Weight DEX observations by pool type quality (Curve StableSwap > Uni V3 1bp > volatile pools)
4. This is essentially already done in depeg detection -- just extend it to the main price assignment

### P5: Add Curve `get_dy()` for Direct On-Chain Pricing

**Impact:** Medium -- highest-quality single price signal for stablecoins
**Effort:** Medium
**Cost:** Free (Alchemy RPC free tier)

**Implementation:**
1. For each stablecoin with a Curve pool, call `get_dy(i, j, 10000e18)` to simulate a 10,000-unit swap
2. Compute implied price from input/output ratio
3. Curve's amplification factor (A=500+) means this price is extremely manipulation-resistant
4. Can be called for ~20 stablecoins with meaningful Curve pools
5. Extend existing `eth_call` pattern from authoritative-price-sources.ts

### P6: Expand Protocol Redemption Quotes

**Impact:** Medium -- authoritative pricing for specific coins
**Effort:** Medium-High (per-protocol integration)
**Cost:** Free (RPC)

**Candidates beyond cUSD and iUSD:**
- **crvUSD:** `price_oracle()` on controller
- **LUSD:** Liquity PriceFeed contract
- **BOLD:** Branch manager redemption rate
- **FRAX:** `redemptionPrice()` view function

Each requires understanding the specific protocol's smart contract interface but follows the established pattern.

### P7: Optimize CoinMarketCap Integration

**Impact:** Low-Medium -- broader enrichment coverage
**Effort:** Low
**Cost:** Free (existing API key)

Switch from per-slug `quotes/latest` to `listings/latest?cryptocurrency_type=stablecoins&limit=200`. One call covers all CMC-listed stablecoins. Keep at 1 call/hour to stay within free tier.

---

## 8. Implementation Considerations

### Cloudflare Worker Constraints

All recommendations are designed to work within our Cloudflare Worker architecture:
- **Stateless HTTP only** -- no WebSocket connections, no persistent state
- **6-connection limit per cron trigger** -- all `ctx.waitUntil()` jobs share one pool
- **30-second CPU limit per request** -- batch operations must be chunked
- **Consume response bodies before starting new fetches** to release connections

### Cron Budget

Current cron schedule runs 24 runtime jobs. Adding new data sources means either:
1. **Piggyback on existing cron** -- add Pyth/CEX/RedStone fetches to `sync-stablecoins` (increases per-run time)
2. **New cron slot** -- requires one of the 10 trigger slots (6 are used)
3. **Stagger within existing slots** -- use `ctx.waitUntil()` for independent fetches

**Recommended:** Piggyback Pyth + CEX tickers on the `sync-stablecoins` cron (they're fast, single-call sources). RedStone and Curve RPC calls could share a separate slot or run as part of the DEX liquidity cron.

### Data Model Extension

New price sources should produce `PrimaryPriceResult`-compatible output with:
- `price: number`
- `source: string` (e.g., "pyth", "binance", "coinbase", "redstone", "curve-onchain")
- `confidence: PriceConfidence`
- Additional metadata: `pythConfidenceInterval`, `venueCount`, `cexSpread`, etc.

The cross-validation logic in `fetchPrimaryPrices()` would evolve from a 2-source comparison to an N-source weighted consensus, with source-type weighting (oracles and exchanges carry more weight than aggregators for specific coins).

### Monitoring

Each new source should integrate with the existing circuit breaker pattern:
- Individual tracking per source
- 3-failure open, 30-min probe
- Webhook alerts on state transitions
- Status dashboard integration (price-source-health component)

---

## Appendix A: Source Availability per Sample Coin

| # | Coin | CG | DL | Pyth | RedStone | Binance | Coinbase | Curve Pool | Other DEX |
|---|------|----|----|------|----------|---------|----------|------------|-----------|
| 1 | USDT | Y | Y | Y | Y (23) | USDTUSD | USDTUSD | 3pool | Uni V3 |
| 2 | USDC | Y | Y | Y | Y (22) | USDCUSDT | USDCUSD | 3pool | Uni V3 |
| 3 | DAI | Y | Y | Y | Y | DAIUSDT | DAIUSD | 3pool | Uni V3 |
| 4 | USDS | Y | Y | Y | Likely | USDSUSDT | -- | Y | Uni V3 |
| 5 | USDe | Y | Y | Y | Likely | USDEUSDT | -- | Y | Multi-L2 |
| 6 | FRAX | Y | Y | Y | Y | -- | FRAXUSD | Deep pool | Uni V3 |
| 7 | GHO | Y | Y | Y | Likely | -- | -- | -- | Uni V3, Balancer |
| 8 | crvUSD | Y | Y | -- | Likely | -- | -- | Native oracle | Multi-chain |
| 9 | PYUSD | Y | Y | Y | Likely | -- | PYUSDUSD | Y | Uni V3 |
| 10 | FDUSD | Y | Y | -- | Likely | FDUSDUSDT | -- | -- | Pancake |
| 11 | LUSD | Y | Y | Y | Y | -- | -- | Deep pool | Uni V3 |
| 12 | BOLD | Y | Y | -- | -- | -- | -- | Y | -- |
| 13 | sUSD | Y | Y | -- | Likely | -- | -- | Y | Velodrome |
| 14 | cUSD | Y | Y | -- | -- | -- | -- | -- | Protocol |
| 15 | iUSD | Y | Y | -- | -- | -- | -- | -- | Protocol |
| 16 | USDD | Y | Y | -- | -- | -- | -- | -- | Tron DEXes |
| 17 | GYEN | Y | Y | -- | -- | -- | -- | -- | -- |
| 18 | A7A5 | Y | Y | -- | -- | -- | -- | -- | -- |
| 19 | BRZ | Y | Y | -- | -- | -- | -- | -- | Minimal |
| 20 | IDRT | Y | -- | -- | -- | -- | -- | -- | -- |
| 21 | ZARP | Y | -- | -- | -- | -- | -- | -- | -- |
| 22 | EURE | Y | Y | -- | -- | -- | -- | Gnosis Curve | Gnosis DEX |
| 23 | EURC | Y | Y | -- | Likely | -- | EURCUSD | Y | Uni V3 |
| 24 | XAUT | Y | Y | -- | Y | XAUTUSDT | -- | -- | -- |
| 25 | PAXG | Y | Y | -- | Y | PAXGUSDT | PAXGUSD | -- | Uni V3 (thin) |
| 26 | KAU | Y | -- | -- | -- | -- | -- | -- | -- |
| 27 | FPI | Y | Y | -- | -- | -- | -- | FPI/FRAX | -- |
| 28 | USDY | Y | Y | -- | -- | -- | -- | -- | Minimal |
| 29 | BUIDL | Y | Y | -- | -- | -- | -- | -- | -- |
| 30 | USDTB | Y | Y | -- | -- | -- | -- | Y | -- |

### Coverage Summary

| Source | Coins Covered (of 30) | Cost | Effort |
|--------|----------------------|------|--------|
| CoinGecko (current) | 30/30 | Existing | -- |
| DefiLlama (current) | 27/30 | Existing | -- |
| Pyth Network | ~12/30 | Free | Low |
| RedStone | ~15/30 | Free | Low |
| Binance Direct | ~8/30 | Free | Low |
| Coinbase Direct | ~8/30 | Free | Low |
| Curve On-Chain | ~15/30 | Free (RPC) | Medium |
| FX Rate Upgrade | 6/30 (all non-USD fiat) | Free/Low | Low-Medium |

## Appendix B: Envisioned Post-Improvement Architecture

```
Every 15 minutes:

  STEP 1: Supply Data (unchanged)
          DefiLlama List → CoinGecko fallback

  STEP 2: Multi-Source Price Fetch (upgraded)
          ├─ CoinGecko /simple/price         ← existing
          ├─ DefiLlama coins API             ← existing
          ├─ Pyth Hermes API                 ← NEW (oracle with confidence)
          ├─ Binance /ticker/price           ← NEW (exchange direct)
          ├─ Coinbase /products/ticker       ← NEW (exchange direct)
          └─ RedStone /prices                ← NEW (venue breakdown)
          → N-source weighted consensus (not just 2-source)
          → Pyth confidence interval as stress indicator
          → Venue agreement ratio from RedStone

  STEP 3: Authoritative Overrides (expanded)
          ├─ Protocol redemption (cUSD, iUSD) ← existing
          ├─ Curve get_dy() for ~15 coins     ← NEW
          └─ crvUSD price_oracle()            ← NEW

  STEP 4: FX Rate Validation (upgraded)
          ├─ Frankfurter/ECB (daily)          ← existing
          ├─ Real-time FX API (hourly+)       ← NEW
          └─ Cross-validate both sources

  STEP 5: DEX Price Integration (promoted)
          └─ Existing DEX observations → now part of primary validation

  STEP 6: Enrichment Cascade (optimized)
          ├─ CMC listings/latest (all stablecoins in one call)  ← UPGRADED
          ├─ Contract → DL coins                                ← existing
          └─ DexScreener                                        ← existing

  STEP 7: Depeg Detection (enhanced)
          ├─ N-source confidence scoring      ← UPGRADED
          ├─ Pyth confidence band monitoring  ← NEW
          ├─ Venue agreement from RedStone    ← NEW
          └─ CEX vs DEX spread analysis       ← NEW
```

**Net result:** From 2-source cross-validation to **5-6 source consensus** for top stablecoins, with **oracle confidence intervals** as a unique early-warning channel, **real-time FX** for non-USD pegs, and **direct exchange prices** eliminating the aggregator-of-aggregator blind spot.
