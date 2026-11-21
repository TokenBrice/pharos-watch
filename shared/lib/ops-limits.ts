export const CIRCUIT_OPEN_THRESHOLD = 3;
export const CIRCUIT_PROBE_INTERVAL_SEC = 1800; // 30 min

/**
 * Operator-issued (`standard`) partner keys by plan: free partner, commercial,
 * and institutional. The default applies when the ops form leaves the rate empty.
 */
export const API_KEY_FREE_PARTNER_RATE_LIMIT_PER_MINUTE = 60;
export const API_KEY_COMMERCIAL_RATE_LIMIT_PER_MINUTE = 120;
export const API_KEY_INSTITUTIONAL_RATE_LIMIT_PER_MINUTE = 600;
export const API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE = API_KEY_FREE_PARTNER_RATE_LIMIT_PER_MINUTE;
export const API_KEY_MIN_RATE_LIMIT_PER_MINUTE = 1;
export const API_KEY_MAX_RATE_LIMIT_PER_MINUTE = 10_000;
export const API_KEY_DEFAULT_EXPIRY_SEC = 90 * 24 * 60 * 60;
export const API_KEY_DEPENDENCY_RETRY_AFTER_SEC = 60;

export const FEEDBACK_RATE_LIMIT_WINDOW_SEC = 600;
export const FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS = 3;
export const FEEDBACK_GLOBAL_RATE_LIMIT_WINDOW_SEC = 3600;
export const FEEDBACK_GLOBAL_RATE_LIMIT_MAX_SUBMISSIONS = 30;

/**
 * Donor (supporter) API keys: one per eligible wallet. Each counted
 * `DONOR_API_KEY_MIN_USD` buys `DONOR_API_KEY_DAYS_PER_MIN_USD` days of
 * access, pro rata; see `creditDonorKey`.
 */
export const DONOR_API_KEY_MIN_USD = 10;
export const DONOR_API_KEY_DAYS_PER_MIN_USD = 30;
/**
 * 00:00 UTC on the day after the release that introduced expiring keys.
 * Donations before it were made under the original no-expiry terms: a wallet
 * whose counted donations before it reach the minimum still gets a key
 * without expiry.
 */
export const DONOR_API_KEY_TERMS_START_SEC = 1_794_873_600;
export const DONOR_API_KEY_RATE_LIMIT_PER_MINUTE = 10;
/** Signed claim messages older or newer than this are rejected. */
export const DONOR_KEY_CLAIM_MAX_AGE_SEC = 5 * 60;

/**
 * Monthly request volume included with each key, counted per UTC calendar
 * month. `api_keys.monthly_request_quota` overrides the tier default for one
 * key. Enforcement starts at `API_KEY_MONTHLY_QUOTA_EFFECTIVE_SEC` so existing
 * key holders get at least 30 days' notice
 * (`API_BREAKING_CHANGE_NOTICE_DAYS` in `public-api-contract.ts`).
 */
export const DONOR_API_KEY_MONTHLY_REQUEST_QUOTA = 100_000;
export const API_KEY_FREE_PARTNER_MONTHLY_REQUEST_QUOTA = 500_000;
export const API_KEY_COMMERCIAL_MONTHLY_REQUEST_QUOTA = 1_000_000;
export const API_KEY_INSTITUTIONAL_MONTHLY_REQUEST_QUOTA = 5_000_000;
/** 2027-01-01T00:00:00Z. */
export const API_KEY_MONTHLY_QUOTA_EFFECTIVE_SEC = 1_798_761_600;
