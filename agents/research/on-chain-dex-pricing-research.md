# On-Chain DEX Pricing for Stablecoins — Research

_Date: 2026-03-13_

Research into approaches for getting reliable on-chain DEX prices for stablecoins from a Cloudflare Worker (stateless HTTP only — no WebSockets, no persistent connections).

---

## 1. Direct DEX Pool Reads via RPC

All of these use `eth_call` (EVM) or `getAccountInfo` / `simulateTransaction` (Solana) — stateless HTTP JSON-RPC requests that work perfectly from a Cloudflare Worker.

### 1.1 Uniswap V3 (Ethereum, Arbitrum, Optimism, Base, Polygon, BSC)

**Two approaches:**

#### A) `slot0()` — Raw spot price (NOT recommended as oracle)

Call `slot0()` on any V3 pool contract (selector `0x3850c7bd`). Returns `sqrtPriceX96` (Q64.96 fixed-point), `tick`, and other state.

```
POST to RPC provider:
{ "method": "eth_call", "params": [{ "to": "<POOL>", "data": "0x3850c7bd" }, "latest"] }
```

Price conversion: `price = (sqrtPriceX96 / 2^96)^2`, adjusted for token decimal differences (`price * 10^(decimal0 - decimal1)`).

**Manipulation risk: HIGH.** `slot0` is the instantaneous spot price and can be moved within a single transaction via flash loans. Concentrated liquidity in V3 means less capital is needed to move the price compared to V2. Never use `slot0` alone as a price oracle.

#### B) QuoterV2 `quoteExactInputSingle()` — Simulated swap (recommended)

The Quoter contract (`0x61fFE014bA17989E743c5F6cB21bF9697530B21e` on most chains) simulates a real swap via `eth_call` without spending gas. It internally reverts after computing the output, returning the quote in the revert data.

```solidity
quoteExactInputSingle(
  tokenIn, tokenOut, fee, amountIn, sqrtPriceLimitX96=0
) → amountOut
```

For stablecoin pricing, pass 1e6 USDC (or appropriate unit) and read the output amount. This captures the actual executable price including concentrated liquidity effects and fees.

**Manipulation risk: Same as slot0 for spot reads** — it reflects current pool state, which can still be manipulated within a block. However, for off-chain monitoring (not on-chain collateral decisions), this is acceptable because we read it from our own cron, not in an atomic transaction context.

#### C) TWAP Oracle — `observe()` (most manipulation-resistant)

Uniswap V3 pools store cumulative tick observations. Call `observe([secondsAgo1, secondsAgo2])` on the pool, then compute:

```
twapTick = (tickCumulative2 - tickCumulative1) / (time2 - time1)
twapPrice = 1.0001^twapTick
```

A 30-minute TWAP makes flash-loan manipulation economically infeasible (attacker would need to sustain the position across many blocks). The trade-off is lag — a 30-min TWAP lags the true price by ~15 minutes on average.

**Best for: Detecting sustained depegs (>30 min). Not suitable for real-time price display.**

**Contract addresses:** Uniswap V3 is deployed on Ethereum, Arbitrum, Optimism, Base, Polygon, BSC, Avalanche, Celo, and more. Pool addresses vary per pair/fee tier — use the Factory's `getPool(tokenA, tokenB, fee)` to discover them.

---

### 1.2 Curve Finance (Ethereum, Arbitrum, Optimism, Polygon, Base)

#### A) `get_dy(i, j, dx)` — Expected swap output

View function that returns how much of token `j` you'd receive for `dx` of token `i`. For stablecoin pools, pass 1e6 (USDC) or 1e18 (DAI) and read the output.

- **StableSwap pools:** `get_dy(i: int128, j: int128, dx: uint256) → uint256`
- **CryptoSwap pools:** `get_dy(i: uint256, j: uint256, dx: uint256) → uint256` (different int types)

Index mapping: call `coins(0)`, `coins(1)`, etc. to discover which index maps to which token.

**Manipulation risk: LOW for stable pools.** Curve's StableSwap invariant (x^3*y + y^3*x = k for 2-coin, extended for n-coin) with high amplification factors (A=500-5000) makes price manipulation extremely expensive. An attacker would need to push the pool far off balance, which costs proportionally more as A increases.

#### B) `get_virtual_price()` — LP token pricing

Returns the value of 1 LP token in units of the pool's underlying peg. Monotonically increasing under normal operation. Useful for LP token valuation, not individual stablecoin pricing.

**Caveat:** Subject to read-only reentrancy in contracts that handle native ETH. Not a concern for off-chain `eth_call` reads.

**Contract discovery:** Curve has multiple registries per chain. The main registry, factory, and crypto-factory each have `pool_list(i)` and `get_coins(pool)` methods. Our existing cron already fetches Curve pool data via the Curve API (`api.curve.fi`).

