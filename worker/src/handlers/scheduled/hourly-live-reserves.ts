import { logWorkerEventArgs } from "../../lib/structured-log";
/**
 * Four-hourly reserve-sync trigger (11 * / 4 * * *):
 *   sync-live-reserves (2) → sync-redemption-backstops (0) → sync-kinesis-supply (1) → cron-sentinel reserve source (1)
 *
 * Reserve adapters run sequentially; backstops are DB-only.
 * Connection budget: 2/6 peak during reserve adapter I/O
 */
import { syncLiveReserves } from "../../cron/sync-live-reserves";
import { syncRedemptionBackstops } from "../../cron/sync-redemption-backstops";
import { syncKinesisSupply } from "../../cron/sync-kinesis-supply";
import { runCronSentinel } from "../../cron/cron-sentinel";
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
          run: (signal, reportProgress) =>
            syncLiveReserves(
              runtime.db,
              signal,
              {
                etherscanApiKey: runtime.env.ETHERSCAN_API_KEY,
                alchemyApiKey: runtime.env.ALCHEMY_API_KEY,
                trongridApiKey: runtime.env.TRONGRID_API_KEY,
                m0ApiKey: runtime.env.M0_API_KEY,
                chainRpcs: runtime.chainRpcs,
              },
              reportProgress,
              undefined,
              checkpointIdentity(checkpoint),
            ),
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
          run: (signal) => syncRedemptionBackstops(runtime.db, signal),
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
          run: (signal) => runCronSentinel(runtime.db, { mode: "reserve-post-sync", signal }),
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

export async function runFourHourlyReserveSyncSlot(runtime: ScheduledRuntimeContext) {
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
  const mainSummary = syncTask
    ? await runScheduledSlotGroups(runtime, "four-hourly reserve sync slot", [
        {
          ...reserveAdapterGroup,
          tasks: [syncTask],
        },
      ])
    : buildScheduledSlotSummary([]);
  const checkpointAfterMain = await loadLiveReserveCheckpoint(runtime.db, identity);
  if (!checkpointAfterMain) {
    throw new Error("live reserve checkpoint missing after queue stage");
  }
  const mainFailedAfterQueueExhaustion = mainSummary.jobsErrored > 0 && isReserveQueueExhausted(checkpointAfterMain);
  const summaries: ScheduledSlotSummary[] = [mainSummary];
  const reserveStageCompleted =
    isReserveQueueExhausted(checkpointAfterMain)
    && mainSummary.jobsErrored === 0
    && mainSummary.jobsSkipped === 0;
  if (!reserveStageCompleted) {
    summaries.push(
      await recordBlockedReserveTasks(
        runtime,
        identity,
        redemptionTasks,
        "sync-live-reserves",
      ),
    );
  } else if (redemptionTasks.length > 0 && redemptionGroup) {
    summaries.push(await runScheduledSlotGroups(runtime, "four-hourly reserve sync slot", [redemptionGroup]));
  }
  if (kinesisTasks.length > 0 && kinesisGroup) {
    summaries.push(await runScheduledSlotGroups(runtime, "four-hourly reserve sync slot", [kinesisGroup]));
  }
  if (!reserveStageCompleted) {
    summaries.push(
      await recordBlockedReserveTasks(
        runtime,
        identity,
        postSyncTasks,
        "sync-live-reserves",
      ),
    );
  } else if (postSyncTasks.length > 0 && postSyncGroup) {
    summaries.push(await runScheduledSlotGroups(runtime, "four-hourly reserve sync slot", [postSyncGroup]));
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
