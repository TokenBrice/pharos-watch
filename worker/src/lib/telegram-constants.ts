/**
 * Centralized Telegram-related magic numbers and tokens.
 *
 * Non-delivery values are centralized here. Runtime-neutral delivery policy
 * lives in `shared/lib/telegram-delivery-policy.ts` and is re-exported below so
 * existing Worker callers retain one stable compatibility surface.
 *
 * Original modules continue to re-export each constant from its prior
 * location for backward compatibility — no callers need to change imports.
 */

import {
  TELEGRAM_ALERT_TTL_SEC as SHARED_TELEGRAM_ALERT_TTL_SEC,
  TELEGRAM_HISTORICAL_SOURCE_PRIORITY,
  TELEGRAM_HISTORICAL_SOURCE_TTL_SEC,
  TELEGRAM_PENDING_PRIORITY as SHARED_TELEGRAM_PENDING_PRIORITY,
} from "@shared/lib/telegram-delivery-policy";

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

// ---------- Delivery policy ----------

// Preserve the established Worker import surface while the policy itself stays
// runtime-neutral and is shared with the synthetic load guard.
/** Compatibility defaults for historical pending rows, not active alert families. */
export const TELEGRAM_ALERT_TTL_SEC = {
  ...SHARED_TELEGRAM_ALERT_TTL_SEC,
  legacy: TELEGRAM_HISTORICAL_SOURCE_TTL_SEC,
} as const;
/** Compatibility defaults for historical pending rows, not active alert families. */
export const TELEGRAM_PENDING_PRIORITY = {
  ...SHARED_TELEGRAM_PENDING_PRIORITY,
  legacy: TELEGRAM_HISTORICAL_SOURCE_PRIORITY,
} as const;

export {
  BLOCK_STRIKE_WINDOW_SEC,
  PENDING_BACKOFF_SCHEDULE_SEC,
  PENDING_DRAIN_TIME_ALERT_SEC,
  PENDING_MAX_ATTEMPTS,
  PENDING_NEAR_TTL_WINDOW_SEC,
  PENDING_OLD_AGE_ALERT_SEC,
  PENDING_TTL_SEC,
  SEND_BATCH_SIZE,
  TELEGRAM_ALERTS_PER_MESSAGE_CHUNK_ESTIMATE,
  TELEGRAM_DISPATCH_INTERVAL_SEC,
  TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
  TELEGRAM_FORMAT_BUDGET_ALLOWANCE,
  TELEGRAM_MAX_MESSAGES_PER_RUN,
  TELEGRAM_PENDING_DRAIN_BUDGET,
  TELEGRAM_HISTORICAL_SOURCE_PRIORITY,
  TELEGRAM_HISTORICAL_SOURCE_TTL_SEC,
} from "@shared/lib/telegram-delivery-policy";

// ---------- Webhook disambiguation ----------

/** TTL for pending ticker-disambiguation rows (5 minutes). */
export const DISAMBIGUATION_TTL_SEC = 5 * 60;

// ---------- Processed-updates retention ----------

/** Retain processed `telegram_processed_updates` rows for 7 days for replay-ack idempotency. */
export const TELEGRAM_PROCESSED_UPDATE_RETENTION_SEC = 7 * 24 * 60 * 60;

/** Keep ambiguous webhook effects long enough for operator reconciliation. */
export const TELEGRAM_WEBHOOK_EFFECT_UNKNOWN_RETENTION_SEC = 90 * 24 * 60 * 60;
export const TELEGRAM_PENDING_EXECUTION_UNKNOWN_RETENTION_SEC = 90 * 24 * 60 * 60;

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
