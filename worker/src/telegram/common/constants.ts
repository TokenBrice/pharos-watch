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

// ---------- Snooze durations ----------

/** Snooze callback arg → duration in seconds. */
export const SNOOZE_SECONDS = {
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "24h": 24 * 60 * 60,
} as const;

// ---------- Message chunking ----------

/**
 * Telegram's per-message character cap is 4096; we leave a small safety margin
 * for the chunk-counter suffix and other appended metadata.
 */
export const TELEGRAM_MESSAGE_CHUNK_LIMIT = 4000;

/**
 * Stable version tag for the message chunking algorithm. Bump whenever the
 * splitting logic (boundaries, tag envelopes, ordering) changes in a way that would
 * alter the chunks produced from the same canonical body.
 */
export const TELEGRAM_SPLIT_VERSION = 4;

// ---------- Delivery policy ----------

export const TELEGRAM_CHAT_BACKOFF_CACHE_PREFIX = "telegram:chat-send-backoff:";

// Preserve the established Worker import surface while the policy itself stays
// runtime-neutral.
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
} from "@shared/lib/telegram-delivery-policy";

// ---------- Processed-updates retention ----------

/** Retain processed `telegram_processed_updates` rows for 7 days for replay-ack idempotency. */
export const TELEGRAM_PROCESSED_UPDATE_RETENTION_SEC = 7 * 24 * 60 * 60;

/**
 * A `processing` claim older than this belongs to a crashed request and is
 * reclaimed by Telegram's redelivery (a rare duplicate reply is accepted).
 */
export const TELEGRAM_PROCESSING_STALE_SEC = 60;

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

// ---------- Bulk subscribe/unsubscribe confirmation gate ----------

/** Maximum number of coin symbols to inline in the bulk-confirm preview line. */
export const BULK_CONFIRM_PREVIEW_LIMIT = 5;

// ---------- /list manage keyboard ----------

/** Page size for the /list `[ Manage ]` keyboard. */
export const MANAGE_PAGE_SIZE = 5;
