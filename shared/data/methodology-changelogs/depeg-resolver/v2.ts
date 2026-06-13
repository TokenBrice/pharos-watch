import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_RESOLVER_V2: readonly MethodologyChangelogEntry[] = [
  {
    version: "2.0",
    title: "Sticky Public Prediction Contract",
    date: "2026-05-27",
    effectiveAt: 1779897600,
    summary:
      "Replaced live DDR drift with DDRv2: one immutable public prediction or no-call at the 24h lock landmark, backed by manifest publication and append-only errata.",
    impact: [
      "Freezes one official public_prediction outcome per canonical incident key instead of recomputing public forecasts every run",
      "Adds pending, lock-deferred, publication-retry, no-call, frozen, and invalidated public states with live facts separated from frozen prediction payloads",
      "Anchors duration estimates to the lock timestamp and preserves frozen fields on stale responses while marking live overlays stale",
      "Moves DDRR accountability to first-published sealed outcomes and explicit coverage states rather than mutable latest snapshots",
    ],
    commits: [],
    reconstructed: false,
  },
];
