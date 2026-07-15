---
title: "Changelog: What's New on Pharos"
canonical: "https://pharos.watch/changelog/"
description: "Weekly release notes for Pharos."
---

# Changelog

## 2026-07-13 to 2026-07-15

USD3 joins coverage, exact liquidity evidence expands, and yield filters show every qualifying result.

- **USD3 coverage**: USD3 joins active tracking as a NAV-bearing senior-credit asset, with sourced issuer, reserve, mint, yield, redemption, and Ethereum flow coverage.
- **Exact pool models**: Exact StableSwap simulations now cover Curve and hook-free Balancer pools, turning eligible pool evidence into more precise exit-liquidity capacity estimates.
- **Resolved exit routes**: Reviewed redemption rails now identify their concrete output assets, allowing eligible routes to resolve, value their exit capacity, and contribute evidence without guessing.
- **Corrected depeg history**: A reviewed cNGN recovery event now links to its canonical incident, keeping the public depeg timeline aligned with the underlying market record.
- **Yield result completeness**: Yield rankings now retain every opportunity that passes selected filters, making the displayed opportunity set match the user's chosen criteria.

## 2026-07-06 to 2026-07-12

The coin page completes its redesign, PharosWatchBot adds personalized daily recaps, and ~$189B of reserves go live.

- **Coverage & lifecycle**: Western Union's USDPT is promoted from pre-launch to active tracking, GYEN freezes after GMO's wind-down, the cemetery archives confirmed wind-downs, 76 AI summaries refresh, and depeg pages become a permanent archive.
- **Live reserve coverage**: Live reserve adapters land for USDT and XAUt (~$186B), Spiko, USDtb, United's U, and PUSD, and redemption methodology v4.17 adds live-direct capacity telemetry for USTB and the 13-coin Mento family.
- **Personalized daily recaps**: PharosWatchBot gains opt-in personalized daily recaps — planned, delivered, and cleaned up durably per chat — with settings controls, a rollout kill switch, operator telemetry, and a privacy disclosure.
- **Truthful bot delivery**: Delivery preserves opt-outs across chat migrations, applies presets atomically, serializes per-chat sends, and pauses during outages; ingress is bounded, logs stay aggregate-only, adoption is measured without tracking.
- **Yield decision workbench**: The yield workbench moves to summary rankings with a complete decision and comparison workflow, and yield v8.32 scores external opportunities at the market level while preserving opportunity risk end to end.
- **Routed operator workspaces**: The single-page admin dashboard splits into eight routed workspaces — Triage, Pipeline, Reliability, Crons, Actions, Comms, History, and API Management — with guarded replay-safe actions and durable audit history.
- **Coin page & bot hero**: The stablecoin detail page completes its Figma template — pill-tab nav, hero KPI band, xl right rail, Sources modal — and the PharosWatchBot page gets a benefits-led signal-board hero with a lighthouse watch beam.
- **Pipeline correctness**: A worker-wide remediation adds durable operations schemas, effect fencing, and exact publication generations so partial data cannot publish as complete, and a sweep resolves 33 numbered issue reports across the stack.

## 2026-06-29 to 2026-07-05

The redesigned homepage canon now spans every nav group, a vaults.fyi yield source lands, and kUSD joins pre-launch.

- **Site-wide design canon**: Every nav group — Markets, Risk, Learn, Reference, Analyze — and the coin detail template adopt the redesigned homepage canon: new hero surfaces, flat cards, the Whyte display face, and sidebar remnants removed.
- **Tablet table workbench**: Tablets now get the full data-table workbench via a new lg breakpoint and auto-fit column priority (useFittedColumns plus a fit toggle), with widened overview columns and fixed header-glyph and price overflow.
- **Yield intelligence**: A new optional vaults.fyi yield source lands with structured logging and rollout guardrails, and venue risk scores are recalibrated against Yearn’s published reports in yield methodology v8.298.
- **Coverage & data**: kUSD and Open USD join the pre-launch board, tGLD gains a Euler/JPEG partnership milestone, frozen stablecoins are fully retired from runtime, redemption, and cemetery surfaces, and verified metadata corrections land.
- **Pipeline hardening**: Worker hardening bounds idempotency reservations, cron leases, and slot timeouts, splits DDR repair debt from cron health, adds append-only D1 retention with queued destructive cleanup, and steadies Telegram failover.
- **Faster merge gate**: The local merge gate splits into per-root vitest projects, overlaps pages-release with validation, and adds telemetry, artifact-skip, and parallel a11y/smoke to cut wall-clock, with glob-safe coverage includes.
- **Codebase simplification**: A large dead-code and duplication sweep across worker, frontend, and shared libraries removes orphaned exports and components, unifies helpers for medians, percentiles, dates, and CSV, and trims bundle and hot-path work.

