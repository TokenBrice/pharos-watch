import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const STABILITY_INDEX_V1: readonly MethodologyChangelogEntry[] = [
  {
    version: "1.3",
    title: "Sample architecture and 24h average model",
    date: "2026-02-26",
    effectiveAt: 1772066100,
    summary:
      "PSI moved to sample-first storage with daily snapshots and 24h average surfaced as the primary displayed signal.",
    impact: [
      "Introduced stability_index_samples table and daily snapshot aggregation",
      "API and UI switched to emphasize 24h average PSI",
      "Historical backfill path adjusted for peak-deviation realism",
    ],
    commits: ["9508e29", "ad75f4f"],
    reconstructed: true,
  },
  {
    version: "1.2",
    title: "15-minute chained compute + depeg depreciation/dedup",
    date: "2026-02-25",
    effectiveAt: 1772057625,
    summary:
      "Operational and methodological upgrade to live 15-minute PSI with chronic-depeg depreciation and per-coin deduplication.",
    impact: [
      "PSI compute moved to chained 15-minute cron after stablecoin sync",
      "Introduced chronic-depeg depreciation (grace 30d, decay 120d, floor 25%)",
      "Active depegs deduped per coin (worst current bps, earliest start for age)",
    ],
    commits: ["8acaa7d", "a79049d", "2dfb975", "615256a"],
    reconstructed: true,
  },
  {
    version: "1.1",
    title: "Current deviation semantics",
    date: "2026-02-25",
    effectiveAt: 1772039501,
    summary:
      "Severity began using live current deviation rather than event peak deviation for active depegs.",
    impact: [
      "Live severity became recovery-sensitive instead of peak-anchored",
      "Backfill behavior later diverged and was subsequently tuned",
    ],
    commits: ["14c75e7"],
    reconstructed: true,
  },
  {
    version: "1.0",
    title: "Initial PSI release",
    date: "2026-02-25",
    effectiveAt: 1772012043,
    summary:
      "Launched PSI compute, API, cron persistence, and frontend integration.",
    impact: [
      "Initial formula: 100 - severity - breadth - freezes + trend",
      "Initial caps: severity 60, breadth 15, freezes 10",
      "Condition bands introduced",
    ],
    commits: ["c4c7caa", "c21a6bd", "5eaf440", "6b3e7e5", "a3f2b53"],
    reconstructed: true,
  },
];
