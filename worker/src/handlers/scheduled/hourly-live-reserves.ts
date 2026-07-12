import { toErrorMessage } from "../../lib/error-utils";
/**
 * Four-hourly reserve-sync trigger (11 * / 4 * * *):
 *   sync-live-reserves (2) → sync-redemption-backstops (0) → sync-kinesis-supply (1) → reserve-post-sync-watchdog (1)
 *
 * Reserve adapters run sequentially; backstops are DB-only.
 * Connection budget: 2/6 peak during reserve adapter I/O
 */
import { syncLiveReserves } from "../../cron/sync-live-reserves";
import { syncRedemptionBackstops } from "../../cron/sync-redemption-backstops";
import { syncKinesisSupply } from "../../cron/sync-kinesis-supply";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { checkCollateralDrift } from "../../lib/collateral-drift";
import { getCache, setCache } from "../../lib/db-cache";
import { SNAPSHOT_KEYS } from "../../cron/telegram-alert-snapshots";
import { computeReserveCompositionOverview, getMaxSyncAge } from "../../lib/live-reserves-store";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { sendAlert } from "../../lib/alerts";
import { logCronEvent, recordCronFailure, type CronResult } from "../../lib/cron-logger";
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
  beginScheduledCheckpoint,
  finishScheduledCheckpoint,
  loadScheduledCheckpoint,
  setScheduledCheckpointChildDisposition,
  type ScheduledCheckpointIdentity,
  type ScheduledRecoveryCheckpoint,
} from "../../lib/scheduled-recovery-checkpoint";
import { LIVE_RESERVE_QUEUE_HASH, SYNC_ORDERED_CONFIGURED_COINS } from "../../cron/sync-live-reserves-shared";
import { flattenScheduledSlotPlanJobs, SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import { createLeaseOwner } from "../../lib/cron-lease-primitives";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { buildAlertReserveSourceEnvelope } from "../../lib/alert-reserve-source-cache";
import {
  isReserveRecoveryFaultInjectionTermination,
  loadReserveRecoveryFaultInjectionController,
  type ReserveRecoveryFaultInjectionController,
  type ReserveRecoveryFaultKillPoint,
} from "../../lib/reserve-recovery-fault-injection";
import { isReserveRecoveryFaultInjectionEnabled } from "../../lib/env";

const PERSISTENTLY_STALE_ALERT_COUNT_THRESHOLD = 3;
const PERSISTENTLY_STALE_ALERT_MAX_AGE_SEC = 21 * DAY_SECONDS;

function reserveAlertTargetClass(runtime: ScheduledRuntimeContext): string {
  if (!runtime.alertWebhookUrl) return "missing-webhook";
  return runtime.alertWebhookUrl.includes("discord.com/api/webhooks") ? "discord-webhook" : "webhook";
}

async function sendReserveSyncAlert(
  runtime: ScheduledRuntimeContext,
  alertType: string,
  title: string,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    const delivered = await sendAlert(runtime.alertWebhookUrl, title, message);
    if (delivered) return;
    await logCronEvent(runtime.db, {
      job: "reserve-post-sync-watchdog",
      eventType: "reserve-alert-delivery-failed",
      severity: "warning",
      message: "Reserve-sync alert delivery failed.",
      metadata: {
        alertType,
        deliveryTargetClass: reserveAlertTargetClass(runtime),
        ...metadata,
      },
    });
  } catch (err) {
    await logCronEvent(runtime.db, {
      job: "reserve-post-sync-watchdog",
      eventType: "reserve-alert-delivery-failed",
      severity: "warning",
      message: "Reserve-sync alert delivery threw unexpectedly.",
      metadata: {
        alertType,
        deliveryTargetClass: reserveAlertTargetClass(runtime),
        error: toErrorMessage(err),
        ...metadata,
      },
    });
  }
}

