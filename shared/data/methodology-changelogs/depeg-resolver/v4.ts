import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_RESOLVER_V4: readonly MethodologyChangelogEntry[] = [
  {
    version: "4.1",
    title: "Structural inputs read published Safety Score outputs",
    date: "2026-08-08",
    effectiveAt: 1786147201,
    summary:
      "DDR's mint-authority structural input now reads the published Safety Score V9 mint posture band instead of the retired standalone Mint Authority band. Prediction weights, factor rules, and exit thresholds are unchanged.",
    impact: [
      "K1's risky-minter test reads the published V9 mint posture band; the concentrated and exposed bands stay the risky set, so the rule is unchanged and only its input moved engines",
      "A run with no installed V9 publication leaves the band absent and K1 falls back to its authority-posture and mint-path legs, as it already did for unscoreable assets",
      "K5 inputs are unchanged: it already read published Safety Score outputs and continues to do so",
      "No factor weights, severity bands, duration landmarks, or incident-lifecycle rules change",
    ],
    commits: [],
    reconstructed: false,
  },
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
