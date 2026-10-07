import { logWorkerEventArgs } from "../../lib/structured-log";
/**
 * Four-hourly reserve-sync trigger (11 * / 4 * * *), two chains:
 *   sync-live-reserves (2) → sync-redemption-backstops (1) → cron-sentinel (1)
 *   sync-kinesis-supply (1)
 *
 * Redemption consumes a sealed accepted reserve view after the producer settles,
 * even when the current cohort is incomplete. Only the sentinel requires this
 * slot's successful queue exhaustion. Recovery completing the producer forces
 * another redemption pass; consumer-only replay remains idempotent.
 *
 * Reserve adapters and redemption RPC observers run sequentially.
 * Recovery serializes Kinesis behind the head to retain its separate 2/6 budget.
 * Connection budget: 3/6 peak (2 + 1) while both chains are in flight
 */
import { syncKinesisSupply } from "../../cron/sync-kinesis-supply";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";
import {
  buildScheduledSlotSummary,
  mergeScheduledSlotSummaries,
  summarizeSkippedScheduledJob,
  type ScheduledSlotSummary,
} from "./slot-summary";
import { logSkippedCronRun } from "./preflight-skip";
import {
  beginLiveReserveCheckpoint,
  finishLiveReserveCheckpoint,
  loadLiveReserveCheckpoint,
  setLiveReserveCheckpointChildDisposition,
  type ScheduledCheckpointIdentity,
  type ScheduledRecoveryCheckpoint,
} from "../../lib/scheduled-recovery-checkpoint";
import { createLeaseOwner } from "../../lib/cron-lease-primitives";
import { getReserveProducerPriority } from "../../lib/reserve-producer-priority";

const SLOT_LABEL = "four-hourly reserve sync slot";

function checkpointIdentity(checkpoint: ScheduledRecoveryCheckpoint): ScheduledCheckpointIdentity {
  return {
    scheduleKey: checkpoint.scheduleKey,
    slotStartedAt: checkpoint.slotStartedAt,
    job: checkpoint.job,
    attemptNo: checkpoint.attemptNo,
    executionGeneration: checkpoint.executionGeneration,
    invocationId: checkpoint.invocationId,
  };
}

function isReserveQueueExhausted(checkpoint: ScheduledRecoveryCheckpoint): boolean {
  return checkpoint.nextItemKey === null && checkpoint.itemsDone === checkpoint.itemsTotal;
}

function checkpointTask(
  runtime: ScheduledRuntimeContext,
  checkpoint: ScheduledRecoveryCheckpoint,
  task: ScheduledSlotGroup["tasks"][number],
): ScheduledSlotGroup["tasks"][number] {
  return {
    ...task,
    run: async (signal, reportProgress) => {
      const identity = checkpointIdentity(checkpoint);
      await setLiveReserveCheckpointChildDisposition(runtime.db, identity, task.job, "running");
      try {
        const result = await task.run(signal, reportProgress);
        const checkpointAfterTask =
          task.job === "sync-live-reserves" ? await loadLiveReserveCheckpoint(runtime.db, identity) : null;
        if (task.job === "sync-live-reserves" && !checkpointAfterTask) {
          throw new Error("live reserve checkpoint missing after queue execution");
        }
        const childDisposition =
          result?.status === "skipped_neutral" ||
          result?.status === "skipped_locked" ||
          (checkpointAfterTask != null && !isReserveQueueExhausted(checkpointAfterTask))
            ? "not_started"
            : result?.status === "error"
              ? "failed"
              : "completed";
        await setLiveReserveCheckpointChildDisposition(runtime.db, identity, task.job, childDisposition);
        return result;
      } catch (error) {
        try {
          await setLiveReserveCheckpointChildDisposition(runtime.db, identity, task.job, "failed");
        } catch (checkpointError) {
          logWorkerEventArgs("handler", "warn", `[hourly-live-reserves] Failed to mark ${task.job} checkpoint failed:`, checkpointError);
        }
        throw error;
      }
    },
  };
}

