import { getCronSlotStartedAtForSchedule } from "@shared/lib/cron-jobs";
import { SCHEDULED_SLOT_PLANS_BY_SCHEDULE, type ScheduledRunnerKey } from "@shared/lib/scheduled-runner-registry";
import type { Env } from "../lib/env";
import {
  getScheduledSlotControlledDeadlineMs,
  runScheduledSlotWithFence,
  type ScheduledSlotExecutionOptions,
} from "../lib/cron-lease";
import { createScheduledRuntimeContext, type ScheduledRuntimeContext } from "./scheduled/context";
import type { ScheduledSlotSummary } from "./scheduled/slot-summary";

type SlotRunner = (runtime: ScheduledRuntimeContext) => Promise<ScheduledSlotSummary | void> | ScheduledSlotSummary | void;
type SlotRunnerLoader = () => Promise<SlotRunner>;

export const SLOT_RUNNER_LOADER_BY_KEY = {
  quarterHourly: () => import("./scheduled/quarter-hourly").then((mod) => mod.runQuarterHourlySlot),
  statusSelfCheckOffset: () => import("./scheduled/status-self-check").then((mod) => mod.runStatusSelfCheckSlot),
  sixHourlyBlacklist: () => import("./scheduled/hourly-blacklist").then((mod) => mod.runSixHourlyBlacklistSlot),
  halfHourlyMintBurnCritical: () =>
    import("./scheduled/twenty-minute-mint-burn-critical").then((mod) => mod.runHalfHourlyMintBurnCriticalSlot),
  twoHourlyDexDiscovery: () =>
    import("./scheduled/thirty-minute-dex-discovery").then((mod) => mod.runTwoHourlyDexDiscoverySlot),
  halfHourlyMintBurnExtended: () =>
    import("./scheduled/twenty-minute-mint-burn-extended").then((mod) => mod.runHalfHourlyMintBurnExtendedSlot),
  halfHourlyOffset: () => import("./scheduled/half-hourly").then((mod) => mod.runHalfHourlySlot),
  halfHourlyChartsOffset: () =>
    import("./scheduled/half-hourly-charts").then((mod) => mod.runHalfHourlyChartsSlot),
  dewsPsiOffset: () => import("./scheduled/dews-psi").then((mod) => mod.runDewsPsiSlot),
  fourHourlyReserveSync: () =>
    import("./scheduled/hourly-live-reserves").then((mod) => mod.runFourHourlyReserveSyncSlot),
  hourlyYieldSync: () => import("./scheduled/hourly-yield").then((mod) => mod.runHourlyYieldSlot),
  fourHourlyYieldSupplemental: () =>
    import("./scheduled/yield-supplemental").then((mod) => mod.runYieldSupplementalSlot),
  fiveMinuteTelegramAlerts: () =>
    import("./scheduled/five-minute-telegram").then((mod) => mod.runFiveMinuteTelegramSlot),
  fiveMinuteReserveRecovery: () =>
    import("./scheduled/reserve-recovery").then((mod) => mod.runFiveMinuteReserveRecoverySlot),
  digestTriggerPoll: () => import("./scheduled/digest-trigger-poll").then((mod) => mod.runDigestTriggerPollSlot),
  daily0300Utc: () => import("./scheduled/daily-0300").then((mod) => mod.runDaily0300Slot),
  daily0800Utc: () => import("./scheduled/daily-0800").then((mod) => mod.runDaily0800Slot),
  daily0805Utc: () => import("./scheduled/daily-0805").then((mod) => mod.runDaily0805Slot),
  daily0810Utc: () => import("./scheduled/daily-0810").then((mod) => mod.runDaily0810Slot),
  monthlyYieldAudit: () => import("./scheduled/monthly-yield-audit").then((mod) => mod.runMonthlyYieldAuditSlot),
} satisfies Record<ScheduledRunnerKey, SlotRunnerLoader>;

export const SLOT_RUNNER_BY_KEY = Object.fromEntries(
  Object.entries(SLOT_RUNNER_LOADER_BY_KEY).map(([key, loadRunner]) => [
    key,
    async (runtime: ScheduledRuntimeContext) => {
      const runner = await loadRunner();
      return runner(runtime);
    },
  ]),
) as Record<ScheduledRunnerKey, SlotRunner>;

type SlotFencePolicy = Pick<ScheduledSlotExecutionOptions, "heartbeatSec" | "staleAfterSec" | "preSweepLimit">;

