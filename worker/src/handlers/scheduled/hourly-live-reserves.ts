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
import { setCache } from "../../lib/db-cache";
import { SNAPSHOT_KEYS } from "../../cron/telegram-alert-snapshots";
import { computeReserveCompositionOverview, getMaxSyncAge } from "../../lib/live-reserves-store";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { logCronEvent, recordCronFailure, type CronResult } from "../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";
import {
  beginScheduledCheckpoint,
  checkpointErrorMetadata,
  finishScheduledCheckpoint,
  setScheduledCheckpointChildDisposition,
  type ScheduledCheckpointIdentity,
  type ScheduledRecoveryCheckpoint,
} from "../../lib/scheduled-recovery-checkpoint";
import {
  LIVE_RESERVE_QUEUE_HASH,
  SYNC_ORDERED_CONFIGURED_COINS,
} from "../../cron/sync-live-reserves-shared";
import { flattenScheduledSlotPlanJobs, SCHEDULED_SLOT_PLANS } from "@shared/lib/scheduled-runner-registry";
import { createLeaseOwner } from "../../lib/cron-lease-primitives";
import { reportAlertCondition } from "../../lib/alert-broker";

const PERSISTENTLY_STALE_ALERT_COUNT_THRESHOLD = 3;
const PERSISTENTLY_STALE_ALERT_MAX_AGE_SEC = 21 * DAY_SECONDS;

function reserveAlertTargetClass(runtime: ScheduledRuntimeContext): string {
  if (!runtime.alertWebhookUrl) return "missing-webhook";
  return runtime.alertWebhookUrl.includes("discord.com/api/webhooks") ? "discord-webhook" : "webhook";
}

async function reportReserveSyncCondition(
  runtime: ScheduledRuntimeContext,
  alertType: string,
  active: boolean,
  title: string,
  message: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await reportAlertCondition(runtime.db, {
      conditionKey: `reserve:${alertType}`,
      active,
      fingerprint: { alertType },
      severity: alertType === "live-reserve-sync-stale" ? "critical" : "warning",
      title,
      message,
      recoveryTitle: `${title} recovered`,
      recoveryMessage: `${alertType} is no longer active.`,
      metadata: {
        alertType,
        deliveryTargetClass: reserveAlertTargetClass(runtime),
        ...metadata,
      },
      mode: runtime.env.ALERT_BROKER_MODE,
      webhookUrl: runtime.alertWebhookUrl,
    });
  } catch (err) {
    await logCronEvent(runtime.db, {
      job: "reserve-post-sync-watchdog",
      eventType: "reserve-alert-broker-failed",
      severity: "warning",
      message: "Reserve-sync alert condition could not be persisted.",
      metadata: {
        alertType,
        deliveryTargetClass: reserveAlertTargetClass(runtime),
        error: toErrorMessage(err),
        ...metadata,
      },
    });
    throw err;
  }
}