---

### 1.3 Balancer V2 (Ethereum, Arbitrum, Optimism, Polygon, Gnosis, Avalanche)

#### A) `queryBatchSwap()` on the Vault — Simulated swap

The Balancer V2 Vault (`0xBA12222222228d8Ba445958a75a0704d566BF2C8` on all chains) exposes `queryBatchSwap()` which simulates a swap without requiring token balances or approvals.

```solidity
queryBatchSwap(
  SwapKind kind,         // GIVEN_IN or GIVEN_OUT
  BatchSwapStep[] swaps, // [{poolId, assetInIndex, assetOutIndex, amount, userData}]
  IAsset[] assets,       // [tokenIn, tokenOut]
  FundManagement funds   // can be zero-address for queries
) → int256[] assetDeltas
```

For a simple single-pool price check, construct a single-step batch swap with the stablecoin pair.

#### B) Pool oracles (WeightedPool2Tokens, MetaStable pools only)

Some Balancer pools expose `getLatest()` and `getTimeWeightedAverage()` for built-in TWAP oracles. However, these are only available on specific pool types (WeightedPool2Tokens and MetaStable), not on all pools.

#### C) `getPoolTokens(poolId)` on the Vault — Reserve ratios

Returns token addresses and balances. For weighted pools, combine with pool weights to compute spot price. For stable pools (ComposableStablePool), the StableMath invariant makes reserve-ratio pricing less straightforward.

**Manipulation risk: MEDIUM.** Depends on pool type. StablePools with high amplification are resistant (similar to Curve). WeightedPools with 50/50 weights are similar to Uniswap V2 in manipulation cost.

---

### 1.4 Aerodrome (Base) / Velodrome (Optimism)

Both share the same contract architecture (Velodrome V2).

#### A) `getAmountOut(amountIn, tokenIn)` on the Pool — Simulated swap

Simplest approach. Pass a unit amount and get the output. Works for both stable and volatile pools.

```solidity
getAmountOut(uint amountIn, address tokenIn) external view returns (uint)
```

#### B) `metadata()` on the Pool — All-in-one info

Returns `(dec0, dec1, r0, r1, st, t0, t1)` — decimals, reserves, stable flag, and token addresses in a single call. For volatile pools, price = r1/r0 adjusted for decimals.

#### C) `getReserves()` — Classic reserve query

Returns `(reserve0, reserve1, blockTimestampLast)`. For volatile pools (x*y=k), price = reserve1/reserve0. For stable pools (x^3*y + y^3*x), use `getAmountOut()` instead.

#### D) `sample()` — TWAP oracle

`sample(tokenIn, amountIn, points, window)` returns an array of TWAP prices from cumulative reserve observations. Provides flash-loan resistance.

**Pool discovery:** Call `getPool(tokenA, tokenB, stable)` on the Pool Factory.

- Aerodrome Factory (Base): `0x420DD381b31aEf6683db6B902084cB0FFEce40da`
- Velodrome V2 Factory (Optimism): `0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a`

**Manipulation risk: LOW for stable pools** (same curve as Curve StableSwap). MEDIUM for volatile pools.

---

### 1.5 Raydium / Orca on Solana

Solana uses a fundamentally different model — no `eth_call`. Two approaches:

#### A) `getAccountInfo` + Deserialization — Read pool state

Call `getAccountInfo` (HTTP JSON-RPC) on the pool's on-chain account address. Deserialize the binary data using the program's account layout.

**Raydium AMM V4:** Use `LIQUIDITY_STATE_LAYOUT_V4` from `@raydium-io/raydium-sdk`. The pool account contains vault balances; price = tokenB_vault / tokenA_vault (adjusted for decimals and any OpenBook liquidity).

**Raydium CPMM:** Simpler layout, pure constant-product. Deserialize vault amounts and compute price directly.

**Orca Whirlpool (CLMM):** Pool account stores `sqrtPrice` as a Q64.64 fixed-point number. Convert: `price = (sqrtPrice / 2^64)^2`, adjusted for token decimals. Equivalent math to Uniswap V3's `sqrtPriceX96` but with Q64.64 instead of Q64.96.

**Complexity: HIGH.** Each program has its own binary layout. You need program-specific deserializers. The `@orca-so/whirlpools-core` package (compiled from Rust to WASM) provides the math utilities but adds bundle size.

#### B) `simulateTransaction` — Simulate a swap

Build a swap instruction (e.g., swap 1 USDC for USDT on Raydium/Orca), then call `simulateTransaction` via HTTP RPC. Read the simulated token balance changes to derive the price.

