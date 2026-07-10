import { CRON_SCHEDULES } from "@shared/lib/cron-jobs";
import { claimNextScheduledCheckpointRecovery } from "../../lib/scheduled-recovery-checkpoint";
import { createScheduledRuntimeContext, type ScheduledRuntimeContext } from "./context";
import { LIVE_RESERVE_SLOT_JOBS, runFourHourlyReserveSyncSlot } from "./hourly-live-reserves";
import { runSingleScheduledJob } from "./slot-groups";
import { sweepStaleScheduledSlotExecutions } from "../../lib/scheduled-slot-fence";
import { createLeaseOwner } from "../../lib/cron-lease-primitives";

const RECOVERY_CHECKPOINT_JOB = "sync-live-reserves";
const RECOVERY_LEASE_SEC = 15 * 60;

async function runReserveRecovery(runtime: ScheduledRuntimeContext, signal: AbortSignal) {
  const sweep = await sweepStaleScheduledSlotExecutions(runtime.db, {
    slotKey: "fourHourlyReserveSync",
    staleAfterSec: 2 * 60,
    limit: 1,
    signal,
  });
  const checkpoint = await claimNextScheduledCheckpointRecovery(runtime.db, {
    job: RECOVERY_CHECKPOINT_JOB,
    childJobs: LIVE_RESERVE_SLOT_JOBS,
    owner: runtime.invocationId ?? createLeaseOwner("reserve-recovery"),
    leaseSec: RECOVERY_LEASE_SEC,
  });
  if (!checkpoint) {
    return {
      status: "ok" as const,
      itemCount: 0,
      metadata: JSON.stringify({
        disposition: "no-recovery-due",
        checkpointsClaimed: 0,
        sweep,
      }),
    };
  }

  const recoveryRuntime = createScheduledRuntimeContext(runtime.env, runtime.ctx, {
    cron: CRON_SCHEDULES.fourHourlyReserveSync,
    scheduleKey: checkpoint.scheduleKey as "fourHourlyReserveSync",
    scheduledTimeMs: checkpoint.slotStartedAt * 1000,
    slotStartedAt: checkpoint.slotStartedAt,
    slotBudgetStartedAtMs: runtime.slotBudgetStartedAtMs ?? Date.now(),
    parentSignal: signal,
    jobAttemptNo: checkpoint.attemptNo,
    producerKind: "scheduled-recovery",
    recoveryCheckpoint: checkpoint,
  });
  recoveryRuntime.slotSignal = signal;
  const summary = await runFourHourlyReserveSyncSlot(recoveryRuntime);
  return {
    status: summary.jobsErrored > 0 ? "error" as const : summary.jobsDegraded > 0 ? "degraded" as const : "ok" as const,
    itemCount: 1,
    error: summary.jobsErrored > 0 ? "reserve recovery child failed" : undefined,
    metadata: JSON.stringify({
      disposition: "recovery-executed",
      checkpointsClaimed: 1,
      originalScheduleKey: checkpoint.scheduleKey,
      originalSlotStartedAt: checkpoint.slotStartedAt,
      recoveryAttemptNo: checkpoint.attemptNo,
      executionGeneration: checkpoint.executionGeneration,
      sourceAttemptNo: checkpoint.sourceAttemptNo,
      childDispositionsAtClaim: checkpoint.childDispositions,
      sweep,
      summary,
    }),
  };
}

export async function runFiveMinuteReserveRecoverySlot(runtime: ScheduledRuntimeContext) {
  return runSingleScheduledJob(runtime, "isolated reserve recovery slot", {
    job: "reserve-recovery",
    errorMessage: "[reserve-recovery] Recovery poll failed:",
    run: (signal) => runReserveRecovery(runtime, signal),
  });
}
