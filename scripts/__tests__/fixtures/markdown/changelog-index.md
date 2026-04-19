---
title: "Changelog: What's New on Pharos"
canonical: "https://pharos.watch/changelog/"
description: "Weekly release notes for Pharos."
---

# Changelog

## 2026-04-13 to 2026-04-19

Pricing pipeline v5.0 lands, 40+ new risk-coverage entries across backstops/blacklist/reserves, and /funding launches.

- **Pricing pipeline v5.0**: Every fetcher returns FetcherOutcome for breaker discipline, Curve/Chainlink staleness guards tighten, upstream-observed timestamps propagate from Bitstamp/Coinbase/Curve, and no-candidate circuit recovery generalizes.
- **DEWS v5.95 contagion amplifier**: Cross-asset contagion amplifier (clamped [1.0, 1.2]) joins the DEWS blend, a backtest harness validates detection rate + lead time on curated anchors, and /api/stress-signals surfaces amplifier breakdown.
- **Mint-burn flows v6.0**: LayerZero/CCIP/CCTP bridges tag as bridge_transfer, atomic roundtrips require 0.5% tolerance, USDC and EURC get CCTP detection, and the Bank Run Gauge reweights by canonical-chain mcap rather than global supply.
- **Redemption backstops v3.98**: 14+ new issuer configs (BRLA, USDAT, BUCK, USDH, Silk, wM, ftUSD, USDz, USDSC, USDM, dEURO, CJPY, and more), capacity clamping to supply, fee-score breakpoints, and documented fail-closed fallbacks for falcon/frxusd.
- **Blacklist tracker v3.91 → v3.95**: 14+ new coins (FIDD, FRXUSD, XUSD, JPYC, USDA/USAT/AEUR, EURCV, NUSD, TUSD, USDP, USDQ, AID, TGBP). Tron ledger mirror, EURC mirror-zero suppression fix, and a new per-coin detail block with stats, chart, and event feed.
- **Reserves + Liquidity v5.4 + cron hygiene**: 10+ new reserve adapters (lisusd-lista, ebusd, mim-abracadabra, usdh, usdat-saturn, buck, buidl-chainlink-nav); Liquidity v5.4 pool dedupe + direct-CEX orderbook depth; cron retuned (reserves 1h→4h, blacklist 1h→6h).
- **Digest on Opus 4.7 + Telegram /status**: Daily digest streams from Opus 4.7 with week-over-week deltas, Momentum Candidates, forward-look cue, and opening/tone guards. Telegram adds /status <ticker>, snooze inline keyboard, and worsening-delta depeg triggers.
- **Detail-page UX remediation**: Detail hero consolidated with HeroSignalsRail (Safety/Peg/Liquidity/DEWS), full scrollspy nav coverage, shared Breadcrumb + expanded command palette, and home snapshot gets methodology tooltips + always-visible PSI deltas.

## 2026-04-05 to 2026-04-12

Infrastructure axis launches, PSI hero gets arc gauge and event timeline, and Liquidity Score v5.0 brings size-aware scoring.

- **Infrastructure axis**: New filter dimension lets users browse stablecoins by underlying protocol — Liquity v1/v2 and M0 tagged across 25 coins, replacing the deprecated protocol-lineage fields.
- **Stability intelligence**: PSI page ships an arc gauge hero with annotated crisis events from COVID Crash to BTC ATH, plus hardened non-USD depeg replay for BRZ, TRYB, and commodity pegs.
- **Safety Scores redesign**: Grade-grouped card grid, systemic risk headline, entrance animations, and v6.93 scoring with steeper peg multiplier and active-depeg grade cap.
- **Live reserves surge**: 10+ new adapters — Frax balance-sheet, Block Analitica for DAI/USDS, MIM cauldrons, eUSD, feUSD, Honey — push live reserve tracking to 126 coins.
- **Liquidity Score v5.0**: Size-aware scoring formulas, best-path exit model with diversification premium, and Uniswap V2/V4 split replace the v4 blend.
- **Broader coverage**: Seven new stablecoins (USDat, wM, USDnr, USDK, XO Cash, evaUSDC, evaUSDT) bring the dashboard to 194 tracked coins; RAI retired to the cemetery.
- **Navigation & pages**: Collapsible sidebar groups, two-column API reference with scrollspy, redesigned /telegram page, and changelog timeline with category tags.
- **Pipeline hardening**: Telegram rate-limit handling and HTML fixes, 100+ audit remediation fixes across four merge streams, blacklist v3.7 enrichment, and mint-burn D1 query batching.

## 2026-03-25 to 2026-04-04

Yield intelligence rebuilt from the ground up, API auth goes live, and a 100+ fix security audit lands.