This works from a Cloudflare Worker (stateless HTTP POST), but requires:
- Building a valid transaction (needs a recent blockhash)
- A throw-away signer (the simulation doesn't actually sign)
- Parsing the simulation result to extract balance changes

**Manipulation risk:** Same as EVM spot prices — reflects current pool state. Solana's ~400ms block times make sustained manipulation harder to maintain but cheaper to attempt per-block.

---

### Direct RPC Assessment Summary

| Protocol | Method | RPC Calls/Price | Manipulation Risk | Complexity | Multi-chain |
|----------|--------|-----------------|-------------------|------------|-------------|
| Uniswap V3 | QuoterV2 | 1 | Medium (spot) | Low | 8+ chains |
| Uniswap V3 | TWAP observe() | 1 | Very Low | Medium | 8+ chains |
| Curve | get_dy | 1 | Low | Low | 5+ chains |
| Balancer V2 | queryBatchSwap | 1 | Medium | Medium | 6+ chains |
| Aerodrome/Velodrome | getAmountOut | 1 | Low (stable) | Low | 2 chains |
| Raydium | getAccountInfo | 1-3 | Medium | High | Solana only |
| Orca Whirlpool | getAccountInfo | 1 | Medium | High | Solana only |

---

## 2. DEX Aggregator APIs

These are the simplest to integrate from a Cloudflare Worker — standard HTTPS REST calls.

### 2.1 1inch Swap/Quote API

**Endpoint:** `https://api.1inch.dev/swap/v6.0/{chainId}/quote`

**Parameters:** `src` (token address), `dst` (token address), `amount` (raw units), `protocols` (optional filter)

**Rate limits & pricing:**
| Plan | Cost | Rate Limit | Monthly Calls |
|------|------|-----------|---------------|
| Dev (free) | $0 | 60 req/min | 100,000 |
| Startup | $149/mo | 10 req/s | 1,000,000 |
| Professional | $299/mo | 20 req/s | 3,000,000 |
| Business | $599/mo | 40 req/s | 7,000,000 |

**Pros:** Aggregates across 400+ liquidity sources per chain. Supports Ethereum, Arbitrum, Optimism, Base, Polygon, BSC, Avalanche, Gnosis, Fantom, zkSync, and more.

**Cons:** Free tier is 1 req/sec effective (60/min). Requires API key registration. Not free for production use at scale.

**Price accuracy:** Very high — aggregates across all DEX sources, so the returned price reflects the best executable price across the entire on-chain market. For stablecoins with deep liquidity, this will closely match CEX prices (typically within 1-5 bps for majors like USDC, USDT, DAI).

---

### 2.2 ParaSwap / Velora API

**Endpoint:** `https://api.paraswap.io/prices?srcToken=...&destToken=...&amount=...&network=...&side=SELL`

**Parameters:** `srcToken`, `destToken`, `amount`, `network` (chain ID), `side` (SELL/BUY), `includeDEXS`/`excludeDEXS` (optional).

**Rate limits:** Not publicly documented. Returns 429 when exceeded — implement exponential backoff. Community reports suggest ~1-2 req/s on the free tier.

**Supported chains:** Ethereum (1), Optimism (10), BSC (56), Polygon (137), Fantom (250), zkEVM (1101), Base (8453), Arbitrum (42161), Avalanche (43114).

**Pros:** No mandatory API key for basic price queries. Returns `otherExchangePrices` parameter that shows quotes from individual DEXes for comparison. Average response time ~500ms. No platform fee on the pricing endpoint.

**Cons:** Rate limits are opaque. Rebranded to Velora — API stability during transition unclear.

---

### 2.3 0x Swap API (v2)

**Endpoint:** `https://api.0x.org/swap/allowance-holder/price` (read-only pricing, no commitment)

**Parameters:** `sellToken`, `buyToken`, `sellAmount`, `chainId`

**Rate limits:**
- Free tier: ~10 RPS
- Paid tiers: custom (contact sales)

**Fee:** 0.15% on select token pairs (charged on-chain during actual swaps, not on price queries). The `/price` endpoint is free to call.

**Supported chains:** Ethereum, Arbitrum, Optimism, Base, Polygon, BSC, Avalanche, Scroll, Linea, Blast, Sonic, Berachain, Unichain, and more (18+ chains as of 2026).

**Pros:** `/price` endpoint is explicitly designed for browsing prices without commitment. 10 RPS free tier is generous. Excellent multi-chain coverage. Cross-chain API in beta (Feb 2026).

**Cons:** Requires API key. The `/quote` endpoint should not be called repeatedly for price discovery (it reserves market maker liquidity).

**Price accuracy:** Routes through 100+ exchanges including RFQ (Request For Quote) from professional market makers, so prices often beat pure AMM routing.

---

### 2.4 Jupiter (Solana)

**Endpoint:** `https://api.jup.ag/swap/v1/quote`

**Parameters:** `inputMint`, `outputMint`, `amount` (in smallest units), `slippageBps`

**Rate limits:** Public API has undocumented rate limits (community reports ~10-30 req/min). QuickNode Metis add-on provides higher limits with explicit SLAs.

**Fee:** 0.2% platform fee on all public API Jupiter swaps, 1% on pump.fun swaps. The quote endpoint itself is free.

**Supported DEXes:** Aggregates across Raydium (AMM, CLMM, CPMM), Orca (Whirlpool), Meteora (DLMM, Pools), Phoenix, Lifinity, and many more Solana DEXes.

**Pros:** Single API covers all major Solana DEXes. Smart routing finds the best price across all venues. Simple HTTP REST interface — works perfectly from a Cloudflare Worker. No Solana-specific deserialization needed.

**Cons:** Solana-only. Rate limits on public API are restrictive. Fee is charged on swaps, not quotes, but may change.

**Price accuracy:** Excellent for Solana stablecoins. Jupiter is the dominant Solana aggregator with near-complete venue coverage.

---

### Aggregator API Assessment Summary

| API | Free Tier | Rate Limit (free) | Chains | Stablecoin Accuracy | Latency |
|-----|-----------|-------------------|--------|---------------------|---------|
| 1inch | 100K/mo | 60 req/min | 12+ EVM | Excellent | ~200-500ms |
| ParaSwap | Unlimited* | ~1-2 req/s | 9 EVM | Excellent | ~500ms |
| 0x | Unlimited* | 10 req/s | 18+ EVM | Excellent (RFQ) | ~200-400ms |
| Jupiter | Unlimited* | ~10-30 req/min | Solana | Excellent | ~200-500ms |

*Unlimited calls but rate-limited. No monthly call cap on free tier (except 1inch).

### Quote-Based Pricing vs Oracle/CEX Pricing

DEX aggregator quotes reflect the **best executable price** across all on-chain venues at the instant of the query. For large stablecoins (USDC, USDT, DAI) with deep on-chain liquidity:

- **vs CEX:** Typically within 1-5 bps of CEX prices. During normal markets, DEX and CEX prices are tightly arbitraged. During stress (bank runs, depegs), DEX prices may diverge from CEX earlier — this is actually valuable signal for depeg detection.
- **vs CoinGecko:** CoinGecko aggregates both CEX and DEX, with volume weighting. DEX-only quotes may differ during CEX/DEX divergence events.
- **Key advantage:** DEX quotes are permissionless and transparent. No API key revocation risk. Prices reflect actual on-chain executable liquidity.
- **Key disadvantage:** Low-liquidity stablecoins may have significant slippage even for small quote amounts. A 1000 USDC quote on a thin pool may show 995 USDT output, suggesting a 0.5% depeg that is really just illiquidity.

---

## 3. Subgraph / Indexer Approaches

### 3.1 TheGraph — Uniswap, Curve, Balancer Subgraphs

**What it provides:** Historical and near-real-time indexed data from DEX smart contract events. Uniswap maintains official subgraphs for V2 and V3 on each chain. Queries via GraphQL.

**Endpoint pattern:** `https://gateway.thegraph.com/api/{api-key}/subgraphs/id/{subgraph-id}`

**Useful queries for pricing:**
```graphql
# Uniswap V3 — get pool price
{
  pool(id: "0x...") {
    token0Price    # price of token0 in terms of token1
    token1Price    # price of token1 in terms of token0
    sqrtPrice
    tick
    liquidity
    totalValueLockedUSD
  }
}
```

**Rate limits:** Based on API key tier. Free tier exists but queries cost GRT tokens on the decentralized network. Hosted service was fully deprecated in 2026.

**Latency:** Subgraphs index with ~1-10 block delay depending on chain and indexer health. Not real-time.

**Pros:** Rich historical data. Single query can return pool metadata, TVL, volume, and price. No need to know contract ABIs or compute prices yourself.

**Cons:** Cost is in GRT tokens (variable). Indexing can lag. Subgraph availability is not guaranteed. Data freshness is block-dependent, not instant. The subgraph is "not intended to be used as a data source for structuring transactions" per Uniswap docs.

**Our current usage:** We already query Uniswap V3 subgraphs on 4 chains and Aerodrome subgraph on Base for the DEX liquidity scoring cron.

---

### 3.2 Goldsky

**What it provides:** Hosted subgraph platform (compatible with TheGraph's subgraph spec) plus a "Mirror" product that streams blockchain data into Postgres/Timescale.

**Pricing:** Free tier available. Paid plans for higher query volumes. 140+ networks supported.

**Pros:** Drop-in replacement for TheGraph hosted service. Better performance (turbo-charged indexing). Webhooks and SQL access. Used by Polymarket, POAP.

**Cons:** Focuses on event extraction, not full application-facing indexing. Reorg handling and state reconstruction responsibility shifts to the client. Another third-party dependency.

---

### 3.3 Envio

**What it provides:** Self-hosted or cloud-hosted blockchain indexer with high customization.

**Pros:** Full control. Highly flexible schema design.

**Cons:** Requires managing infrastructure, scaling, monitoring. High DevOps overhead. Not suitable for a stateless Worker integration without a separate backend.

---

### 3.4 Ponder

**What it provides:** Open-source, self-hosted indexing framework.

**Pros:** Full control, maximum customization.

**Cons:** Self-hosted only. Same operational overhead concerns as Envio.

---

### 3.5 GeckoTerminal API (CoinGecko Onchain)

**What it provides:** Pre-indexed DEX pool data across 100+ networks. Pool prices, volumes, OHLCV, token discovery.

**Endpoints:**
- `GET /networks/{network}/pools/{address}` — single pool data including `base_token_price_usd`, reserves, volume
- `GET /networks/{network}/tokens/{address}/pools` — all pools for a token
- `GET /networks/{network}/pools/multi/{addresses}` — batch pool queries
- `GET /simple/networks/{network}/token_price/{addresses}` — simple token price by address
- OHLCV: day/hour/minute granularity per pool

**Rate limits:**
- Free: 30 calls/min (some docs say 10/min — there's inconsistency)
- Paid (CoinGecko API plan): 250 calls/min (25x increase)

**Latency:** API responses are near-real-time (updated every few seconds for active pools).

**Pros:** We already use GeckoTerminal in our discovery cron for DEX pool staging. No need to know contract ABIs. Covers 100+ chains automatically. Simple REST API, perfect for Workers.

**Cons:** Rate limits are restrictive on the free tier. Price is derived from pool data (token0/token1 reserves), so accuracy depends on pool depth. Not manipulation-resistant (reflects whatever the pool state is). Cannot query TWAP or historical tick data.

**Our current usage:** GeckoTerminal is already a discovery source in `dex_pool_staging` (runs on `6,26,46 * * * *`). We use it for pool discovery and TVL data, not currently for price extraction.

---

### Subgraph/Indexer Assessment Summary

| Source | Price Freshness | Historical Data | Rate Limit (free) | Cost | CF Worker Compatible |
|--------|----------------|-----------------|-------------------|------|---------------------|
| TheGraph (Uniswap) | ~1-10 blocks | Yes (rich) | GRT-based | Variable (GRT) | Yes |
| Goldsky | ~1-10 blocks | Yes | Free tier | Paid plans | Yes |
| Envio | Real-time | Yes | N/A (self-hosted) | Infra costs | No (needs backend) |
| Ponder | Real-time | Yes | N/A (self-hosted) | Infra costs | No (needs backend) |
| GeckoTerminal | Near-real-time | OHLCV only | 30/min | Free / CG paid | Yes |

---

## 4. Multi-Chain Coverage Considerations

### 4.1 DEX Protocols by Chain

| Chain | Major DEXes | Stablecoin Liquidity Depth | Notes |
|-------|------------|---------------------------|-------|
| **Ethereum** | Uniswap V3, Curve, Balancer V2, Maverick | Very Deep ($B+) | Primary venue for USDT, USDC, DAI, FRAX. Curve 3pool is the anchor |
| **Arbitrum** | Uniswap V3, Curve, Balancer, Camelot, GMX | Deep ($100M+) | Strong USDC.e/USDC/USDT liquidity |
| **Optimism** | Velodrome, Uniswap V3, Curve, Beethoven X | Moderate-Deep ($50M+) | Velodrome dominates stablecoin pairs |
| **Base** | Aerodrome, Uniswap V3, Curve, Maverick | Deep ($100M+) | Aerodrome is the primary venue. Strong USDC/USDbC pairs |
| **Polygon** | Uniswap V3, Curve, Balancer, QuickSwap | Moderate ($10M+) | Less stablecoin depth than L2s recently |
| **BSC** | PancakeSwap, Uniswap V3, Thena | Moderate ($10M+) | USDT dominates, BUSD deprecated |
| **Avalanche** | Trader Joe, Curve, Platypus | Moderate ($10M+) | USDC/USDT primary pairs |
| **Solana** | Jupiter (aggregating Raydium, Orca, Meteora, Phoenix) | Deep ($100M+) | Jupiter is the de facto single entry point |
| **Gnosis** | Curve, Balancer, SushiSwap | Low ($1M+) | WXDAI/USDC pairs |
| **Scroll/Linea/zkSync** | Various (early) | Low-Moderate | Emerging stablecoin liquidity |

### 4.2 Where Stablecoin Liquidity Actually Lives

For the 156 stablecoins we track, liquidity distribution is highly concentrated:

- **Top 5 stablecoins (USDT, USDC, DAI, USDS, USDe):** Deep liquidity on Ethereum + 2-4 L2s/alt-L1s each. Multiple DEX venues per chain. Prices are tightly arbitraged and reliable.
- **Mid-tier (ranks 6-30, e.g., FRAX, LUSD, PYUSD, GHO, crvUSD):** Moderate liquidity on 1-3 chains. Often concentrated in 1-2 DEX protocols (Curve is dominant for many). Prices generally reliable but can have brief dislocations.
- **Long tail (ranks 31-156):** Many have liquidity on only 1 chain and 1-2 pools. DEX prices may be thin/unreliable. Some may have no DEX liquidity at all (CEX-only or protocol-internal).

### 4.3 Multi-Source Aggregation Strategy

For a production system reading prices across chains and DEXes:

1. **Prefer aggregator APIs for broad coverage:** 0x or 1inch can cover 12-18 EVM chains with a single integration. Jupiter covers Solana. This gives best-executable-price across all venues without per-protocol integration.

2. **Use direct RPC reads for high-value signal:** For the top 10-20 stablecoins, direct reads on known deep pools (Curve 3pool, Uniswap V3 USDC/USDT 1bp pools) provide manipulation-resistant pricing, especially using TWAP.

3. **Cross-validate:** Compare DEX price vs CoinGecko/CEX price. Flag divergences >10bps as potential depeg signals. Divergences >50bps warrant alerts.

4. **Per-chain RPC cost awareness:** Each `eth_call` costs 1 RPC request. With 156 stablecoins x N chains x M protocols, direct reads scale quadratically. Aggregator APIs collapse this to 1 call per stablecoin per chain.

---

## 5. Feasibility Assessment for Cloudflare Workers

### What Works Well

- **All HTTP-based approaches** (aggregator APIs, RPC `eth_call`, Solana HTTP RPC, TheGraph/GeckoTerminal APIs) work natively from a Cloudflare Worker. No WebSocket or persistent connection needed.
- **`eth_call` is stateless** — each call is an independent HTTP POST to an RPC provider. Perfect for Workers.
- **Aggregator API calls** are simple HTTPS GET/POST. Low integration complexity.

### Constraints

- **Workers CPU time limit:** 10-50ms CPU time on free, up to 30s on paid. Complex deserialization (especially Solana Borsh decoding) may be CPU-intensive. EVM ABI decoding is lightweight.
- **Workers 6-connection limit per cron trigger:** All `ctx.waitUntil()` jobs share one 6-connection pool. Must consume response bodies before starting new fetches. Batch calls using Multicall or multi-account RPC where possible.
- **Subrequest limits:** 50 subrequests on free, 1000 on paid. With 156 stablecoins, direct RPC reads across multiple chains would hit this quickly. Aggregator APIs are more efficient (1 call per stablecoin).

### Recommended Architecture

```
                    ┌─────────────────────────────────┐
                    │   Cron: dex-price-sync           │
                    │   (every 10-30 min)              │
                    └───────────┬─────────────────────┘
                                │
          ┌─────────────────────┼──────────────────────┐
          │                     │                      │
    ┌─────▼──────┐    ┌────────▼────────┐    ┌────────▼────────┐
    │ Aggregator  │    │ Direct RPC      │    │ GeckoTerminal   │
    │ APIs        │    │ (top 20 coins)  │    │ (discovery/     │
    │ (0x/1inch)  │    │                 │    │  validation)    │
    │             │    │ Curve get_dy    │    │                 │
    │ All 156     │    │ Uni V3 TWAP     │    │ Already in      │
    │ stablecoins │    │ Aero getAmtOut  │    │ staging cron    │
    │ ~156 calls  │    │ ~60 calls       │    │                 │
    └─────┬──────┘    └────────┬────────┘    └────────┬────────┘
          │                     │                      │
          └─────────────────────┼──────────────────────┘
                                │
                    ┌───────────▼──────────────────────┐
                    │   Aggregate & Store in D1         │
                    │   - median of available sources   │
                    │   - flag CEX/DEX divergence       │
                    │   - update depeg signals          │
                    └──────────────────────────────────┘
```

---

## 6. Provider Cost Comparison (for RPC-based reads)

| Provider | Free Tier | eth_call Cost | Multi-chain | Best For |
|----------|-----------|---------------|-------------|----------|
| **Alchemy** | 30M CUs (~1.2M calls) | 26 CUs/call | 30+ chains | General reads |
| **Infura** | 3M credits/day | 1 credit/call | 10+ chains | Simple reads |
| **QuickNode** | 50 req/s (shared) | varies | 25+ chains | Solana + EVM |
| **Chainstack** | limited | varies | 30+ chains | Dedicated nodes |
| **Cloudflare Web3 Gateway** | free (Ethereum only) | free | Ethereum only | Zero-cost Ethereum reads |
| **Public RPCs** | free | free | varies | Testing only (unreliable) |

**For 156 stablecoins polled every 30 minutes across 3 methods:**
- Aggregator path: 156 calls/30min = 312/hr = 7,488/day — well within free tiers
- Direct RPC path: ~60 calls/30min for top 20 = 120/hr = 2,880/day — minimal
- Total: ~10K calls/day — easily within Alchemy free tier (1.2M/month) or Infura free tier (3M/day)

---

## 7. Recommendations

### For Pharos Specifically

Given our existing infrastructure (Cloudflare Worker cron, D1, GeckoTerminal discovery already running):

1. **Lowest-hanging fruit: 0x `/price` endpoint.** 10 RPS free tier, 18+ chains, simple REST. One integration covers all EVM stablecoins. Use for broad price coverage.

2. **Solana: Jupiter quote API.** Single endpoint covers all Solana DEXes. Pair with our existing CoinGecko price data for cross-validation.

3. **High-value TWAP: Uniswap V3 `observe()` on Ethereum.** For top 10-15 stablecoins, a 30-min TWAP from the deepest Uniswap V3 pool provides manipulation-resistant price signal. Useful for depeg detection confidence.

4. **Curve `get_dy` for stablecoin-specific signal.** Curve pools are the deepest venue for most stablecoins. A single `get_dy` call per pool gives a highly reliable price that's hard to manipulate due to the StableSwap invariant.

5. **Cross-validation with existing data.** Compare DEX prices against our CoinGecko/DefiLlama prices. The delta itself is a useful signal (large DEX-CEX spread = early depeg indicator).

### What NOT to Do

- **Do not use Uniswap V3 `slot0` spot price as an oracle** — trivially manipulable.
- **Do not build per-protocol Solana deserializers** — use Jupiter's aggregator API instead. The complexity of Borsh deserialization for Raydium/Orca layouts is not justified when Jupiter provides a clean HTTP API.
- **Do not self-host Envio/Ponder** — we're a static export + Worker architecture, not a server-managed backend.
- **Do not rely on a single source** — always cross-validate. Any single DEX pool can be temporarily manipulated.

---

## Sources

### Uniswap V3
- [Uniswap V3 Math Primer](https://blog.uniswap.org/uniswap-v3-math-primer)
- [Fetching Pool Data — Uniswap Docs](https://docs.uniswap.org/sdk/v3/guides/advanced/pool-data)
- [sqrtPriceX96 — RareSkills](https://rareskills.io/post/uniswap-v3-sqrtpricex96)
- [UniswapV3Pool Reference](https://docs.uniswap.org/contracts/v3/reference/core/UniswapV3Pool)
- [IUniswapV3PoolState](https://docs.uniswap.org/contracts/v3/reference/core/interfaces/pool/IUniswapV3PoolState)
- [Quoter Contract Reference](https://docs.uniswap.org/contracts/v3/reference/periphery/lens/Quoter)
- [QuoterV2 Reference](https://docs.uniswap.org/contracts/v3/reference/periphery/lens/QuoterV2)
- [Getting a Quote — Uniswap SDK](https://docs.uniswap.org/sdk/v3/guides/swaps/quoting)
- [Uniswap V3 Subgraph Overview](https://docs.uniswap.org/api/subgraph/overview)
- [V3 Subgraph Query Examples](https://docs.uniswap.org/api/subgraph/guides/v3-examples)

### Curve
- [Curve Exchange Pools Docs](https://curve.readthedocs.io/exchange-pools.html)
- [Curve CryptoSwap Pool Docs](https://docs.curve.finance/cryptoswap-exchange/cryptoswap/pools/crypto-pool/)
- [Using Chainlink Oracles with Curve LP Pools](https://blog.chain.link/using-chainlink-oracles-to-securely-utilize-curve-lp-pools/)
- [Heartbreaks & Curve LP Oracles — ChainSecurity](https://www.chainsecurity.com/blog/heartbreaks-curve-lp-oracles)

### Balancer
- [Balancer Pool Interfacing](https://docs-v2.balancer.fi/reference/contracts/pool-interfacing.html)
- [Balancer V2 Pools Overview](https://balancer.gitbook.io/balancer-v2/products/balancer-pools)

### Aerodrome / Velodrome
- [Aerodrome Contracts (GitHub)](https://github.com/aerodrome-finance/contracts)
- [Aerodrome Pool.sol Source](https://github.com/aerodrome-finance/contracts/blob/main/contracts/Pool.sol)
- [Aerodrome Router.sol Source](https://github.com/aerodrome-finance/contracts/blob/main/contracts/Router.sol)
- [Velodrome Contracts (GitHub)](https://github.com/velodrome-finance/contracts)
- [Velodrome/Aerodrome Case Study — Optimism](https://www.optimism.io/case-studies/velodrome-aerodrome)

### Solana (Raydium / Orca)
- [How to Monitor a Raydium Liquidity Pool — Helius](https://www.helius.dev/blog/how-to-monitor-a-raydium-liquidity-pool)
- [Track Raydium LPs — QuickNode](https://www.quicknode.com/guides/solana-development/3rd-party-integrations/track-raydium-lps)
- [Raydium SDK V1 (GitHub)](https://github.com/raydium-io/raydium-sdk-v1)
- [Orca Whirlpools — Price & Ticks](https://dev.orca.so/Architecture%20Overview/Price%20&%20Ticks/)
- [Orca Whirlpools Core SDK](https://www.npmjs.com/package/@orca-so/whirlpools-core)
- [Orca Whirlpools (GitHub)](https://github.com/orca-so/whirlpools)
- [Solana simulateTransaction RPC Docs](https://solana.com/docs/rpc/http/simulatetransaction)
- [Jupiter API Reference](https://dev.jup.ag/api-reference)
- [Jupiter Swap API Quote Endpoint](https://dev.jup.ag/docs/swap-api/get-quote)
- [Metis Jupiter Swap API — QuickNode](https://marketplace.quicknode.com/add-on/metis-jupiter-swap-api)

### DEX Aggregator APIs
- [1inch API Pricing](https://business.1inch.com/pricing/)
- [1inch Developer Portal](https://business.1inch.com/portal/documentation)
- [ParaSwap/Velora Developer Docs](https://developers.velora.xyz)
- [0x API Docs](https://0x.org/docs/api)
- [0x Swap API Getting Started](https://0x.org/docs/0x-swap-api/guides/swap-tokens-with-0x-swap-api)
- [0x Pricing](https://0x.org/pricing)
- [0x Cross-Chain API Launch](https://www.prnewswire.com/apac/news-releases/0x-launches-cross-chain-api-beta-to-power-agentic-swaps-across-blockchains-302698823.html)

### Subgraphs / Indexers
- [TheGraph — Uniswap Subgraph](https://thegraph.com/blog/uniswap-built-on-the-graph/)
- [Goldsky Subgraphs](https://docs.goldsky.com/subgraphs/introduction)
- [GeckoTerminal API Docs](https://apiguide.geckoterminal.com/)
- [GeckoTerminal API Swagger](https://api.geckoterminal.com/docs/index.html)
- [GeckoTerminal Review 2026](https://cryptoadventure.com/geckoterminal-review-2026-multichain-dex-pool-data-token-discovery-and-a-free-api/)
- [Best Blockchain Indexers 2026 — Ormi](https://blog.ormilabs.com/best-blockchain-indexers-in-2025-real-time-web3-data-and-subgraph-platforms-compared/)
- [Top 5 Hosted Subgraph Platforms 2026 — Chainstack](https://chainstack.com/top-5-hosted-subgraph-indexing-platforms-2026/)

### Manipulation Resistance / Oracle Security
- [Ormer: Manipulation-Resistant Oracle (arXiv)](https://arxiv.org/html/2410.07893v2)
- [TWAP vs VWAP — Chainlink](https://chain.link/education-hub/twap-vs-vwap)
- [Price Oracle Manipulation — Cyfrin](https://www.cyfrin.io/blog/price-oracle-manipulation-attacks-with-examples)
- [Flash Loan Exploits Guide — Speedrun Ethereum](https://speedrunethereum.com/guides/flash-loan-exploits)
- [SC03: Price Oracle Manipulation — OWASP](https://owasp.org/www-project-smart-contract-top-10/2026/en/src/SC03-price-oracle-manipulation.html)
- [Stablecoin Oracle Manipulation Vectors](https://stablecoininsider.org/stablecoin-oracle-manipulation-vectors/)
- [Uniswap V3 JIT Attacks — Zealynx](https://www.zealynx.io/blogs/uniswap-v3)

### RPC Providers
- [Best RPC Providers 2026 — CryptoAdventure](https://cryptoadventure.com/best-rpc-providers-in-2026-reliability-privacy-tradeoffs-pricing-and-rate-limits/)
- [Best Ethereum RPC Providers 2026 — Chainstack](https://chainstack.com/best-ethereum-rpc-providers-in-2026/)
- [Alchemy vs Infura vs QuickNode — Chainnodes](https://www.chainnodes.org/blog/alchemy-vs-infura-vs-quicknode-vs-chainnodes-ethereum-rpc-provider-pricing-comparison/)
- [Infura Pricing](https://www.infura.io/pricing)
