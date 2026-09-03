import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { buildAlertReserveSourceEnvelope } from "../lib/alert-reserve-source-cache";
import { rethrowIfAborted, throwIfAborted } from "../lib/abort";
import { checkCollateralDrift } from "../lib/collateral-drift";
import type { CronResult } from "../lib/cron-logger";
import { recordCronFailure } from "../lib/cron-logger";
import { getCache, setCache } from "../lib/db-cache";
import { computeReserveCompositionOverview, getMaxSyncAge } from "../lib/live-reserves/store";
import { logWorkerEventArgs } from "../lib/structured-log";
import { SYNC_ORDERED_CONFIGURED_COINS } from "./sync-live-reserves-shared";
import { SNAPSHOT_KEYS } from "./telegram-alert-snapshots";

const PERSISTENTLY_STALE_WARNING_COUNT_THRESHOLD = 3;
const PERSISTENTLY_STALE_WARNING_MAX_AGE_SEC = 21 * DAY_SECONDS;

export async function runReservePostSyncWatchdog(
  db: D1Database,
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
    const drift = await checkCollateralDrift(db);
    throwIfAborted(signal);
    driftCoinCount = drift.driftCoins.length;
    fallbackCoinCount = drift.fallbackCoins.length;
    if (drift.driftCoins.length > 0) {
      const driftSummary = drift.driftCoins
        .map((entry) => `${entry.id}: live=${entry.liveScore}, curated=${entry.curatedScore} (Δ${entry.delta})`)
        .join("\n");
      logWorkerEventArgs("handler", "warn", `[live-reserves] Collateral drift detected:\n${driftSummary}`);
    }
    if (drift.fallbackCoins.length > 5) {
      logWorkerEventArgs("handler", "warn", `[live-reserves] ${drift.fallbackCoins.length} live-enabled coins using curated fallback`);
    }

    const reservePublishedAt = Math.floor(Date.now() / 1000);
    const previousReserveSource = await getCache(db, SNAPSHOT_KEYS.reserve);
    const reserveSourceEnvelope = buildAlertReserveSourceEnvelope(
      drift.driftCoins.map((entry) => entry.id),
      previousReserveSource,
      {
        nowSec: reservePublishedAt,
        producerIntervalSec: CRON_INTERVALS["sync-live-reserves"],
      },
    );
    await setCache(db, SNAPSHOT_KEYS.reserve, JSON.stringify(reserveSourceEnvelope), signal);

    maxSyncAgeSec = await getMaxSyncAge(
      db,
      Math.floor(Date.now() / 1000),
      SYNC_ORDERED_CONFIGURED_COINS.map((coin) => coin.id),
    );
    throwIfAborted(signal);
  } catch (error) {
    rethrowIfAborted(error, signal);
    degradedReasons.push("drift-cache-age-check-failed");
    recordCronFailure("reserve-post-sync-watchdog", error, { metadata: { stage: "drift-cache-age" } });
  }

  try {
    throwIfAborted(signal);
    const overview = await computeReserveCompositionOverview(db, Math.floor(Date.now() / 1000));
    throwIfAborted(signal);
    const persistentlyStale = overview.persistentlyStaleIndependentCoins;
    persistentlyStaleIndependentCoinCount = persistentlyStale.length;
    maxPersistentlyStaleAgeSec = persistentlyStale.length > 0 ? persistentlyStale[0].ageSec : 0;
    const shouldWarn =
      persistentlyStale.length > PERSISTENTLY_STALE_WARNING_COUNT_THRESHOLD
      || maxPersistentlyStaleAgeSec > PERSISTENTLY_STALE_WARNING_MAX_AGE_SEC;
    if (shouldWarn) {
      const staleSummary = persistentlyStale
        .map((entry) => `${entry.stablecoinId}: ${Math.round(entry.ageSec / DAY_SECONDS)}d`)
        .join("\n");
      logWorkerEventArgs("handler", "warn", `[live-reserves] Persistently-stale independent sources:\n${staleSummary}`);
    }
  } catch (error) {
    rethrowIfAborted(error, signal);
    degradedReasons.push("persistent-stale-overview-failed");
    recordCronFailure("reserve-post-sync-watchdog", error, { metadata: { stage: "persistent-stale-overview" } });
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
