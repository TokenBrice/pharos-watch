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
import { sendAlert } from "../../lib/alerts";
import { logCronEvent, recordCronFailure, type CronResult } from "../../lib/cron-logger";
import type { ScheduledRuntimeContext } from "./context";
import { runScheduledSlotGroups, type ScheduledSlotGroup } from "./slot-groups";

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
    const driftIds = drift.driftCoins.map((d) => d.id).sort();
    await setCache(runtime.db, SNAPSHOT_KEYS.reserve, JSON.stringify(driftIds), signal);

    maxSyncAgeSec = await getMaxSyncAge(runtime.db);
    throwIfAborted(signal);
    // Alert after ~3 missed 4-hourly runs, matching the "several missed runs"
    // posture the previous 6h threshold gave at the prior hourly cadence.
    if (maxSyncAgeSec > 12 * 3600) {
      await sendReserveSyncAlert(
        runtime,
        "live-reserve-sync-stale",
        "Live reserve sync stale",
        `No successful sync in ${Math.round(maxSyncAgeSec / 3600)}h. Check cron scheduler.`,
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

function buildReserveSyncSlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
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
}

export async function runFourHourlyReserveSyncSlot(runtime: ScheduledRuntimeContext) {
  return runScheduledSlotGroups(
    runtime,
    "four-hourly reserve sync slot",
    buildReserveSyncSlotGroups(runtime),
  );
}
