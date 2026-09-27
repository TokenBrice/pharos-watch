import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const BLACKLIST_TRACKER_V4: readonly MethodologyChangelogEntry[] = [
  {
    version: "4.1",
    title: "Execution-order state and durable malformed-log quarantine",
    date: "2026-09-27",
    effectiveAt: 1790467200,
    summary: "Orders EVM state transitions by block-global log position and explicitly withholds ambiguous Tron state. Malformed required fields receive three scan observations before durable quarantine.",
    impact: [
      "Timestamp, block number, numeric log index, and array suffix replace lexical transaction-hash ordering across state folds, SQL history selection, and ledger rebuilds.",
      "Same-block Tron events across transactions do not imply a known order; affected records are excluded from confirmed active counts and reported as tron-cross-transaction-order.",
      "Missing or invalid direction bools, address arrays, addresses, and log identities hold the frontier for up to three distinct scans, then retain source evidence and a named decode-retry-exhausted disposition in durable storage.",
      "A valid empty address array remains a complete observation; unknown event-time amounts remain separate from required state evidence.",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.0",
    title: "Canonical reviewed exposure status",
    date: "2026-08-11",
    effectiveAt: 1786406400, // 2026-08-11T00:00:00Z
    summary:
      "Makes the sourced blacklistability review the sole product-level FreezeWatch status authority, removing the parallel authored override and runtime inference path without changing current classifications.",
    impact: [
      "`blacklistabilityReview.reviewedStatus` is now the only authored Yes, Upstream, Possible, or No verdict",
      "The generated client-registry `blacklistStatus` is a direct projection of that verdict for FreezeWatch, Report Cards, coverage views, and Selector data",
      "Safety Score V9 continues to consume the same review for evidence and scoring, but its access projection is no longer a fallback product-status source",
      "All 404 tracked stablecoin classifications are unchanged by the migration",
    ],
    commits: [],
    reconstructed: false,
  },
];
