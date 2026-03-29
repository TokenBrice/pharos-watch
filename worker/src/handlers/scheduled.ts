import { getCronScheduleKey, getCronSlotStartedAtForSchedule } from "@shared/lib/cron-jobs";
import { SCHEDULED_RUNNER_KEYS_BY_SCHEDULE, type ScheduledRunnerKey } from "@shared/lib/scheduled-runner-registry";
import type { Env } from "../lib/env";
import { runScheduledSlotWithFence } from "../lib/cron-lease";
import { createScheduledRuntimeContext, type ScheduledRuntimeContext } from "./scheduled/context";
import { runQuarterHourlySlot } from "./scheduled/quarter-hourly";
import { runHourlyBlacklistSlot } from "./scheduled/hourly-blacklist";
import { runTwentyMinuteMintBurnCriticalSlot } from "./scheduled/twenty-minute-mint-burn-critical";
import { runTwentyMinuteDexDiscoverySlot } from "./scheduled/twenty-minute-dex-discovery";
import { runTwentyMinuteMintBurnExtendedSlot } from "./scheduled/twenty-minute-mint-burn-extended";
import { runHalfHourlySlot } from "./scheduled/half-hourly";
import { runHourlyReserveSyncSlot } from "./scheduled/hourly-live-reserves";
import { runHourlyYieldSlot } from "./scheduled/hourly-yield";
import { runYieldSupplementalSlot } from "./scheduled/yield-supplemental";
import { runFiveMinuteTelegramSlot } from "./scheduled/five-minute-telegram";
import { runDaily0800Slot } from "./scheduled/daily-0800";
import { runDaily0805Slot } from "./scheduled/daily-0805";
import { runMonthlyYieldAuditSlot } from "./scheduled/monthly-yield-audit";

type SlotRunner = (runtime: ScheduledRuntimeContext) => Promise<void> | void;

const SLOT_RUNNER_BY_KEY = {
  quarterHourly: runQuarterHourlySlot,
  hourlyBlacklist: runHourlyBlacklistSlot,
  twentyMinuteMintBurn: runTwentyMinuteMintBurnCriticalSlot,
  thirtyMinuteDexDiscovery: runTwentyMinuteDexDiscoverySlot,
  twentyMinuteExtendedOffset: runTwentyMinuteMintBurnExtendedSlot,
  halfHourlyOffset: runHalfHourlySlot,
  hourlyReserveSync: runHourlyReserveSyncSlot,
  hourlyYieldSync: runHourlyYieldSlot,
  fourHourlyYieldSupplemental: runYieldSupplementalSlot,
  fiveMinuteTelegramAlerts: runFiveMinuteTelegramSlot,
  daily0800Utc: runDaily0800Slot,
  daily0805Utc: runDaily0805Slot,
  monthlyYieldAudit: runMonthlyYieldAuditSlot,
} satisfies Record<ScheduledRunnerKey, SlotRunner>;

export const SLOT_RUNNER_BY_SCHEDULE: Record<string, SlotRunner> = Object.fromEntries(
  Object.entries(SCHEDULED_RUNNER_KEYS_BY_SCHEDULE).map(([schedule, runnerKey]) => [
    schedule,
    SLOT_RUNNER_BY_KEY[runnerKey],
  ]),
) as Record<string, SlotRunner>;

function buildUnknownScheduleError(cron: string): Error {
  return new Error(`[cron-slot] Unknown scheduled trigger: ${cron}`);
}

export async function handleScheduledEvent(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const runner = SLOT_RUNNER_BY_SCHEDULE[event.cron];
  const scheduleKey = getCronScheduleKey(event.cron);
  if (!runner || !scheduleKey) {
    const error = buildUnknownScheduleError(event.cron);
    console.error(error.message);
    throw error;
  }

  const scheduledTimeMs = typeof event.scheduledTime === "number" ? event.scheduledTime : null;
  const slotStartedAt = getCronSlotStartedAtForSchedule(scheduleKey, scheduledTimeMs);
  const runtime = createScheduledRuntimeContext(env, ctx, {
    cron: event.cron,
    scheduleKey,
    scheduledTimeMs,
    slotStartedAt,
  });

  const slotResult = await runScheduledSlotWithFence(
    env.DB,
    scheduleKey,
    () => Promise.resolve(runner(runtime)),
    { slotStartedAt },
  );

  if (slotResult.status === "skipped_duplicate") {
    console.info(`[cron-slot] Skipping duplicate slot ${scheduleKey}@${slotStartedAt}`);
    return;
  }
  if (slotResult.status === "skipped_running") {
    console.info(`[cron-slot] Slot already running ${scheduleKey}@${slotStartedAt}`);
  }
}
