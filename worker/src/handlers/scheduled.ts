import { logWorkerEventArgs } from "../lib/structured-log";
import { getCronSlotStartedAtForSchedule } from "@shared/lib/cron-jobs";
import { SCHEDULED_SLOT_PLANS_BY_SCHEDULE, type ScheduledRunnerKey } from "@shared/lib/scheduled-runner-registry";
import type { Env } from "../lib/env";
import {
  getScheduledSlotControlledDeadlineMs,
} from "../lib/cron-timeouts";
import {
  runScheduledSlotWithFence,
  type ScheduledSlotExecutionOptions,
} from "../lib/scheduled-slot-fence";
import { waitForV9MemoryLaneRelease } from "../lib/v9-slot-window";
import { recordScheduledWorkerVersionFirstSeen } from "../lib/worker-version-first-seen";
import { createScheduledRuntimeContext, type ScheduledRuntimeContext } from "./scheduled/context";
import type { ScheduledSlotSummary } from "./scheduled/slot-summary";

type SlotRunner = (runtime: ScheduledRuntimeContext) => Promise<ScheduledSlotSummary | void> | ScheduledSlotSummary | void;
type SlotRunnerLoader = () => Promise<SlotRunner>;

export const SLOT_RUNNER_LOADER_BY_KEY = {
  quarterHourly: () => import("./scheduled/quarter-hourly").then((mod) => mod.runQuarterHourlySlot),
  v9SupplyAttributionOffset: () =>
    import("./scheduled/v9-supply-attribution").then((mod) => mod.runV9SupplyAttributionSlot),
  depegResolverOffset: () =>
    import("./scheduled/depeg-resolver").then((mod) => mod.runDepegResolverSlot),
  v9PublicationOffset: () =>
    import("./scheduled/v9-publication").then((mod) => mod.runV9PublicationSlot),
  statusSelfCheckOffset: () => import("./scheduled/status-self-check").then((mod) => mod.runStatusSelfCheckSlot),
  sixHourlyBlacklist: () => import("./scheduled/hourly-blacklist").then((mod) => mod.runSixHourlyBlacklistSlot),
  halfHourlyMintBurnCritical: () =>
    import("./scheduled/twenty-minute-mint-burn-critical").then((mod) => mod.runHalfHourlyMintBurnCriticalSlot),
  twoHourlyDexDiscovery: () =>
    import("./scheduled/thirty-minute-dex-discovery").then((mod) => mod.runTwoHourlyDexDiscoverySlot),
  halfHourlyMintBurnExtended: () =>
    import("./scheduled/twenty-minute-mint-burn-extended").then((mod) => mod.runHalfHourlyMintBurnExtendedSlot),
  halfHourlyMeasuredExecution: () =>
    import("./scheduled/half-hourly-measured-execution").then((mod) => mod.runHalfHourlyMeasuredExecutionSlot),
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

type SlotFencePolicy = Pick<ScheduledSlotExecutionOptions, "staleAfterSec">;

// staleAfterSec measures consecutive missed slot heartbeats, not job length:
// the fence heartbeat timer runs for the whole slot regardless of how long a
// child job takes, so even the longest lanes tolerate a tight window. Five to
// six minutes of heartbeat silence means the isolate was killed (OOM kills
// write no terminal row), and every extra minute here extends the outage of
// each lane that gates on the dead slot. Only lanes that need the sixth
// minute of takeover slack are listed below; every other slot runs on the
// fence defaults (heartbeatSec 60, staleAfterSec 5*60, preSweepLimit 5).
const LONG_SLOT_FENCE_POLICY = {
  staleAfterSec: 6 * 60,
} satisfies SlotFencePolicy;

const SLOT_FENCE_POLICY_BY_RUNNER_KEY: Partial<Record<ScheduledRunnerKey, SlotFencePolicy>> = {
  fiveMinuteReserveRecovery: LONG_SLOT_FENCE_POLICY,
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

export class ScheduledSlotAggregateError extends Error {
  readonly scheduleKey: string;
  readonly slotStartedAt: number;
  readonly metadata: unknown;

  constructor(scheduleKey: string, slotStartedAt: number, metadata: unknown, cause?: unknown) {
    super(`Scheduled slot ${scheduleKey}@${slotStartedAt} completed with one or more child errors`);
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
    this.name = "ScheduledSlotAggregateError";
    this.scheduleKey = scheduleKey;
    this.slotStartedAt = slotStartedAt;
    this.metadata = metadata;
  }
}

export async function handleScheduledEvent(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const slotBudgetStartedAtMs = Date.now();
  const slotPlan = SCHEDULED_SLOT_PLANS_BY_SCHEDULE[event.cron];
  const loadRunner = slotPlan ? SLOT_RUNNER_LOADER_BY_KEY[slotPlan.runnerKey] : undefined;
  if (!loadRunner || !slotPlan) {
    const error = buildUnknownScheduleError(event.cron);
    logWorkerEventArgs("handler", "error", error.message);
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
  try {
    await recordScheduledWorkerVersionFirstSeen(
      env.DB,
      runtime.workerVersion,
      Math.floor(slotBudgetStartedAtMs / 1000),
    );
  } catch (error) {
    logWorkerEventArgs("handler", "warn", "[cron-slot] Failed to record worker version first-seen time:", error);
  }

  let slotResult;
  try {
    slotResult = await runScheduledSlotWithFence(
      env.DB,
      scheduleKey,
      async (slotSignal) => {
        runtime.slotSignal = slotSignal;
        if (
          slotPlan.runnerKey !== "v9SupplyAttributionOffset" &&
          slotPlan.runnerKey !== "v9PublicationOffset"
        ) {
          await waitForV9MemoryLaneRelease(env.DB, slotSignal);
        }
        const runner = await loadRunner();
        const summary = await runner(runtime);
        if (!summary) return;
        return {
          ...summary,
          fetchBudget: runtime.fetchBudget?.snapshot() ?? null,
          invocationId: runtime.invocationId ?? null,
          workerVersion: runtime.workerVersion ?? null,
        };
      },
      {
        slotStartedAt,
        invocationId: runtime.invocationId ?? null,
        workerVersion: runtime.workerVersion ?? null,
        deadlineMs: getScheduledSlotControlledDeadlineMs(slotBudgetStartedAtMs),
        ...(SLOT_FENCE_POLICY_BY_RUNNER_KEY[slotPlan.runnerKey] ?? {}),
      },
    );
  } catch (error) {
    if (error instanceof ScheduledSlotAggregateError) throw error;
    throw new ScheduledSlotAggregateError(scheduleKey, slotStartedAt, null, error);
  }

  if (slotResult.status === "skipped_duplicate") {
    logWorkerEventArgs("handler", "info", `[cron-slot] Skipping duplicate slot ${scheduleKey}@${slotStartedAt}`);
    return;
  }
  if (slotResult.status === "skipped_running") {
    logWorkerEventArgs("handler", "info", `[cron-slot] Slot already running ${scheduleKey}@${slotStartedAt}`);
    return;
  }
  if (slotResult.resultStatus === "error") {
    throw new ScheduledSlotAggregateError(scheduleKey, slotStartedAt, slotResult.metadata);
  }
}