async function runReservePostSyncWatchdog(runtime: ScheduledRuntimeContext, signal?: AbortSignal): Promise<CronResult> {
  const degradedReasons: string[] = [];
  let driftCoinCount = 0;
  let fallbackCoinCount = 0;
  let maxSyncAgeSec: number | null = null;
  let persistentlyStaleIndependentCoinCount = 0;
  let maxPersistentlyStaleAgeSec = 0;

  try {
    throwIfAborted(signal);
    const drift = await checkCollateralDrift(runtime.db);
    throwIfAborted(signal);
    driftCoinCount = drift.driftCoins.length;
    fallbackCoinCount = drift.fallbackCoins.length;
    if (drift.driftCoins.length > 0) {
      const driftSummary = drift.driftCoins
        .map((d) => `${d.id}: live=${d.liveScore}, curated=${d.curatedScore} (Δ${d.delta})`)
        .join("\n");
      console.warn(`[live-reserves] Collateral drift detected:\n${driftSummary}`);
      await sendReserveSyncAlert(
        runtime,
        "collateral-score-drift",
        "Collateral Score Drift",
        `${drift.driftCoins.length} coin(s) with >15pt live/curated divergence:\n${driftSummary}`,
        { driftCoinCount: drift.driftCoins.length },
      );
    }
    if (drift.fallbackCoins.length > 5) {
      console.warn(`[live-reserves] ${drift.fallbackCoins.length} live-enabled coins using curated fallback`);
    }

    // Persist the currently-drifting id-set for the Telegram reserve-drift alert
    // family (C123). The four-hourly reserve slot is the producer; the dispatch
    // cron only diffs prior-vs-current from this snapshot and never recomputes
    // drift, keeping reserve-adapter network I/O out of the dispatch trigger's
    // 6-connection pool. fallbackCoins (failed live fetch) are intentionally
    // omitted so a transient fetch failure never reads as a drift change.
    const reservePublishedAt = Math.floor(Date.now() / 1000);
    const previousReserveSource = await getCache(runtime.db, SNAPSHOT_KEYS.reserve);
    const reserveSourceEnvelope = buildAlertReserveSourceEnvelope(
      drift.driftCoins.map((d) => d.id),
      previousReserveSource,
      {
        nowSec: reservePublishedAt,
        producerIntervalSec: CRON_INTERVALS["sync-live-reserves"],
      },
    );
    await setCache(runtime.db, SNAPSHOT_KEYS.reserve, JSON.stringify(reserveSourceEnvelope), signal);

    maxSyncAgeSec = await getMaxSyncAge(
      runtime.db,
      Math.floor(Date.now() / 1000),
      SYNC_ORDERED_CONFIGURED_COINS.map((coin) => coin.id),
    );
    throwIfAborted(signal);
    // Alert after ~3 missed 4-hourly runs, matching the "several missed runs"
    // posture the previous 6h threshold gave at the prior hourly cadence.
    if (maxSyncAgeSec > 12 * 3600) {
      await sendReserveSyncAlert(
        runtime,
        "live-reserve-sync-stale",
        "Live reserve sync stale",
        `Oldest configured reserve has not been attempted in ${Math.round(maxSyncAgeSec / 3600)}h. Check cron scheduler.`,
        { maxAgeHours: Math.round(maxSyncAgeSec / 3600) },
      );
    }
  } catch (e) {
    rethrowIfAborted(e, signal);
    degradedReasons.push("drift-cache-age-check-failed");
    recordCronFailure("reserve-post-sync-watchdog", e, { metadata: { stage: "drift-cache-age" } });
  }

  try {
    throwIfAborted(signal);
    const overview = await computeReserveCompositionOverview(runtime.db, Math.floor(Date.now() / 1000));
    throwIfAborted(signal);
    const persistentlyStale = overview.persistentlyStaleIndependentCoins;
    persistentlyStaleIndependentCoinCount = persistentlyStale.length;
    maxPersistentlyStaleAgeSec = persistentlyStale.length > 0 ? persistentlyStale[0].ageSec : 0;
    const shouldAlert =
      persistentlyStale.length > PERSISTENTLY_STALE_ALERT_COUNT_THRESHOLD ||
      maxPersistentlyStaleAgeSec > PERSISTENTLY_STALE_ALERT_MAX_AGE_SEC;
    if (shouldAlert) {
      const staleSummary = persistentlyStale
        .map((entry) => `${entry.stablecoinId}: ${Math.round(entry.ageSec / DAY_SECONDS)}d`)
        .join("\n");
      console.warn(`[live-reserves] Persistently-stale independent sources:\n${staleSummary}`);
      await sendReserveSyncAlert(
        runtime,
        "persistently-stale-independent-sources",
        "Persistently-stale independent reserve sources",
        `${persistentlyStale.length} coin(s) configured-live with degraded/error status and last success >14d ago:\n${staleSummary}`,
        {
          staleCoinCount: persistentlyStale.length,
          maxStaleAgeDays: Math.round(maxPersistentlyStaleAgeSec / DAY_SECONDS),
        },
      );
    }
  } catch (e) {
    rethrowIfAborted(e, signal);
    degradedReasons.push("persistent-stale-overview-failed");
    recordCronFailure("reserve-post-sync-watchdog", e, { metadata: { stage: "persistent-stale-overview" } });
  }

  return {
    status: degradedReasons.length > 0 ? "degraded" : "ok",
    itemCount: driftCoinCount + persistentlyStaleIndependentCoinCount,
    metadata: JSON.stringify({
      degradedReasons,
      driftCoinCount,
      fallbackCoinCount,
      maxSyncAgeSec,
      persistentlyStaleIndependentCoinCount,
      maxPersistentlyStaleAgeSec,
    }),
  };
}

