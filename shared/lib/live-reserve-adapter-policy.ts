import type { LiveReserveAdapterValidationPolicy } from "../types/live-reserve-core";

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

export const MATERIAL_UNKNOWN_EXPOSURE_PCT = 5;
export const DASHBOARD_SOURCE_MAX_AGE_SEC = 3 * DAY_SECONDS;
export const DISCLOSURE_SOURCE_MAX_AGE_SEC = 7 * DAY_SECONDS;
export const MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC = 33 * DAY_SECONDS;
export const LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC = 4_000_000;
export const BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC = 5 * DAY_SECONDS;
