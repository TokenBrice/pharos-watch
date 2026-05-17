import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const LIQUIDITY_SCORE_V3: readonly MethodologyChangelogEntry[] = [
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
];
