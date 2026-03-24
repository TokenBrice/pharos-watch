# DEX API Coverage Assessment

Date: 2026-03-24

## Scope

- Compared Pharos's current liquidity-source set against the current top-50 DEX protocols by 24h volume from DefiLlama's `overview/dexs` endpoint.
- Focused on additions that would improve **stablecoin liquidity coverage quality**, not just generic market coverage.
- Prioritized protocol-native sources that can replace or outrank lower-confidence fallback sources (`CG onchain`, `GeckoTerminal`, `DexScreener`, `CG tickers`).

## Current Pharos Liquidity Source Set

Primary / scoring-grade sources already in use:

- DeFiLlama Yields API
- DeFiLlama Protocols API
- Curve API
- Uniswap V3 subgraphs: Ethereum, Base, Arbitrum, Polygon
- Aerodrome subgraph: Base
- Fluid direct API
- Balancer direct API
- Raydium direct API
- Orca direct API

Discovery / fallback sources already in use:

- CoinGecko Onchain
- GeckoTerminal
- DexScreener
- CoinGecko tickers

Important current gaps from code:

- `worker/src/cron/dex-liquidity/constants.ts` only defines `UNIV3_SUBGRAPHS`; there is no native Uniswap v4 source.
- Aerodrome integration is a `pairs`-style subgraph query (`reserveUSD`, `isStable`), which strongly suggests Solidly pools only, not Slipstream concentrated liquidity.
- No native PancakeSwap source.
- No native Meteora source.
- No native Tron DEX source.
- No native LFJ / Trader Joe source.
- No native Ekubo source.

## High-Signal Top-50 Protocols

From DefiLlama top-50 by 24h volume on 2026-03-24, the most relevant protocols for Pharos are:

- Already covered natively: Uniswap V3, Curve, Fluid, Orca, Raydium, Balancer
- Important gaps with viable API paths: PancakeSwap AMM V3, PancakeSwap AMM, Meteora DLMM, Ekubo, Joe V2.2
- Important gaps but weaker/unclear API fit: Aerodrome Slipstream, Velodrome V3, SUNSwap V3, Cetus CLMM
- Low-value for Pharos liquidity scoring despite high volume: Kalshi, Polymarket, Hyperliquid Spot Orderbook, pump.fun, PumpSwap, LaunchLab, four.meme

## Candidate Assessment

### 1. Meteora DLMM

Status: **Should add**

Why:

- Top-50 by live volume and materially relevant on Solana, where Pharos tracks many stablecoin pools.
- Current Solana primary sources are only Raydium + Orca; Meteora is a meaningful missing leg.
- Public API exists and exposes the fields we need for liquidity scoring.

Evidence:

- Meteora docs expose a DLMM API schema.
- Live API sample from `https://dlmm.datapi.meteora.ag/pools?page=1&limit=1` includes:
  - `token_x`, `token_y`
  - `token_x_amount`, `token_y_amount`
  - `current_price`
  - `tvl`
  - `volume`
  - `fees`

Fit:

- High. This looks very similar to the current Raydium/Orca adapters.
- Likely the cleanest next direct integration.

Priority: **P1**

### 2. PancakeSwap (V3 first, then StableSwap / V2, then Infinity if needed)

Status: **Should add**

Why:

- Very large live volume.
- Strong stablecoin relevance on BSC, plus some Base / Arbitrum / Ethereum presence.
- Pharos currently relies on indirect discovery for Pancake pools even though BSC is a major stablecoin venue.

Evidence:

- PancakeSwap developer docs publish official subgraph endpoints for:
  - Exchange v3
  - Exchange v2
  - StableSwap
- Docs list per-chain endpoints for BSC, Ethereum, Arbitrum, Base, zkSync Era, Linea, Polygon zkEVM, opBNB.

Fit:

- High for V3 and StableSwap.
- Likely easiest to implement as another subgraph family, similar to existing Uni v3 ingestion.
- Biggest business value is probably BSC stablecoin coverage.

Priority: **P1**

