import { createMethodologyVersion } from "./base";

const ddr = createMethodologyVersion({
  currentVersion: "1.1",
  changelogPath: "/methodology/depeg-resolver-changelog/",
  changelog: [
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
  ],
});

/** Canonical DDR methodology version (no "v" prefix). */
export const DDR_METHODOLOGY_VERSION = ddr.currentVersion;

/** Display-ready DDR methodology version (with "v" prefix). */
export const DDR_METHODOLOGY_VERSION_LABEL = ddr.versionLabel;

/** Public changelog route for DDR methodology history. */
export const DDR_METHODOLOGY_CHANGELOG_PATH = ddr.changelogPath;

/** Reconstructed changelog data. */
export const DDR_METHODOLOGY_CHANGELOG = ddr.changelog;

/** Resolve DDR methodology version active at a given Unix timestamp (seconds). */
export const getDdrMethodologyVersionAt = ddr.getVersionAt;

/** Sub-component versions surfaced in the API _meta for reproducibility. */
export const DDR_RESOLUTION_RUBRIC_VERSION = "resolution-rubric-v1";
export const DDR_DURATION_MODEL_VERSION = "duration-landmark-v1";
export const DDR_INCIDENT_GROUPING_VERSION = "incident-group-v1";
export const DDR_SUPPORT_RULES_VERSION = "support-rules-v1";
