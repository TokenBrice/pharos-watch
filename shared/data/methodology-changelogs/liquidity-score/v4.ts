import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const LIQUIDITY_SCORE_V4: readonly MethodologyChangelogEntry[] = [
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
    effectiveAt: 1773792002,
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
    effectiveAt: 1773792001,
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
    effectiveAt: 1773792000,
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
      "Volume activity now uses log-scale (33.3*log10(V/T/0.005)); median score rises from 5 to ~35",
      "Cross-chain component removed; TVL Depth raised to 35%, Pool Quality to 22.5%",
      "Durability: organic 15% (sqrt curve), TVL stability 35%, volume consistency 25%, maturity 25%",
      "Locked liquidity sub-component removed from durability (no reliable data source)",
    ],
    commits: [],
    reconstructed: false,
  },
];