## 2026-06-22 to 2026-06-28

A redesigned homepage and global top-nav with a new Whyte typeface, plus a worker-hardening rollout and reserve work.

- **Homepage & nav redesign**: A global top-nav replaces the retired sidebar and the homepage is rebuilt around a dashboard workbench with compact tables and a tighter Market Pulse, set in a new Whyte display typeface with flat, unified card shells.
- **Worker hardening rollout**: A structural worker-hardening rollout adds a job-attempt ledger and gated repair runner, per-provider execution budgets, tighter cron-lease observability, and a status page exposing canary counts and dependency health.
- **Reserve feed integrity**: The usdo-openeden live feed is suspended after its issuer gateway blocked Worker egress, falling back to curated data; a stale AZND source is removed and live-reserve finalization is bounded under the cron cap.
- **Exit liquidity & redemption**: Tier 1+2 redemption-backstop confidence upgrades land, Morpho and Yearn V3 vaults gain exit-capacity telemetry, and inactive DEX pools are excluded from global liquidity scoring so depth reflects only live venues.
- **Benchmark & price resilience**: The GBP SONIA benchmark fails over to the FRED IUDZOS2 mirror with an ALFRED fallback, USD EFFR source order is hardened, and backfill and mint-burn heal stale commodity prices and null amounts from history.
- **Methodology & data corrections**: A scoring-weighted doc-vs-code audit corrects drift across the corpus, sUSD is frozen for SIP-423, AUSD and msUSD reserve summaries are fixed, and the pre-launch board refreshes with trUSD's live mainnet contracts.

## 2026-06-15 to 2026-06-21

Yield gains a Yearn-style venue-risk rubric (61 venues), Telegram adds reserve-drift alerts, and case studies reach 24.

- **Yield venue-risk rubric**: A Yearn-style 5-category venue-risk rubric lands in the Protected Yield Score, growing the scored-venue registry from 12 to 61. Source-risk cards, confidence flags, and concentration chips surface it across yield views.
- **Telegram alerting overhaul**: The bot becomes a real alerting surface: a reserve-drift alert family with mini-app, watchlist export/import, 24h net mint/burn on /status, durable /pause, and per-coin muting, atop a deep rate-limit and opt-out pass.
- **Case studies & learn hub**: The case-study archive more than doubles from 11 to 24 retrospectives, each with social cards and timelines, now surfaced on mechanism, cemetery, and glossary pages. A content-rich /learn hub ties the surfaces together.
- **Depeg engine hardening**: The depeg resolver and DEWS early-warning engine (v6.09) harden against stale and mixed-freshness rows: monotonic watermarks, bounded incident adoption, and DDRR scoring that waits for terminal evidence before recovery.
- **Coverage & pricing**: Smokehouse USDC joins the tracked set and bbqUSDC gains NAV, yield, and redemption routing. Resupply gains live redemption-capacity telemetry, and supplemental pricing adds exact-contract sources with stricter freshness.
- **Security hardening**: A security pass redacts provider URLs from worker logs, hardens phishing-signature extraction and supplemental price freshness, passes Access credentials to the release marker, and rejects future-dated price data.
- **Reliability & code health**: Worker pipelines stop persisting aborted mint/burn and digest writes and bound yield-history reads. A broad refactor sweep dedups helpers and clears dead code across worker, frontend, scripts, and tests.

## 2026-06-07 to 2026-06-14

Safety Score v8.0 folds in mint authority, report cards score chain and oracle risk, and a depeg control board ships.