### 3. Aerodrome Slipstream / Velodrome V3

Status: **Probably should add, but API path needs validation**

Why:

- Aerodrome Slipstream is top-10 by live volume.
- Velodrome V3 is also in the top-50.
- Current Aerodrome query shape looks legacy-pair oriented, not concentrated-liquidity oriented.

Evidence:

- Local code currently queries `pairs { reserveUSD token0Price token1Price isStable }`, which is not a concentrated-liquidity model.
- No official source was confirmed during this pass for a clean public Slipstream/V3 API or subgraph doc.

Fit:

- Potentially high, especially for Base and OP.
- But this needs one more research pass to confirm the right source before implementation.

Priority: **P2**

### 4. LFJ / Joe V2.2

Status: **Could add**

Why:

- Top-50 by live volume.
- Relevant for Avalanche stablecoin venues.
- Official DEX API exists and exposes strong pool-level fields.

Evidence:

- LFJ developer docs expose:
  - `GET https://api.lfj.dev/v1/pools/{chain}`
  - `GET https://api.lfj.dev/v1/pools/{chain}/{address}`
- Response shape includes:
  - `reserveX`, `reserveY`
  - `liquidityUsd`
  - `volumeUsd`
  - `feesUsd`
  - token metadata
- API key is required.

Fit:

- Good technically.
- Slightly worse operationally because it introduces another keyed provider.

Priority: **P2**

### 5. Ekubo

Status: **Could add**

Why:

- Top-50 by live volume.
- Relevant for Starknet stablecoin coverage, where Pharos has less primary-grade DEX coverage today.
- Official API is public and documented.

Evidence:

- Ekubo docs expose a public API at `https://prod-api.ekubo.org`.
- OpenAPI includes pool- and liquidity-related endpoints such as:
  - `/overview/pairs`
  - `/pair/{chainId}/{tokenA}/{tokenB}/pools`
  - `/pools/{chainId}/{coreAddress}/{poolId}/liquidity`
  - `/tokens/{chainId}/{tokenA}/{tokenB}/liquidity`

Fit:

- Good, but probably lower absolute coverage impact than Pancake or Meteora.

Priority: **P2**

### 6. SUNSwap V3

Status: **Not recommended yet**

Why:

- Tron stablecoin liquidity matters.
- But the documented public API does not appear rich enough for Pharos's scoring model.

Evidence:

- `https://openapi.sun.io/v2/allpairs?...` returns:
  - token IDs/symbols
  - `price`
  - `base_volume`
  - `quote_volume`
- It does **not** expose TVL, reserves, or depth.

Fit:

- Weak for liquidity scoring.
- Could help for price discovery, but not for the main liquidity feature.

Priority: **P3**

### 7. Cetus CLMM

Status: **Not recommended yet**

Why:

- Top-50 by live volume and relevant on Sui/Aptos.
- But this pass did not confirm a clean public REST API comparable to the sources above.

Fit:

- Would likely require SDK or indexer work rather than a simple fetcher.

Priority: **P3**

## Recommendation

Recommended implementation order:

1. Meteora DLMM
2. PancakeSwap V3 + StableSwap on BSC-first
3. Validate and add Aerodrome Slipstream / Velodrome V3 source
4. LFJ / Joe V2.2
5. Ekubo

Do not prioritize right now:

- SUNSwap V3
- Cetus CLMM
- prediction/orderbook venues
- memecoin launch DEXs

## Practical Impact

What would most improve Pharos coverage quality:

- **Meteora**: fills a real Solana stablecoin gap not covered by Raydium/Orca
- **PancakeSwap**: upgrades BSC stablecoin coverage from mostly indirect/fallback to protocol-native
- **Slipstream / Velodrome V3**: closes a likely Base/OP concentrated-liquidity blind spot

What would improve coverage breadth but with lower ROI:

- **LFJ / Joe**: useful for Avalanche, but smaller footprint than Pancake/Meteora
- **Ekubo**: useful for Starknet, but narrower ecosystem impact
