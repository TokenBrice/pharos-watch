import { createMethodologyVersion } from "./methodology-version";

const liquidity = createMethodologyVersion({
  currentVersion: "5.5",
  changelogPath: "/methodology/liquidity-score-changelog/",
  changelog: [
    {
      version: "5.5",
      title: "Absolute TVL Depth fallback recalibration and Slipstream sqrt_ratio price",
      date: "2026-04-17",
      effectiveAt: 1776384000,
      summary:
        "Absolute TVL Depth fallback (used when circulatingUsd is unavailable) now shares the ratio formula's anchor via a $1B implied reference mcap. Aerodrome/Velodrome Slipstream price derivation now uses on-chain sqrt_ratio (Q64.96) instead of total-reserve ratios for concentrated liquidity pools.",
      impact: [
        "Absolute TVL Depth fallback: `20 * log10(tvl / 100_000) + 20` → `35 * log10(tvl / 700_000)`; coins without market cap data no longer gain ~24 points of unearned TVL Depth",
        "Aerodrome/Velodrome Slipstream price observations now derive from on-chain sqrt_ratio instead of reserve ratios; concentrated liquidity pools no longer emit biased spot prices when one side lacks a tracked USD price",
        "Slipstream pools where sqrt_ratio is unusable and one side has no tracked price are now dropped entirely (no reserve-ratio fallback derivation)",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.4",
      title: "Curve enrichment scoping and staged UUID dedupe",
      date: "2026-04-14",
      effectiveAt: 1776165200,
      summary:
        "Curve API enrichment is now scoped to Curve DeFiLlama rows, and staged exact pool-id rows can dedupe against a single identity-poor DeFiLlama UUID row through the same narrow optional-metadata wildcard used by primary dedupe.",
      impact: [
        "Non-Curve DeFiLlama pools that share token symbols with a Curve pool no longer inherit Curve registry metadata, balance ratios, token prices, or metapool-adjusted TVL",
        "CoinGecko/GeckoTerminal provider ids with underscores or provider suffixes normalize to the same canonical protocol family as DeFiLlama ids during pool-identity construction",
        "Staged discovery now skips a staged exact pool-id row when it uniquely matches one primary DeFiLlama UUID row by chain, protocol, token set, and pool-shape family, while ambiguous same-pair staged buckets still remain separate",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.3",
      title: "PancakeSwap trailing-hour volume window",
      date: "2026-04-08",
      effectiveAt: 1775613600,
      summary:
        "PancakeSwap V3 direct volume now sums the official `poolHourDatas.volumeUSD` buckets across a bounded trailing 24-hour window instead of treating the latest `poolDayDatas` row as if it were a rolling 24h metric.",
      impact: [
        "Intraday PancakeSwap volume no longer collapses toward zero until UTC rollover just because the current day bucket has only accumulated partial activity",
        "Fresh non-swap day buckets can no longer zero out yesterday's still-relevant trading activity, because trailing volume now comes from summed hourly swap buckets",
        "The PancakeSwap direct fetch keeps bounded batching under The Graph row cap while staying on official subgraph entities instead of adding a new historical block lookup dependency",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.2",
      title: "Orderbook ticker contract refresh and Balancer exact-address identity",
      date: "2026-04-08",
      effectiveAt: 1775606400,
      summary:
        "CoinGecko orderbook fallback now ignores the deprecated `trust_score` field and validates tickers by observable freshness/price/volume fields, while Balancer direct pools now use the API's exact pool address for identity instead of the 32-byte vault pool id.",
      impact: [
        "CoinGecko tickers fallback and discovery staging no longer drop every post-March-2026 ticker row just because CoinGecko now returns `trust_score = null`",
        "Orderbook fallback ticker intake now requires finite USD price/volume plus a stable exchange identifier, improving sanitization without depending on deprecated metadata",
        "Balancer direct API pools now reserve and dedupe by the true pool address, restoring exact-id confirmation against staged discovery and overlap checks",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.1",
      title: "Authoritative protocol confirmation for staged discovery",
      date: "2026-04-07",
      effectiveAt: 1775520000,
      summary:
        "Staged discovery rows can no longer invent new pools inside protocol families that already have a clean protocol-native direct source. When that authoritative fetch succeeds on a supported chain, staged rows must match one of its exact pool ids or they are excluded.",
      impact: [
        "GeckoTerminal, CoinGecko Onchain, and DexScreener staging rows that claim Balancer, Fluid, Raydium, Orca, Meteora, PancakeSwap, Aerodrome, or Velodrome liquidity now require authoritative exact-id confirmation when the matching direct fetch succeeded cleanly on that chain",
        "The guard fails open when the authoritative source is unavailable or degraded, so discovery sources still recover coverage during native-source incidents instead of hard-zeroing the row",
        "Liquidity cron metadata now records `stagedPoolsSkippedByAuthoritativeProtocol` separately from exact-id and derived-identity dedupe skips",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.0",
      title: "Size-aware scoring: relative TVL depth, recalibrated volume, quality retention",
      date: "2026-04-05",
      effectiveAt: 1775347200,
      summary:
        "All scoring dimensions are now size-independent. TVL Depth measures effective TVL relative to market cap instead of absolute dollar value. Volume Activity has a recalibrated curve with a realistic ceiling (tops out at ~32% V/T instead of ~500%). Pool Quality measures venue quality retention ratio (qualityAdjustedTvl / totalTvl, rescaled) instead of absolute quality-adjusted TVL. Weights rebalanced to 30/20/20/20/10.",
      impact: [
        "TVL Depth uses effective-TVL-to-market-cap ratio on a log scale (35 × log10(ratio / 0.0007)), with absolute fallback for coins without market cap data",
        "Volume Activity recalibrated: 38 × (log10(V/T) + 3) — zero line at 0.1% V/T, tops at ~32% V/T. USDC/USDT now score 86-90 instead of 52-56",
        "Pool Quality measures quality retention (qualityAdjustedTvl / totalTvl, rescaled from 15-80% range to 0-100). Fully size-independent",
        "Weights rebalanced from 35/20/22.5/15/7.5 to 30/20/20/20/10 — structural quality (Pool Quality + Durability = 40%) now matches depth + activity (50%)",
        "Coins like BOLD and LUSD with high relative depth ratios see significant score improvements; large-cap coins with low relative depth see depth dimension scores decrease but compensate through volume, durability, and diversity",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.9",
      title: "Blocked dead Bunni DEX inputs",
      date: "2026-04-03",
      effectiveAt: 1775242800,
      summary:
        "Explicitly blocked Bunni from liquidity scoring and DEX implied-price publication after dead-venue rows kept surfacing as retained liquidity.",
      impact: [
        "Bunni is now excluded during crawl intake and DeFiLlama pool processing instead of being treated as a live DEX venue",
        "Retained-pool filters and challenger snapshots ignore Bunni even if stale rows or unexpected inputs survive earlier gates",
        "Liquidity scores, dexPriceUsd, and downstream DEX cross-checks no longer count Bunni TVL, pool counts, or protocol medians",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.8",
      title: "Direct-source duplicate hardening for Balancer and staged exact ids",
      date: "2026-04-03",
      effectiveAt: 1775239200,
      summary:
        "Direct-source dedupe now reserves every authoritative exact pool id for later staged matching, and Balancer stablecoin pools can still collapse against direct Balancer coverage when DefiLlama omits the subtype in `balancer-v3` metadata.",
      impact: [
        "Sub-threshold direct API pools now still block later exact-address staged duplicates from re-entering scoring with incompatible TVL semantics",
        "GeckoTerminal and CoinGecko discovery rows can no longer inflate liquidity by resurrecting the same exact direct pool after the direct row was excluded from scoring",
        "Balancer stablecoin pools now dedupe correctly against Balancer direct API even when DefiLlama labels the row as generic `balancer-v3` without stable subtype metadata",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.7",
      title: "Retained-pool DEX price publication",
      date: "2026-04-03",
      effectiveAt: 1775214000,
      summary:
        "DEX implied-price publication now derives from the final retained pool surface after dedupe, caps, and scoring filters, instead of from the earlier raw observation stream.",
      impact: [
        "Pools that are skipped as duplicates or dropped by retained-pool quality filters can no longer keep influencing dex_prices",
        "dexPriceUsd, price_sources_json, and downstream dexPriceCheck consumers now reflect the same retained pool surface used for challenger publication and UI liquidity detail",
        "High-TVL discovery rows that never survive retained-pool admission can no longer manufacture near-peg DEX aggregates for depegged assets",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.6",
      title: "Protocol-native DEX coverage expansion",
      date: "2026-03-24",
      effectiveAt: 1774352400,
      summary:
        "Liquidity scoring now ingests Meteora DLMM, PancakeSwap V3, and Aerodrome/Velodrome Slipstream pool-state data as protocol-native direct sources, expanding primary-grade coverage across Solana, BSC, Base, and Optimism.",
      impact: [
        "Meteora DLMM pools now enter the direct-API merge path with measured TVL, volume, balances, and fee data",
        "PancakeSwap V3 pools now add protocol-native primary coverage across BSC and supported EVM chains through official Graph subgraphs",
        "Aerodrome Slipstream and Velodrome Slipstream pools now contribute pool-state TVL, balances, fees, and DEX-price observations via the on-chain Sugar view contracts",
        "Direct-source precedence over overlapping DeFiLlama rows now requires measured non-zero 24h volume, so Slipstream pool-state rows expand coverage without displacing stronger DL rows when volume telemetry is absent",
        "New concentrated-liquidity quality buckets now score PancakeSwap and Slipstream fee tiers consistently with existing Uni V3 logic",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.5",
      title: "Coverage recall hardening and measurement-aware confidence",
      date: "2026-03-24",
      effectiveAt: 1774346400,
      summary:
        "DEX liquidity now paginates deeper through GeckoTerminal and CoinGecko Onchain discovery, enriches weak partial coverage instead of only zero-coverage rows, and scores coverage confidence from measured-vs-synthetic retained TVL rather than a fixed source-family ladder.",
      impact: [
        "GeckoTerminal and CoinGecko Onchain token crawls now read multiple bounded pages instead of stopping after page 1",
        "DexScreener and CoinGecko tickers fallback now trigger for weak partial coverage, not only coins with zero pools or no DEX price",
        "Fallback orderbook rows now preserve explicit synthetic/decayed/provenance flags instead of masquerading as organic USDC pools",
        "Coverage confidence now incorporates protocol breadth, source-family breadth, measured balance share, measured price share, and synthetic or decayed TVL share",
        "Direct-API pools default to a shorter maturity assumption and Fluid reserve normalization now marks whether balances were safely measured",
        "Shared secondary-pool contribution logic centralizes GT/CG/staged/fallback aggregate handling to reduce drift across merge paths",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.4",
      title: "Chain-aware pool identity dedupe and challenger snapshot publishing",
      date: "2026-03-19",
      effectiveAt: 1773961394,
      summary:
        "DEX liquidity now resolves tracked tokens chain-aware, deduplicates pools with conservative identity keys instead of coarse fingerprints, collapses duplicate DEX price observations before aggregation, and publishes dedicated challenger snapshots from the full retained pool set.",
      impact: [
        "Direct API and staged/fallback pools resolve tracked assets by chain+address first, with chain-scoped symbol fallback only when unique",
        "Cross-source pool dedupe now uses exact pool ids first and derived token-shape matches only when they are unique on both sides",
        "Repeated sightings of the same physical pool across direct API, staged, and fallback sources now collapse before dex_prices weighting",
        "Depeg challenger inputs publish from the full retained pool set instead of the visible top-pools subset",
        "Fluid pools with missing token decimals now fall back to neutral balance rather than using unsafe raw reserve units",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.3",
      title: "Fluid DexReservesResolver balance integration",
      date: "2026-03-18",
      effectiveAt: 1773792001,
      summary:
        "Fluid pools on Ethereum, Arbitrum, Base, and Polygon now read balances and fee detail from the official " +
        "DexReservesResolver instead of staying on neutral placeholders.",
      impact: [
        "Fluid top-pool rows now populate Balance and Detail when the official DexReservesResolver is deployed on that chain",
        "Fluid pool quality now uses measured balance health on resolver-backed EVM chains, rather than a hardcoded neutral 1.0",
        "Fluid fee detail now comes from the on-chain pool config (`1% = 10_000`), normalized to basis-point badges in the UI",
        "BSC and Plasma Fluid pools remain on neutral-balance fallback until Fluid ships the same resolver path there",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.2",
      title: "Measured direct-API balance health and normalized pool-detail metadata",
      date: "2026-03-18",
      effectiveAt: 1773792000,
      summary:
        "Balancer, Raydium, and Orca direct-API pools now preserve measured balance and fee metadata through scoring " +
        "instead of merging with neutral placeholders. Pool-detail fee tiers are normalized to basis points for all sources.",
      impact: [
        "Direct-API Balancer, Raydium, and Orca pools now populate top-pool balance bars and detail badges",
        "Measured direct-API balance ratios now feed balance-weighted aggregates, stress, and effective TVL instead of assuming 1.0",
        "Balancer weighted pools normalize balance health against target token weights rather than raw reserve symmetry",
        "Orca vault balances are normalized from raw token units before balance-health calculation",
        "Top-pool fee tiers now serialize as actual basis points (for example 1bp, 5bp, 30bp) across UniV3, CG-onchain, and direct APIs",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.1",
      title: "Direct API precedence, primary-grade coverage, and fetcher contract hardening",
      date: "2026-03-18",
      effectiveAt: 1773875700,
      summary:
        "Direct API sources now replace overlapping DeFiLlama pools before scoring, run ahead of staged/fallback sources, " +
        "and count as primary-grade coverage. Raydium and Orca contract handling was hardened against live API drift, " +
        "Fluid volume normalization moved to one-sided USD volume, and Balancer intake now excludes unsupported pool types.",
      impact: [
        "Raydium lower-case poolType contract fix restores live Solana pool coverage",
        "Orca now paginates via cursor.next with retry/backoff and a below-threshold stop, instead of truncating after page 1",
        "Direct API pools are fingerprint-deduped and preferred over overlapping DeFiLlama pools before score computation",
        "Direct API sources merge before staged/DexScreener/CG-ticker fallbacks, preventing lower-confidence sources from claiming the same pool first",
        "direct_api-only rows now classify as primary coverage (confidence 1.0) instead of fallback coverage",
        "Fluid volume now uses one-sided USD-normalized pool volume instead of double-counting raw token legs",
        "Balancer intake is limited to supported stable/weighted pool families on mapped chains only",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "4.0",
      title: "Log-scale volume, cross-chain removal, durability rebalance",
      date: "2026-03-10",
      effectiveAt: 1773127850,
      summary:
        "Volume activity switched from linear to log-scale. Cross-chain component removed and weight redistributed to TVL depth and pool quality. Durability sub-weights rebalanced: locked liquidity removed, organic fraction reduced to 15% with sqrt curve, history-measured signals raised to 85%.",
      impact: [
        "Volume activity now uses log-scale (33.3*log10(V/T/0.005)) — median score rises from 5 to ~35",
        "Cross-chain component removed; TVL Depth raised to 35%, Pool Quality to 22.5%",
        "Durability: organic 15% (sqrt curve), TVL stability 35%, volume consistency 25%, maturity 25%",
        "Locked liquidity sub-component removed from durability (no reliable data source)",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.4",
      title: "Retained-pool score recomputation and trusted staged-price hardening",
      date: "2026-03-09",
      effectiveAt: 1773056006,
      summary:
        "Liquidity scoring now rebuilds every aggregate from the retained pool set after filtering/caps, while staged discovery preserves pool-quality metadata and stricter DEX-price trust rules.",
      impact: [
        "Filtered or TVL-capped pools can no longer keep influencing score inputs through stale aggregate fields",
        "HHI now uses the full retained pool set before display truncation; global 7d volume is pool-deduped",
        "Staged pool merge now dedups against token-pair fingerprints and preserves raw DEX metadata/quality multipliers",
        "DEX price observations require a consistent $50K post-confidence TVL floor across source families",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.3",
      title: "Separated discovery pipeline with staged pool confidence decay",
      date: "2026-03-09",
      effectiveAt: 1773045555,
      summary:
        "Discovery sources (CG Onchain, GeckoTerminal, DexScreener, CG Tickers) now run on an independent 20-minute cron with 3x more budget. Staged pools merged into scoring with freshness confidence decay and explicit defaults contract.",
      impact: [
        "Discovery cron runs independently on 20-min trigger with ~15 min budget (was 5 min shared)",
        "Staged pools receive confidence decay: max(0.5, 1 - ageHours/48), excluded after 24h",
        "Chain-aware source routing reduces wasted API calls by skipping irrelevant chains",
        "Tiered priority with exponential backoff prevents looping on pool-less coins",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "3.2",
      title: "Effective TVL symbol-fallback inflation fix",
      date: "2026-03-02",
      effectiveAt: 1772449220,
      summary: "Corrected effective TVL inflation when symbol fallback matched non-Curve pools to Curve entries.",
      impact: [
        "Metapool-adjusted TVL now applies only to address-matched Curve pools",
        "Symbol-fallback pools keep their own TVL in effective TVL calculations",
        "Removes accidental score inflation from cross-pool symbol collisions",
      ],
      commits: ["71cc096"],
      reconstructed: true,
    },
    {
      version: "3.1",
      title: "Anti-duplication and protocol TVL cap normalization",
      date: "2026-02-28",
      effectiveAt: 1772316807,
      summary:
        "Introduced fingerprint-based deduplication and DeFiLlama-anchored cap logic to suppress inflated secondary-source TVLs.",
      impact: [
        "CG/GT/DS pools deduped against DeFiLlama using token-pair fingerprints",
        "Secondary-source pool TVL capped and proportionally scaled by protocol-level DeFiLlama ceilings",
        "Global protocol and chain TVL totals kept consistent after cap reductions",
      ],
      commits: ["0b6bfb8", "617ab25", "1224015", "0e54c20"],
      reconstructed: true,
    },
    {
      version: "3.0",
      title: "Coverage expansion with fallback sources",
      date: "2026-02-28",
      effectiveAt: 1772274138,
      summary:
        "Expanded zero-pool recovery with DexScreener and CoinGecko tickers fallbacks for orderbook-heavy assets.",
      impact: [
        "DexScreener fallback adds pools for tracked coins still missing after primary crawl",
        "CoinGecko tickers fallback synthesizes orderbook liquidity where AMM coverage is absent",
        "Reduces false zero-liquidity outcomes for long-tail and niche assets",
      ],
      commits: ["6b2e006", "ef9bb2b"],
      reconstructed: true,
    },
    {
      version: "2.2",
      title: "No-pool rows moved to NR semantics",
      date: "2026-02-27",
      effectiveAt: 1772209768,
      summary: "Coins without DEX pools switched from score=0 placeholders to NULL (NR) semantics.",
      impact: [
        "No-liquidity rows now persist liquidity_score as NULL instead of 0",
        "Daily history placeholders for no-pool coins also use NULL scores",
        "Downstream consumers can distinguish not-rated from genuinely low-liquidity assets",
      ],
      commits: ["06c6681"],
      reconstructed: true,
    },
    {
      version: "2.1",
      title: "Onchain source upgrade and locked-liquidity durability term",
      date: "2026-02-25",
      effectiveAt: 1772035489,
      summary:
        "Primary pool discovery moved to CoinGecko Onchain with locked-liquidity data integrated into durability scoring.",
      impact: [
        "CG Onchain became primary source (with GT fallback) for richer pool metadata",
        "Durability weights changed from 40/25/20/15 to 35/25/20/15/5",
        "Locked liquidity added as an explicit durability sub-component",
      ],
      commits: ["361e240", "4f6d9ed"],
      reconstructed: true,
    },
    {
      version: "2.0",
      title: "Six-component v2 liquidity model",
      date: "2026-02-19",
      effectiveAt: 1771499167,
      summary:
        "Moved from a five-component heuristic to a six-component model with effective TVL and durability decomposition.",
      impact: [
        "Weights changed from 35/25/20/10/10 to 30/20/20/15/7.5/7.5",
        "TVL depth switched to effective TVL, not raw TVL only",
        "Durability and per-component score breakdown persisted in D1",
      ],
      commits: ["0254445"],
      reconstructed: true,
    },
    {
      version: "1.0",
      title: "Initial DEX liquidity score release",
      date: "2026-02-19",
      effectiveAt: 1771488526,
      summary: "Launched baseline DEX liquidity scoring, API surface, and dashboard integration.",
      impact: [
        "Initial five-component composite (TVL depth, volume, pool quality, diversity, cross-chain)",
        "DeFiLlama-driven pool aggregation and top-pool persistence introduced",
        "Liquidity map endpoint and page-level leaderboard shipped",
      ],
      commits: ["a7ae273", "443ac1b", "f26fdf3"],
      reconstructed: true,
    },
  ],
});

/** Canonical Liquidity Score methodology version (no "v" prefix). */
export const LIQUIDITY_METHODOLOGY_VERSION = liquidity.currentVersion;

/** Display-ready Liquidity Score methodology version (with "v" prefix). */
export const LIQUIDITY_METHODOLOGY_VERSION_LABEL = liquidity.versionLabel;

/** Public changelog route for Liquidity Score methodology history. */
export const LIQUIDITY_METHODOLOGY_CHANGELOG_PATH = liquidity.changelogPath;

/** Reconstructed changelog data. */
export const LIQUIDITY_METHODOLOGY_CHANGELOG = liquidity.changelog;

/** Resolve Liquidity Score methodology version active at a given Unix timestamp (seconds). */
export const getLiquidityMethodologyVersionAt = liquidity.getVersionAt;