- **Safety Score v8.0**: Mint authority joins the Decentralization factor as a penalty-only blend, backed by on-chain verification of the issuer registry. Caps now decay, multiple incidents are supported, and the score shows on coin pages.
- **Chain & oracle risk**: Report cards now fold in L2BEAT chain risk and CDP oracle risk, with new bridge-route and enriched oracle risk profiles. The Decentralization compute is deduped and now enforces oracle coverage.
- **Reserves & redemption**: Reserve views ship for 11 active coins, eight more become evidence-bearing attestation feeds, and 30 redemption routes gain live reserve-sync capacity. Redemption reaches v4.11 with documented same-day buffers.
- **Yield & compliance**: Yield coverage expands via the Wave 1 source-roster (v8.23), and GBP, JPY, and AUD benchmarks move to direct central-bank sources. A broad MiCA and GENIUS data pass refreshes compliance metadata across the registry.
- **Depeg control board**: The depeg table becomes an interactive control board with filtering, sorting, and severity signals. Displayed deviation is now gated on peg-reference authority (DEWS v6.08), and repair-required events are quarantined.
- **Verification passport**: The coin detail hero becomes a verification passport — visas for Issued, MiCA, GENIUS, and track record — and the contract wall becomes labeled rows with inline verify actions. An MRZ experiment was reverted.
- **Search, a11y & performance**: Per-chain OG cards ship for 107 chain pages, detail pages gain FAQ and Article JSON-LD, and a hydrated-state axe lane plus screen-reader tables raise accessibility. Critical CSS inlines and the CSP drops unsafe-eval.
- **Platform consolidation**: A shared table system replaces bespoke tables with common shells, controls, and skeletons. Code-health Waves 1–4 dedupe helpers, prune dead exports, name magic numbers, and tidy worker and scoring internals.

## 2026-06-01 to 2026-06-06

Navigation redesign reshapes the sidebar and homepage, a compare hub launches, and the depeg resolver locks forecasts.

- **Navigation & homepage redesign**: The sidebar becomes a lit 'watch column', a sticky core tape rail spans the top routes, and the homepage swaps static callouts for a rotating discovery module. The depeg resolver is promoted in primary navigation.
- **Public compare hub**: A new indexable compare hub launches for side-by-side stablecoin lookups, the DEWS radar now surfaces high-risk coin logos scaled by escalation tier, and the public dataset catalog gains JSON-LD structured data.
- **Resolver readiness & apxUSD**: The depeg resolver now locks predictions by forecast readiness or backstop, persisting lock metadata behind a readiness contract. The apxUSD incident reopened across DDR/DDRR with hardened pricing and projection.
- **Reserves & Royco yield**: A structured tranche-yield safety model lands and ingests Royco Dawn rows, while live-reserve coverage gains audit hardening, finalization fixes, and corrected source mappings for assigned assets.
- **Scoring updates**: Safety Score advances to v7.291, and PegScore coverage extends to more priced assets.
- **Pipeline fail-closed hardening**: Pricing, depeg, DEWS, yield, reserves, and blacklist paths now fail closed on stale or uncorroborated data, with freshness guards, input gating, and hardened parsing. The ops proxy now requires Access JWTs.
- **Codebase consolidation**: A broad refactor wave shares helpers across worker, Telegram, and UI layers, derives types from schemas, and prunes dead code; perf work defers heavy detail bundles, memoizes the coverage matrix, and chunks cron queries.

## 2026-05-25 to 2026-05-31

The Depeg Resolver (DDR/DDRR) v2 ships at /depeg, dashboard cards flatten, and the data layer gets a two-pass audit.

