/**
 * Runtime-neutral Telegram delivery policy.
 *
 * Worker modules re-export these values from `telegram-constants.ts` for
 * compatibility. The synthetic load guard imports this module directly so its
 * capacity model cannot silently drift from production delivery behavior.
 */

/** Default stale-row TTL for the pending alert queue (one hour). */
export const PENDING_TTL_SEC = 60 * 60;

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

/** Hard application timeout for the Telegram dispatch job. */
export const TELEGRAM_DISPATCH_TIMEOUT_MS = 14 * 60_000;

/** Stop starting fresh/pending send batches before the outer job deadline. */
export const TELEGRAM_DISPATCH_SOFT_DEADLINE_MS = 4 * 60_000;

/** Upper bound on message attempts per dispatcher run. */
export const TELEGRAM_MAX_MESSAGES_PER_RUN = 3_600;

/** Pending-drain share reserved from the per-run send budget. */
export const TELEGRAM_PENDING_DRAIN_BUDGET = Math.floor(TELEGRAM_MAX_MESSAGES_PER_RUN / 4);

/** A long retry_after is treated as a bot-wide flood limit. */
export const TELEGRAM_GLOBAL_RATE_LIMIT_RETRY_AFTER_THRESHOLD_SEC = 30;

/** Distinct chat-scoped 429s that imply a bot-wide flood limit. */
export const TELEGRAM_GLOBAL_RATE_LIMIT_DISTINCT_CHAT_THRESHOLD = 3;

/** Cheap pre-format estimate of alert lines per delivered message chunk. */
export const TELEGRAM_ALERTS_PER_MESSAGE_CHUNK_ESTIMATE = 16;

/** Manifest/overflow headroom above the per-run format budget. */
export const TELEGRAM_FORMAT_BUDGET_ALLOWANCE = 64;

/** Parallel Bot API sends, leaving Worker connection headroom. */
export const SEND_BATCH_SIZE = 4;

/** Defensive retry ceiling inside the pending-row TTL window. */
export const PENDING_MAX_ATTEMPTS = 20;

/** Exponential retry schedule, indexed by the prior attempt count. */
export const PENDING_BACKOFF_SCHEDULE_SEC = [60, 120, 240, 480, 600] as const;

/** Two-strike window for Telegram 403 lifecycle handling. */
export const BLOCK_STRIKE_WINDOW_SEC = 24 * 60 * 60;

/** Pending rows older than this need operator attention. */
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

/**
 * Reviewed calibration inputs that exist only in the synthetic load model.
 * Production-enforced values above are imported separately by the harness.
 */
export const TELEGRAM_LOAD_GUARD_ASSUMPTIONS = {
  watcherTargets: [500, 1_000, 5_000, 10_000],
  requiredTarget: 5_000,
  exploratoryTarget: 10_000,
  telegramBroadcastMessagesPerSecond: 30,
  telegramP95SendLatencyMs: 250,
  d1WriteMsPerMessage: 20,
  normalSloSeconds: 15 * 60,
  spikeMaxSeconds: 60 * 60,
  telegram429StormSeconds: 15 * 60,
  defaultDispatchCpuMs: 30_000,
  cpuBudgetSafetyFraction: 0.5,
  formatCpuMsPerChat: 1.5,
  sendCpuMsPerMessage: 2,
} as const;
