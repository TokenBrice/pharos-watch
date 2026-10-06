import { CRON_SCHEDULES } from "@shared/lib/cron-jobs";
import {
  claimNextLiveReserveCheckpointRecovery,
  prepareEligibleLiveReserveCheckpointRecoveries,
  retireSupersededLiveReserveCheckpoints,
} from "../../lib/scheduled-recovery-checkpoint";
import { createScheduledRuntimeContext, type ScheduledRuntimeContext } from "./context";
import { runSingleScheduledJob } from "./slot-groups";
import { sweepStaleScheduledSlotExecutions } from "../../lib/scheduled-slot-fence";
import { createLeaseOwner } from "../../lib/cron-lease-primitives";
import type { CronProgressReporter } from "../../lib/cron-logger";

type ReserveRecoveryMode = "off" | "recover";

function normalizeReserveRecoveryMode(value: string | null | undefined): ReserveRecoveryMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === "recover" ? "recover" : "off";
}

const RECOVERY_LEASE_SEC = 15 * 60;
const RECOVERY_STALE_AFTER_SEC = 5 * 60;

async function runReserveRecovery(
  runtime: ScheduledRuntimeContext,
  signal: AbortSignal,
  reportProgress: CronProgressReporter,
) {
  const mode = normalizeReserveRecoveryMode(runtime.env.WORKER_RESERVE_RECOVERY_MODE);
  // This lane runs every five minutes, so it is the fast global reconciler
  // for slots whose isolate was killed without a terminal write (OOM leaves
  // state='running' with a silent heartbeat). Runs in every recovery mode:
  // sweeping is DB-only and independent of the reserve checkpoint machinery.
  await reportProgress({ stage: "sweeping-stale-slots" });
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

  // Config-only polls must not initialize the checkpoint replay's redemption
  // and sentinel graphs alongside reserve adapters on the 128 MB isolate.
  await reportProgress({ stage: "recovering-reserve-config" });
  const { recoverLiveReserveConfigChanges } = await import("../../cron/reserve-recovery-config");
  const configRecovery = await recoverLiveReserveConfigChanges(runtime.db, signal, {
    etherscanApiKey: runtime.env.ETHERSCAN_API_KEY,
    alchemyApiKey: runtime.env.ALCHEMY_API_KEY,
    trongridApiKey: runtime.env.TRONGRID_API_KEY,
    m0ApiKey: runtime.env.M0_API_KEY,
    chainRpcs: runtime.chainRpcs,
    dwellirNative: runtime.dwellirNative,
  });
  const configRecoveryDegraded = configRecovery.failed.length > 0
    || ("deferredCount" in configRecovery && configRecovery.deferredCount > 0)
    || ("missingFetcherCount" in configRecovery && configRecovery.missingFetcherCount > 0);


  await reportProgress({ stage: "preparing-reserve-checkpoint" });
  const sweep = await sweepStaleScheduledSlotExecutions(runtime.db, {
    slotKey: "fourHourlyReserveSync",
    staleAfterSec: RECOVERY_STALE_AFTER_SEC,
    limit: 1,
    signal,
    reconcilerWorkerVersion: runtime.workerVersion ?? null,
  });
  const retiredCheckpoints = await retireSupersededLiveReserveCheckpoints(runtime.db);
  const preparation = await prepareEligibleLiveReserveCheckpointRecoveries(runtime.db, {
    staleAfterSec: RECOVERY_STALE_AFTER_SEC,
    limit: 1,
  });

  const checkpoint = await claimNextLiveReserveCheckpointRecovery(runtime.db, {
    owner: runtime.invocationId ?? createLeaseOwner("reserve-recovery"),
    leaseSec: RECOVERY_LEASE_SEC,
  });
  if (!checkpoint) {
    const recoveryBlocked = preparation.inspection.incompatibleCheckpointCount > 0
      && preparation.inspection.eligibleCheckpointCount === 0
      && preparation.inspection.readyCheckpointCount === 0;
    return {
      status: recoveryBlocked || configRecoveryDegraded
        ? "degraded" as const : "ok" as const,
      itemCount: configRecovery.healed.length,
      metadata: JSON.stringify({
        disposition: "no-recovery-due",
        mode,
        configRecovery,
        retiredCheckpoints,
        ...(recoveryBlocked ? { statusCause: "reserve-recovery-zero-eligible-incompatible" } : {}),
        checkpointsClaimed: 0,
        sweep,
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
  await reportProgress({ stage: "replaying-reserve-checkpoint" });
  const { runFourHourlyReserveSyncSlot } = await import("./hourly-live-reserves");
  const summary = await runFourHourlyReserveSyncSlot(recoveryRuntime);
  const recoveryDeferred = summary.jobsSkipped > 0;
  return {
    status: summary.jobsErrored > 0
      ? "error" as const
      : summary.jobsDegraded > 0 || recoveryDeferred || configRecoveryDegraded
        ? "degraded" as const
        : "ok" as const,
    itemCount: 1 + configRecovery.healed.length,
    error: summary.jobsErrored > 0 ? "reserve recovery child failed" : undefined,
    metadata: JSON.stringify({
      disposition: recoveryDeferred ? "recovery-deferred" : "recovery-executed",
      mode,
      configRecovery,
      checkpointsClaimed: 1,
      originalScheduleKey: checkpoint.scheduleKey,
      originalSlotStartedAt: checkpoint.slotStartedAt,
      recoveryAttemptNo: checkpoint.attemptNo,
      executionGeneration: checkpoint.executionGeneration,
      sourceAttemptNo: checkpoint.sourceAttemptNo,
      childDispositionsAtClaim: checkpoint.childDispositions,
      sweep,
      preparation,
      retiredCheckpoints,
      summary,
    }),
  };
}

export async function runFiveMinuteReserveRecoverySlot(runtime: ScheduledRuntimeContext) {
  return runSingleScheduledJob(runtime, "isolated reserve recovery slot", {
    job: "reserve-recovery",
    errorMessage: "[reserve-recovery] Recovery poll failed:",
    run: (signal, reportProgress) => runReserveRecovery(runtime, signal, reportProgress),
  });
}
