import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const BLACKLIST_TRACKER_V2: readonly MethodologyChangelogEntry[] = [
  {
    version: "2.2",
    title: "Precision and integrity hardening",
    date: "2026-02-18",
    effectiveAt: 1771432970,
    summary:
      "Amount math and log parsing were hardened to reduce silent corruption and improve sync telemetry.",
    impact: [
      "Token amounts switched to BigInt-safe decimal conversion to avoid large-value precision loss",
      "Malformed EVM logs (invalid block/timestamp) are discarded instead of being inserted",
      "Sync now emits structured run metadata (`itemCount`, `contractsSkipped`, budget usage)",
    ],
    commits: ["c6c1391", "7bc5361", "e950f76"],
    reconstructed: true,
  },
  {
    version: "2.1",
    title: "Pre-block balance sampling and zero-amount recovery",
    date: "2026-02-18",
    effectiveAt: 1771426563,
    summary:
      "Balance attribution moved to pre-event block semantics, and backfill began explicitly reprocessing suspicious zero blacklist amounts.",
    impact: [
      "Balance enrichment samples `blockNumber - 1` for blacklist, unblacklist, and destroy",
      "Backfill now re-attempts rows with `amount = 0` for blacklist events",
      "Reduces same-block ordering artifacts that previously produced false zeros",
    ],
    commits: ["d7e0ad4"],
    reconstructed: true,
  },
  {
    version: "2.0",
    title: "L2 balance reliability and budgeted full-scan loop",
    date: "2026-02-12",
    effectiveAt: 1770882143,
    summary:
      "Major tracking architecture shift for L2 correctness and deterministic scan coverage under strict subrequest budgets.",
    impact: [
      "Introduced shared per-run subrequest budgeting with least-synced-first config ordering",
      "L2 balance sourcing evolved from Etherscan-only to RPC/dRPC archive-aware historical balance fetches",
      "Backfill moved ahead of incremental scan and EVM head caching reduced redundant rescans",
    ],
    commits: ["58c4f05", "77dad70", "28a7ead", "add68dc", "fb7e7d6", "7d9e677"],
    reconstructed: true,
  },
];