export const LIVE_RESERVE_SLOT_JOBS = flattenScheduledSlotPlanJobs(SCHEDULED_SLOT_PLANS.fourHourlyReserveSync);

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
  faultInjection: ReserveRecoveryFaultInjectionController | null,
): ScheduledSlotGroup["tasks"][number] {
  return {
    ...task,
    run: async (signal, reportProgress) => {
      const sidecarKillPoint = (
        {
          "sync-redemption-backstops": "before_sync-redemption-backstops",
          "sync-kinesis-supply": "before_sync-kinesis-supply",
          "reserve-post-sync-watchdog": "before_reserve-post-sync-watchdog",
        } as Partial<Record<string, ReserveRecoveryFaultKillPoint>>
      )[task.job];
      if (sidecarKillPoint) await faultInjection?.trigger(sidecarKillPoint);
      const identity = checkpointIdentity(checkpoint);
      await setScheduledCheckpointChildDisposition(runtime.db, identity, task.job, "running");
      try {
        const result = await task.run(signal, reportProgress);
        const checkpointAfterTask =
          task.job === "sync-live-reserves" ? await loadScheduledCheckpoint(runtime.db, identity) : null;
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
        await setScheduledCheckpointChildDisposition(runtime.db, identity, task.job, childDisposition);
        return result;
      } catch (error) {
        if (isReserveRecoveryFaultInjectionTermination(error)) throw error;
        try {
          await setScheduledCheckpointChildDisposition(runtime.db, identity, task.job, "failed");
        } catch (checkpointError) {
          console.warn(`[hourly-live-reserves] Failed to mark ${task.job} checkpoint failed:`, checkpointError);
        }
        throw error;
      }
    },
  };
}

