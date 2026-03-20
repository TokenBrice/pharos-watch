# About Page

## Overview

The `/about/` route is the product overview for Pharos. It explains:

- why the project exists
- what the dashboard tracks directly
- what signals and scores it computes
- how the data pipeline is assembled
- where to find methodology, source code, and support channels

Primary implementation file:

- `src/app/about/page.tsx`

## Section Contract

The page is organized into these sections, in order:

1. `Why Pharos?`
2. `What Pharos Tracks`
3. `What Pharos Computes`
4. `Live Walkthrough`
5. `Classification`
6. `Data Pipeline`
7. `Methodology`
8. `Disclaimer`
9. `Get in Touch`

## Design And Interaction Rules

- The intro section keeps the contributor/logo strip above the copy until `lg` so mobile widths do not crush the text column.
- `What Pharos Tracks` and `What Pharos Computes` use full-row links instead of small linked headings. This preserves larger touch targets on mobile and reduces the repeated tile-grid feel.
- Standalone calls to action use outline buttons with `h-11` on mobile for 44px tap targets.
- Accent use is reduced to a small set of section tones:
  - brand / identity: frost-blue
  - coverage / data sourcing: amber
  - computed signals: emerald
  - governance classification: violet
  - neutral/legal: zinc
- The data pipeline section should stay flat. Use a source-group list plus a 3-step flow summary rather than nested card grids.

## Navigation Contract

- `Contagion Map` must link to `/dependency-map/`
- `Systemic Risk Scoreboard` remains linked to `/safety-scores/` because the stress-panel scoreboard lives on that route
- `Methodology`, broadcast, Telegram, GitHub, and contact actions are surfaced as explicit CTAs rather than buried inline links

## Content Notes

- The page is public-facing product copy, so internal workflow references should stay clear and non-novelty-first.
- When adding a new major data source or externally visible feature surfaced on this page, update this document and the route copy together.
- Supply/price sourcing now explicitly includes direct protocol redemption quotes for selected redeemable assets, alongside market-data sources, with current examples including Cap cUSD, infiniFi iUSD, and crvUSD. Primary pricing uses N-source consensus across CoinGecko, DefiLlama, Pyth Network oracles, Binance/Kraken/Bitstamp/Coinbase spot tickers, RedStone oracle, and Curve on-chain StableSwap prices, with Jupiter Price API available as a Solana fallback.
- Reserve-transparency sources now include issuer/protocol reserve APIs, dashboards, proof-of-reserve portals, and direct on-chain vault/accounting reads used for live reserve composition where available, with current examples including Ethena, Falcon, infiniFi, M0, Mento Reserve, OpenEden, Accountable, Tether, Frax, Circle, First Digital Labs, SG-FORGE, Paxos, Origin Protocol, Sky/MakerDAO, Chainlink PoR/NAV feeds, and Aave GHO.
- On-chain reads now include selected public chain RPC endpoints alongside Etherscan v2, TronGrid, Alchemy, and dRPC when a direct reserve probe needs chain-native access.
- The `Ratings & Reference` source group now explicitly includes Bluechip, Chainlink Data Feeds, Frankfurter, Open Exchange Rates, `fawazahmed0/exchange-api`, ExchangeRate-API, gold-api.com, and FRED DGS3MO. Keep this list aligned with `DATA_SOURCE_GROUPS` in `src/app/about/page.tsx` when the FX or benchmark stack changes.
- The DEX data source group reflects the live liquidity pipeline: DeFiLlama Yields and DeFiLlama Protocols alongside Curve Finance API, The Graph, Fluid API + DexReservesResolver, Balancer API, Raydium API, Orca API, GeckoTerminal, and DexScreener.
