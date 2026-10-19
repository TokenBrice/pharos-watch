import { CRON_SCHEDULES } from "@shared/lib/cron-jobs";
import { isReserveConfigRecoverySlot } from "@shared/lib/cron-cadences";
import {
  claimNextLiveReserveCheckpointRecovery,
  prepareEligibleLiveReserveCheckpointRecoveries,
  releaseUnstartedLiveReserveRecoveryClaim,
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
  type ReserveProducerPriority,
} from "../../lib/reserve-producer-priority";
import { resolveScheduledSlotPolicy } from "../../lib/scheduled-slot-policy";
import { reconcileReserveContinuations } from "../../lib/reserve-continuation-reconciliation";

type ReserveRecoveryMode = "off" | "recover";

function normalizeReserveRecoveryMode(value: string | null | undefined): ReserveRecoveryMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === "recover" ? "recover" : "off";
}

function priorityPollStatus(priority: ReserveProducerPriority | null): "ok" | "skipped_neutral" {
  // Expected waiting completes the poll only with positive bounded evidence.
  return priority?.condition === "producer-slot-live"
    || priority?.condition === "next-slot-lookahead"
    || priority?.condition === "same-role-slot-running"
    ? "ok" : "skipped_neutral";
}

function priorityPollReason(priority: ReserveProducerPriority): string {
  return priority.condition === "producer-slot-live" ? "producer-slot-live" : priority.reason;
}

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
  if (mode === "off") {
    return createCronResult({
      status: "ok", itemCount: 0,
      metadata: { mode, disposition: "disabled", checkpointsClaimed: 0 },
    });
  }
  await reconcileReserveContinuations(runtime.db, signal);
  const priority = await getReserveProducerPriority(runtime.db);
  if (priority) return createCronResult({
    status: priorityPollStatus(priority), itemCount: 0,
    metadata: { mode, reason: priorityPollReason(priority), producerPriority: { ...priority }, attemptedCount: 0, checkpointsClaimed: 0 },
  });


  await reportProgress({ stage: "preparing-reserve-checkpoint" });
  const sweep = await sweepStaleScheduledSlotExecutions(runtime.db, {
    slotKey: "fourHourlyReserveSync",
    limit: 1,
    signal,
  });
  const retiredCheckpoints = await retireSupersededLiveReserveCheckpoints(runtime.db);
  const preparation = await prepareEligibleLiveReserveCheckpointRecoveries(runtime.db, {
    staleAfterSec: resolveScheduledSlotPolicy("fourHourlyReserveSync").slotSilenceSec,
    limit: 1,
  });

  const claim = await claimNextLiveReserveCheckpointRecovery(runtime.db, {
    owner: runtime.invocationId ?? createLeaseOwner("reserve-recovery"),
    leaseSec: RESERVE_RECOVERY_CLAIM_SEC,
  });
  if (claim.disposition !== "claimed") {
    // Exact scheduled minute, not wall-clock time: duplicate old/new expressions
    // share the slot fence and global recovery lease. Never catch up config work
    // on the four intervening minute polls or load its graph on those ticks.
    if (!isReserveConfigRecoverySlot(runtime.slotStartedAt)) {
      const priority = claim.disposition === "priority" ? claim.producerPriority : null;
      const recoveryBlocked = preparation.inspection.incompatibleCheckpointCount > 0
        && preparation.inspection.eligibleCheckpointCount === 0
        && preparation.inspection.readyCheckpointCount === 0;
      return createReserveRecoveryResult({
        status: priority ? priorityPollStatus(priority) : "ok", itemCount: 0,
        metadata: {
          mode, disposition: priority ? "recovery-priority" : "no-recovery-due",
          configRecovery: { disposition: "not-due" }, checkpointsClaimed: 0,
          retiredCheckpoints, sweep: { ...sweep }, preparation,
          ...(recoveryBlocked ? { statusCause: "reserve-recovery-zero-eligible-incompatible" } : {}),
          ...(priority ? { reason: priorityPollReason(priority), producerPriority: priority } : {}),
        } as CronMetadataRecord,
      });
    }
    // Keep changed-config work off the normal cohort's wall/CPU budget.
    // Lazy import also keeps config-only polls free of the consumer graph.
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
      status: configReasons.length > 0 ? "degraded" : priorityPollStatus(beforeReplayPriority), itemCount: configRecovery.healed.length,
      metadata: { mode, configRecovery, checkpointsClaimed: 0, producerPriority: beforeReplayPriority,
        reasons: [...configReasons, priorityPollReason(beforeReplayPriority)],
        reason: configReasons[0] ?? priorityPollReason(beforeReplayPriority) } as CronMetadataRecord,
    });
    const recoveryBlocked = preparation.inspection.incompatibleCheckpointCount > 0
      && preparation.inspection.eligibleCheckpointCount === 0
      && preparation.inspection.readyCheckpointCount === 0;
    const priority = claim.disposition === "priority" ? claim.producerPriority : null;
    return createReserveRecoveryResult({
      status: configReasons.length > 0 ? "degraded" : priority ? priorityPollStatus(priority) : "ok",
      itemCount: configRecovery.healed.length,
      metadata: {
        disposition: priority ? "recovery-priority" : "no-recovery-due",
        mode,
        configRecovery,
        retiredCheckpoints,
        ...(recoveryBlocked ? { statusCause: "reserve-recovery-zero-eligible-incompatible" } : {}),
        checkpointsClaimed: 0,
        sweep: { ...sweep },
        preparation,
        ...(priority ? { producerPriority: priority } : {}),
        ...(configReasons[0] || priority ? { reason: configReasons[0] ?? priorityPollReason(priority!) } : {}),
        reasons: [...configReasons, ...(priority ? [priorityPollReason(priority)] : [])],
      } as CronMetadataRecord,
    });
  }
  const checkpoint = claim.checkpoint;
  const replayPriority = await getReserveProducerPriority(runtime.db);
  if (replayPriority) {
    const recoveryClaimRelease = await releaseUnstartedLiveReserveRecoveryClaim(runtime.db, checkpoint);
    return createReserveRecoveryResult({
      status: priorityPollStatus(replayPriority), itemCount: 0,
      metadata: { mode, checkpointsClaimed: 1, reason: priorityPollReason(replayPriority),
        reasons: [priorityPollReason(replayPriority)], producerPriority: replayPriority,
        recoveryClaimRelease } as CronMetadataRecord,
    });
  }

  const recoveryRuntime = createScheduledRuntimeContext(runtime.env, runtime.ctx, {
    cron: CRON_SCHEDULES.fourHourlyReserveSync,
    scheduleKey: checkpoint.scheduleKey as "fourHourlyReserveSync",
    scheduledTimeMs: checkpoint.slotStartedAt * 1000,
    slotStartedAt: checkpoint.slotStartedAt,
    slotBudgetStartedAtMs: runtime.deadline.eventEntryMs,
    deadline: runtime.deadline,
    executionFence: runtime.executionFence,
    parentSignal: signal,
    jobAttemptNo: checkpoint.attemptNo,
    producerKind: "scheduled-recovery",
    recoveryCheckpoint: checkpoint,
  });
  recoveryRuntime.slotSignal = signal;
  await reportProgress({ stage: "replaying-reserve-checkpoint" });
  const { runFourHourlyReserveSyncSlot } = await import("./four-hourly-reserves");
  const summary = await runFourHourlyReserveSyncSlot(recoveryRuntime);
  runtime.pendingReserveContinuation = summary.reserveContinuation;
  const admissionReason = summary.jobs?.find((job) =>
    job.reason === "producer-slot-priority" || job.reason === "same-role-slot-co-tenancy")?.reason;
  const admissionPriority = admissionReason && summary.jobsErrored === 0 && summary.jobsDegraded === 0
    ? await getReserveProducerPriority(runtime.db) : null;
  const admissionPollReason = admissionReason
    ? admissionPriority ? priorityPollReason(admissionPriority) : admissionReason
    : null;
  const continuationPending = summary.jobs.some((job) => job.reason === "reserve-cohort-continuation");
  const recoveryDeferred = summary.jobsSkipped > 0;
  const reasons = [
    ...(summary.jobsErrored > 0 ? ["reserve-replay-child-error"] : []),
    ...(summary.jobsDegraded > 0 ? ["reserve-replay-child-degraded"] : []),
    ...(recoveryDeferred && !admissionReason ? ["reserve-replay-deferred"] : []),
    ...(admissionPollReason ? [admissionPollReason] : []),
  ];
  return createReserveRecoveryResult({
    status: summary.jobsErrored > 0 ? "error"
      : summary.jobsDegraded > 0 || (recoveryDeferred && !admissionReason)
        ? "degraded" : admissionReason ? priorityPollStatus(admissionPriority) : "ok",
    itemCount: recoveryDeferred ? 0 : 1,
    error: summary.jobsErrored > 0 ? "reserve recovery child failed" : undefined,
    metadata: {
      disposition: continuationPending ? "cohort-continuation" : recoveryDeferred ? "recovery-deferred" : "recovery-executed",
      continuationPending,
      mode,
      configRecovery: { disposition: "deferred-for-cohort" },
      checkpointsClaimed: 1,
      originalScheduleKey: checkpoint.scheduleKey,
      originalSlotStartedAt: checkpoint.slotStartedAt,
      recoveryAttemptNo: checkpoint.attemptNo,
      executionGeneration: checkpoint.executionGeneration,
      sourceAttemptNo: checkpoint.sourceAttemptNo,
      childDispositionsAtClaim: checkpoint.childDispositions,
      sweep: { ...sweep },
      preparation,
      retiredCheckpoints,
      summary: { ...summary },
      ...(admissionPriority ? { producerPriority: admissionPriority } : {}),
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
