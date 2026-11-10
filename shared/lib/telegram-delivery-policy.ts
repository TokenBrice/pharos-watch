/**
 * Runtime-neutral Telegram delivery policy.
 *
 * Worker modules re-export these values from `telegram-constants.ts` for
 * compatibility. The synthetic load guard imports this module directly so its
 * capacity model cannot silently drift from production delivery behavior.
 */

import { CRON_INTERVALS } from "./cron-jobs";

/**
 * Real-time alert detection policy (ADR-32/R5: the single authority for
 * per-family thresholds, dwell, hysteresis and cooldowns). Moves that miss
 * these gates are not sent live; each suppression is counted by a named
 * reason in dispatch metadata so the daily roll-up can consume them later.
 */
export const TELEGRAM_ALERT_POLICY = {
  safety: {
    /** A downgrade of at least this many notches (C to C- is 1) is severe. */
    severeMinGradeNotches: 2,
    /** A downgrade landing at or below this grade is severe regardless of size. */
    severeFloorGrade: "D",
    /** A severe move must hold this long versus the last alerted grade. */
    dwellSec: 6 * 60 * 60,
    /** No second live downgrade alert for the same coin inside this window. */
    downgradeCooldownSec: 24 * 60 * 60,
    /** Global-only ("all stablecoins") safety moves need this score change, when scored, to appear in the roll-up. */
    globalMinScoreDrop: 3,
  },
  dews: {
    /** An escalation must appear in this many consecutive DEWS computations. */
    escalationMinComputations: 2,
    /** A band is left only once the score falls this far below its lower bound. */
    exitHysteresisPoints: 5,
    /** A coin calm (below ALERT) this long loses its alerted-band baseline. */
    baselineResetQuietSec: 24 * 60 * 60,
  },
  freeze: {
    /** Freeze/unfreeze events at or above this USD amount go live; destroy always does. */
    realtimeMinAmountUsd: 1_000_000,
    /** Smaller or unpriced freezes reach direct followers in one batch per chat this often. */
    batchIntervalSec: 60 * 60,
  },
  /** Daily "Changes" roll-up: everything that is not sent live. */
  rollup: {
    /** Local hour (chat timezone, UTC when unset) from which the day's roll-up is due. */
    localHour: 9,
    /** Window for a chat's first roll-up, before it has a previous one. */
    firstWindowSec: 24 * 60 * 60,
    /** Change-log retention; longer than any roll-up window a paused chat could need. */
    changeLogRetentionSec: 8 * 24 * 60 * 60,
    /** Lines listed per roll-up before the rest are summarized as "N more changes". */
    maxListedChanges: 25,
  },
  /** Per-chat budget for live messages; depeg is exempt and overflow goes to the roll-up. */
  chatCap: {
    maxRealtimeMessages: 6,
    windowSec: 24 * 60 * 60,
  },
  /**
   * Families whose global ("all stablecoins") opt-in is roll-up only: no live
   * send reaches a chat covered for a coin solely through the global opt-in.
   * Per-coin and preset follows keep live alerts.
   */
  rollupOnlyGlobalFamilies: ["safety", "dews"],
} as const;

/** Default source/queue TTL; modeled 20% headroom is not a D1 latency guarantee. */
export const PENDING_TTL_SEC = 2 * 60 * 60;

export const TELEGRAM_ALERT_TTL_SEC = {
  depeg: PENDING_TTL_SEC,
  dews: PENDING_TTL_SEC,
  safety: PENDING_TTL_SEC,
  launch: 90 * 60,
  reserve: PENDING_TTL_SEC,
  freeze: PENDING_TTL_SEC,
  adminBroadcast: 45 * 60,
} as const;

/** Defaults retained only for rows written before alert-family attribution was explicit. */
export const TELEGRAM_HISTORICAL_SOURCE_TTL_SEC = PENDING_TTL_SEC;

/**
 * The dedicated Telegram alert dispatcher's cadence. `cron-jobs.ts` is the
 * only cadence authority; capacity, drain and timeout models derive from it.
 */
export const TELEGRAM_DISPATCH_INTERVAL_SEC = CRON_INTERVALS["dispatch-telegram-alerts"];

/**
 * Hard application timeout for the Telegram dispatch job.
 *
 * The send loop stops admitting batches at four minutes. Keep a short
 * finalization window after that boundary, but fail before the next five-minute
 * invocation so an unabortable D1 operation cannot renew a lease across
 * several dispatch slots.
 */
export const TELEGRAM_DISPATCH_TIMEOUT_MS = 4 * 60_000 + 30_000;

