import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_RESOLVER_V5: readonly MethodologyChangelogEntry[] = [
  {
    version: "5.92",
    title: "Continuous depeg windows and reason-authoritative recovery labels",
    date: "2026-08-23",
    effectiveAt: 1787443200,
    summary:
      "Depeg onset and recovery windows now require consecutive observations no more than one producer interval apart, while DDR training and DDRR review classify recovery from explicit closure reasons with a legacy price fallback only for null-reason rows.",
    impact: [
      "Same-direction pending episodes reset after an observation gap greater than 1200 seconds, so a blind interval cannot backdate a confirmed onset",
      "Recovery confirmation stores both first and last qualified observations, resets after a gap greater than 1200 seconds or contradictory evidence, and keeps events open through missing data",
      "Explicit recovered-primary, recovered-dex, and recovered-native reasons define recovered labels even when native quote-domain policy stores no recovery price",
      "Direction supersession, coverage loss, orphan cleanup, and unknown explicit closures cannot enter the recovered duration corpus or DDRR recovered outcomes through a stray recovery price",
      "Legacy rows with null close reasons retain recovery-price compatibility so historical recovered labels are not erased",
    ],
    commits: [],
    reconstructed: false,
  },
];
