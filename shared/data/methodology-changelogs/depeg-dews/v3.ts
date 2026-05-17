import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_DEWS_V3: readonly MethodologyChangelogEntry[] = [
  {
    version: "3.2",
    title: "Tracking-window direction fix",
    date: "2026-02-27",
    effectiveAt: 1772187654,
    summary:
      "Corrected tracking-start math to avoid diluting young-coin depeg severity across pre-launch periods.",
    impact: [
      "Lookback boundary corrected from min(firstSeen, fourYearsAgo) to max(...)",
      "Peg-time and severity now computed against realistic coin lifetime bounds",
      "Young-coin scores became less artificially inflated",
    ],
    commits: ["74aa1cd"],
    reconstructed: true,
  },
  {
    version: "3.1",
    title: "Confirmation and detector hardening",
    date: "2026-02-26",
    effectiveAt: 1772117934,
    summary:
      "Hardened confirmation and detection against invalid references, non-finite values, and partial-write edge cases.",
    impact: [
      "Pending rows with invalid peg_reference are dropped before confirmation math",
      "Detection now rejects non-finite peg references before bps computation",
      "Pending confirmation mutations are batched atomically for consistent state transitions",
    ],
    commits: ["c2832ae", "61e8f9b", "c868ba2", "76aa8c6"],
    reconstructed: true,
  },
  {
    version: "3.0",
    title: "Two-stage confirmation for large-cap depegs",
    date: "2026-02-25",
    effectiveAt: 1772018098,
    summary:
      "Large-cap depeg detection moved from single-source trigger to a pending-confirmation pipeline with secondary-source validation.",
    impact: [
      ">= $1B coins now route through depeg_pending before promotion to depeg_events",
      "Secondary agreement uses CoinGecko and/or DEX with a 50% threshold bar",
      "sync-stablecoins now runs detectDepegEvents and confirmPendingDepegs sequentially each cycle",
    ],
    commits: ["ece06dd", "c1adfa7", "5fac720", "9854efe", "8c5a9b9"],
    reconstructed: true,
  },
];