- **Depeg Resolver (DDR/DDRR) v2**: /depeg goes public: DDR predicts how long an active depeg will last with sticky locked forecasts and a verdict-band lockup; DDRR scores past predictions on a reviewer. DDR also shows on each coin page.
- **Data audit & remediation**: Data passes plus follow-ups recover crvUSD and Reservoir reserve breakers, move ZCHF capacity to CHFAU, switch fxSAVE redemption to live capacity, align USG/HLUSD/JPYC/YUSD, and pin StablR's EURR/USDR multisig exploit.
- **Compliance & GENIUS tracker**: A new GENIUS Act tracker surface launches alongside expanded compliance metadata research, and the MiCA tracker now enforces out-of-scope constraints to keep deliberately-undefined coins distinct from unassessed ones.
- **Pre-launch additions**: Tenbin Gold (tGLD) — a synthetic gold debt-note from a CME-futures basket — and GEL₮, Tether's pre-launch Georgian Lari, join the pre-launch list, and the weekly upcoming sweep tracks Flipcash's launch and USDPT.
- **Flat-card design pass**: Card accents flatten — the colored border-l retires except for data-driven indicators. Price Transparency and Redemption Backstop go full-width on coin pages, and depeg page hierarchy tightens around the resolver.
- **Platform hygiene**: Cron cache helpers centralize, depeg resolver and DEWS D1 retries harden, admin API contracts get schema validation, and several large surfaces (yield, command palette, timeline, picker) split into smaller modules.

## 2026-05-18 to 2026-05-24

Design-system overhaul lands, the MiCA tracker goes live, and the yield page gets a ground-up rebuild.

- **Design system & UX overhaul**: Foundational tokens consolidated with a severity AA-contrast fork, then an IA graph, a11y and motion choreography, editorial voice, inline sparklines with linked brushing, and a universal watchlist with palette verbs.
- **Yield intelligence overhaul**: Yield rebuilt around a scatter and a draggable risk-budget slider, a source sheet showing confidence and depth, a per-factor PYS breakdown, per-coin APY-change attribution, and a public decision ledger (v8.16).
- **MiCA tracker launch**: A new /mica/ tracker launches and sweeps to full coverage at 25 coins, cross-referenced against the ESMA register, with GUSD ruled non-compliant and the tracker cross-linked from coin and compliance surfaces.
- **Learn hub & depeg case studies**: A new /learn hub and LEARN nav group launch with a depeg case-studies section; case studies cross-link from coin, cemetery, depeg, and mechanism pages, and chart annotations now link to the case study behind each event.
- **Guided stablecoin Picker**: A guided stablecoin picker ships at /screener/picker/ on a new selector engine: snapshot endpoint, peg-scope scoring, custody and depeg-watch logic, a mobile form, a homepage callout, and a Telegram follow command.
- **Navigation & homepage refresh**: An alternate homepage and timeline layout land, with a 9-depeg desktop grid, an optional phosphor CRT reading mode, a unified chain-profile hero, expanded mechanism explainers, and a prominence-ranked command palette.
- **Pricing integrity & reliability**: DEX price sanity gates and Carbon normalization make DexScreener augmentation opt-in (pricing v6.05), Liquidity Score v5.7 adds price-gating, plus a cron staleness watchdog and an API-key rate-limit fallback.
- **Redemption backstop coverage**: Redemption backstop scoring (v4.04) gains documented route sources, source-support validation, and expanded confidence scoring, with a coverage matrix that surfaces outage and degraded states; report cards degrade on redemption outages, the data is exposed in stablecoin JSON-LD, and malformed telemetry fails closed.
- **Mint Authority transparency**: A new Mint Authority section on coin pages surfaces who can mint and control supply — control addresses with on-chain evidence, Safe-module display, and risk-tone posture cues — with coverage expanded across the top stablecoins.
- **Broader coverage**: The tracked universe reaches 399 coins with FUSD, sDOLA, GLDT, and Ondo's iAUON and sLVON added and pre-launch gynUSD joining, while reserve adapters climb to 57 and live-reserve coverage to 267.

## 2026-05-11 to 2026-05-17

Screener launches, detail pages rebuild around verdict, and Yield v8.13 ships multi-currency benchmarks.

