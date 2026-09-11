import type { LiveReserveAdapterValidationPolicy } from "./live-reserve-core";

const DAY_SECONDS = 86_400;

export const VERIFIED_OR_UNVERIFIED_FRESHNESS = [
  "verified",
  "unverified",
] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];
export const VERIFIED_ONLY_FRESHNESS = [
  "verified",
] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];
export const NOT_APPLICABLE_ONLY_FRESHNESS = [
  "not-applicable",
] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];
export const UNVERIFIED_OR_NOT_APPLICABLE_FRESHNESS = [
  "unverified",
  "not-applicable",
] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];
/** Every mode the runtime can emit: the adapter's freshness depends on which
 *  probe path a coin's params select, so no single mode is the contract. */
export const ANY_FRESHNESS = [
  "verified",
  "unverified",
  "not-applicable",
] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];

export const MATERIAL_UNKNOWN_EXPOSURE_PCT = 5;
export const DASHBOARD_SOURCE_MAX_AGE_SEC = 3 * DAY_SECONDS;
export const DISCLOSURE_SOURCE_MAX_AGE_SEC = 7 * DAY_SECONDS;
export const WEEKLY_SOURCE_MAX_AGE_SEC = DISCLOSURE_SOURCE_MAX_AGE_SEC;
export const MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC = 33 * DAY_SECONDS;
export const LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC = 4_000_000;
/** Monthly examinations issued 30-41 days after their as-of date on a ~30-day
 *  cadence (Gemini/BPM GUSD, 94 reports through 2026-05): the newest report is
 *  up to ~71 days old the day before its successor lands, so the late-monthly
 *  46-day cap degraded ~16 days of every healthy cycle. 75 days = observed
 *  worst case plus publication grace. Decision 2026-09-11. */
export const LAGGED_MONTHLY_EXAMINATION_SOURCE_MAX_AGE_SEC = 75 * DAY_SECONDS;
export const QUARTERLY_DISCLOSURE_SOURCE_MAX_AGE_SEC = 10_000_000;
export const QUARTERLY_ASSURANCE_MAX_AGE_SEC = 100 * DAY_SECONDS;
export const BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC = 5 * DAY_SECONDS;

// Named validation tiers. Every adapter that shares a tier must share the
// constant so a policy change is one edit, and a bespoke block in the
// declaration table reads as a deliberate exception with its own comment.

/** Same-run reads of current state: there is no upstream publication to age. */
export const LATEST_STATE_VALIDATION = {
  allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS,
} as const satisfies LiveReserveAdapterValidationPolicy;

/** Latest-state reads over a basket that may not price every holding. */
export const LATEST_STATE_WITH_UNKNOWN_CAP_VALIDATION = {
  maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
  allowedFreshnessModes: NOT_APPLICABLE_ONLY_FRESHNESS,
} as const satisfies LiveReserveAdapterValidationPolicy;

/** Upstream feed whose publication timestamp is optional and uncapped. */
export const TIMESTAMPED_FEED_VALIDATION = {
  allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
} as const satisfies LiveReserveAdapterValidationPolicy;

/** Upstream feed that must carry a publication timestamp, uncapped. */
export const VERIFIED_ONLY_VALIDATION = {
  allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
} as const satisfies LiveReserveAdapterValidationPolicy;

/** Issuer/protocol dashboard refreshed at least every few days. */
export const DASHBOARD_VALIDATION = {
  maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
  allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
} as const satisfies LiveReserveAdapterValidationPolicy;

/** Dashboard feed over a basket that may not price every holding. */
export const DASHBOARD_WITH_UNKNOWN_CAP_VALIDATION = {
  maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
  maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
  allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
} as const satisfies LiveReserveAdapterValidationPolicy;

/** Dashboard feed whose publication timestamp is mandatory. */
export const DASHBOARD_VERIFIED_VALIDATION = {
  maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
  allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
} as const satisfies LiveReserveAdapterValidationPolicy;

/** Weekly issuer disclosure feed. */
export const DISCLOSURE_VALIDATION = {
  maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC,
  allowedFreshnessModes: VERIFIED_OR_UNVERIFIED_FRESHNESS,
} as const satisfies LiveReserveAdapterValidationPolicy;

/** Monthly attestation or assurance report. */
export const MONTHLY_VERIFIED_VALIDATION = {
  maxSourceAgeSec: MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
  allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
} as const satisfies LiveReserveAdapterValidationPolicy;

/** Monthly report whose publisher routinely lands past the month boundary. */
export const LATE_MONTHLY_VERIFIED_VALIDATION = {
  maxSourceAgeSec: LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
  allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
} as const satisfies LiveReserveAdapterValidationPolicy;

/** Monthly examination whose issuance lags the as-of date by more than a month. */
export const LAGGED_MONTHLY_EXAMINATION_VALIDATION = {
  maxSourceAgeSec: LAGGED_MONTHLY_EXAMINATION_SOURCE_MAX_AGE_SEC,
  allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
} as const satisfies LiveReserveAdapterValidationPolicy;

/** Upstream that publishes no accounting timestamp at all, over a basket that
 *  may not price every holding. */
export const TIMESTAMPLESS_WITH_UNKNOWN_CAP_VALIDATION = {
  maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
  allowedFreshnessModes: UNVERIFIED_OR_NOT_APPLICABLE_FRESHNESS,
} as const satisfies LiveReserveAdapterValidationPolicy;
