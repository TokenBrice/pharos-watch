import { createMethodologyVersion } from "./base";

const ddr = createMethodologyVersion({
  currentVersion: "2.0",
  changelogPath: "/methodology/depeg-resolver-changelog/",
  changelog: [
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

/** DDRv2 public prediction policy version. */
export const DDR_PREDICTION_POLICY_VERSION = "sticky-24h-v1";

/** May 27, 2026 00:00:00 UTC. */
export const DDR_V2_EFFECTIVE_AT = 1779897600;

/** DDRv2 freezes public predictions after the 24h landmark. */
export const DDR_PUBLIC_PREDICTION_DELAY_SEC = 24 * 3600;

/** Normal quarter-hour cron cadence plus edge jitter for on-time lock labeling. */
export const DDR_LOCK_ON_TIME_GRACE_SEC = 20 * 60;

/** DDRv2 cache/manifest generation values. */
export const DDR_SNAPSHOT_CACHE_GENERATION = 2;
export const DDRR_SNAPSHOT_CACHE_GENERATION = 2;
export const DDRR_REVIEWER_VERSION = "ddr-reviewer-v2";
