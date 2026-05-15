import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const SAFETY_SCORE_V4: readonly MethodologyChangelogEntry[] = [
    {
      version: "4.1",
      title: "Liquidity weight increase + reclassifications",
      date: "2026-02-27",
      effectiveAt: 1772150403,
      summary:
        "Liquidity weight raised to 30% as the most defining stablecoin attribute. Five coins reclassified to decentralized.",
      impact: [
        "Weights: Liquidity 25->30%, Resilience 25->20%",
        "crvUSD, FRXUSD, USR, GYD, ALUSD reclassified from centralized-dependent to decentralized",
      ],
      commits: ["122733d"],
      reconstructed: true,
    },
    {
      version: "4.0",
      title: "Peg stability becomes a multiplier",
      date: "2026-02-27",
      effectiveAt: 1772150402,
      summary:
        "Biggest structural change: peg stability removed from weighted dimensions and applied as a post-hoc power-curve multiplier.",
      impact: [
        "Peg applied as final *= (pegScore/100)^0.20 instead of 25% dimension weight",
        "Grade thresholds lowered 5 points to compensate for structural deflation",
      ],
      commits: ["6ed2ec9"],
      reconstructed: true,
    },
];
