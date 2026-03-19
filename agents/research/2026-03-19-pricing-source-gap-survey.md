# Pricing Source Gap Survey

Date: 2026-03-19

Question:
- Which free or effectively free data sources should Pharos add next to improve price accuracy and coverage?

## Summary

The strongest next additions are not more generic aggregators. The biggest remaining gains come from:

1. more independent CEX venue reads,
2. more Solana-native liquidity coverage,
3. stronger oracle/reference inputs for non-USD and commodity validation.

## Priority Recommendations

### 1. Chainlink Data Feeds

Why:
- strongest missing independent oracle family for major stablecoins, FX pairs, and commodity references,
- especially valuable for non-USD pegs and gold/silver references where the current live path still leans on daily ECB data and gold-api spot.

Best use in Pharos:
- validation / corroboration voice, not sole source of truth,
- first for FX and commodity references,
- then for major stablecoin USD feeds where coverage exists.

Strengths:
- decentralized oracle design,
- good complement to Pyth and RedStone,
- can strengthen both primary consensus and reference-rate validation.

Caveat:
- integration is on-chain / RPC based rather than a simple HTTP JSON API,
- feed coverage is uneven across the full long tail.

Priority: High

### 2. Kraken Public Ticker API

Why:
- strong independent venue for USD and fiat stablecoin pairs,
- materially improves venue diversity beyond Binance + Coinbase,
- especially useful for major assets and non-USD reference pairs.

Best use in Pharos:
- add as another direct CEX voice in primary consensus,
- use for majors first (`USDT`, `USDC`, `DAI`, `EURC` / `EUROC`, `PYUSD`, precious-metals pairs where listed).

Strengths:
- free public REST endpoint,
- good liquidity for stablecoin-fiat markets,
- easy Worker integration.

Priority: High

### 3. Meteora DLMM / DAMM APIs

Why:
- the clearest remaining Solana liquidity gap after Raydium + Orca,
- large pool surface and official paginated pool endpoints,
- likely the highest-value missing DEX venue for Solana stablecoin depth.

Best use in Pharos:
- direct DEX-liquidity integration alongside Raydium and Orca,
- DEX price observations plus liquidity scoring,
- not as a standalone authoritative primary-price source.

Strengths:
- official docs expose paginated pool/state endpoints,
- 30 RPS documented rate limit,
- strong complement to existing Solana coverage.

Priority: High

### 4. Bitstamp Public Ticker API

Why:
- easy additional fiat/CEX venue with simple public endpoints,
- good low-effort diversification for major pairs.

Best use in Pharos:
- add as a lighter-weight CEX corroboration source after Kraken,
- do not overweight it relative to Binance/Coinbase/Kraken.

Priority: Medium

### 5. Jupiter Price API V3

Why:
- Jupiter sees a broad Solana routing surface and already exposes heuristics-based USD pricing,
- useful for Solana long-tail coverage where raw pool coverage is still incomplete.

Best use in Pharos:
- soft corroboration or fallback only,
- not a hard primary source because it is itself an aggregated heuristic price.

Strengths:
- very easy HTTP integration,
- broad Solana token coverage,
- explicit liquidity/recency heuristics in the product design.

Caveat:
- this is an aggregator, not a raw venue price,
- should not be allowed to create fake independence against other Solana aggregators.

Priority: Medium

## Not Recommended as Immediate Next Adds

1. another generic aggregator equivalent to CoinGecko / DefiLlama
   - low marginal independence

2. exchange-rate providers that are merely thin wrappers over the same daily ECB data
   - low incremental value for intraday depeg decisions

3. partially documented subgraph endpoints that depend on account-specific gateway keys
   - operationally fragile compared with official public APIs

## Suggested Rollout Order

1. Kraken
2. Meteora
3. Chainlink reference feeds
4. Bitstamp
5. Jupiter Price V3 as fallback-grade Solana corroboration

## Source Notes

Live probes performed in this pass:
- Jupiter `price/v3` returned current USDC Solana pricing plus liquidity / recency fields.
- Meteora DLMM API returned paginated pool metadata successfully.
- Kraken public ticker returned live `USDCUSD` and `USDTUSD`.
- Bitstamp public ticker returned live `usdtusd`.

Official docs reviewed:
- Jupiter developer docs
- Meteora DLMM API docs
- Kraken REST API docs
- Frankfurter docs
- Chainlink developer docs
