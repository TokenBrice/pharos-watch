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

/**
 * Sentinel `alert_snooze_until_ts` value marking a chat as durably "Paused"
 * (`/pause`). 2100-01-01 UTC — far enough out that the snooze filter treats the
 * chat as indefinitely suppressed, while a normal timed snooze (max 24h) can
 * never collide with it. Paused is a value convention layered on the existing
 * snooze column, so no migration or routing change is needed.
 */
export const PAUSE_SENTINEL_TS = 4102444800;

/** True when a snooze timestamp is the durable Paused sentinel (exact match). */
export function isPausedSentinel(ts: number | null | undefined): boolean {
  return ts === PAUSE_SENTINEL_TS;
}

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
  reserve: PENDING_TTL_SEC,
  adminBroadcast: 30 * 60,
  legacy: PENDING_TTL_SEC,
} as const;

/** The dedicated Telegram alert dispatcher runs every five minutes. */
export const TELEGRAM_DISPATCH_INTERVAL_SEC = 5 * 60;

/**
 * Fresh-send soft deadline for one dispatch invocation. The outer cron lease is
 * longer, but fresh Telegram batches should stop early enough that the next
 * five-minute lane is not blocked by slow Bot API responses.
 */
export const TELEGRAM_DISPATCH_SOFT_DEADLINE_MS = 4 * 60_000;

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

/** Ambiguous retry_after values at or above this are treated as bot-wide flood limits. */
export const TELEGRAM_GLOBAL_RATE_LIMIT_RETRY_AFTER_THRESHOLD_SEC = 30;

/** Distinct chat-scoped 429s in one send loop that imply a bot-wide flood limit. */
export const TELEGRAM_GLOBAL_RATE_LIMIT_DISTINCT_CHAT_THRESHOLD = 3;

/**
 * Approximate alert lines that fit in one delivered message chunk. Used purely
 * as a cheap (no-format) chunk estimate when selecting which candidate chats to
 * format ahead of a fresh send (C102). Mirrors the load harness assumption.
 */
export const TELEGRAM_ALERTS_PER_MESSAGE_CHUNK_ESTIMATE = 16;

/**
 * Small headroom added to `TELEGRAM_MAX_MESSAGES_PER_RUN` when deciding how many
 * candidate chats to format before a fresh send (C102). The pending drain can
 * only shrink the real fresh budget below this run, so formatting up to the full
 * per-run cap plus a manifest/overflow allowance never under-formats a chat that
 * could plausibly be sent fresh, while bounding worst-case formatting CPU in a
 * market-wide burst.
 */
export const TELEGRAM_FORMAT_BUDGET_ALLOWANCE = 64;

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
  reserve: 30,
  riskAlert: 30,
  legacy: 50,
  adminBroadcast: 90,
} as const;

// ---------- Webhook disambiguation ----------

/** TTL for pending ticker-disambiguation rows (5 minutes). */
export const DISAMBIGUATION_TTL_SEC = 5 * 60;

// ---------- Processed-updates retention ----------

/** Retain processed `telegram_processed_updates` rows for 7 days for replay-ack idempotency. */
export const TELEGRAM_PROCESSED_UPDATE_RETENTION_SEC = 7 * 24 * 60 * 60;

/** A `processing` claim older than this is considered stale and can be reclaimed by another worker. */
export const TELEGRAM_PROCESSING_STALE_SEC = 5 * 60;

// ---------- Webhook ingress tuning ----------

/**
 * Cache TTL for the per-chat welcome-on-add idempotency marker. Telegram can
 * deliver `my_chat_member` repeatedly for the same chat, so we suppress the
 * welcome message for 24h once sent.
 */
export const TELEGRAM_GROUP_WELCOME_CACHE_TTL_SEC = 24 * 60 * 60;

/** Generous per-chat cap across commands, callbacks, and pending text replies. */
export const CHAT_COMMAND_FLOOD_WINDOW_SEC = 60;
export const CHAT_COMMAND_FLOOD_LIMIT = 20;
export const GROUP_CHAT_COMMAND_FLOOD_LIMIT = CHAT_COMMAND_FLOOD_LIMIT * 4;

/** Cooldown for expensive group-admin diagnostic lookups. */
export const GROUP_ADMIN_DIAGNOSTIC_COOLDOWN_SEC = 20;

// ---------- Bulk subscribe/unsubscribe confirmation gate ----------

/**
 * Bulk subscribe/unsubscribe commands are gated behind an inline Confirm/Cancel
 * keyboard when the resolved coin set exceeds this threshold OR the literal
 * `all` token was used.
 */
export const BULK_CONFIRM_COIN_THRESHOLD = 10;

/** Maximum number of coin symbols to inline in the bulk-confirm preview line. */
export const BULK_CONFIRM_PREVIEW_LIMIT = 5;

// ---------- /list manage keyboard ----------

/** Page size for the /list `[ Manage ]` keyboard. */
export const MANAGE_PAGE_SIZE = 5;

// ---------- C128: burst-aware summary / delta mode ----------

/**
 * A global-follow chat matching at least this many DISTINCT coins in a single
 * dispatch run (with global as the dominant match source) collapses to one
 * burst-summary chunk instead of a multi-coin message. Default is effectively
 * OFF — lower it only after observing `burstCollapsedChats` in dispatch
 * metadata, per the C128 rollout note (ship high, then tighten).
 */
export const BURST_EVENT_THRESHOLD = 1_000_000;

/**
 * How long a per-chat burst marker stays live. While live, a bursting chat
 * receives only coins not already summarized (delta-only); the TTL is anchored
 * to the first burst entry, not refreshed, so normal delivery resumes after it.
 */
export const BURST_MARKER_TTL_SEC = 1800;
