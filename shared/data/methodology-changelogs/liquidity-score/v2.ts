import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const LIQUIDITY_SCORE_V2: readonly MethodologyChangelogEntry[] = [
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
];
