import { logWorkerEvent, logWorkerEventArgs } from "../lib/structured-log";
import { getCronSlotStartedAtForTrigger, type CronScheduleKey } from "@shared/lib/cron-jobs";
import { SCHEDULED_SLOT_PLANS_BY_SCHEDULE, type ScheduledWorkerRole } from "@shared/lib/scheduled-runner-registry";
import type { ScheduledEnv } from "../lib/env";
import { runScheduledSlotWithFence, type ScheduledSlotCatchUpRequest } from "../lib/scheduled-slot-fence";
import type { SlotRunnerLoader } from "./scheduled/runner-types";
import { waitForV9MemoryLaneRelease } from "../lib/v9-slot-window";
import { sendReserveContinuation } from "../lib/reserve-continuation-send";
import { createSlotDeadline, SCHEDULED_SLOT_JOB_BUDGET_MS } from "../lib/cron-timeouts";

import { createScheduledRuntimeContext } from "./scheduled/context";

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
  env: ScheduledEnv,
  ctx: ExecutionContext,
  workerRole: ScheduledWorkerRole,
  runnerLoaders: Partial<Record<CronScheduleKey, SlotRunnerLoader>>,
  slotBudgetStartedAtMs: number,
  catchUp?: ScheduledSlotCatchUpRequest,
  /** Controlled deadline for a catch-up; never later than an ordinary delivery's. */
  catchUpDeadlineMs?: number,
): Promise<void> {
  const slotPlan = SCHEDULED_SLOT_PLANS_BY_SCHEDULE[event.cron];
  if (!slotPlan) {
    // Cloudflare keeps delivering a removed expression while trigger changes
    // propagate (~13 min after #1608). Nothing owns it, so skip neutrally; a
    // warn that persists past propagation is genuine config drift.
    logWorkerEvent({
      scope: "handler",
      level: "warn",
      event: "scheduled-trigger-unknown",
      message: "Skipping scheduled trigger with no slot plan",
      status: "skipped_neutral",
      metadata: { status: "skipped_neutral", reason: "scheduled-trigger-unknown", workerRole, cron: event.cron },
    });
    return;
  }
  if (slotPlan.worker !== workerRole) {
    logWorkerEvent({
      scope: "handler",
      level: "info",
      event: "scheduled-worker-not-owner",
      message: "Skipping scheduled trigger owned by another Worker",
      status: "skipped_neutral",
      metadata: { status: "skipped_neutral", reason: "scheduled-worker-not-owner", workerRole, owner: slotPlan.worker, cron: event.cron },
    });
    return;
  }

  const loadRunner = runnerLoaders[slotPlan.scheduleKey];
  if (!loadRunner) throw buildUnknownScheduleError(event.cron);
  const scheduledTimeMs = typeof event.scheduledTime === "number" ? event.scheduledTime : null;
  const scheduleKey = slotPlan.scheduleKey;
  const slotStartedAt = getCronSlotStartedAtForTrigger(scheduleKey, event.cron, scheduledTimeMs);
  const runtime = createScheduledRuntimeContext(env, ctx, {
    cron: event.cron,
    scheduleKey,
    workerRole,
    scheduledTimeMs,
    slotStartedAt,
    slotBudgetStartedAtMs,
    ...(catchUp ? { catchUp } : {}),
    ...(catchUpDeadlineMs != null ? {
      deadline: createSlotDeadline(slotBudgetStartedAtMs,
        Math.min(catchUpDeadlineMs, slotBudgetStartedAtMs + SCHEDULED_SLOT_JOB_BUDGET_MS)),
    } : {}),
  });

  let slotResult;
  try {
    slotResult = await runScheduledSlotWithFence(
      env.DB,
      scheduleKey,
      async (slotSignal, executionFence) => {
        runtime.slotSignal = slotSignal;
        runtime.executionFence = executionFence;
        if (
          workerRole === "heavy" &&
          slotPlan.scheduleKey !== "v9SupplyAttributionOffset" &&
          slotPlan.scheduleKey !== "v9PublicationOffset"
        ) {
          await waitForV9MemoryLaneRelease(env.DB, slotSignal);
          slotSignal.throwIfAborted();
        }
        const runner = await loadRunner();
        slotSignal.throwIfAborted();
        const summary = await runner(runtime);
        slotSignal.throwIfAborted();
        if (!summary) return;
        runtime.pendingReserveContinuation = summary.reserveContinuation ?? runtime.pendingReserveContinuation;
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
        workerRole,
        deadline: runtime.deadline,
        waitUntil: (work) => ctx.waitUntil(work),
        ...(catchUp ? { catchUp } : {}),
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
  // The executing slot terminal CAS, child accounting and job leases have all
  // settled. Sending from continueLiveReserveCheckpoint would race this fence.
  if (slotResult.resultStatus !== "error") {
    await sendReserveContinuation(env, runtime.pendingReserveContinuation, runtime.deadline);
  }
  if (slotResult.resultStatus === "error") {
    throw new ScheduledSlotAggregateError(scheduleKey, slotStartedAt, slotResult.metadata);
  }
}
