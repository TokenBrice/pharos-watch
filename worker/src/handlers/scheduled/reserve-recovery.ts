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
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import { createCronResult } from "../../lib/cron-result";
import type { CronMetadataRecord } from "../../lib/cron-result";
import {
  getReserveProducerPriority,
  RESERVE_RECOVERY_CLAIM_SEC,
} from "../../lib/reserve-producer-priority";

type ReserveRecoveryMode = "off" | "recover";

function normalizeReserveRecoveryMode(value: string | null | undefined): ReserveRecoveryMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === "recover" ? "recover" : "off";
}

const RECOVERY_STALE_AFTER_SEC = 5 * 60;

function createReserveRecoveryResult(
  result: Omit<CronResult, "metadata"> & { metadata: CronMetadataRecord },
): CronResult {
  if (result.status == null || result.status === "ok") {
    return createCronResult({ ...result, status: "ok" });
  }
  const reason = result.metadata.reason;
  if (typeof reason !== "string" || !reason) throw new Error("Reserve recovery non-ok result missing reason");
  return createCronResult({ ...result, status: result.status, metadata: { ...result.metadata, reason } });
}

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
    return createCronResult({
      status: "ok", itemCount: 0,
      metadata: { mode, disposition: "disabled", checkpointsClaimed: 0 },
    });
  }
  const priority = await getReserveProducerPriority(runtime.db);
  if (priority) return createCronResult({
    status: "skipped_neutral", itemCount: 0,
    metadata: { mode, reason: priority.reason, producerPriority: { ...priority }, attemptedCount: 0, checkpointsClaimed: 0 },
  });

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
  }, { invocationId: runtime.invocationId, scheduleKey: runtime.scheduleKey, slotStartedAt: runtime.slotStartedAt });
  const configReasons = [
    ...(configRecovery.failed.length > 0 ? ["reserve-config-recovery-failed"] : []),
    ...("missingFetcherCount" in configRecovery && configRecovery.missingFetcherCount > 0 ? ["reserve-config-recovery-missing-fetcher"] : []),
    ...("deferredCount" in configRecovery && configRecovery.deferredCount > 0 ? ["reserve-config-recovery-deferred"] : []),
  ];
  const beforeReplayPriority = "producerPriority" in configRecovery && configRecovery.producerPriority
    ? configRecovery.producerPriority : await getReserveProducerPriority(runtime.db);
  if (beforeReplayPriority) return createReserveRecoveryResult({
    status: configReasons.length > 0 ? "degraded" : "skipped_neutral", itemCount: configRecovery.healed.length,
    metadata: { mode, configRecovery, checkpointsClaimed: 0, producerPriority: beforeReplayPriority,
      reasons: [...configReasons, beforeReplayPriority.reason],
      reason: configReasons[0] ?? beforeReplayPriority.reason } as CronMetadataRecord,
  });

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

  const claim = await claimNextLiveReserveCheckpointRecovery(runtime.db, {
    owner: runtime.invocationId ?? createLeaseOwner("reserve-recovery"),
    leaseSec: RESERVE_RECOVERY_CLAIM_SEC,
  });
  if (claim.disposition !== "claimed") {
    const recoveryBlocked = preparation.inspection.incompatibleCheckpointCount > 0
      && preparation.inspection.eligibleCheckpointCount === 0
      && preparation.inspection.readyCheckpointCount === 0;
    const priority = claim.disposition === "priority" ? claim.producerPriority : null;
    return createReserveRecoveryResult({
      status: configReasons.length > 0 ? "degraded" : priority ? "skipped_neutral" : "ok",
      itemCount: configRecovery.healed.length,
      metadata: {
        disposition: priority ? "recovery-priority" : "no-recovery-due",
        mode,
        configRecovery,
        retiredCheckpoints,
        ...(recoveryBlocked ? { statusCause: "reserve-recovery-zero-eligible-incompatible" } : {}),
        checkpointsClaimed: 0,
        sweep,
        preparation,
        ...(priority ? { producerPriority: priority } : {}),
        ...(configReasons[0] || priority ? { reason: configReasons[0] ?? priority!.reason } : {}),
        reasons: [...configReasons, ...(priority ? [priority.reason] : [])],
      } as CronMetadataRecord,
    });
  }
  const checkpoint = claim.checkpoint;
  const replayPriority = await getReserveProducerPriority(runtime.db);
  if (replayPriority) return createReserveRecoveryResult({
    status: configReasons.length > 0 ? "degraded" : "skipped_neutral", itemCount: configRecovery.healed.length,
    metadata: { mode, configRecovery, checkpointsClaimed: 1, reason: configReasons[0] ?? replayPriority.reason,
      reasons: [...configReasons, replayPriority.reason], producerPriority: replayPriority } as CronMetadataRecord,
  });

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
  const admissionReason = summary.jobs?.find((job) =>
    job.reason === "producer-slot-priority" || job.reason === "heavy-slot-co-tenancy")?.reason;
  const recoveryDeferred = summary.jobsSkipped > 0;
  const reasons = [
    ...(summary.jobsErrored > 0 ? ["reserve-replay-child-error"] : []),
    ...(summary.jobsDegraded > 0 ? ["reserve-replay-child-degraded"] : []),
    ...(recoveryDeferred && !admissionReason ? ["reserve-replay-deferred"] : []),
    ...configReasons,
    ...(admissionReason ? [admissionReason] : []),
  ];
  return createReserveRecoveryResult({
    status: summary.jobsErrored > 0 ? "error"
      : summary.jobsDegraded > 0 || configReasons.length > 0 || (recoveryDeferred && !admissionReason)
        ? "degraded" : admissionReason ? "skipped_neutral" : "ok",
    itemCount: 1 + configRecovery.healed.length,
    error: summary.jobsErrored > 0 ? "reserve recovery child failed" : undefined,
    metadata: {
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
      reasons,
      ...(reasons[0] ? { reason: reasons[0] } : {}),
    } as CronMetadataRecord,
  });
}

export async function runFiveMinuteReserveRecoverySlot(runtime: ScheduledRuntimeContext) {
  return runSingleScheduledJob(runtime, "isolated reserve recovery slot", {
    job: "reserve-recovery",
    errorMessage: "[reserve-recovery] Recovery poll failed:",
    run: (signal, reportProgress) => runReserveRecovery(runtime, signal, reportProgress),
  });
}
