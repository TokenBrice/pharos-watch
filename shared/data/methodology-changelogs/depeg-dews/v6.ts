import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_DEWS_V6: readonly MethodologyChangelogEntry[] = [
  {
    version: "6.0",
    title: "Historical provenance, quality-aware PegScore, and calibration metrics",
    date: "2026-05-14",
    effectiveAt: 1778716800,
    summary:
      "Depeg history now records durable replay/audit provenance, PegScore discounts weak or disputed historical rows, and DEWS backtests report calibration metrics from stored stress-signal history.",
    impact: [
      "Backfill runs persist replay status, counts, fingerprints, source providers, quote mode, peg-reference/supply source, confidence tier, and public provenance projections",
      "Audit verdicts are direction-aware and persist confirmed, disputed, false_positive, no_data, and repaired-style outcomes without deleting rows solely because audit data is weak or absent",
      "PegScore excludes false-positive/disputed events and downweights low-confidence rows while surfacing quality-adjustment counters to callers",
      "DEWS calibration metrics now use stored stress_signal_history as the primary source and report precision, recall, false-positive days, false-negative incidents, lead-time percentiles, churn, and cohorts",
    ],
    commits: [],
    reconstructed: false,
  },
];
