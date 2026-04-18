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

## Route Shell Contract

The route shell is owned directly by `src/app/about/page.tsx`.

- `metadata` sets the canonical path `/about/` plus route-specific title/description/Open Graph fields
- the page renders through `FeaturePageShell` with `breadcrumbName="About Pharos"`, `path="/about/"`, title `About Pharos`, and a single lead paragraph
- `headerSupplement` renders `AboutReferenceModule` immediately below the title/lead with five reference cards derived from `NAV_GROUPS.info` excluding `/about`: `/methodology/`, `/coverage/`, `/about/api/`, `/status/`, and `/changelog/`
- the shell's `preface` injects FAQ JSON-LD describing why Pharos exists, what it tracks, how it classifies coins, and where the data comes from

## Section Contract

The page is organized into these sections, in order:

1. `Why Pharos?`
2. `Who Is Building Pharos?`
3. `Live Walkthrough`
4. `What Pharos Tracks`
5. `What Pharos Computes`
6. `Classification`
7. `Data Pipeline`
8. `Methodology`
9. `Disclaimer` (rendered as an `<aside>`, not a titled `AboutSection`)
10. `Get in Touch`

## Design And Interaction Rules

- The dedicated `Who Is Building Pharos?` section uses `lg:grid-cols-[auto_minmax(0,1fr)]` to place the contributor/logo strip beside the copy on `lg+`, stacking vertically below `lg` so the text column does not get crushed.
- `What Pharos Tracks` and `What Pharos Computes` use full-row links instead of small linked headings. This preserves larger touch targets on mobile and reduces the repeated tile-grid feel.
- CTA buttons keep `min-h-11` on mobile so the tap target does not collapse below the 44px floor.
- Accent use is reduced to a small set of section tones:
  - brand / identity: frost-blue
  - coverage / data sourcing: amber
  - computed signals: emerald
  - governance classification: violet
  - neutral/legal: zinc
- The data pipeline section should stay flat. Use a source-group list plus a 3-step flow summary rather than nested card grids.

## Navigation Contract

- `/about/` remains a top-level route, and primary navigation places it first in the `Reference` group (`NAV_GROUPS.info`).
- `/about/` is now the reference hub for low-frequency explainer surfaces. `Methodology`, `Coverage`, API Reference, Status, and Changelog are grouped around it in the reference module. `Start Here` is not part of the About reference module; it remains the conditional bottom-nav shortcut and footer link.
- `Peg Tracker` must link to `/depeg/`, because the dedicated depeg route owns the heatmap and depeg-history surface
- `Contagion Map` must link to `/dependency-map/`
- `Systemic Risk Scoreboard` remains linked to `/safety-scores/` because the stress-panel scoreboard lives on that route
- `Methodology`, broadcast, Telegram, GitHub, and profile links are surfaced as explicit CTAs rather than buried inline links

## Content Notes

- The page is public-facing product copy, so internal workflow references should stay clear and non-novelty-first.
- The `Get in Touch` copy describes Pharos as MIT-licensed open source and links to the GitHub repository.
- When adding a new major data source or externally visible feature surfaced on this page, update this document and the route copy together.
- Supply/price sourcing now explicitly includes direct protocol redemption quotes for selected redeemable assets, alongside market-data sources, with current examples including Cap cUSD and infiniFi iUSD. Primary pricing uses N-source consensus across CoinGecko, DefiLlama, Pyth Network oracles, Binance/Kraken/Bitstamp/Coinbase spot tickers, RedStone oracle, and Curve on-chain StableSwap prices, with Jupiter Price API available as a Solana fallback. For tracked DefiLlama-backed assets whose known deployments are missing from DefiLlama chain coverage, CoinGecko also repairs the total supply / market-cap buckets so multichain issuer supply is not understated.
- Reserve-transparency sources now include issuer/protocol reserve APIs, dashboards, proof-of-reserve portals, and direct on-chain vault/accounting reads used for live reserve composition where available, with current examples including Anzen, Ethena, Falcon, Frankencoin, Hashnote, infiniFi, M0, Mento Reserve, OpenEden, Re, USDD, USD.AI, USD1 Chainlink bundle oracle, Accountable, Tether, Frax, Circle, First Digital Labs, SG-FORGE, Paxos, Sky/MakerDAO, Chainlink PoR/NAV oracles, Aave GHO, f(x), Asymmetry, JupUSD, USDGO, Solstice, River, and Curve/Yield Basis reserve reads.
- On-chain reads now include selected public EVM and Solana RPC endpoints, Etherscan v2, TronGrid, Alchemy, and dRPC when a direct reserve or supply probe needs chain-native access, including Frankencoin's ZCHF -> VCHF StablecoinBridge balance read for redemption-capacity telemetry and Solana mint-supply validation for live reserve coverage.
- The `Ratings & Reference` source group now explicitly includes Bluechip, Chainlink Data Feeds, Frankfurter, Open Exchange Rates, `fawazahmed0/currency-api`, ExchangeRate-API, gold-api.com, FRED `DGS3MO`, the ECB Data API for 3M compounded €STR, and SIX delayed SARON compound-rate downloads via public guest access. Keep this list aligned with `DATA_SOURCE_GROUPS` in `src/app/about/page.tsx` when the FX or benchmark stack changes.
- The DEX data source group reflects the live liquidity and yield pipeline: DeFiLlama Yields and DeFiLlama Protocols, protocol-native yield APIs (Hashnote, Ondo, Morpho, Pendle, Yearn Kong, Beefy, Aave V3, Compound V3, BIMA Earn), alongside Curve Finance API, The Graph, Fluid API + DexReservesResolver, Balancer API, Raydium API, Orca API, Meteora API, PancakeSwap subgraphs, Aerodrome and Velodrome Sugar view contracts, GeckoTerminal, and DexScreener. Dead or deprecated DEX slugs such as Bunni are actively blocked from runtime pricing and liquidity inputs rather than treated as live venues.
- PSI copy should describe the current 30-minute cadence and the live formula inputs: active-depeg severity, market-cap breadth, DEWS stress breadth, and 7-day market-cap trend.