async function runReservePostSyncWatchdog(
  runtime: ScheduledRuntimeContext,
  signal?: AbortSignal,
): Promise<CronResult> {
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
      await reportReserveSyncCondition(
        runtime,
        "collateral-score-drift",
        true,
        "Collateral Score Drift",
        `${drift.driftCoins.length} coin(s) with >15pt live/curated divergence:\n${driftSummary}`,
        { driftCoinCount: drift.driftCoins.length },
      );
    } else {
      await reportReserveSyncCondition(
        runtime,
        "collateral-score-drift",
        false,
        "Collateral Score Drift",
        "No material collateral-score drift is active.",
        { driftCoinCount: 0 },
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
    const driftIds = drift.driftCoins.map((d) => d.id).sort();
    await setCache(runtime.db, SNAPSHOT_KEYS.reserve, JSON.stringify(driftIds), signal);

    maxSyncAgeSec = await getMaxSyncAge(
      runtime.db,
      Math.floor(Date.now() / 1000),
      SYNC_ORDERED_CONFIGURED_COINS.map((coin) => coin.id),
    );
    throwIfAborted(signal);
    // Alert after ~3 missed 4-hourly runs, matching the "several missed runs"
    // posture the previous 6h threshold gave at the prior hourly cadence.
    const reserveSyncStale = maxSyncAgeSec > 12 * 3600;
    await reportReserveSyncCondition(
      runtime,
      "live-reserve-sync-stale",
      reserveSyncStale,
      "Live reserve sync stale",
      reserveSyncStale
        ? `Oldest configured reserve has not been attempted in ${Math.round(maxSyncAgeSec / 3600)}h. Check cron scheduler.`
        : "Every configured reserve has a current attempt.",
      { maxAgeHours: Number.isFinite(maxSyncAgeSec) ? Math.round(maxSyncAgeSec / 3600) : null },
    );
  } catch (e) {
    rethrowIfAborted(e, signal);
    degradedReasons.push("drift-cache-age-check-failed");
    recordCronFailure("reserve-post-sync-watchdog", e, { metadata: { stage: "drift-cache-age" } });
  }

  try {
    throwIfAborted(signal);
    const overview = await computeReserveCompositionOverview(
      runtime.db,
      Math.floor(Date.now() / 1000),
    );
    throwIfAborted(signal);
    const persistentlyStale = overview.persistentlyStaleIndependentCoins;
    persistentlyStaleIndependentCoinCount = persistentlyStale.length;
    maxPersistentlyStaleAgeSec = persistentlyStale.length > 0 ? persistentlyStale[0].ageSec : 0;
    const shouldAlert =
      persistentlyStale.length > PERSISTENTLY_STALE_ALERT_COUNT_THRESHOLD
      || maxPersistentlyStaleAgeSec > PERSISTENTLY_STALE_ALERT_MAX_AGE_SEC;
    const staleSummary = persistentlyStale
      .map((entry) => `${entry.stablecoinId}: ${Math.round(entry.ageSec / DAY_SECONDS)}d`)
      .join("\n");
    if (shouldAlert) {
      console.warn(`[live-reserves] Persistently-stale independent sources:\n${staleSummary}`);
    }
    await reportReserveSyncCondition(
      runtime,
      "persistently-stale-independent-sources",
      shouldAlert,
      "Persistently-stale independent reserve sources",
      shouldAlert
        ? `${persistentlyStale.length} coin(s) configured-live with degraded/error status and last success >14d ago:\n${staleSummary}`
        : "Independent reserve sources are within the persistent-staleness threshold.",
      {
        staleCoinCount: persistentlyStale.length,
        maxStaleAgeDays: Math.round(maxPersistentlyStaleAgeSec / DAY_SECONDS),
      },
    );
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

export const LIVE_RESERVE_SLOT_JOBS = flattenScheduledSlotPlanJobs(
  SCHEDULED_SLOT_PLANS.fourHourlyReserveSync,
);

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

function checkpointTask(
  runtime: ScheduledRuntimeContext,
  checkpoint: ScheduledRecoveryCheckpoint,
  task: ScheduledSlotGroup["tasks"][number],
): ScheduledSlotGroup["tasks"][number] {
  return {
    ...task,
    run: async (signal, reportProgress) => {
      const identity = checkpointIdentity(checkpoint);
      await setScheduledCheckpointChildDisposition(runtime.db, identity, task.job, "running");
      try {
        const result = await task.run(signal, reportProgress);
        await setScheduledCheckpointChildDisposition(
          runtime.db,
          identity,
          task.job,
          result?.status === "error" ? "failed" : "completed",
        );
        return result;
      } catch (error) {
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
): ScheduledSlotGroup[] {
  const groups: ScheduledSlotGroup[] = [
    {
      mode: "serial",
      label: "reserve-adapters",
      stopOnFailure: true,
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
  return groups.map((group) => ({
    ...group,
    tasks: group.tasks
      .filter((task) => checkpoint.childDispositions[task.job] !== "completed")
      .map((task) => checkpointTask(runtime, checkpoint, task)),
  }));
}

export async function runFourHourlyReserveSyncSlot(runtime: ScheduledRuntimeContext) {
  const checkpoint = runtime.recoveryCheckpoint ?? await beginScheduledCheckpoint(runtime.db, {
    scheduleKey: runtime.scheduleKey,
    slotStartedAt: runtime.slotStartedAt,
    job: "sync-live-reserves",
    invocationId: runtime.invocationId ?? createLeaseOwner("reserve-checkpoint"),
    workerVersion: runtime.workerVersion ?? null,
    queueHash: LIVE_RESERVE_QUEUE_HASH,
    nextItemKey: SYNC_ORDERED_CONFIGURED_COINS[0]?.id ?? null,
    itemsTotal: SYNC_ORDERED_CONFIGURED_COINS.length,
    childJobs: LIVE_RESERVE_SLOT_JOBS,
  });
  const identity = checkpointIdentity(checkpoint);
  try {
    const summary = await runScheduledSlotGroups(
      runtime,
      "four-hourly reserve sync slot",
      buildReserveSyncSlotGroups(runtime, checkpoint),
    );
    await finishScheduledCheckpoint(runtime.db, identity, {
      state: summary.jobsErrored > 0 ? "failed" : "completed",
      error: summary.jobsErrored > 0 ? "one or more reserve-slot children failed" : null,
    });
    return summary;
  } catch (error) {
    try {
      await finishScheduledCheckpoint(runtime.db, identity, {
        state: "failed",
        error: checkpointErrorMetadata(error),
      });
    } catch (checkpointError) {
      console.warn("[hourly-live-reserves] Failed to finish reserve checkpoint:", checkpointError);
    }
    throw error;
  }
}
