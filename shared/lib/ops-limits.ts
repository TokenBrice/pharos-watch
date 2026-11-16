export const CIRCUIT_OPEN_THRESHOLD = 3;
export const CIRCUIT_PROBE_INTERVAL_SEC = 1800; // 30 min

export const API_KEY_DEFAULT_RATE_LIMIT_PER_MINUTE = 120;
export const API_KEY_MIN_RATE_LIMIT_PER_MINUTE = 1;
export const API_KEY_MAX_RATE_LIMIT_PER_MINUTE = 10_000;
export const API_KEY_DEFAULT_EXPIRY_SEC = 90 * 24 * 60 * 60;
export const API_KEY_DEPENDENCY_RETRY_AFTER_SEC = 60;

export const FEEDBACK_RATE_LIMIT_WINDOW_SEC = 600;
export const FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS = 3;
export const FEEDBACK_GLOBAL_RATE_LIMIT_WINDOW_SEC = 3600;
export const FEEDBACK_GLOBAL_RATE_LIMIT_MAX_SUBMISSIONS = 30;

export const SELF_SERVE_API_KEY_RATE_LIMIT_PER_MINUTE = 30;

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
