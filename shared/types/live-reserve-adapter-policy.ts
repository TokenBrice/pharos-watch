import type { LiveReserveAdapterValidationPolicy } from "./live-reserve-core";

const DAY_SECONDS = 86_400;

export const VERIFIED_OR_UNVERIFIED_FRESHNESS = [
  "verified",
  "unverified",
] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];
export const VERIFIED_ONLY_FRESHNESS = [
  "verified",
] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];
const NOT_APPLICABLE_ONLY_FRESHNESS = [
  "not-applicable",
] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];
export const UNVERIFIED_ONLY_FRESHNESS = [
  "unverified",
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
/** Month-end disclosures whose successor lands weeks into the following month,
 *  rather than just past the month boundary. Measured period-end to publication
 *  lag from each publisher's own report index: Paxos PAXG/PYUSD/USDP/USDG 23-28
 *  days (19 reports, 2025-01..2026-07), Ripple RLUSD 25-29 (5, 2026-01..07),
 *  Anchorage USAT/USDPT/USDGO 26-29 (12, 2026-01..07), StraitsX XSGD/XUSD 23-29
 *  (7 month-end reports, 2026-01..07; the XUSD index mirrors XSGD), Fidelity
 *  FIDD 12-25 (6, 2026-02..07), AUDX 14-28 (6, 2026-02..07), Agora AUSD 27-32
 *  (3, 2026-05..07; its 2026-07 report was signed 2026-09-01). The newest
 *  report is therefore up to 63 days old (31-day month + 32-day worst case) the
 *  day before its successor lands, so the late-monthly 46.3-day cap degraded
 *  9-17 days of every healthy cycle and the warning fired on schedule rather
 *  than on evidence. 70 days = 31 + 32 plus publication grace. Decision
 *  2026-09-24. */
export const NEXT_MONTH_DISCLOSURE_SOURCE_MAX_AGE_SEC = 70 * DAY_SECONDS;
export const QUARTERLY_ASSURANCE_MAX_AGE_SEC = 100 * DAY_SECONDS;
export const BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC = 5 * DAY_SECONDS;
/** Matrixdock's issuer-transmitted `FallbackReserveFeed` rounds (XAGm silver
 *  and the XAUm sibling feed). `setReserve()` is the only writer, so a round
 *  advances only when the issuer actually changes the reserve: this is a
 *  reserve-change event, not a heartbeat, and the adapter pins the frozen
 *  answer against live `ozPerToken()` x supply. 2026-09-24 review of the
 *  contract's own `ReserveSet` history (rounds 1-7, 2026-03-13..2026-08-04)
 *  measured inter-round gaps of 7.0, 7.1, 25.7, 36.0, 15.3 and 52.7 days, so
 *  the previous 4,000,000s (46.3 day) budget degraded a healthy feed for ~6
 *  days during the 6/12 -> 8/4 cycle. 60 days = worst observed interval plus a
 *  week of issuer operating lag; the sibling XAUm feed's longer quiet interval
 *  is not used as evidence because its reserve/supply invariant was not
 *  independently reconciled. Decision 2026-09-24. */
export const MATRIXDOCK_BULLION_RESERVE_FEED_MAX_AGE_SEC = 60 * DAY_SECONDS;

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

/** Month-end disclosure whose successor is published in the following month. */
export const NEXT_MONTH_VERIFIED_VALIDATION = {
  maxSourceAgeSec: NEXT_MONTH_DISCLOSURE_SOURCE_MAX_AGE_SEC,
  allowedFreshnessModes: VERIFIED_ONLY_FRESHNESS,
} as const satisfies LiveReserveAdapterValidationPolicy;

/** Upstream that publishes no accounting timestamp at all, over a basket that
 *  may not price every holding. */
export const TIMESTAMPLESS_WITH_UNKNOWN_CAP_VALIDATION = {
  maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
  allowedFreshnessModes: UNVERIFIED_OR_NOT_APPLICABLE_FRESHNESS,
} as const satisfies LiveReserveAdapterValidationPolicy;

/** Upstream that publishes no accounting timestamp at all and is therefore
 *  only ever able to attest `unverified` freshness, over a basket that may not
 *  price every holding. The declared budget is kept so the miss stays visible,
 *  but validate.ts reports it as the informational `freshness-unverified`
 *  warning instead of the degraded `stale-source-undeterminable`, which no
 *  upstream behaviour could ever clear. Reservoir's balance-sheet API is this
 *  tier (decision 2026-09-24): its payload carries no timestamp field at all,
 *  so the previous `verified|unverified` contract degraded all three coins on
 *  every successful run. The snapshot still cannot enter collateral scoring. */
export const UNVERIFIED_ONLY_WITH_UNKNOWN_CAP_VALIDATION = {
  maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
  maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
  allowedFreshnessModes: UNVERIFIED_ONLY_FRESHNESS,
} as const satisfies LiveReserveAdapterValidationPolicy;
