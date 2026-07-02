import { DEPEG_RESOLVER_V1 } from "../../data/methodology-changelogs/depeg-resolver/v1";
import { DEPEG_RESOLVER_V2 } from "../../data/methodology-changelogs/depeg-resolver/v2";
import { DEPEG_RESOLVER_V3 } from "../../data/methodology-changelogs/depeg-resolver/v3";
import { createMethodologyVersion } from "./base";
import {
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION,
  DDR_METHODOLOGY_VERSION_LABEL,
} from "./constants";

const ddr = createMethodologyVersion({
  currentVersion: DDR_METHODOLOGY_VERSION,
  changelogPath: DDR_METHODOLOGY_CHANGELOG_PATH,
  changelog: [...DEPEG_RESOLVER_V3, ...DEPEG_RESOLVER_V2, ...DEPEG_RESOLVER_V1],
});
const ddrV2ChangelogEntry = ddr.changelog.find((entry) => entry.version === "2.0");

export {
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION,
  DDR_METHODOLOGY_VERSION_LABEL,
} from "./constants";

/** Reconstructed changelog data. */
export const DDR_METHODOLOGY_CHANGELOG = ddr.changelog;

/** Resolve DDR methodology version active at a given Unix timestamp (seconds). */
export const getDdrMethodologyVersionAt = ddr.getVersionAt;

/** Sub-component versions surfaced in the API _meta for reproducibility. */
export const DDR_RESOLUTION_RUBRIC_VERSION = "resolution-rubric-v2";
export const DDR_DURATION_MODEL_VERSION = "duration-landmark-v1";
export const DDR_INCIDENT_GROUPING_VERSION = "incident-group-v2";
export const DDR_SUPPORT_RULES_VERSION = "support-rules-v1";

/** DDRv2 public prediction policy version. */
export const DDR_PREDICTION_POLICY_VERSION = "sticky-24h-v1";

/**
 * Canonical version-stamp object covering all six DDR methodology version
 * constants. Spread into seal inputs and payloads so a version bump in this
 * file propagates to every site atomically.
 */
export const DDR_VERSION_STAMP = {
  methodologyVersion: DDR_METHODOLOGY_VERSION,
  methodologyVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
  predictionPolicyVersion: DDR_PREDICTION_POLICY_VERSION,
  resolutionRubricVersion: DDR_RESOLUTION_RUBRIC_VERSION,
  durationModelVersion: DDR_DURATION_MODEL_VERSION,
  incidentGroupingVersion: DDR_INCIDENT_GROUPING_VERSION,
  supportRulesVersion: DDR_SUPPORT_RULES_VERSION,
} as const;

/** DDRv3 forecast-readiness contract version. */
export const DDR_FORECAST_READINESS_VERSION = "readiness-72h-v1";

/** Strict early public locks require a forecast-readiness score greater than this threshold. */
export const DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD = 0.75;

/** DDRv3 readiness backstop: a public lock cannot wait beyond 72h under readiness-72h-v1. */
export const DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC = 72 * 3600;

/** Active public-lock backstop delay for pending canonical incidents under DDRv3. */
export const DDR_PUBLIC_PREDICTION_BACKSTOP_DELAY_SEC = DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC;

const ddrV2EffectiveAt = ddrV2ChangelogEntry?.effectiveAt;
if (ddrV2EffectiveAt == null) {
  throw new Error("DDR v2 changelog entry is missing its effectiveAt timestamp");
}
/** Effective timestamp of the DDR v2 methodology landmark (sourced from the v2 changelog entry). */
export const DDR_V2_EFFECTIVE_AT = ddrV2EffectiveAt;

/** DDRv2 freezes public predictions after the 24h landmark. */
export const DDR_PUBLIC_PREDICTION_DELAY_SEC = 24 * 3600;

/** Normal quarter-hour cron cadence plus edge jitter for on-time lock labeling. */
export const DDR_LOCK_ON_TIME_GRACE_SEC = 20 * 60;

/** DDRv2 cache/manifest generation values. */
export const DDR_SNAPSHOT_CACHE_GENERATION = 2;
export const DDRR_SNAPSHOT_CACHE_GENERATION = 2;
export const DDRR_REVIEWER_VERSION = "ddr-reviewer-v3";
