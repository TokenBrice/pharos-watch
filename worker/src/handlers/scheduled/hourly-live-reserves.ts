/**
 * Four-hourly reserve-sync trigger (11 * / 4 * * *):
 *   sync-live-reserves (2) → sync-redemption-backstops (0) → sync-kinesis-supply (1) → collateral drift check (0)
 *
 * Reserve adapters run sequentially; backstops are DB-only.
 * Connection budget: 2/6 peak during reserve adapter I/O
 */
import { syncLiveReserves } from "../../cron/sync-live-reserves";
import { syncRedemptionBackstops } from "../../cron/sync-redemption-backstops";
import { syncKinesisSupply } from "../../cron/sync-kinesis-supply";
import { checkCollateralDrift } from "../../lib/collateral-drift";
import { computeReserveCompositionOverview, getMaxSyncAge } from "../../lib/live-reserves-store";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { sendAlert } from "../../lib/alerts";
import { logCronEvent } from "../../lib/cron-logger";
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
      job: "sync-live-reserves",
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
      job: "sync-live-reserves",
      eventType: "reserve-alert-delivery-failed",
      severity: "warning",
      message: "Reserve-sync alert delivery threw unexpectedly.",
      metadata: {
        alertType,
        deliveryTargetClass: reserveAlertTargetClass(runtime),
        error: err instanceof Error ? err.message : String(err),
        ...metadata,
      },
    });
  }
}

function buildReserveSyncSlotGroups(runtime: ScheduledRuntimeContext): ScheduledSlotGroup[] {
  return [
    {
      mode: "serial",
      label: "reserve-adapters",
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
  ];
}

export async function runFourHourlyReserveSyncSlot(runtime: ScheduledRuntimeContext) {
  const summary = await runScheduledSlotGroups(
    runtime,
    "four-hourly reserve sync slot",
    buildReserveSyncSlotGroups(runtime),
  );

  try {
    const drift = await checkCollateralDrift(runtime.db);
    if (drift.driftCoins.length > 0) {
      const summary = drift.driftCoins
        .map((d) => `${d.id}: live=${d.liveScore}, curated=${d.curatedScore} (Δ${d.delta})`)
        .join("\n");
      console.warn(`[live-reserves] Collateral drift detected:\n${summary}`);
      await sendReserveSyncAlert(
        runtime,
        "collateral-score-drift",
        "Collateral Score Drift",
        `${drift.driftCoins.length} coin(s) with >15pt live/curated divergence:\n${summary}`,
        { driftCoinCount: drift.driftCoins.length },
      );
    }
    if (drift.fallbackCoins.length > 5) {
      console.warn(`[live-reserves] ${drift.fallbackCoins.length} live-enabled coins using curated fallback`);
    }

    const maxAge = await getMaxSyncAge(runtime.db);
    // Alert after ~3 missed 4-hourly runs, matching the "several missed runs"
    // posture the previous 6h threshold gave at the prior hourly cadence.
    if (maxAge > 12 * 3600) {
      await sendReserveSyncAlert(
        runtime,
        "live-reserve-sync-stale",
        "Live reserve sync stale",
        `No successful sync in ${Math.round(maxAge / 3600)}h. Check cron scheduler.`,
        { maxAgeHours: Math.round(maxAge / 3600) },
      );
    }
  } catch (e) {
    console.error("[live-reserves] Drift check failed:", e);
  }

  try {
    const overview = await computeReserveCompositionOverview(
      runtime.db,
      Math.floor(Date.now() / 1000),
    );
    const persistentlyStale = overview.persistentlyStaleIndependentCoins;
    const maxStaleAgeSec = persistentlyStale.length > 0 ? persistentlyStale[0].ageSec : 0;
    const shouldAlert =
      persistentlyStale.length > PERSISTENTLY_STALE_ALERT_COUNT_THRESHOLD
      || maxStaleAgeSec > PERSISTENTLY_STALE_ALERT_MAX_AGE_SEC;
    if (shouldAlert) {
      const summary = persistentlyStale
        .map((entry) => `${entry.stablecoinId}: ${Math.round(entry.ageSec / DAY_SECONDS)}d`)
        .join("\n");
      console.warn(`[live-reserves] Persistently-stale independent sources:\n${summary}`);
      await sendReserveSyncAlert(
        runtime,
        "persistently-stale-independent-sources",
        "Persistently-stale independent reserve sources",
        `${persistentlyStale.length} coin(s) configured-live with degraded/error status and last success >14d ago:\n${summary}`,
        {
          staleCoinCount: persistentlyStale.length,
          maxStaleAgeDays: Math.round(maxStaleAgeSec / DAY_SECONDS),
        },
      );
    }
  } catch (e) {
    console.error("[live-reserves] Persistent-stale overview failed:", e);
  }

  return summary;
}