function buildReserveSyncSlotGroups(
  runtime: ScheduledRuntimeContext,
  checkpoint: ScheduledRecoveryCheckpoint,
  faultInjection: ReserveRecoveryFaultInjectionController | null,
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
                chainRpcs: runtime.chainRpcs,
              },
              reportProgress,
              undefined,
              checkpointIdentity(checkpoint),
              faultInjection,
            ),
        },
        {
          job: "sync-redemption-backstops",
          errorMessage: "[hourly-live-reserves] Redemption backstops sync failed:",
          run: (signal) => syncRedemptionBackstops(runtime.db, signal),
        },
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
          job: "reserve-post-sync-watchdog",
          errorMessage: "[hourly-live-reserves] Reserve post-sync watchdog failed:",
          run: (signal) => runReservePostSyncWatchdog(runtime, signal),
        },
      ],
    },
  ];
  const shouldRunJobs = new Set<string>();
  let upstreamCompleted = isReserveQueueExhausted(checkpoint);
  for (const group of groups) {
    for (const task of group.tasks) {
      const taskCompleted = checkpoint.childDispositions[task.job] === "completed";
      if (!upstreamCompleted || !taskCompleted) shouldRunJobs.add(task.job);
      upstreamCompleted = upstreamCompleted && taskCompleted;
    }
  }
  return groups.map((group) => ({
    ...group,
    tasks: group.tasks
      .filter((task) => shouldRunJobs.has(task.job))
      .map((task) => checkpointTask(runtime, checkpoint, task, faultInjection)),
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
    await setScheduledCheckpointChildDisposition(runtime.db, checkpoint, task.job, "not_started");
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
    (await beginScheduledCheckpoint(runtime.db, {
      scheduleKey: runtime.scheduleKey,
      slotStartedAt: runtime.slotStartedAt,
      job: "sync-live-reserves",
      invocationId: runtime.invocationId ?? createLeaseOwner("reserve-checkpoint"),
      workerVersion: runtime.workerVersion ?? null,
      queueHash: LIVE_RESERVE_QUEUE_HASH,
      nextItemKey: SYNC_ORDERED_CONFIGURED_COINS[0]?.id ?? null,
      itemsTotal: SYNC_ORDERED_CONFIGURED_COINS.length,
      childJobs: LIVE_RESERVE_SLOT_JOBS,
    }));
  const identity = checkpointIdentity(checkpoint);
  const faultInjection = isReserveRecoveryFaultInjectionEnabled(runtime.env.WORKER_RESERVE_FAULT_INJECTION_ENABLED)
    ? await loadReserveRecoveryFaultInjectionController(runtime.db, checkpoint)
    : null;
  await faultInjection?.trigger("after_checkpoint");
  const [reserveAdapterGroup, postSyncGroup] = buildReserveSyncSlotGroups(runtime, checkpoint, faultInjection);
  const syncTask = reserveAdapterGroup?.tasks.find((task) => task.job === "sync-live-reserves");
  const adapterSidecarTasks = reserveAdapterGroup?.tasks.filter((task) => task.job !== "sync-live-reserves") ?? [];
  const postSyncTasks = postSyncGroup?.tasks ?? [];
  const mainSummary = syncTask
    ? await runScheduledSlotGroups(runtime, "four-hourly reserve sync slot", [
        {
          ...reserveAdapterGroup,
          tasks: [syncTask],
        },
      ])
    : buildScheduledSlotSummary([]);
  const checkpointAfterMain = await loadScheduledCheckpoint(runtime.db, identity);
  if (!checkpointAfterMain) {
    throw new Error("live reserve checkpoint missing after queue stage");
  }
  const mainFailedAfterQueueExhaustion = mainSummary.jobsErrored > 0 && isReserveQueueExhausted(checkpointAfterMain);
  const summaries: ScheduledSlotSummary[] = [mainSummary];
  if (!isReserveQueueExhausted(checkpointAfterMain)) {
    summaries.push(
      await recordBlockedReserveTasks(
        runtime,
        identity,
        [...adapterSidecarTasks, ...postSyncTasks],
        "sync-live-reserves",
      ),
    );
  } else if (mainSummary.jobsErrored > 0) {
    summaries.push(
      await recordBlockedReserveTasks(
        runtime,
        identity,
        [...adapterSidecarTasks, ...postSyncTasks],
        "sync-live-reserves",
      ),
    );
  } else if (mainSummary.jobsSkipped > 0) {
    summaries.push(
      await recordBlockedReserveTasks(
        runtime,
        identity,
        [...adapterSidecarTasks, ...postSyncTasks],
        "sync-live-reserves",
      ),
    );
  } else {
    const adapterSidecarSummary =
      adapterSidecarTasks.length > 0 && reserveAdapterGroup
        ? await runScheduledSlotGroups(runtime, "four-hourly reserve sync slot", [
            {
              ...reserveAdapterGroup,
              tasks: adapterSidecarTasks,
            },
          ])
        : buildScheduledSlotSummary([]);
    summaries.push(adapterSidecarSummary);
    if (adapterSidecarSummary.jobsErrored > 0 || adapterSidecarSummary.jobsSkipped > 0) {
      summaries.push(
        await recordBlockedReserveTasks(
          runtime,
          identity,
          postSyncTasks,
          adapterSidecarSummary.jobs.find((job) => job.outcome === "skipped")?.job ?? "reserve-sidecars",
        ),
      );
    } else if (postSyncGroup) {
      summaries.push(await runScheduledSlotGroups(runtime, "four-hourly reserve sync slot", [postSyncGroup]));
    }
  }
  const summary = mergeScheduledSlotSummaries(summaries);
  const checkpointAfterChildren = await loadScheduledCheckpoint(runtime.db, identity);
  if (!checkpointAfterChildren) {
    throw new Error("live reserve checkpoint missing before slot finalization");
  }
  if (mainFailedAfterQueueExhaustion) {
    await finishScheduledCheckpoint(runtime.db, identity, {
      state: "failed",
      error: "live reserve queue exhausted without a successful result",
    });
  } else if (
    summary.jobsErrored === 0 &&
    summary.jobsSkipped === 0 &&
    isReserveQueueExhausted(checkpointAfterChildren)
  ) {
    await finishScheduledCheckpoint(runtime.db, identity, {
      state: "completed",
      error: null,
    });
  }
  return summary;
}
