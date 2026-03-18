import {
  createMethodologyVersion,
} from "./methodology-version";

const liquidity = createMethodologyVersion({
  currentVersion: "4.3",
  changelogPath: "/methodology/liquidity-score-changelog/",
  changelog: [
  {
    version: "4.3",
    title: "Fluid DexReservesResolver balance integration",
    date: "2026-03-18",
    effectiveAt: 1773882000,
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
    effectiveAt: 1773879300,
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
    summary:
      "Corrected effective TVL inflation when symbol fallback matched non-Curve pools to Curve entries.",
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
    summary:
      "Coins without DEX pools switched from score=0 placeholders to NULL (NR) semantics.",
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
    summary:
      "Launched baseline DEX liquidity scoring, API surface, and dashboard integration.",
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