const SHORT_SLOT_FENCE_POLICY = {
  heartbeatSec: 30,
  staleAfterSec: 10 * 60,
  preSweepLimit: 5,
} satisfies SlotFencePolicy;

const MEDIUM_SLOT_FENCE_POLICY = {
  heartbeatSec: 45,
  staleAfterSec: 20 * 60,
  preSweepLimit: 5,
} satisfies SlotFencePolicy;

const LONG_SLOT_FENCE_POLICY = {
  heartbeatSec: 60,
  staleAfterSec: 35 * 60,
  preSweepLimit: 5,
} satisfies SlotFencePolicy;

const SLOT_FENCE_POLICY_BY_RUNNER_KEY: Partial<Record<ScheduledRunnerKey, SlotFencePolicy>> = {
  statusSelfCheckOffset: SHORT_SLOT_FENCE_POLICY,
  digestTriggerPoll: SHORT_SLOT_FENCE_POLICY,
  fiveMinuteTelegramAlerts: MEDIUM_SLOT_FENCE_POLICY,
  fiveMinuteReserveRecovery: LONG_SLOT_FENCE_POLICY,
  quarterHourly: MEDIUM_SLOT_FENCE_POLICY,
  halfHourlyOffset: MEDIUM_SLOT_FENCE_POLICY,
  halfHourlyChartsOffset: MEDIUM_SLOT_FENCE_POLICY,
  dewsPsiOffset: MEDIUM_SLOT_FENCE_POLICY,
  sixHourlyBlacklist: LONG_SLOT_FENCE_POLICY,
  halfHourlyMintBurnCritical: LONG_SLOT_FENCE_POLICY,
  twoHourlyDexDiscovery: LONG_SLOT_FENCE_POLICY,
  halfHourlyMintBurnExtended: LONG_SLOT_FENCE_POLICY,
  fourHourlyReserveSync: LONG_SLOT_FENCE_POLICY,
  hourlyYieldSync: LONG_SLOT_FENCE_POLICY,
  fourHourlyYieldSupplemental: LONG_SLOT_FENCE_POLICY,
  daily0300Utc: LONG_SLOT_FENCE_POLICY,
  daily0800Utc: LONG_SLOT_FENCE_POLICY,
  daily0805Utc: LONG_SLOT_FENCE_POLICY,
  daily0810Utc: LONG_SLOT_FENCE_POLICY,
  monthlyYieldAudit: LONG_SLOT_FENCE_POLICY,
};

function buildUnknownScheduleError(cron: string): Error {
  return new Error(`[cron-slot] Unknown scheduled trigger: ${cron}`);
}

export async function handleScheduledEvent(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const slotBudgetStartedAtMs = Date.now();
  const slotPlan = SCHEDULED_SLOT_PLANS_BY_SCHEDULE[event.cron];
  const runner = slotPlan ? SLOT_RUNNER_BY_KEY[slotPlan.runnerKey] : undefined;
  if (!runner || !slotPlan) {
    const error = buildUnknownScheduleError(event.cron);
    console.error(error.message);
    throw error;
  }

  const scheduledTimeMs = typeof event.scheduledTime === "number" ? event.scheduledTime : null;
  const scheduleKey = slotPlan.scheduleKey;
  const slotStartedAt = getCronSlotStartedAtForSchedule(scheduleKey, scheduledTimeMs);
  const runtime = createScheduledRuntimeContext(env, ctx, {
    cron: event.cron,
    scheduleKey,
    scheduledTimeMs,
    slotStartedAt,
    slotBudgetStartedAtMs,
  });

  const slotResult = await runScheduledSlotWithFence(
    env.DB,
    scheduleKey,
    (slotSignal) => {
      runtime.slotSignal = slotSignal;
      return Promise.resolve(runner(runtime));
    },
    {
      slotStartedAt,
      deadlineMs: getScheduledSlotControlledDeadlineMs(slotBudgetStartedAtMs),
      ...(SLOT_FENCE_POLICY_BY_RUNNER_KEY[slotPlan.runnerKey] ?? {}),
    },
  );

  if (slotResult.status === "skipped_duplicate") {
    console.info(`[cron-slot] Skipping duplicate slot ${scheduleKey}@${slotStartedAt}`);
    return;
  }
  if (slotResult.status === "skipped_running") {
    console.info(`[cron-slot] Slot already running ${scheduleKey}@${slotStartedAt}`);
    return;
  }
}
