import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const MINT_BURN_FLOW_V2: readonly MethodologyChangelogEntry[] = [
  {
    version: "2.1",
    title: "Grade-aware flight-to-quality classification",
    date: "2026-03-01",
    effectiveAt: 1772379888,
    summary:
      "Flight-to-quality shifted from static safe-haven lists to report-card score buckets, with fallback only when grade data is stale or missing.",
    impact: [
      "Safe/risky FTQ buckets now derive from report-card scores (safe >= 65, risky < 50, neutral ignored)",
      "Static safe-haven sets are now fallback-only for unavailable or stale report-card cache",
      "Largest-event attribution aligned to requested window semantics in aggregate mode",
    ],
    commits: ["dcdefde", "c1c1839"],
    reconstructed: true,
  },
  {
    version: "2.0",
    title: "USDT treasury-event capture and partial-data gauge support",
    date: "2026-03-01",
    effectiveAt: 1772375712,
    summary:
      "Coverage and scoring robustness were upgraded to capture USDT treasury mint/burn events and keep the gauge active during early-history ramp.",
    impact: [
      "Added `startBlock` per config for near-history initialization instead of scanning from genesis",
      "USDT now tracks `Issue` and `Redeem` events that do not emit standard `Transfer` mints/burns",
      "Gauge now computes from available non-null FIS inputs instead of returning null when any coin lacks sufficient history",
    ],
    commits: ["2144236", "1eddad0"],
    reconstructed: true,
  },
];