function buildReserveSyncSlotGroups(
  runtime: ScheduledRuntimeContext,
  checkpoint: ScheduledRecoveryCheckpoint,
): ScheduledSlotGroup[] {
  const groups: ScheduledSlotGroup[] = [
    {
      mode: "serial",
      label: "reserve-adapters",
      stopOnFailure: true,
      stopOnNonNeutralSkip: true,
      tasks: [
        {
          job: "sync-live-reserves",
          errorMessage: "[hourly-live-reserves] Live reserves sync failed:",
          run: async (signal, reportProgress) => {
            // An exhausted recovery checkpoint needs only its consumers, not
            // the complete reserve-adapter graph retained beside their inputs.
            const { syncLiveReserves } = await import("../../cron/sync-live-reserves");
            return syncLiveReserves(
              runtime.db,
              signal,
              {
                etherscanApiKey: runtime.env.ETHERSCAN_API_KEY,
                alchemyApiKey: runtime.env.ALCHEMY_API_KEY,
                trongridApiKey: runtime.env.TRONGRID_API_KEY,
                m0ApiKey: runtime.env.M0_API_KEY,
                chainRpcs: runtime.chainRpcs,
                dwellirNative: runtime.dwellirNative,
              },
              reportProgress,
              undefined,
              checkpointIdentity(checkpoint),
            );
          },
        },
      ],
    },
    {
      mode: "serial",
      label: "redemption-backstops",
      tasks: [
        {
          job: "sync-redemption-backstops",
          errorMessage: "[hourly-live-reserves] Redemption backstops sync failed:",
          // Static initialization would retain the V9 redemption-policy graph
          // during every reserve adapter attempt, before this consumer is due.
          run: async (signal, reportProgress) => {
            await reportProgress({ stage: "initializing-redemption-backstops" });
            const { syncRedemptionBackstops } = await import("../../cron/sync-redemption-backstops");
            return syncRedemptionBackstops(runtime.db, signal, { chainRpcs: runtime.chainRpcs }, reportProgress);
          },
        },
      ],
    },
    {
      mode: "serial",
      label: "kinesis-supply",
      tasks: [
        {
          job: "sync-kinesis-supply",
          errorMessage: "[hourly-live-reserves] Kinesis supply sync failed:",
          run: (signal) => syncKinesisSupply(runtime.db, signal),
        },
      ],
    },
    {
      mode: "serial",
      label: "reserve-post-sync",
      tasks: [
        {
          job: "cron-sentinel",
          errorMessage: "[hourly-live-reserves] Reserve post-sync watchdog failed:",
          // Keep the multi-mode sentinel graph out of the producer's heap until
          // its generation has finished and this ordered consumer can execute.
          run: async (signal) => {
            const { runCronSentinel } = await import("../../cron/cron-sentinel");
            return runCronSentinel(runtime.db, { mode: "reserve-post-sync", signal });
          },
        },
      ],
    },
  ];
  const shouldRunJobs = new Set<string>();
  for (const group of groups) {
    for (const task of group.tasks) {
      const taskCompleted = checkpoint.childDispositions[task.job] === "completed";
      const durableFrontierCompleted = task.job !== "sync-live-reserves" || isReserveQueueExhausted(checkpoint);
      if (!taskCompleted || !durableFrontierCompleted) shouldRunJobs.add(task.job);
    }
  }
  if (shouldRunJobs.has("sync-live-reserves")) shouldRunJobs.add("sync-redemption-backstops");
  return groups.map((group) => ({
    ...group,
    tasks: group.tasks
      .filter((task) => shouldRunJobs.has(task.job))
      .map((task) => checkpointTask(runtime, checkpoint, task)),
  }));
}

async function recordBlockedReserveTasks(
  runtime: ScheduledRuntimeContext,
  checkpoint: ScheduledCheckpointIdentity,
  tasks: readonly ScheduledSlotGroup["tasks"][number][],
  blockedBy: string,
): Promise<ScheduledSlotSummary> {
  const reason = `upstream-incomplete:${blockedBy}`;
  for (const task of tasks) {
    await setLiveReserveCheckpointChildDisposition(runtime.db, checkpoint, task.job, "not_started");
    await logSkippedCronRun(runtime, {
      job: task.job,
      reason,
      message: `${task.job} did not start because ${blockedBy} did not complete`,
      metadata: { childDisposition: "not_started" },
    });
  }
  return buildScheduledSlotSummary(tasks.map((task) => summarizeSkippedScheduledJob(task.job, reason)));
}

async function recordPriorityDeferredReserveTasks(
  runtime: ScheduledRuntimeContext,
  jobs: readonly string[],
  reason: string,
  metadata: Record<string, unknown>,
): Promise<ScheduledSlotSummary> {
  for (const job of jobs) await logSkippedCronRun(runtime, {
    job, status: "skipped_neutral", reason, message: "Reserve replay deferred for a protected scheduled slot", metadata,
  });
  return buildScheduledSlotSummary(jobs.map((job) => ({
    job, outcome: "skipped", status: "skipped_neutral", reason, neutral: true,
  })));
}

