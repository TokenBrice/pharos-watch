import { CRON_SCHEDULES } from "@shared/lib/cron-jobs";
import {
  claimNextScheduledCheckpointRecovery,
  inspectScheduledCheckpointRecoveryEligibility,
  prepareEligibleScheduledCheckpointRecoveries,
  retireIncompatibleScheduledCheckpointRecoveries,
} from "../../lib/scheduled-recovery-checkpoint";
import { createScheduledRuntimeContext, type ScheduledRuntimeContext } from "./context";
import {
  LIVE_RESERVE_CHILD_PREREQUISITES,
  LIVE_RESERVE_SLOT_JOBS,
  runFourHourlyReserveSyncSlot,
} from "./hourly-live-reserves";
import { runSingleScheduledJob } from "./slot-groups";
import { sweepStaleScheduledSlotExecutions } from "../../lib/scheduled-slot-fence";
import { createLeaseOwner } from "../../lib/cron-lease-primitives";
import { LIVE_RESERVE_QUEUE_HASH } from "../../cron/sync-live-reserves-shared";
import { normalizeReserveRecoveryMode } from "../../lib/reserve-recovery-mode";

const RECOVERY_CHECKPOINT_JOB = "sync-live-reserves";
const RECOVERY_LEASE_SEC = 15 * 60;
const RECOVERY_STALE_AFTER_SEC = 2 * 60;

async function runReserveRecovery(runtime: ScheduledRuntimeContext, signal: AbortSignal) {
  const mode = normalizeReserveRecoveryMode(runtime.env.WORKER_RESERVE_RECOVERY_MODE);
  if (mode === "off") {
    return {
      status: "ok" as const,
      itemCount: 0,
      metadata: JSON.stringify({ mode, disposition: "disabled", checkpointsClaimed: 0 }),
    };
  }

  if (mode === "shadow") {
    const inspection = await inspectScheduledCheckpointRecoveryEligibility(runtime.db, {
      scheduleKey: "fourHourlyReserveSync",
      job: RECOVERY_CHECKPOINT_JOB,
      expectedQueueHash: LIVE_RESERVE_QUEUE_HASH,
      staleAfterSec: RECOVERY_STALE_AFTER_SEC,
    });
    return {
      status: "ok" as const,
      itemCount: inspection.eligibleCheckpointCount,
      metadata: JSON.stringify({
        mode,
        disposition: "shadow-observed",
        checkpointsClaimed: 0,
        inspection,
      }),
    };
  }

  const sweep = await sweepStaleScheduledSlotExecutions(runtime.db, {
    slotKey: "fourHourlyReserveSync",
    staleAfterSec: RECOVERY_STALE_AFTER_SEC,
    limit: 1,
    signal,
  });
  const incompatibleRetirement = await retireIncompatibleScheduledCheckpointRecoveries(runtime.db, {
    scheduleKey: "fourHourlyReserveSync",
    job: RECOVERY_CHECKPOINT_JOB,
    childJobs: LIVE_RESERVE_SLOT_JOBS,
    expectedQueueHash: LIVE_RESERVE_QUEUE_HASH,
    limit: 5,
  });
  const preparation = await prepareEligibleScheduledCheckpointRecoveries(runtime.db, {
    scheduleKey: "fourHourlyReserveSync",
    job: RECOVERY_CHECKPOINT_JOB,
    childJobs: LIVE_RESERVE_SLOT_JOBS,
    childPrerequisites: LIVE_RESERVE_CHILD_PREREQUISITES,
    expectedQueueHash: LIVE_RESERVE_QUEUE_HASH,
    staleAfterSec: RECOVERY_STALE_AFTER_SEC,
    limit: 1,
  });
  if (mode === "reconcile") {
    const inspection = await inspectScheduledCheckpointRecoveryEligibility(runtime.db, {
      scheduleKey: "fourHourlyReserveSync",
      job: RECOVERY_CHECKPOINT_JOB,
      expectedQueueHash: LIVE_RESERVE_QUEUE_HASH,
      staleAfterSec: RECOVERY_STALE_AFTER_SEC,
    });
    return {
      status: "ok" as const,
      itemCount: preparation.prepared.length + incompatibleRetirement.retired,
      metadata: JSON.stringify({
        mode,
        disposition: preparation.prepared.length > 0
          ? "recovery-prepared"
          : incompatibleRetirement.retired > 0
            ? "incompatible-checkpoints-retired"
            : "no-reconciliation-due",
        checkpointsClaimed: 0,
        sweep,
        incompatibleRetirement,
        preparation,
        inspection,
      }),
    };
  }

  const checkpoint = await claimNextScheduledCheckpointRecovery(runtime.db, {
    job: RECOVERY_CHECKPOINT_JOB,
    childJobs: LIVE_RESERVE_SLOT_JOBS,
    childPrerequisites: LIVE_RESERVE_CHILD_PREREQUISITES,
    owner: runtime.invocationId ?? createLeaseOwner("reserve-recovery"),
    leaseSec: RECOVERY_LEASE_SEC,
    expectedQueueHash: LIVE_RESERVE_QUEUE_HASH,
  });
  if (!checkpoint) {
    return {
      status: "ok" as const,
      itemCount: 0,
      metadata: JSON.stringify({
        disposition: "no-recovery-due",
        mode,
        checkpointsClaimed: 0,
        sweep,
        incompatibleRetirement,
        preparation,
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
  const recoveryDeferred = summary.jobsSkipped > 0;
  return {
    status: summary.jobsErrored > 0
      ? "error" as const
      : summary.jobsDegraded > 0 || recoveryDeferred
        ? "degraded" as const
        : "ok" as const,
    itemCount: 1,
    error: summary.jobsErrored > 0 ? "reserve recovery child failed" : undefined,
    metadata: JSON.stringify({
      disposition: recoveryDeferred ? "recovery-deferred" : "recovery-executed",
      mode,
      checkpointsClaimed: 1,
      incompatibleRetirement,
      originalScheduleKey: checkpoint.scheduleKey,
      originalSlotStartedAt: checkpoint.slotStartedAt,
      recoveryAttemptNo: checkpoint.attemptNo,
      executionGeneration: checkpoint.executionGeneration,
      sourceAttemptNo: checkpoint.sourceAttemptNo,
      childDispositionsAtClaim: checkpoint.childDispositions,
      sweep,
      preparation,
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
