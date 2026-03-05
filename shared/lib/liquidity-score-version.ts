/** Canonical Liquidity Score methodology version (no "v" prefix). */
export const LIQUIDITY_METHODOLOGY_VERSION = "3.2";

/** Display-ready Liquidity Score methodology version (with "v" prefix). */
export const LIQUIDITY_METHODOLOGY_VERSION_LABEL = `v${LIQUIDITY_METHODOLOGY_VERSION}`;

/** Public changelog route for Liquidity Score methodology version history. */
export const LIQUIDITY_METHODOLOGY_CHANGELOG_PATH = "/methodology/liquidity-score-changelog/";

export interface LiquidityMethodologyChangelogEntry {
  version: string;
  title: string;
  date: string; // YYYY-MM-DD
  effectiveAt: number; // Unix seconds (UTC)
  summary: string;
  scoreImpact: readonly string[];
  commits: readonly string[];
  reconstructed: boolean;
}

/**
 * Reconstructed Liquidity Score methodology timeline from git commit history.
 *
 * Notes:
 * - Effective timestamps use commit timestamps (UTC) of methodology-impacting changes.
 * - Entries marked reconstructed=true were inferred from commit history because liquidity
 *   scoring did not ship with explicit methodology version tracking.
 */
export const LIQUIDITY_METHODOLOGY_CHANGELOG: readonly LiquidityMethodologyChangelogEntry[] = [
  {
    version: "3.2",
    title: "Effective TVL symbol-fallback inflation fix",
    date: "2026-03-02",
    effectiveAt: 1772449220,
    summary:
      "Corrected effective TVL inflation when symbol fallback matched non-Curve pools to Curve entries.",
    scoreImpact: [
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
    scoreImpact: [
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
    scoreImpact: [
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
    scoreImpact: [
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
    scoreImpact: [
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
    scoreImpact: [
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
    scoreImpact: [
      "Initial five-component composite (TVL depth, volume, pool quality, diversity, cross-chain)",
      "DeFiLlama-driven pool aggregation and top-pool persistence introduced",
      "Liquidity map endpoint and page-level leaderboard shipped",
    ],
    commits: ["a7ae273", "443ac1b", "f26fdf3"],
    reconstructed: true,
  },
] as const;

const LIQUIDITY_VERSION_WINDOWS_ASC = [...LIQUIDITY_METHODOLOGY_CHANGELOG]
  .map((entry) => ({ version: entry.version, effectiveAt: entry.effectiveAt }))
  .sort((a, b) => a.effectiveAt - b.effectiveAt);

/** Resolve Liquidity Score methodology version active at a given Unix timestamp (seconds). */
export function getLiquidityMethodologyVersionAt(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return LIQUIDITY_METHODOLOGY_VERSION;

  let resolved = LIQUIDITY_VERSION_WINDOWS_ASC[0]?.version ?? LIQUIDITY_METHODOLOGY_VERSION;
  for (const window of LIQUIDITY_VERSION_WINDOWS_ASC) {
    if (unixSeconds >= window.effectiveAt) {
      resolved = window.version;
    } else {
      break;
    }
  }
  return resolved;
}

export function toLiquidityMethodologyVersionLabel(version: string): string {
  return `v${version}`;
}
