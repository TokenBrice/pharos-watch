# Oracle & Pricing Data Source Research

> Research date: 2026-03-14
> Purpose: Evaluate on-chain oracle and pricing sources as additional price feeds for Pharos stablecoin monitoring
> Context: Currently using CoinGecko (~1-5 min delay) and DefiLlama as primary price sources

---

## Table of Contents

1. [Chainlink Price Feeds](#1-chainlink-price-feeds)
2. [Pyth Network (Hermes)](#2-pyth-network-hermes)
3. [RedStone Oracle](#3-redstone-oracle)
4. [Chronicle Protocol](#4-chronicle-protocol)
5. [API3 / dAPI](#5-api3--dapi)
6. [Uniswap v3 TWAP](#6-uniswap-v3-twap)
7. [Curve Pool Virtual Prices](#7-curve-pool-virtual-prices)
8. [Comparative Summary](#8-comparative-summary)
9. [Recommendation for Pharos](#9-recommendation-for-pharos)

---

## 1. Chainlink Price Feeds

### Overview
Chainlink is the dominant oracle network, securing ~64% of oracle-dependent TVL. Price feeds are maintained by a decentralized network of independent node operators who aggregate data from premium data providers.

### API Availability

- **No dedicated HTTP REST API.** Chainlink price feeds are on-chain contracts. Reading them off-chain requires calling `latestRoundData()` on the aggregator contract via a blockchain RPC endpoint (Alchemy, Infura, etc.).
- **Chainlink Data Streams** (separate product) offers a low-latency HTTP/WebSocket API, but requires an **enterprise subscription** (no self-service, no public pricing). Subscription-based billing; must contact sales.
- **Historical Price Feeds API** exists as a quickstart template but still requires supplying your own RPC URL as a parameter.
- **Rate limits** are determined by your RPC provider, not Chainlink itself.
- **Cost**: Free to read on-chain feeds (you pay only RPC provider costs). Data Streams requires paid subscription.

### Data Freshness (Stablecoin Feeds on Ethereum)

| Feed | Heartbeat | Deviation Threshold |
|------|-----------|-------------------|
| USDT/USD | 86,400s (24h) | 0.25% |
| USDC/USD | 82,800s (~23h) | 0.25% |
| DAI/USD | 3,600s (1h) | 0.25% |
| USDS/USD | 82,800s (~23h) | 0.3% |
| USDe/USD | 82,800s (~23h) | 0.5% |
| PYUSD/USD | 86,400s (24h) | 0.3% |
| sUSDe/USD | 86,400s (24h) | 0.5% |

**Critical finding**: Major stablecoin feeds (USDT, USDC) have 24-hour heartbeats. This means on-chain values can be up to 24h stale during low-volatility periods. Updates only trigger on 0.25% deviation OR heartbeat expiry, whichever comes first. DAI is notably faster at 1h heartbeat.

### Stablecoin Coverage
~7-10 stablecoin/USD feeds on Ethereum mainnet (USDT, USDC, DAI, USDS, USDe, PYUSD, sUSDe, FRAX, TUSD). Additional feeds on L2s (Arbitrum, Optimism, Base, Polygon) with potentially different heartbeats.

### Historical Data
Yes -- all round data is stored on-chain. You can iterate through historical rounds via `getRoundData(roundId)`. Practically unlimited history back to feed deployment.

### Price Aggregation
Premium data providers aggregate raw price data from centralized and decentralized exchanges. Independent Chainlink nodes fetch from these providers, then reach consensus off-chain before posting on-chain. Multiple layers of aggregation before the on-chain value.

### Known Reliability Issues
- **Stale data during low volatility**: 24h heartbeat for USDC/USDT means prices can be many hours old.
- **March 2023 stETH depeg**: Chainlink was slow to reflect the depeg because aggregation lagged.
- **L2 sequencer dependency**: If an L2 sequencer goes down, feeds on that L2 stop updating.
- **Reentrancy attacks on LP token pricing** (not direct feeds, but LP token virtual prices read via Chainlink).

### Cloudflare Worker Compatibility
**Partially compatible.** Requires an RPC call (single HTTP request to Alchemy/Infura). No persistent connections needed. ~200-500ms round-trip per feed. Can batch multiple feeds in parallel.

**Realistic refresh rate**: Limited by RPC costs and the 24h heartbeat. Even polling every 5 minutes, the on-chain value for USDC/USDT changes at most once per 24h during calm markets. During depeg events, deviation-triggered updates happen within seconds of 0.25% moves.

### Comparison to CoinGecko
**Worse for stablecoins during calm markets** (24h vs 1-5 min). **Comparable during volatility** (deviation triggers update). The on-chain value is more trustworthy (decentralized consensus vs single API provider) but dramatically less fresh for stablecoin monitoring.

---

## 2. Pyth Network (Hermes)

### Overview
Pyth is a pull-based oracle aggregating data from ~95 first-party institutional publishers (market makers, exchanges, trading firms). Data is aggregated on Pythnet (Solana-based appchain) and served via Hermes, a REST/SSE web service.

### API Availability

**Free HTTP REST API (Hermes)**:
- **Public endpoint**: `https://hermes.pyth.network`
- **No API key required** for the public endpoint
- **Rate limits**: 30 requests per 10 seconds per IP (= 3 req/s, 180 req/min). Exceeding triggers 429 for 60 seconds.
- **Third-party providers** (Triton, P2P, Blockdaemon, Figment) offer private endpoints with higher limits.
- **Pyth Pro** (launched Sept 2025): Enterprise subscription service with customizable feeds and higher limits.

**Verified working endpoints**:

```
GET /v2/updates/price/latest?ids[]=<hex_feed_id>&parsed=true
GET /v2/updates/price/stream?ids[]=<hex_feed_id>  (SSE streaming)
GET /api/latest_price_feeds?ids[]=<hex_feed_id>    (legacy v1)
```

**Benchmarks API** (historical data):
- **Endpoint**: `https://benchmarks.pyth.network`
- `GET /v1/updates/price/<unix_timestamp>?ids=<hex_feed_id>&parsed=true`
- Returns price at any historical timestamp. Interval queries up to 60s.
- Same rate limits as Hermes.

### Data Freshness
- **Sub-second updates on Pythnet** (400ms Solana slot time)
- **Hermes serves the latest Pythnet data** with ~1-2s latency from price change to API availability
- **Verified**: API response includes `publish_time` and `proof_available_time` typically 1-2s apart
- **Tested latency**: ~140ms HTTP round-trip from Europe

### Stablecoin Coverage

Confirmed stablecoin feeds (with hex IDs):

| Feed | Feed ID (hex, truncated) |
|------|-------------------------|
| USDT/USD | `0x2b89b9dc...e2e53b` |
| USDC/USD | `0xeaa020c6...9c94a` |
| DAI/USD | Available (lookup via API) |
| BUSD/USD | Available |
| FRAX/USD | Available |
| TUSD/USD | Available |
| USDD/USD | Available |
| CUSD/USD | Available |
| EUROC/EUR | Available |
| OUSD/USD | Available |
| USTC/USD | Available |

~11+ stablecoin feeds documented, likely more added since. Feed IDs discoverable programmatically via `HermesClient.getPriceFeeds("usdt", "crypto")`.

### Response Format

```json
{
  "parsed": [{
    "id": "2b89b9dc...",
    "price": {
      "price": "100013342",   // raw integer
      "conf": "60974",         // confidence interval
      "expo": -8,              // divide by 10^8
      "publish_time": 1773442820
    },
    "ema_price": {
      "price": "100012889",   // exponential moving average
      "conf": "58022",
      "expo": -8,
      "publish_time": 1773442820
    }
  }]
}
```

**Key feature**: Confidence intervals (`conf`) provide a built-in uncertainty measure. For USDT at $1.00013, confidence was $0.00061 -- meaning the true price is within $0.99952-$1.00074 with high probability. This is extremely valuable for depeg detection.

### Historical Data
Yes, via the Benchmarks API. Tested successfully -- returns signed price data at any historical Unix timestamp. Rate-limited same as Hermes (30 req/10s).

### Price Aggregation
First-party publishers (exchanges, market makers like Jump, Virtu, Jane Street, Two Sigma) push signed prices to Pythnet. The protocol aggregates using a weighted median with confidence intervals. No intermediary data providers -- publishers report their own prices. Statistical anomaly detection filters outliers.

### Known Reliability Issues
- **Public endpoint reliability**: Pyth recommends private Hermes providers for production use. Public endpoint may have downtime.
- **Stablecoin fee tier**: Pyth governance proposed 0.01% fee tier for stablecoin on-chain updates (not relevant for off-chain reads).
- **Confidence intervals can be wide** during low liquidity periods.
- **Pythnet dependency**: If Pythnet goes down, all feeds stop. Mitigated by 2/3+ validator quorum.

### Cloudflare Worker Compatibility
**Excellent.** Pure HTTP REST API, no persistent connections, no API keys needed. 140ms typical latency. Can fetch multiple feed IDs in a single request. SSE streaming would NOT work in Workers (no long-lived connections), but REST polling is perfect.

**Realistic refresh rate**: With 30 req/10s limit and multi-ID batching, you could poll all ~11 stablecoin feeds once per second. Practically, polling every 10-30 seconds is sufficient and well within limits.

### Comparison to CoinGecko
**Significantly faster** (1-2s vs 1-5 min). **Confidence intervals** are a unique advantage for depeg detection. Coverage is narrower (~11 stablecoins vs 156 tracked by Pharos). **Free tier** is sufficient for our use case.

---

## 3. RedStone Oracle

### Overview
RedStone is a modular oracle providing data feeds across 100+ blockchains. Claims 97.9% stablecoin market cap coverage. Supports both push and pull delivery models with an off-chain cache layer.

### API Availability

**Free HTTP API (no API key required)**:
- **Base URL**: `https://api.redstone.finance`
- **Endpoint**: `GET /prices?symbol=<SYMBOL>&provider=redstone&limit=1`
- **Multi-symbol**: `GET /prices?symbols=USDT,USDC,DAI&provider=redstone&limit=1`
- **Historical**: `getHistoricalPrice(symbol, { date: "2021-03-30T12:35:09" })` via JS SDK; HTTP endpoint supports historical queries.
- **No API keys needed.**
- **Rate limits**: Not publicly documented. No enforcement observed during testing.
- **npm SDK**: `@redstone-finance/sdk` and legacy `redstone-api`

**Also available**: Off-chain SDK (`@redstone-finance/sdk`) for fetching signed data packages with configurable gateway timeouts and minimum signer thresholds.

### Data Freshness
- Data is continuously collected by RedStone oracle nodes and pushed to the cache layer.
- **Tested latency**: ~180ms HTTP round-trip.
- Update frequency depends on the model: push feeds use heartbeat+deviation; cache layer updates appear to be near-continuous.
- Stablecoin deviation thresholds typically 0.5-1%, with specialized feeds as tight as 0.05% (CAP protocol).

### Stablecoin Coverage
**Extensive.** Claims 97.9% stablecoin market cap coverage. Tested successfully: USDT, USDC, DAI, FRAX, GHO, LUSD, crvUSD, USDe, PYUSD, and more. The `provider=redstone` data service covers 100+ tokens.

### Response Format (Unique Strength)

```json
{
  "symbol": "USDC",
  "value": 1.00000874,
  "source": {
    "binance-usd": 0.999984963,
    "binance-usdt": 0.999984963,
    "bitget-usd": 1.0000849815,
    "bitstamp-usd": 1.0,
    "coinbase-usd": 1.00022,
    "gemini-usd": 0.99995,
    "kraken-usd": 1.00002,
    "curve-ethereum-dai": 1.00010501,
    "curve-ethereum-usdt": 0.99998697,
    "uniswap-v3-ethereum-dai-100": 1.00011874,
    "uniswap-v4-arbitrumone-usdt-8": 1.00000874
  },
  "timestamp": 1773442800000,
  "liteEvmSignature": "..."
}
```

**Key feature**: The response includes per-exchange/per-DEX-pool prices with the source breakdown. This is remarkably valuable for depeg detection -- you can see which venues are depegging first. ~20+ individual sources for USDC including CEXes (Binance, Coinbase, Kraken, etc.) and DEXes (Curve, Uniswap v3/v4).

### Historical Data
Yes. Available via the JS SDK and HTTP API. Data is archived on Arweave blockchain for permanent storage.

### Price Aggregation
Oracle nodes fetch prices from Tier 1 exchanges (CEX and DEX), aggregate via median/weighted aggregation, and sign the result. The cache layer stores recent signed packages. Each response includes the individual exchange sources -- full transparency into the aggregation.

### Known Reliability Issues
- **Younger network** than Chainlink. Securing ~$8.5B TVL vs Chainlink's $93B.
- **Cache layer dependency**: If the cache gateways go down, off-chain reads fail (on-chain push feeds still work).
- **No documented rate limits** could mean sudden enforcement without warning.
- Acquired Security Token Market in Jan 2026, expanding into RWA data.

### Cloudflare Worker Compatibility
**Excellent.** Simple HTTP GET requests, no API keys, no persistent connections. 180ms typical latency. Can batch multiple symbols.

**Realistic refresh rate**: Without documented rate limits and low latency, polling every 10-30 seconds is easily achievable. The per-source breakdown reduces the need for high-frequency polling since you get venue-level granularity in each request.

### Comparison to CoinGecko
**Comparable or better freshness.** The killer feature is the **per-exchange source breakdown** -- CoinGecko gives you one aggregated price, RedStone gives you 20+ individual venue prices. This is uniquely valuable for stablecoin depeg detection (seeing which venues depeg first).

---

## 4. Chronicle Protocol

### Overview
Chronicle (formerly Maker oracles) has been operational since 2017, originally powering Maker/DAI. Uses Schnorr-based signatures for gas-efficient on-chain updates. 25 validators including Infura, Etherscan, Gnosis.

### API Availability

- **No public HTTP REST API for off-chain price reads.**
- On-chain access is **whitelist-gated**: must call `read()` or `readWithAge()` on the oracle contract, but only after your address is whitelisted. On testnet, self-whitelisting via `SelfKisser`. On mainnet, requires support ticket via Discord.
- **Dashboard** provides visual/historical exploration but no programmatic API.
- Off-chain P2P data channels exist but are not publicly exposed.
- To read prices off-chain, you would need: (a) whitelisted address, (b) RPC endpoint, (c) call the contract.

### Data Freshness
- Push-based with Schnorr signature aggregation.
- 60-80% less gas per update than competitors, allowing more frequent on-chain updates.
- Specific update frequencies per feed not publicly documented.

### Stablecoin Coverage
~65+ data feeds total. Documented stablecoin feeds: DAI/USD, USDS/USD, PYUSD/USD, USR/USD, GYD/USD, USDM/wUSDM, USDa/USD, HONEY/USD, NECT/USD. Moderate coverage, focused on Maker ecosystem and partners.

### Historical Data
Chronicle stores archived data for all price feeds going back to 2019. Accessible via the Chronicle dashboard, not via a public API.

### Price Aggregation
Custom-built data models using "Tier 1 Primary Sources" (Coinbase, Binance, Uniswap, Curve). 25 validators independently source data and sign; Schnorr signature aggregation produces a single compact update.

### Known Reliability Issues
- **Whitelist-gated access** is the primary barrier. Not self-service for mainnet.
- **Maker ecosystem dependency**: Primary customer is Sky/Maker. Unclear long-term incentive to serve external consumers.
- Coverage is narrower than Chainlink or Pyth.

### Cloudflare Worker Compatibility
**Poor.** Requires on-chain contract call via RPC (not Chronicle's fault, but architectural). Whitelist requirement adds operational overhead. No HTTP API.

**Realistic refresh rate**: Same as Chainlink on-chain reads (~200-500ms per RPC call). But the whitelist requirement and lack of HTTP API make this impractical for Pharos.

### Comparison to CoinGecko
**Not practical** as a CoinGecko alternative due to whitelist gating and lack of HTTP API. Would need significant integration work for minimal benefit over other options.

---

## 5. API3 / dAPI

### Overview
API3 provides "first-party oracles" where data providers themselves operate Airnode middleware. dAPIs are on-chain data feeds maintained by these first-party oracles. Shifted to push-oracle model in 2025-2026.

### API Availability

**Signed API (HTTP endpoint)**:
- **URL pattern**: `GET https://signed-api.api3.org/public/<AIRNODE_ADDRESS>`
- Returns cryptographically signed price data from a specific data provider (Airnode).
- **Free, public, no API key required.**
- **Rate limited**: "Excessive call frequency is restricted by rate limiting or full access denial." No specific numbers published.
- Returns signed data for ALL feeds from that Airnode, not per-asset queries.

**However**: To use this effectively, you need to know the Airnode addresses for data providers that cover your assets. There is no simple "give me USDT price" endpoint. You must:
1. Look up the Airnode address for a provider (e.g., Nodary) via the API3 Market or AirseekerRegistry contract.
2. Look up the template ID for the specific feed (e.g., USDT/USD).
3. Call the Signed API with the Airnode address.
4. Parse the response to find your feed by template ID.

### Data Freshness
- Airnode feeds "continuously query the API" of data providers and push signed data to the Signed API.
- Push-oracle model includes MEV-resistant design.
- Specific update frequencies depend on the data provider configuration. Sub-second is theoretically possible.

### Stablecoin Coverage
API3 is "prioritizing data feeds for LSTs, LRTs, and stablecoins." The API3 Market lists available dAPIs per chain. Coverage is expanding but specifics are not easily discoverable without querying the on-chain registry or API3 Market UI.

### Historical Data
No public historical data API. The Signed API only serves the latest signed data.

### Price Aggregation
First-party model: Data providers (API providers) directly sign their data via Airnode. Beacons (individual feeds) can be aggregated into "beacon sets" for multi-source aggregation. The `Api3ServerV1` contract handles on-chain aggregation.

### Known Reliability Issues
- **Discovery friction**: Finding the right Airnode address and template ID is non-trivial.
- **Smaller ecosystem** than Chainlink or Pyth.
- **Rate limit ambiguity**: "Excessive" calls trigger blocking, but no concrete thresholds published.
- **OEV Network** (Oracle Extractable Value) is a unique feature but adds complexity.

### Cloudflare Worker Compatibility
**Moderate.** HTTP GET to Signed API works from Workers. But the discovery problem (needing Airnode addresses) and the response format (all feeds from one provider, not per-asset) add integration complexity.

**Realistic refresh rate**: Unknown due to undocumented rate limits. The API is HTTP-based and could be polled every 10-30s, but you'd need to parse multi-feed responses.

### Comparison to CoinGecko
**Not practical** as a CoinGecko replacement. The API is designed for on-chain oracle infrastructure, not off-chain price consumption. Discovery friction and response format make it unsuitable for our use case.

---

## 6. Uniswap v3 TWAP

### Overview
Every Uniswap v3 pool stores cumulative tick observations on-chain, enabling computation of Time-Weighted Average Prices. These are manipulation-resistant price references.

### API Availability

- **No HTTP API.** TWAP computation requires on-chain reads.
- **Method**: Call `observe(uint32[] secondsAgos)` on the pool contract via RPC. Returns `tickCumulative` values. Compute TWAP as `(tickCumulative[1] - tickCumulative[0]) / elapsed_seconds`.
- **Uniswap v3 Subgraph** (The Graph): Indexes pool state, swaps, positions. But does NOT index raw `tickCumulative` observations. You must call the pool contract directly for TWAP data.
- **Cost**: RPC provider costs only.

### Data Freshness
- Observations update on every block where a swap occurs in that pool (Ethereum: ~12s blocks).
- TWAP windows are configurable: 30-minute TWAP is the DeFi standard.
- **By design, TWAP is smoothed** -- it intentionally dampens short-term volatility. A 30-min TWAP will be 15+ minutes behind a spot price move.
- Observation array can store up to 65,535 entries (~9+ days of data).

### Stablecoin Pool Coverage (Ethereum)

| Pool | Fee Tier | Approximate TVL |
|------|----------|-----------------|
| USDC/USDT | 0.01% | ~$25M |
| USDC/USDT | 0.05% | Significant |
| DAI/USDC | 0.01% | ~$108M |
| DAI/USDC | 0.05% | ~$62M |
| DAI/USDT | 0.05% | Moderate |

Stablecoin-to-stablecoin pools exist but with lower liquidity than stablecoin/ETH pairs. USDC/USDT 0.01% pool processes ~$33M daily volume.

### Historical Data
Yes, stored on-chain in the observation array. Up to ~9 days of tick-level data per pool (if observation slots are expanded). Older data requires archive node access.

### Price Aggregation
Pure AMM price -- derived from the pool's invariant curve. The TWAP is a geometric mean of tick prices over the window. No external data sources; price is purely a function of trader behavior in that pool.

### Manipulation Resistance
- **30-min TWAP manipulation on major pairs is prohibitively expensive** (~$360B+ capital required for USDC/WETH with $1M wide-range liquidity).
- **PoS caveat**: Multi-block validators could theoretically manipulate, but at massive capital cost.
- **Stablecoin-to-stablecoin pools have lower liquidity**, making TWAP more susceptible to manipulation than major pairs.
- **Geometric mean** (not arithmetic) makes single-block outliers less impactful.

### Known Reliability Issues
- **Low-liquidity pools** can have unreliable TWAPs.
- **No observations if no swaps occur** -- inactive pools produce stale data.
- **Concentrated liquidity** means the oracle reflects price within the active range only.
- **Single-DEX dependency**: Only reflects Uniswap v3 trading activity, not broader market.

### Cloudflare Worker Compatibility
**Moderate.** Requires on-chain RPC calls (~200-500ms each). Multiple calls needed per pool (one `observe()` call returns two cumulative values). Computing TWAP from ticks involves math (1.0001^tick conversion).

**Realistic refresh rate**: Could compute a 30-min TWAP every 1-5 minutes. But the TWAP is inherently lagged, so more frequent updates provide diminishing returns.

### Comparison to CoinGecko
**Complementary, not a replacement.** TWAP is inherently smoothed (lagged) but manipulation-resistant. Best used as a **cross-reference** to detect if CoinGecko/other spot prices diverge from the TWAP -- a divergence signal could indicate manipulation or a genuine depeg. Not suitable as a primary price feed due to coverage limitations (only pools that exist on Uniswap v3) and inherent smoothing.

---

## 7. Curve Pool Virtual Prices

### Overview
Curve's StableSwap AMM is purpose-built for stablecoin trading. Pool virtual prices, exchange rates, and the Curve REST API provide stablecoin-specific pricing data.

### API Availability

**Curve REST API (free, no auth)**:
- **Base URL**: `https://api.curve.finance/v1`
- **OpenAPI spec**: `https://api.curve.finance/v1/openapi.json`
- **Swagger docs**: `https://api.curve.finance/v1/documentation`
- **Status page**: `https://statuspage.freshping.io/59335-CurveAPI`

**Key endpoints (verified working)**:

| Endpoint | Description |
|----------|-------------|
| `GET /getPools/all/{blockchainId}` | All pools with virtual prices, coins, TVL |
| `GET /getPools/{blockchainId}/{registryId}` | Pools by registry (e.g., `factory-crvusd`) |
| `GET /getVolumes/{blockchainId}` | 24h volume per pool |
| `GET /getCrvusdTotalSupply` | crvUSD total supply |
| `GET /getVolumes/ethereum/crvusd-amms` | crvUSD AMM volumes |
| `GET /getTokens/all/{blockchainId}` | All tokens with pricing |
| `GET /getSubgraphData/{blockchainId}` | Subgraph data |

Supported chains: ethereum, arbitrum, base, optimism, polygon, bsc, avalanche, fantom, fraxtal, sonic, zksync, and more.

- **Rate limits**: Not publicly documented. No explicit rate limiting observed.
- **No API key required.**

**On-chain (via RPC)**:
- `get_virtual_price()` on any pool contract
- MetaRegistry `get_virtual_price_from_lp_token(token)` for LP-level pricing

### Data Freshness
- **REST API**: Appears to update periodically (likely every few minutes). Response includes pool balances and virtual prices that reflect recent on-chain state.
- **On-chain**: Virtual price updates with every swap/deposit/withdrawal. Near real-time via RPC.
- Virtual prices start at 1.0 and monotonically increase as fees accrue (for StableSwap pools).

### Stablecoin Coverage
**Best-in-class for stablecoin-to-stablecoin data.** Tested major pools:

| Pool | Coins | TVL |
|------|-------|-----|
| 3pool | DAI/USDC/USDT | $163M |
| PYUSD/USDS (Spark) | PYUSD/USDS | $100M |
| FRAX/USDe | FRAX/USDe | $75M |
| pyUSD/crvUSD | PYUSD/crvUSD | $50M |
| PayPool | PYUSD/USDC | $46M |
| crvUSD/USDC | USDC/crvUSD | $22M |
| crvUSD/USDT | USDT/crvUSD | $17M |
| LUSD/3Crv | LUSD/3Crv | $12M |
| MIM/3Crv | MIM/3Crv | $9M |

Covers nearly every major stablecoin through pool composition.

### Response Format (Pool Data)
Pool objects include: `address`, `coins` (with addresses, decimals, symbols, prices), `virtualPrice`, `usdTotal` (TVL), `amplificationCoefficient`, `totalSupply`, individual coin balances. The REST response for all Ethereum pools is ~1.3MB.

### Historical Data
Not directly via the REST API. On-chain virtual prices have full history via archive nodes. A third-party project (Bisonai/curve-api-historical-data) provides a historical data REST API.

### Price Aggregation
Pool exchange rates are determined by the StableSwap invariant (amplified constant-product formula). Virtual price = pool invariant / LP token supply. This reflects the collective trading activity and liquidity in the pool. **Not aggregated from external sources** -- it IS the market price within Curve.

### Known Reliability Issues
- **Virtual price reentrancy attacks** (historical vulnerability -- mitigated in newer versions but older pools may be affected).
- **Flash loan manipulation** risk for protocols using Curve as an oracle. Chainlink explicitly recommends NOT using Curve virtual price as a price oracle for other protocols.
- **crvUSD oracle** uses an EMA (exponential moving average) of Tricrypto pool TWAPs, adding smoothing/lag.
- **API status**: The REST API has had occasional downtime (status page available).

### Cloudflare Worker Compatibility
**Good.** The REST API is a simple HTTP GET, returns JSON, no auth required. The main caveat is response size (~1.3MB for all Ethereum pools). Should filter to specific pools.

**Realistic refresh rate**: The API doesn't document rate limits. Polling every 5-10 minutes for the full pool set, or every 1-2 minutes for specific pools, should be fine.

### Comparison to CoinGecko
**Complementary.** Curve prices are DEX-native stablecoin exchange rates, not aggregated spot prices. The pool balance ratios and virtual prices provide a unique signal: when a pool becomes imbalanced (e.g., 80% USDC / 20% USDT in a 50/50 pool), it signals a relative value shift that CoinGecko aggregated prices may smooth over. Best used as a **depeg detection signal** rather than a primary price source.

---

## 8. Comparative Summary

| Source | HTTP API? | Free? | Auth? | Rate Limits | Stablecoin Coverage | Freshness | Historical | CF Worker? | Depeg Detection Value |
|--------|-----------|-------|-------|-------------|--------------------|-----------|-----------|-----------|-----------------------|
| **Chainlink Feeds** | No (RPC only) | RPC costs | N/A | RPC-dependent | ~7-10 feeds | 24h heartbeat | Yes (on-chain) | Moderate | Low (too stale) |
| **Chainlink Streams** | Yes (REST+WS) | No (enterprise) | Yes | Unknown | Broad | Sub-second | Unknown | Yes | High (if accessible) |
| **Pyth Hermes** | **Yes** | **Yes** | **No** | 30/10s per IP | ~11-15 feeds | **1-2s** | Yes (Benchmarks) | **Excellent** | **High** (confidence intervals) |
| **RedStone** | **Yes** | **Yes** | **No** | Undocumented | ~20+ stablecoins | ~10s | Yes (Arweave) | **Excellent** | **Highest** (per-venue breakdown) |
| **Chronicle** | No (whitelist+RPC) | Whitelist req'd | Yes | N/A | ~10 feeds | Unknown | Yes (2019+) | Poor | Low (access barrier) |
| **API3 Signed API** | Yes | Yes | No | Undocumented | Unknown | Continuous | No | Moderate | Low (discovery friction) |
| **Uniswap v3 TWAP** | No (RPC only) | RPC costs | N/A | RPC-dependent | 5-10 pools | 30-min avg | Yes (on-chain) | Moderate | Medium (cross-reference) |
| **Curve REST API** | **Yes** | **Yes** | **No** | Undocumented | **Excellent** (~30+ pools) | ~minutes | Limited | **Good** | **High** (pool imbalance signals) |

---

## 9. Recommendation for Pharos

### Tier 1: Strongly Recommended

#### Pyth Network Hermes
- **Why**: Free HTTP API, no auth, excellent CF Worker compatibility, 1-2s freshness, confidence intervals are a unique signal for depeg detection.
- **Integration effort**: Low. Single HTTP GET per poll. Batch multiple feed IDs.
- **Use case**: Secondary real-time price feed for top-10 stablecoins. Confidence interval widening can serve as an early depeg warning signal.
- **Limitation**: Coverage limited to ~11-15 stablecoins. Won't cover our long tail of 156.

#### RedStone Oracle API
- **Why**: Free HTTP API, no auth, excellent CF Worker compatibility, per-venue price breakdown is uniquely valuable.
- **Integration effort**: Low. Simple HTTP GET.
- **Use case**: Venue-level price analysis. When Binance shows USDC at $0.998 while Coinbase shows $1.001, that's an actionable signal. Could power a "price dispersion" metric for each stablecoin.
- **Limitation**: Undocumented rate limits are a risk. Coverage breadth needs verification for our full asset list.

### Tier 2: Worth Integrating

#### Curve REST API
- **Why**: Free, no auth, excellent stablecoin-to-stablecoin pool coverage, pool imbalance data.
- **Integration effort**: Low-medium. Response is large (~1.3MB for all pools), need to filter.
- **Use case**: Pool balance ratios as depeg indicators. When the 3pool shifts from 33/33/33 to 50/25/25, that signals DAI demand relative to USDC/USDT. crvUSD supply tracking.
- **Limitation**: Not a direct price feed. Requires interpretation of pool dynamics.

### Tier 3: Consider for Specific Use Cases

#### Uniswap v3 TWAP
- **Why**: Manipulation-resistant price reference.
- **Integration effort**: Medium-high. Requires RPC calls, TWAP math, pool selection.
- **Use case**: Cross-reference against spot prices. If spot price deviates significantly from 30-min TWAP, it could indicate manipulation or a genuine rapid depeg.
- **Limitation**: Stablecoin-to-stablecoin pool liquidity is lower than stablecoin/ETH pools. Only useful as a cross-reference signal, not primary data.

### Not Recommended for Pharos

- **Chainlink on-chain feeds**: 24h heartbeat makes them useless for stablecoin monitoring.
- **Chainlink Data Streams**: Enterprise pricing makes it cost-prohibitive for our use case.
- **Chronicle Protocol**: Whitelist gating and no HTTP API make integration impractical.
- **API3 Signed API**: Discovery friction and response format are not suited for price monitoring.
