import {
  createMethodologyVersion,
} from "./methodology-version";

const yieldMethodology = createMethodologyVersion({
  currentVersion: "4.1",
  changelogPath: "/methodology/yield-changelog/",
  changelog: [
  {
    version: "4.1",
    title: "Conservative LUSD Stability Pool source",
    date: "2026-03-07",
    effectiveAt: 1772884800,
    summary:
      "LUSD gained a deterministic B.Protocol / Liquity Stability Pool source that estimates only the LQTY incentive stream and labels that limitation explicitly.",
    impact: [
      "Added direct on-chain LUSD source using Liquity Stability Pool deposits and CommunityIssuance totals",
      "APR converts projected LQTY emissions to USD using CoinGecko spot price and excludes ETH liquidation gains by design",
      "LUSD can now surface both B.Protocol Stability Pool and auto-discovered lending alternatives in the same ranking payload",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.0",
    title: "Multi-source rankings and alternative-source transparency",
    date: "2026-03-03",
    effectiveAt: 1772559178,
    summary:
      "Yield rankings moved from single-source rows to per-source modeling, so each coin can expose both native and wrapper yield paths.",
    impact: [
      "yield_data primary key changed to (stablecoin_id, source_key) with per-source rows",
      "is_best now marks the highest-APY source per coin; non-best alternatives are retained",
      "Tier 2 matching aggregates all valid sources (native map, wrapper map, symbol fallback)",
      "/api/yield-rankings now includes altSources[] and UI exposes +N alternative source details",
    ],
    commits: ["b94e042"],
    reconstructed: true,
  },
  {
    version: "3.3",
    title: "Coverage ratchet: deterministic overrides + address-aware discovery",
    date: "2026-03-03",
    effectiveAt: 1772529534,
    summary:
      "Auto-discovered lending coverage expanded with stricter quality gates, deterministic overrides, and contract-address fallback matching for symbol drift.",
    impact: [
      "Auto-discovery added minimum APY/TVL filters and expanded protocol allowlist coverage",
      "Deterministic pool overrides introduced for hard-to-match symbols (including explicit safety bypass handling)",
      "findBestLendingPool now falls back to underlying token address matches when symbol matching fails",
      "Price-derived fallback explicitly extended to BUIDL when no usable on-chain or DL source exists",
    ],
    commits: ["d9bf617", "39f3f95", "2a45230", "ce2293d"],
    reconstructed: true,
  },
  {
    version: "3.2",
    title: "Inherited blacklistability alignment for inline safety scoring",
    date: "2026-03-02",
    effectiveAt: 1772459422,
    summary:
      "Yield sync safety scoring switched to shared blacklistability logic (including reserve inheritance), improving parity with report-card safety behavior.",
    impact: [
      "Resilience inputs in inline safety computation now use shared isBlacklistable() logic",
      "Risk penalties in PYS better reflect inherited blacklist exposure",
      "Reduced divergence between yield-page safety grades and safety-scores page outputs",
    ],
    commits: ["595f176"],
    reconstructed: true,
  },
  {
    version: "3.1",
    title: "Auto-discovery hardening and finite-math safeguards",
    date: "2026-03-01",
    effectiveAt: 1772386997,
    summary:
      "Post-launch hardening pass improved reliability of discovered yield rows and prevented non-finite volatility values from polluting persisted rankings.",
    impact: [
      "NAV tokens were included in inline safety scoring instead of defaulting to implicit NR behavior",
      "Yield sync now reuses cached DeFiLlama pools from DEX sync to reduce upstream fetch failures",
      "Non-finite 30-day APY volatility values are sanitized before D1 writes",
    ],
    commits: ["2e2a0aa", "9decd36", "4402307"],
    reconstructed: true,
  },
  {
    version: "3.0",
    title: "Automatic lending-opportunity discovery",
    date: "2026-03-01",
    effectiveAt: 1772380525,
    summary:
      "Yield Intelligence expanded beyond explicitly yield-bearing tokens by automatically discovering best lending pools for safer non-yield-bearing coins.",
    impact: [
      "Added allowlist-based auto-discovery pass over DeFiLlama lending pools",
      "Eligibility gated by safety score threshold before pool selection",
      "Introduced defillama-auto source type and lending-opportunity yield classification",
    ],
    commits: ["2b1a551"],
    reconstructed: true,
  },
  {
    version: "2.1",
    title: "Warning-signal telemetry and fxUSD native mapping",
    date: "2026-03-01",
    effectiveAt: 1772380127,
    summary:
      "Yield rows gained warning-signal state for anomaly detection, while deterministic pool coverage expanded with fxUSD native yield mapping.",
    impact: [
      "warning_signals persistence added with spike/divergence/trend/reward/TVL-outflow checks",
      "Signal detection now uses market-median APY and prior TVL context per coin",
      "Tier-2 deterministic source map added explicit fxUSD Stability Pool coverage",
    ],
    commits: ["dcdefde", "35f8021"],
    reconstructed: true,
  },
  {
    version: "2.0",
    title: "Wave-1 coverage expansion and numerical hardening",
    date: "2026-03-01",
    effectiveAt: 1772378501,
    summary:
      "Wave-1 expanded native/wrapper mappings and tightened core PYS stability math to avoid edge-case distortion.",
    impact: [
      "Added wave-1 variant/pool mappings for additional native-yield stablecoins",
      "Near-zero mean handling in stability/variance math prevents coefficient-of-variation blowups",
      "Safety fallback and finite-value guards were formalized for ranking writes",
    ],
    commits: ["f5ecd72", "6b327eb"],
    reconstructed: true,
  },
  {
    version: "1.1",
    title: "Launch-audit corrections for APY windowing and display",
    date: "2026-03-01",
    effectiveAt: 1772375700,
    summary:
      "Early launch audit corrected APY window semantics and cleaned up yield stability presentation/lookup behavior.",
    impact: [
      "7-day APY switched to timestamp-window filtering instead of proportional sample slicing",
      "Tier-1 previous exchange-rate reads were reused from cached lookup state",
      "Yield stability display normalized as a true 0-100 percentage in UI components",
    ],
    commits: ["873842c"],
    reconstructed: true,
  },
  {
    version: "1.0",
    title: "Initial Yield Intelligence release",
    date: "2026-03-01",
    effectiveAt: 1772370812,
    summary:
      "Launched Yield Intelligence schema, cron computation pipeline, API surface, and dashboard integration.",
    impact: [
      "Introduced three-tier APY resolution (on-chain rate, DeFiLlama pool, NAV price-derived fallback)",
      "Launched PYS model (risk penalty + variance sustainability multiplier + scaling factor)",
      "Added yield_data/yield_history tables and public yield-rankings/yield-history API handlers",
    ],
    commits: ["0709a1d", "569664e", "22695dc", "81ba632", "0e7b8b3"],
    reconstructed: true,
  },
  ],
});

/** Display-ready Yield Intelligence methodology version (with "v" prefix). */
export const YIELD_METHODOLOGY_VERSION_LABEL = yieldMethodology.versionLabel;

/** Public changelog route for Yield Intelligence methodology history. */
export const YIELD_METHODOLOGY_CHANGELOG_PATH = yieldMethodology.changelogPath;

/** Reconstructed changelog data. */
export const YIELD_METHODOLOGY_CHANGELOG = yieldMethodology.changelog;
