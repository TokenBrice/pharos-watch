import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_RESOLVER_V1: readonly MethodologyChangelogEntry[] = [
  {
    version: "1.1",
    title: "Depeg Duration Resolver Reviewer",
    date: "2026-05-25",
    effectiveAt: 1779733800,
    summary:
      "Added the Depeg Duration Resolver Reviewer (DDRR), the audit layer that scores stored DDR assessments against later canonical depeg-event outcomes.",
    impact: [
      "Stores quarter-hourly DDR assessment checkpoints and reviews the first checkpoint for each event under the current methodology",
      "Publishes recovery-likelihood accuracy and average observed-minus-DDR recovery-duration error on /depeg/ and GET /api/depeg-resolver-review",
      "Keeps pending, insufficient-signal, and data-issue rows visible while excluding them from scored headline accuracy",
      "Removes terminal-lifecycle assets from live DDR readouts while DDRR scores their stored predictions as terminal outcomes",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "1.0",
    title: "Initial Depeg Duration Resolver",
    date: "2026-05-25",
    effectiveAt: 1779667200,
    summary:
      "Launched the two-stage Depeg Duration Resolver: a mechanistic Resolution Outlook (terminal vs recoverable) and a stratified empirical duration estimate over recovered historical incidents.",
    impact: [
      "Stage 1 emits an ordinal verdict (recovery_likely / at_risk / recovery_unlikely / insufficient_signal) from kill signals and recovery anchors over structural metadata and the live depeg fingerprint",
      "Stage 2 emits a depth/direction/structural-class stratified landmark estimate with per-horizon (6h/24h/7d/30d) resolution likelihood, support-gated and Wilson-bounded",
      "Verdicts are calibrated domain reads, not fitted probabilities; audit-verdict gating is not used because event provenance is unpopulated",
    ],
    commits: [],
    reconstructed: false,
  },
];