export async function runFourHourlyReserveSyncSlot(runtime: ScheduledRuntimeContext) {
  if (runtime.recoveryCheckpoint) {
    const priority = await getReserveProducerPriority(runtime.db);
    if (priority) {
      const jobs = buildReserveSyncSlotGroups(runtime, runtime.recoveryCheckpoint)
        .flatMap((group) => group.tasks.map((task) => task.job));
      return recordPriorityDeferredReserveTasks(runtime, jobs, priority.reason, { producerPriority: priority });
    }
  }
  const checkpoint =
    runtime.recoveryCheckpoint ??
    (await beginLiveReserveCheckpoint(runtime.db, {
      slotStartedAt: runtime.slotStartedAt,
      invocationId: runtime.invocationId ?? createLeaseOwner("reserve-checkpoint"),
      workerVersion: runtime.workerVersion ?? null,
    }));
  const identity = checkpointIdentity(checkpoint);
  const [reserveAdapterGroup, redemptionGroup, kinesisGroup, postSyncGroup] =
    buildReserveSyncSlotGroups(runtime, checkpoint);
  const syncTask = reserveAdapterGroup?.tasks[0];
  const redemptionTasks = redemptionGroup?.tasks ?? [];
  const kinesisTasks = kinesisGroup?.tasks ?? [];
  const postSyncTasks = postSyncGroup?.tasks ?? [];
  // Kinesis is independent. Redemption reads only sealed acceptance after the
  // head settles, while the sentinel still requires this slot's full cohort.
  const main = syncTask
    ? runScheduledSlotGroups(runtime, SLOT_LABEL, [{ ...reserveAdapterGroup, tasks: [syncTask] }])
    : Promise.resolve(buildScheduledSlotSummary([]));
  // The independent five-minute lane declares 2/6, unlike the regular 3/6
  // producer slot. Keep the independent child, but never overlap its fetch.
  if (runtime.recoveryCheckpoint) await main;
  const [mainSummary, kinesisSummary] = await Promise.all([
    main,
    kinesisTasks.length > 0 && kinesisGroup
      ? runScheduledSlotGroups(runtime, SLOT_LABEL, [kinesisGroup])
      : buildScheduledSlotSummary([]),
  ]);
  const checkpointAfterMain = await loadLiveReserveCheckpoint(runtime.db, identity);
  if (!checkpointAfterMain) {
    throw new Error("live reserve checkpoint missing after queue stage");
  }
  const mainFailedAfterQueueExhaustion = mainSummary.jobsErrored > 0 && isReserveQueueExhausted(checkpointAfterMain);
  const summaries: ScheduledSlotSummary[] = [mainSummary, kinesisSummary];
  const admissionSkip = [...mainSummary.jobs, ...kinesisSummary.jobs].find((job) =>
    job.reason === "producer-slot-priority" || job.reason === "heavy-slot-co-tenancy");
  if (runtime.recoveryCheckpoint && admissionSkip) {
    summaries.push(await recordPriorityDeferredReserveTasks(runtime,
      [...redemptionTasks, ...postSyncTasks].map((task) => task.job), admissionSkip.reason!, {}));
    return mergeScheduledSlotSummaries(summaries);
  }
  const reserveStageCompleted =
    isReserveQueueExhausted(checkpointAfterMain)
    && mainSummary.jobsErrored === 0
    && mainSummary.jobsSkipped === 0;
  if (redemptionTasks.length > 0 && redemptionGroup) {
    summaries.push(await runScheduledSlotGroups(runtime, SLOT_LABEL, [redemptionGroup]));
    const redemptionSkip = summaries[summaries.length - 1]?.jobs.find((job) =>
      job.reason === "producer-slot-priority" || job.reason === "heavy-slot-co-tenancy");
    if (runtime.recoveryCheckpoint && redemptionSkip) {
      summaries.push(await recordPriorityDeferredReserveTasks(runtime,
        postSyncTasks.map((task) => task.job), redemptionSkip.reason!, {}));
      return mergeScheduledSlotSummaries(summaries);
    }
  }
  if (!reserveStageCompleted) {
    // an unfinished or failed reserve stage must not refresh the drift envelope
    // from the previous one. It re-runs with the replayed suffix.
    summaries.push(
      await recordBlockedReserveTasks(
        runtime,
        identity,
        postSyncTasks,
        "sync-live-reserves",
      ),
    );
  } else {
    // Redemption has already settled before the sentinel starts.
    if (postSyncTasks.length > 0 && postSyncGroup) {
      summaries.push(await runScheduledSlotGroups(runtime, SLOT_LABEL, [postSyncGroup]));
    }
  }
  const summary = mergeScheduledSlotSummaries(summaries);
  const checkpointAfterChildren = await loadLiveReserveCheckpoint(runtime.db, identity);
  if (!checkpointAfterChildren) {
    throw new Error("live reserve checkpoint missing before slot finalization");
  }
  if (mainFailedAfterQueueExhaustion) {
    await finishLiveReserveCheckpoint(runtime.db, identity, {
      state: "failed",
      error: "live reserve queue exhausted without a successful result",
    });
  } else if (
    summary.jobsErrored === 0 &&
    summary.jobsSkipped === 0 &&
    isReserveQueueExhausted(checkpointAfterChildren)
  ) {
    await finishLiveReserveCheckpoint(runtime.db, identity, {
      state: "completed",
      error: null,
    });
  }
  return summary;
}
