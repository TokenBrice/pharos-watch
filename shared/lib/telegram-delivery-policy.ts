/**
 * Runtime-neutral Telegram delivery policy.
 *
 * Worker modules re-export these values from `telegram-constants.ts` for
 * compatibility. The synthetic load guard imports this module directly so its
 * capacity model cannot silently drift from production delivery behavior.
 */

/** Default source/queue TTL leaves 20% headroom after bounded planning and drain. */
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

/** The dedicated Telegram alert dispatcher runs every five minutes. */
export const TELEGRAM_DISPATCH_INTERVAL_SEC = 5 * 60;

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

/** Pending-drain share reserved from the per-run send budget. */
export const TELEGRAM_PENDING_DRAIN_BUDGET = 1_800;

/** Subscribers captured and planned per durable target-plan transition. */
export const TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE = 90;

/** Planned target rows handed to the pending queue per transition. */
export const TELEGRAM_TARGET_PLAN_ENQUEUE_PAGE_SIZE = 45;

/** Durable target-plan transitions permitted in one dispatch invocation. */
export const TELEGRAM_TARGET_PLAN_MAX_STEPS_PER_RUN = 32;

export function estimateTelegramTargetPlanCoordinatorBound(input: {
  subscriberCount: number;
  targetCount: number;
  maxSteps?: number;
}): { steps: number; runs: number } {
  const subscribers = Math.max(0, Math.floor(input.subscriberCount));
  const targets = Math.max(0, Math.floor(input.targetCount));
  const maxSteps = Math.max(
    1,
    Math.floor(input.maxSteps ?? TELEGRAM_TARGET_PLAN_MAX_STEPS_PER_RUN),
  );
  const captureSteps = Math.floor(subscribers / TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE) + 1;
  const planningSteps = Math.ceil(subscribers / TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE) + 1;
  const openDeliverySteps = 1;
  const enqueueSteps = Math.max(1, Math.ceil(targets / TELEGRAM_TARGET_PLAN_ENQUEUE_PAGE_SIZE));
  const steps = captureSteps + planningSteps + openDeliverySteps + enqueueSteps;
  return { steps, runs: Math.ceil(steps / maxSteps) };
}

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
