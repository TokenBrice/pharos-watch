/**
 * Centralized Telegram-related magic numbers and tokens.
 *
 * These values were previously scattered across the Telegram alert pipeline
 * (alerts, pending-queue, webhook callbacks, insights, parsing). Centralizing
 * them here gives a single source of truth so a tweak does not require
 * grepping multiple files, and so tests can assert their shape from one place.
 *
 * Original modules continue to re-export each constant from its prior
 * location for backward compatibility — no callers need to change imports.
 */

// ---------- Depeg-step subscription values ----------

/** Allowed bps values for the depeg-step subscription setting. */
export const DEPEG_STEP_VALUES = [100, 250, 500] as const;

export type DepegStepValue = (typeof DEPEG_STEP_VALUES)[number];

/** Type guard for depeg-step values (`100 | 250 | 500`). */
export function isDepegStepValue(value: unknown): value is DepegStepValue {
  return (
    typeof value === "number" &&
    (DEPEG_STEP_VALUES as readonly number[]).includes(value)
  );
}

// ---------- Snooze durations ----------

/** Snooze callback arg → duration in seconds. */
export const SNOOZE_SECONDS = {
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "24h": 24 * 60 * 60,
} as const;

// ---------- Top-N insight views ----------

/** Recognized `/top` view names (used for routing + did-you-mean suggestions). */
export const TOP_VIEW_NAMES = ["depeg", "dews", "yield", "liquidity", "chains", "safety"] as const;

// ---------- Message chunking ----------

/**
 * Telegram's per-message character cap is 4096; we leave a small safety margin
 * for the chunk-counter suffix and other appended metadata.
 */
export const TELEGRAM_MESSAGE_CHUNK_LIMIT = 4000;

/**
 * Stable version tag for the message chunking algorithm. Bump whenever the
 * splitting logic (boundaries, repair, ordering) changes in a way that would
 * alter the chunks produced from the same canonical body.
 */
export const TELEGRAM_SPLIT_VERSION = 1;

// ---------- Pending-queue tuning ----------

/** Stale-row TTL for the pending alerts queue (1 hour). */
export const PENDING_TTL_SEC = 3600;

export const TELEGRAM_ALERT_TTL_SEC = {
  depeg: PENDING_TTL_SEC,
  dews: PENDING_TTL_SEC,
  safety: PENDING_TTL_SEC,
  launch: 30 * 60,
  adminBroadcast: 30 * 60,
  legacy: PENDING_TTL_SEC,
} as const;

/** The dedicated Telegram alert dispatcher runs every five minutes. */
export const TELEGRAM_DISPATCH_INTERVAL_SEC = 5 * 60;

/**
 * Upper bound on message attempts per dispatcher run.
 *
 * This keeps the same `SEND_BATCH_SIZE = 4` connection footprint but allows
 * the dedicated five-minute Telegram slot to drain a 5k-watcher broad alert
 * inside the normal/spike SLO envelope when Bot API latency is healthy.
 */
export const TELEGRAM_MAX_MESSAGES_PER_RUN = 3600;

/** Pending drain share reserved from the per-run Telegram send budget. */
export const TELEGRAM_PENDING_DRAIN_BUDGET = Math.floor(TELEGRAM_MAX_MESSAGES_PER_RUN / 4);

/** Parallel sends per batch (leave Workers connection headroom). */
export const SEND_BATCH_SIZE = 4;

/** Defensive ceiling so a pathological row cannot loop forever inside the TTL window. */
export const PENDING_MAX_ATTEMPTS = 20;

/**
 * Exponential backoff schedule (seconds) indexed by prior attempt count.
 * Used when Telegram does not return a `Retry-After` header.
 */
export const PENDING_BACKOFF_SCHEDULE_SEC = [60, 120, 240, 480, 600] as const;

/**
 * Two-strike window for 403 (Forbidden / bot blocked): a single 403 is
 * transient; only after a second 403 within this window do we clear flags.
 */
export const BLOCK_STRIKE_WINDOW_SEC = 24 * 3600;

/** Pending rows older than this need operator attention before TTL risk builds. */
export const PENDING_OLD_AGE_ALERT_SEC = 15 * 60;

/** Estimated drain times above this are considered degraded. */
export const PENDING_DRAIN_TIME_ALERT_SEC = 30 * 60;

/** Rows inside this window from expiry count as near-TTL risk. */
export const PENDING_NEAR_TTL_WINDOW_SEC = 15 * 60;

export const TELEGRAM_PENDING_PRIORITY = {
  depeg: 10,
  dews: 20,
  safety: 20,
  launch: 30,
  riskAlert: 30,
  legacy: 50,
  adminBroadcast: 90,
} as const;

// ---------- Webhook disambiguation ----------

/** TTL for pending ticker-disambiguation rows (5 minutes). */
export const DISAMBIGUATION_TTL_SEC = 5 * 60;