- **Pharos Screener launch**: New /screener/ tool ships with composable filters, blacklistable + safety-tier predicates, URL state codec, and universal CSV/NDJSON/Markdown export for power users.
- **Detail page rebuild**: Detail pages restructure around section banners, with a verdict-first hero, mechanism schematics, AI summaries with Term popovers, attestor + freezability identity pills, and a mobile compact summary bar.
- **Trust & SEO surface area**: Ten methodology white-paper PDFs go live, RSS feeds ship for digest/depeg/methodology/cemetery, citation blocks + Pharos URN substrate land, plus AI-disclosure badges and a page-footer trust strip.
- **Yield methodology v8.13**: Yield gets a v8.13 bump with a multi-currency benchmark registry (GBP/JPY/MXN/BRL/AUD/CAD), currency tab strip, per-coin /stablecoin/[id]/yield page, source-risk scoring, and yield-spike annotations.
- **Tape → Timeline migration**: The Tape moves to /timeline/ with per-class digest grouping and new PSI/DEWS/mint-burn/yield/peak-worsen/methodology/cemetery/lifecycle projectors. Copy-permalink, server-side search, and wire-service redesign land.
- **Telegram Mini App maturation**: Mini App Phase 2-4 ships with HMAC hardening, /forget command, batched coin-setting writes, global depeg-step setting, and watchlists. Group UX, retention, and webhook delivery hardened across the board.
- **DEWS v6 + depeg lifecycle**: DEWS v6 lands with evidence + freshness scoring, depeg lifecycle provenance schema, /depeg/<event>/ pages gated at 250 bps threshold, incident triage surface, and historical provenance persistence.
- **Reserve coverage expansion**: Reserve adapter count climbs to 55 with sGHO, Zephyr, centrifuge-vault, Resupply, hbUSDT, and score-grade adapters. Live-reserves coverage reaches 252; methodology v7.23 documents the scoring policy.
- **Redemption backstop v4**: Redemption backstop v4 ships with audited route coverage, capacity-model split, run-row handling, source-reviewed backstop scoring, refreshed coverage modeling, and a redemption backstop card on detail pages.
- **Performance + bundle work**: Client registry splits into a slim 281 KiB path (down from 1.37 MiB), fonts move to woff2 + subset Newsreader, detail charts lazy-mount on intersection, Web Vitals stream to GA, and chunk-size budgets gate merges.
- **Worker + scripts modularization**: Scripts split into ci/maintenance/oneshots, telegram webhook + store split into focused submodules, shared/lib groups by domain (chains, classification, telegram, blacklist), and cron mock factories standardize tests.
- **CI + supply chain hardening**: Zizmor + CodeQL findings remediated, persist-credentials + explicit secrets enforced on workflows, deploy validation runtime trimmed, validate leaf jobs start immediately, and pages release smoke gates clarified.

## 2026-05-04 to 2026-05-10

Non-USD stablecoin batch ships, DEX pricing gains confidence telemetry, and Telegram adds depeg-step commands.

- **Non-USD coverage expansion**: Non-USD peg batch ships with supply-backfill fallback, CADD joins with full redemption + live-reserve coverage, Tangent USG activates, and the homepage Fiat filter works on first click.
- **Live reserve hardening**: Reserve Protocol DTF adapter goes live, deferred and uncertain sync states surface in the UI, adapter helper contracts expand coverage, and River/SG Forge date handling hardens.
- **DEX pricing telemetry**: Confidence telemetry exposes per-source reliability, expanded bridge sources widen DEX coverage, impossible TVL and fee-variant duplicates rejected, and stale Coinbase DAI-USD dropped.
- **Digest intelligence**: Daily digest leads with critical risk signals and uses live prices for active depegs. Telegram gains depeg-step commands and hardened group UX; homepage preview rebalanced.
- **Freezability and blacklist audit**: Freezability classifications audited and corrected, USD3 reclassified as CeFi-dependent, blacklist identity tracking improved with new API artifacts and redemption backstop coverage.
- **USND archive**: Nerite USND moves to the frozen cemetery archive after the rsETH collateral incident, preserving the detail page while removing live reserve tracking.
- **Infrastructure and docs**: Alt-peg atlas positioning fixed, LLMs stablecoin export refreshed, sitemap test prereqs generated correctly, and README gains TOC with AI guidance cross-reference.

## 2026-04-27 to 2026-05-03

PharosVille v1 ships, frozen lifecycle lands with USR + BUCK archived, and a 10-phase audit remediation closes.