- **Yield intelligence overhaul**: 10+ protocol-native adapters (Aave V3, Compound V3, Morpho, Pendle, Beefy, Yearn Kong), benchmark-aware scoring, coverage audits, and 365-day backfill charts
- **API key authentication**: Full auth gate on protected endpoints with key rotation, audit logging, dual-pepper hashing, and rate limiting
- **Broader stablecoin coverage**: CHFAU, trUSD, Base Dollar added; live reserves expanded for USDSC, satUSD, USDai, Anzen USDz, and Liquity v1 LUSD
- **Codebase hardening**: Comprehensive three-pillar audit remediation across security, reliability, and maintainability with 100+ targeted fixes
- **Richer risk surfaces**: Non-USD market share charts, blacklist status distribution, treasury stable exposure portfolio, and gold-peg support
- **Pipeline reliability**: Hardened pricing consensus, reserve sync, redemption backstops, depeg recovery, and cron orchestration
- **Status page upgrades**: Telegram delivery summary, degraded-first cache tables, circuit breaker visibility, and request-source attribution
- **Changelog page**: Weekly release notes page with editorial summaries and full commit history

## 2026-03-17 to 2026-03-24

Four new DEX APIs feed pricing consensus, Safety Score hits v6.0, and live reserves double to 114 coins.

- **Multi-DEX API integration**: Fluid, Balancer, Raydium, and Orca direct API fetchers with per-protocol price disaggregation into pricing consensus
- **Pricing source expansion**: Kraken, Bitstamp, Jupiter, and Chainlink added to consensus; tertiary FX fallback for multi-source outages
- **Redemption backstop coverage**: Expanded from 66 to 136 coins with BUIDL, NAV-based, AMM, and on-chain backstop configs plus fee accuracy fixes
- **Safety Score v6.0**: Custody tiers, mature-alt-L1 classification, 2-factor Resilience scoring, and custodyModel overrides for all remaining coins
- **Pre-launch module**: New /upcoming page with milestone tracking, Telegram launch alerts, pre-launch detail views, and curation skill
- **Live reserve expansion**: Coverage expanded from 54 to 114 coins with curated-validated adapters, display blocks, and risk validation
- **Design polish**: RegimeBar PSI indicator, confidence typography, chart tooltip standardization, table density toggle, and command palette history
- **Stablecoin additions**: DUSD, USSD, USBD added; all 174 AI editorial summaries rewritten; new collateral-as-dependency section on detail pages

## 2026-03-09 to 2026-03-16

Chain analytics and multi-source pricing launch alongside a major live-reserve and audit push.

- **Chain analytics launch**: New /chains/ leaderboard and per-chain profile pages with health scores, supply snapshots, and cross-linked stablecoin detail
- **Multi-source pricing**: N-source consensus module integrating Pyth, RedStone, Binance, Coinbase, Curve on-chain prices, and real-time FX rates
- **Live reserve expansion**: Five batches of reserve adapters (USDT, OUSD, Circle, GHO, Sky, Mento, crvUSD), live collateral scoring in report cards, and drift alerting
- **Deeper digest intelligence**: Weekly recap format, yield anomaly signals, DEX liquidity shifts, PSI trajectories, and Telegram pending queue for reliable delivery
- **Broader stablecoin coverage**: dUSD, CETES, Parallel USDp, thBILL added to tracking; CNHT, EURA, USDA moved to cemetery
- **Codebase hardening**: Two major audit remediation campaigns (38 tasks), Zod validation at system boundaries, timing-safe auth, and shared contract consolidation
- **Liquidity Score v4**: Log-scale volume, reworked durability formula, DexScreener and CG ticker fallback crawlers for broader pool coverage
- **Start Here onboarding**: New onboarding page, compare flow signals, stablecoin coverage matrix, and Telegram global alert subscriptions

## 2026-03-01 to 2026-03-08

Dynamic social cards, motion design overhaul, DEWS radar redesign, and mint/burn flows rebuilt on Alchemy.

- **Dynamic OG images**: Worker-generated social cards with Satori + resvg-wasm for stablecoin, safety, depeg, and PSI pages with one-click sharing
- **Homepage motion design**: Entrance choreography, animated counters, grade badge pop, chart draw-in, contagion ripple, and intelligence briefing module
- **DEWS radar redesign**: Inverted radar with animated sweep line, interactive coin dots, hover tooltips, and Telegram alerts for band transitions
- **Mint/burn flows overhaul**: Alchemy JSON-RPC migration, expanded to top-50 Ethereum coins, BRRRR deck hero, flow signals strip, and 30/90d net columns
- **Ticker-issuer ID migration**: Four-phase migration to canonical IDs across all stablecoins with portfolio migration, URL redirects, and DL remapping
- **Worker hardening**: Circuit breakers, AbortSignal cron timeouts, D1 retry logic, 160+ new tests, and degraded-mode pipeline handling
- **Expanded coverage**: USTB, OUSG, USCC, mTBILL, USD+, apxUSD, wsrUSD, ebUSD, USND, USDaf added to tracking with reserves and AI summaries
- **Methodology versioning**: Version tracking and changelogs surfaced for PSI, PegScore/DEWS, Liquidity Score, blacklist, and mint/burn flows
