# Stablecoin Registry Provenance Notes

This file preserves maintainer comments removed when the tracked stablecoin registry moved from executable TypeScript arrays to JSON assets.

Historical-reference note:

- section headers such as `usd-major.ts` and `usd-minor.ts` refer to the retired pre-JSON registry files those comments originally lived in
- line numbers below are archival anchors into that historical TypeScript registry, not guaranteed positions inside the current JSON assets
- current canonical registry data lives under `shared/data/stablecoins/*.json`

## usd-major.ts
- Line 296: Source: BitGo monthly attestation reports (AICPA criteria). Exact % not published; estimated from collateral description.
- Line 383: Source: Paxos KPMG Feb 2025 attestation ($744.6M repos, $25.6M cash of $770.1M total)
- Line 429: Source: Falcon Finance transparency dashboard + DWF Labs research (Sep 2025). Approximate from published $ amounts.
- Line 456: Source: Hashnote/Circle SDYF docs + Nansen analysis. Fund invests exclusively in T-bills and reverse repos.
- Line 494: Source: Paxos/Enrome LLP monthly attestation (ISCA standards). Exact % not published; estimated from collateral description.
- Line 501: ── Rank 11-20 ───────────────────────────────────────────────────────
- Line 519: Source: BPM LLP / Deloitte attestation (Dec 2024 breakdown: ~36% T-bills, ~36% MMF, ~28% cash). NYDFS-regulated.
- Line 556: Source: Ondo Finance docs + Ankura Trust daily reports. Ondo targets 99%+ Treasuries; 104% overcollateralized.
- Line 602: Source: BlackRock/Securitize prospectus. 100% in cash, T-bills, and repos. Exact % not disclosed; estimated for money market fund.
- Line 646: Source: Messari Jan 2026, Stablewatch late 2025. Confidence: Medium
- Line 687: Source: Ethena docs, The Block, CoinDesk Mar 2025. Confidence: High
- Line 692: No CoinGecko listing (verified 2026-03-14). CG only lists WrappedM (wM). Priced via DL contract fallback.
- Line 732: Source: m0.org FAQ, Chainlink integration Jan 2026. Confidence: High
- Line 752: Source: GlobeNewsWire Dec 2025 launch announcement. Confidence: Low
- Line 781: Source: The Defiant Feb 19 2026 (DefiLlama breakdown), USD.AI Dec 18 2025 PYUSD integration. Confidence: Medium
- Line 808: Source: Usual docs, RWA.xyz, ChainArgos Feb 2026. Confidence: Medium
- Line 891: Source: Aave V3 Ethereum market data, Eco.com GHO guide, Chaos Labs risk dashboard
- Line 923: Source: Protos investigation, SEC settlement, Moore HK attestation. Confidence: Medium
- Line 973: Source: First Digital Labs transparency, Prescient Jan 31, 2026. Confidence: High
- Line 997: Source: Cap docs, Aave blog, blocmates Jan 2026. Confidence: Low
- Line 1032: Source: Resolv docs, Coin Bureau, Binance Academy Q4 2025. Confidence: Medium
- Line 1058: Source: Figure Certificate Co. prospectus (SEC), KPMG Q1 2025. Confidence: High
- Line 1107: Source: Curve Finance crvUSD Mint Markets UI (Feb 2026). Based on Mint Markets TVL breakdown.
- Line 1133: Source: Solstice docs, StablecoinInsider Sep-Dec 2025. Confidence: Medium
- Line 1139: ── Rank 31-40 ───────────────────────────────────────────────────────
- Line 1165: Source: Avalon docs, Decrypt, Wu Blockchain late 2024-2025. Confidence: Low
- Line 1179: USDD liveReservesConfig now uses app-api.usdd.io `latest-collateral` + `collateral-history` for the Tron collateral mix shown on `usdd.io/data`.
## usd-minor.ts
- Line 7: Binance Peg BUSD (id 153) removed — BUSD discontinued (see cemetery)
- Line 46: Source: LlamaRisk Jul 2025, Chaos Labs, Frax docs. Confidence: Medium
- Line 78: Source: Inverse Finance transparency, DefiLlama Feb 2026. Confidence: Medium
- Line 118: Source: Agora product page, RWA.xyz, PwC attestation. Confidence: Medium
- Line 158: Source: stats.infinifi.xyz, Mar 2026. Confidence: High
- Line 189: Source: Aster docs, Coin Bureau, IQ.wiki 2025. Confidence: High
- Line 195: FLEXUSD (id 21) removed — CoinFLEX exchange bankruptcy June 2022 (see cemetery)
- Line 334: No CoinGecko listing (verified 2026-03-14). Priced via DL fallback.
- Line 502: ── Rank 51-60 ───────────────────────────────────────────────────────
- Line 576: DEUSD removed — collapsed Nov 2025 when Stream Finance failed
- Line 686: BUSD (id 4) removed — regulatory shutdown Feb 2023 (see cemetery)
- Line 827: ── Rank 71-80 ───────────────────────────────────────────────────────
- Line 1120: Source: live reserve sync (api.aladdin.club/api1/get_fx_tvl), March 2026. Confidence: High
- Line 1162: ── Rank 81-90 ───────────────────────────────────────────────────────
- Line 1405: ── Rank 91-100 ──────────────────────────────────────────────────────
- Line 1540: USD+ (id 46) removed — protocol abandoned 2025 (see cemetery)
- Line 1541: FUSD removed — Fantom USD de-pegged 2022, zombie stablecoin (see cemetery)
- Line 1715: ── Additional tracked ─────────────────────────────────────────────
- Line 2305: liveReservesConfig disabled 2026-03-15: Origin Protocol deprecated the
- Line 2306: /api/v2/ousd/collateral endpoint (returns 404). Re-enable when a
- Line 2307: replacement API is available.
- Line 2387: No CoinGecko listing (verified 2026-03-14). Different project from "USDu" by Unitas Labs. Priced via DL fallback.
- Line 2412: Supply ~$2.14M (Mar 2026) — below $5M soft threshold, but native stablecoin of Sonic ecosystem (strategic importance)
- Line 2448: ── dTRINITY ──────────────────────────────────────────────────────
- Line 2518: ── Tokenized treasury / RWA fund tokens ──────────────────────────
- Line 2584: Source: Ondo Finance docs + Arbitrum STEP application. Migrated from SHV ETF to BUIDL in March 2024.
- Line 2589: OUSG oracle (0x9Cad45...) has access-restricted getPrice() — reverts for non-whitelisted callers.
- Line 2590: liveReservesConfig disabled until Ondo opens public oracle access.
- Line 2794: syrupUSDC holds USDC-denominated loan receivables; BTC/ETH/crypto is collateral securing those loans, not the underlying asset
- Line 2842: syrupUSDT holds USDT-denominated loan receivables; BTC/ETH/crypto is collateral securing those loans, not the underlying asset
- Line 2865: Snapshot: 2026-02-28. Allocation rebalances dynamically across 50+ pools.
- Line 2917: Illustrative example allocation from https://docs.apyx.fi/solution-overview/example-collateral-allocation
- Line 2918: Actual composition rebalances dynamically. No live per-asset breakdown is publicly available.
- Line 2927: ── Pre-Launch ──────────────────────────────────────────────────────
## non-usd.ts
- Line 8: ── Rank 21-30 ───────────────────────────────────────────────────────
- Line 25: Source: Elliptic blog, Crystal Intelligence 2025-2026. Confidence: Medium
- Line 29: USDN (id 12) removed — algorithmic death spiral Apr 2022 (see cemetery)
- Line 62: Source: Circle transparency page Feb 23, 2026. Confidence: High
- Line 68: ── Rank 41-50 ───────────────────────────────────────────────────────
- Line 111: ── Rank 61-70 ───────────────────────────────────────────────────────
- Line 148: USP (id 97) removed — Platypus exploited in 2023, protocol defunct (see cemetery)
- Line 284: ── Additional non-USD pegs ────────────────────────────────────────
- Line 423: ── Additional EUR-pegged ────────────────────────────────────────────
- Line 424: EURT removed — discontinued by Tether
- Line 469: PAR (id 56) removed — abandoned by Mimo Protocol, pivoted to KUMA (see cemetery)
- Line 470: IBEUR removed — liquidity drain Dec 2023 (see cemetery)
- Line 471: EUROe (id 98) removed — acquired by Paxos, wound down May 2025 (see cemetery)
- Line 502: FPI reserve view now uses curated 100% FRAX backing from Frax CPI-peg docs (maintained 100% collateral ratio against FRAX).
- Line 633: ── Additional CHF-pegged ────────────────────────────────────────────
- Line 654: ── GBP-pegged ───────────────────────────────────────────────────────
- Line 691: ── Additional non-USD/non-EUR pegs ──────────────────────────────────
- Line 729: ── CAD / CNY / CNH / PHP / MXN / UAH / ARS pegs ─────────────────────
- Line 730: ISC reserve view now uses the issuer's published five-bucket RWA basket framing (gold, bonds, T-bills, equity, cash) instead of the generic template fallback.
- Line 799: Option A: ERC-20 total-supply probe on Base confirms on-chain liveness.
- Line 800: Option C (future): custom etherfuse adapter against their reserves API
- Line 801: once Etherfuse publishes a public JSON endpoint for reserve composition.
- Line 815: ── Pre-Launch ──────────────────────────────────────────────────────
## commodity.ts
- Line 7: ── Gold-Pegged (not in DefiLlama stablecoins API — data via DefiLlama coins/protocol APIs) ──
- Line 8: commodityOunces: troy ounces per token (used for peg deviation normalization)
- Line 98: gold-vro (VeraOne VRO) removed — too small, unreliable supply data
- Line 169: ── Silver-Pegged (data via DefiLlama coins API) ──────────────────────
- Line 190: ── Pre-Launch ──────────────────────────────────────────────────────
