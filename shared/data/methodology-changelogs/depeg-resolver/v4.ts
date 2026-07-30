import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_RESOLVER_V4: readonly MethodologyChangelogEntry[] = [
  {
    version: "4.0",
    title: "DDR v4 Methodology Contract",
    date: "2026-07-30",
    effectiveAt: 1785427200,
    summary:
      "DDR v4 updates terminality signals, duration landmarks, incident lifecycle grouping, support rules, and reviewer audit metadata for new predictions.",
    impact: [
      "Issuer wind-down evidence and measured exit or supply stress provide earlier terminality context, while backing concentration is gated by mechanism and observed impairment",
      "Duration labels follow canonical incident grouping, typical ranges use the 15th-85th percentiles, and comparable histories are deduplicated by coin",
      "Recovered pre-lock incidents can close and resurrect within the merge window, while regime-escalating tails begin a separate incident and prediction",
      "DDRR review rows expose repaired and split lineage and publish expected-versus-observed horizon calibration alongside realized outcomes",
    ],
    commits: [],
    reconstructed: false,
  },
];
