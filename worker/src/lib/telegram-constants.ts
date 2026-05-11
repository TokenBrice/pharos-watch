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

// ---------- Webhook disambiguation ----------

/** TTL for pending ticker-disambiguation rows (5 minutes). */
export const DISAMBIGUATION_TTL_SEC = 5 * 60;
