import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const MINT_BURN_FLOW_V1: readonly MethodologyChangelogEntry[] = [
  {
    version: "1.0",
    title: "Initial Mint/Burn Flow release",
    date: "2026-03-01",
    effectiveAt: 1772369418,
    summary:
      "Launched baseline mint/burn flow tracking, scoring primitives, and public API surfaces for aggregate and per-coin analysis.",
    impact: [
      "Introduced phase-1 contract coverage for 10 tracked stablecoins",
      "Shipped FIS formula, seven-band Bank Run Gauge mapping, and flight-to-quality detection thresholds",
      "Deployed incremental sync cron with `/api/mint-burn-flows` and `/api/mint-burn-events`",
    ],
    commits: ["06ad0d9", "e36a0c1", "2473c86", "fea681c"],
    reconstructed: true,
  },
];
