import { CRON_SCHEDULES } from "@shared/lib/cron-jobs";
import type { Env } from "../lib/env";
import { createScheduledRuntimeContext, type ScheduledRuntimeContext } from "./scheduled/context";
import { runQuarterHourlySlot } from "./scheduled/quarter-hourly";
import { runTwentyMinuteBlacklistSlot } from "./scheduled/twenty-minute-blacklist";
import { runTwentyMinuteMintBurnCriticalSlot } from "./scheduled/twenty-minute-mint-burn-critical";
import { runTwentyMinuteDexDiscoverySlot } from "./scheduled/twenty-minute-dex-discovery";
import { runTwentyMinuteMintBurnExtendedSlot } from "./scheduled/twenty-minute-mint-burn-extended";
import { runHalfHourlySlot } from "./scheduled/half-hourly";
import { runHourlyReserveSyncSlot } from "./scheduled/hourly-live-reserves";
import { runFiveMinuteTelegramSlot } from "./scheduled/five-minute-telegram";
import { runDaily0800Slot } from "./scheduled/daily-0800";
import { runDaily0805Slot } from "./scheduled/daily-0805";

type SlotRunner = (runtime: ScheduledRuntimeContext) => Promise<void> | void;

const SLOT_RUNNER_BY_SCHEDULE: Record<string, SlotRunner> = {
  [CRON_SCHEDULES.quarterHourly]: runQuarterHourlySlot,
  [CRON_SCHEDULES.twentyMinuteOffset]: runTwentyMinuteBlacklistSlot,
  [CRON_SCHEDULES.twentyMinuteMintBurn]: runTwentyMinuteMintBurnCriticalSlot,
  [CRON_SCHEDULES.thirtyMinuteDexDiscovery]: runTwentyMinuteDexDiscoverySlot,
  [CRON_SCHEDULES.twentyMinuteExtendedOffset]: runTwentyMinuteMintBurnExtendedSlot,
  [CRON_SCHEDULES.halfHourlyOffset]: runHalfHourlySlot,
  [CRON_SCHEDULES.hourlyReserveSync]: runHourlyReserveSyncSlot,
  [CRON_SCHEDULES.fiveMinuteTelegramAlerts]: runFiveMinuteTelegramSlot,
  [CRON_SCHEDULES.daily0800Utc]: runDaily0800Slot,
  [CRON_SCHEDULES.daily0805Utc]: runDaily0805Slot,
};

export async function handleScheduledEvent(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const runtime = createScheduledRuntimeContext(env, ctx);
  const runner = SLOT_RUNNER_BY_SCHEDULE[event.cron];
  if (!runner) {
    return;
  }

  await runner(runtime);
}
