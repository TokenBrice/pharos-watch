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
      detail: [
        { kind: "paragraph", text: "Liquidity 25%→30% (“swappability is the most defining aspect of a stablecoin”), resilience 25%→20%." },
        { kind: "paragraph", text: "5 coins reclassified from centralized-dependent to decentralized: crvUSD, FRXUSD, USR, GYD, ALUSD." },
        { kind: "weights", values: ["multiplier", "30%", "—", "20%", "15%", "25%"] },
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
      detail: [
        {
          kind: "paragraph",
          text: [{ emphasis: "Biggest structural change." }, " Peg Stability removed from the weighted base dimensions entirely and applied as a post-hoc power-curve multiplier:"],
        },
        { kind: "formula", text: "final = base × (pegScore / 100) ^ 0.20" },
        {
          kind: "table",
          ariaLabel: "Safety Score v4 pegScore multiplier examples",
          tableId: "scoring-v4-pegscore-multiplier",
          testId: "scoring-v4-pegscore-multiplier-table",
          columns: [
            { id: "pegScore", label: "pegScore", rowHeader: true },
            { id: "multiplier", label: "Multiplier" },
            { id: "impact", label: "Impact" },
          ],
          rows: [
            { id: "100", cells: { pegScore: "100", multiplier: "1.000", impact: "none" } },
            { id: "90", cells: { pegScore: "90", multiplier: "≈0.979", impact: "−2%" } },
            { id: "50", cells: { pegScore: "50", multiplier: "≈0.870", impact: "−13%" } },
            { id: "10", cells: { pegScore: "10", multiplier: "≈0.631", impact: "−37%" } },
            { id: "0", cells: { pegScore: "0", multiplier: "0", impact: "dead" } },
          ],
        },
        { kind: "paragraph", text: "Grade thresholds lowered 5 points to compensate for structural deflation. Minimum rated base dimensions reduced from 3 to 2." },
        { kind: "weights", values: ["multiplier", "25%", "—", "25%", "10%", "30%"] },
      ],
      commits: ["6ed2ec9"],
      reconstructed: true,
    },
];