/** Stop starting fresh/pending send batches before the outer job deadline. */
export const TELEGRAM_DISPATCH_SOFT_DEADLINE_MS = 4 * 60_000;

/** Upper bound on message attempts per dispatcher run. */
export const TELEGRAM_MAX_MESSAGES_PER_RUN = 3_600;

/**
 * Pending-drain share reserved from the per-run send budget. Delivery v2 has no
 * hard row budget (it drains until the soft deadline); admin broadcast
 * preflight uses this as the conservative rows-per-run drain rate.
 */
export const TELEGRAM_PENDING_DRAIN_BUDGET = 1_800;

/** Delivery v2 fan-out: chats built per page and pages per dispatch run. */
export const TELEGRAM_FANOUT_PAGE_CHATS = 200;
export const TELEGRAM_FANOUT_MAX_PAGES_PER_RUN = 12;

export function crossesTelegramDepegWorseningStep(
  previousDeviationBps: number,
  currentDeviationBps: number,
  step: number | null,
): boolean {
  return step != null
    && step > 0
    && currentDeviationBps > previousDeviationBps
    && Math.floor(previousDeviationBps / step) < Math.floor(currentDeviationBps / step);
}

export function mergeTelegramDepegWorseningSteps(
  existing: number | null,
  additional: number | null,
): number | null {
  if (existing == null) return additional;
  if (additional == null) return existing;
  return Math.min(existing, additional);
}

/**
 * Telegram's per-message character cap is 4096; we leave a small safety margin
 * for the chunk-counter suffix and other appended metadata.
 */
export const TELEGRAM_MESSAGE_CHUNK_LIMIT = 4000;

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
  freeze: 10,
  riskAlert: 30,
  adminBroadcast: 90,
} as const;

/** Priority retained only for rows written before alert-family attribution was explicit. */
export const TELEGRAM_HISTORICAL_SOURCE_PRIORITY = 50;

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

/** Chat pause is indefinite; timed snoozes stop suppressing at their deadline. */
export function isTelegramSnoozeActive(ts: number | null | undefined, nowSec: number): boolean {
  return isPausedSentinel(ts) || (ts != null && ts > nowSec);
}

/**
 * Failure classes the delivery transport resolves to `blocked` (a `403` or a
 * blocked lifecycle description, and `chat_not_found`): Telegram cannot deliver
 * until the reader messages the bot again, so the reader copy names that
 * recovery path. Retryability stays owned by the Worker transport.
 */
export function isTelegramBlockedFailureClass(failureClass: string | null | undefined): boolean {
  return failureClass === "blocked" || failureClass === "chat_not_found";
}

/**
 * Reviewed calibration inputs that exist only in the synthetic load model.
 * Production-enforced values above are imported separately by the harness.
 */
export const TELEGRAM_LOAD_GUARD_ASSUMPTIONS = {
  watcherTargets: [500, 1_000, 5_000, 10_000],
  requiredTarget: 5_000,
  /**
   * Tier whose planning-plus-delivery completion is enforced against the risk-alert SLO.
   * Reviewed 2026-09-22: once planning time counts, the 5-minute planner cadence caps a
   * single-depeg fan-out at ~40 min for 5,000 watchers (production: 855); 1,000 is the
   * largest tier the current planner meets. CPU, TTL-margin and status-path budgets stay
   * measured at `requiredTarget`. Raising this back to 5,000 needs the planner redesign
   * recorded in agents/2026-09-21-holistic-review/execution/DECISIONS.md.
   */
  sloEnforcedTarget: 1_000,
  exploratoryTarget: 10_000,
  telegramBroadcastMessagesPerSecond: 30,
  telegramP95SendLatencyMs: 250,
  d1WriteMsPerMessage: 20,
  normalSloSeconds: 15 * 60,
  spikeMaxSeconds: 60 * 60,
  telegram429StormSeconds: 15 * 60,
  minimumTtlMarginFraction: 0.2,
  defaultDispatchCpuMs: 30_000,
  cpuBudgetSafetyFraction: 0.5,
  formatCpuMsPerChat: 1.5,
  sendCpuMsPerMessage: 2,
  productionDispatchSubscribers: 855,
  productionDispatchCandidateSubscribers: 338,
  productionDispatchTargets: 300,
  productionFanoutInputPageWallMs: 18_000,
  productionPlanningPageWallMs: 1_500,
  productionHandoffOperationsPerPage: 8,
  productionHandoffOperationWallMs: 200,
  productionSourcePresetWallMs: 2_000,
  productionDispatchWallBudgetMs: 180_000,
} as const;