- **Pharosville v1**: Pharosville v1 launch: a pixel-art harbor where the Pharos data comes to life, with chains as harbors, stablecoins as ships, and DEWS alert tiers as sea zones.
- **Frozen lifecycle**: USR (Resolv) and BUCK become the first frozen archives. Frozen banner + chart footers, command-palette/compare/cemetery surfaces, OG/sitemap retention, cron writes excluded, PSI excludes frozen.
- **Audit remediation: 10 phases**: Phases 2-10 close: refactor splits (env contracts, contagion graph, dex discovery, taxonomy, fallback, depeg), shell-safe git refs, validated D1 usage payloads, KYC blacklist hardening, Node 24 baseline.
- **Per-coin catalog migration**: Stablecoin metadata moves from monolithic JSON shells to per-coin files with a generated aggregate; loaders, docs, lifecycle references, and tests follow.
- **Coverage and redemption modeling**: MYRC and KRWQ join coverage (MYR + KRW peg support); pmUSD gets a redemption backstop via sUSDS PSM; catalog refreshes after the crvUSD GHO PegKeeper update.
- **Mint/burn cleanup + DEX resilience**: Legacy mint/burn sync fallback removed, D1 rows-read cut, homepage events count chip restored via O(1) sqlite_sequence read; DEX liquidity degrades cleanly on source outages.
- **Funding page polish**: Funding KPI card now shows <1% donor share and prior-month coverage; 12 new donations from this week's funding-update sweep.

## 2026-04-20 to 2026-04-26

Harbor and canal metaphors redraw /chains and /liquidity, public /api/* goes keyed-only, and tracked coverage hits 215.

- **Visualization metaphors**: /chains becomes a nautical harbor chart with ships scaled by supply, /liquidity turns into a canal with mitre lock gates and chain basins, and the PSI hero gets a lighthouse mini-scene.
- **Alt-pegs world atlas**: Alt-pegs hub gains a docked world map with country-fill colors driven by peg taxonomy, a celestial band for Gold/Silver/CPI, fullscreen inspection mode, and a non-USD market structure route.
- **Coverage and variants framework**: Tracked coverage grows from 191 to 215 across a flat RWA issuer batch, risk-wrapper assets, and a redemption-modeling pass; a new variants framework links wrappers to parents with inherited blacklist status.
- **/api/* keyed-only**: Public /api/* lane is removed in favor of X-API-Key on every request; /_site-data/* is gated on Origin/Referer headers, with a tested 401 floor and a narrow exempt carve-out for feedback/og/health.
- **Pipeline correctness hardening**: Reserve/chart/yield-rankings cache validators, freshness sentinels, supply-history validation, malformed payload handling, abort-signal propagation, cron lane isolation, and onchain-only detail fallback.
- **Tier 1 refactor wave**: Repo-wide dedup: shared isRecord/CircuitRecord/admin-gates, GradeBadge and DetailSectionTitle primitives, error boundaries, dead layouts, retired legacy stablecoin routes, and frontend module splits.

## 2026-04-13 to 2026-04-19

Pricing pipeline v5.0 lands, 40+ new risk-coverage entries across backstops/blacklist/reserves, and /funding launches.

- **Pricing pipeline v5.0**: Every fetcher returns FetcherOutcome for breaker discipline, Curve/Chainlink staleness guards tighten, upstream-observed timestamps propagate from Bitstamp/Coinbase/Curve, and no-candidate circuit recovery generalizes.
- **DEWS v5.95 contagion amplifier**: Cross-asset contagion amplifier (clamped [1.0, 1.2]) joins the DEWS blend, a backtest harness validates detection rate + lead time on curated anchors, and /api/stress-signals surfaces amplifier breakdown.
- **Mint-burn flows v6.0**: LayerZero/CCIP/CCTP bridges tag as bridge_transfer, atomic roundtrips require 0.5% tolerance, USDC and EURC get CCTP detection, and the Bank Run Gauge reweights by canonical-chain mcap rather than global supply.
- **Redemption backstops v3.99**: Adds the flat/RWA issuer batch (USDon, USDsui, BRLV, USDGLO, AUDM, Alloy aUSDT) on top of the prior route expansion, capacity clamping to supply, fee-score breakpoints, and documented fail-closed fallbacks for falcon/frxusd.
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
