import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_DEWS_V6: readonly MethodologyChangelogEntry[] = [
  {
    version: "6.02",
    title: "Explicit zero supply-history anchors",
    date: "2026-06-05",
    effectiveAt: 1780617600,
    summary:
      "DEWS now preserves explicit zero previous-day and previous-week supply-history anchors instead of treating them as missing current-supply fallbacks.",
    impact: [
      "Absent previous-day or previous-week supply history still defaults to the current supply so new or incomplete rows do not create false contraction",
      "Finite zero buckets in the stablecoins cache now remain zero when the supply-velocity input is assembled",
      "The supply sub-signal continues to treat zero baselines as zero velocity stress, avoiding divide-by-zero while keeping the input provenance explicit",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.01",
    title: "Priced-observation PegScore anchors",
    date: "2026-06-03",
    effectiveAt: 1780444800,
    summary:
      "PegScore tracking windows can now anchor from the first durable Pharos price observation when supply-history coverage is absent, so priced non-NAV assets no longer remain unrated solely because they have not written a supply snapshot.",
    impact: [
      "Curated launch dates remain the preferred tracking anchor, followed by the earliest supply_history snapshot",
      "For priced assets without either anchor, the stablecoins cache now contributes a durable first-observed valid-price timestamp through the same first-seen cache used by PegScore",
      "Newly observed priced assets still need at least 7 days of tracking before PegScore is rated; missing-price assets and pure NAV tokens remain NR",
      "Low-cap assets below the live depeg-event floor can receive a PegScore anchor, while the existing coverage-limited flag continues to warn that empty event history is not full depeg coverage",
    ],
    commits: [],
    reconstructed: false,
  },
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
