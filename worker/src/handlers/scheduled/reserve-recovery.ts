import { CRON_SCHEDULES } from "@shared/lib/cron-jobs";
import {
  claimNextLiveReserveCheckpointRecovery,
  inspectLiveReserveCheckpointRecoveryEligibility,
  prepareEligibleLiveReserveCheckpointRecoveries,
  retireIncompatibleLiveReserveCheckpointRecoveries,
} from "../../lib/scheduled-recovery-checkpoint";
import { createScheduledRuntimeContext, type ScheduledRuntimeContext } from "./context";
import { runFourHourlyReserveSyncSlot } from "./hourly-live-reserves";
import { runSingleScheduledJob } from "./slot-groups";
import { sweepStaleScheduledSlotExecutions } from "../../lib/scheduled-slot-fence";
import { createLeaseOwner } from "../../lib/cron-lease-primitives";

type ReserveRecoveryMode = "off" | "shadow" | "reconcile" | "recover";

function normalizeReserveRecoveryMode(value: string | null | undefined): ReserveRecoveryMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "shadow" || normalized === "reconcile" || normalized === "recover") {
    return normalized;
  }
  return "off";
}

const RECOVERY_LEASE_SEC = 15 * 60;
const RECOVERY_STALE_AFTER_SEC = 2 * 60;

async function runReserveRecovery(runtime: ScheduledRuntimeContext, signal: AbortSignal) {
  const mode = normalizeReserveRecoveryMode(runtime.env.WORKER_RESERVE_RECOVERY_MODE);
  // This lane runs every five minutes, so it is the fast global reconciler
  // for slots whose isolate was killed without a terminal write (OOM leaves
  // state='running' with a silent heartbeat). Runs in every recovery mode:
  // sweeping is DB-only and independent of the reserve checkpoint machinery.
  await sweepStaleScheduledSlotExecutions(runtime.db, {
    staleAfterSec: 5 * 60,
    limit: 10,
    signal,
    reconcilerWorkerVersion: runtime.workerVersion ?? null,
  });
  if (mode === "off") {
    return {
      status: "ok" as const,
      itemCount: 0,
      metadata: JSON.stringify({ mode, disposition: "disabled", checkpointsClaimed: 0 }),
    };
  }

  if (mode === "shadow") {
    const inspection = await inspectLiveReserveCheckpointRecoveryEligibility(runtime.db, {
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
    reconcilerWorkerVersion: runtime.workerVersion ?? null,
  });
  const incompatibleRetirement = await retireIncompatibleLiveReserveCheckpointRecoveries(runtime.db, {
    limit: 5,
  });
  const preparation = await prepareEligibleLiveReserveCheckpointRecoveries(runtime.db, {
    staleAfterSec: RECOVERY_STALE_AFTER_SEC,
    limit: 1,
  });
  if (mode === "reconcile") {
    const inspection = await inspectLiveReserveCheckpointRecoveryEligibility(runtime.db, {
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

  const checkpoint = await claimNextLiveReserveCheckpointRecovery(runtime.db, {
    owner: runtime.invocationId ?? createLeaseOwner("reserve-recovery"),
    leaseSec: RECOVERY_LEASE_SEC,
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
