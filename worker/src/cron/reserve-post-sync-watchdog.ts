import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { buildAlertReserveSourceEnvelope } from "../lib/alert-reserve-source-cache";
import { rethrowIfAborted, throwIfAborted } from "../lib/abort";
import { checkCollateralDrift } from "../lib/collateral-drift";
import type { CronResult } from "../lib/cron-logger";
import { recordCronFailure } from "../lib/cron-logger";
import { getCache, setCache } from "../lib/db-cache";
import { computeReserveCompositionOverview, getMaxSyncAge, loadReserveSyncStateMap } from "../lib/live-reserves/store";
import { logWorkerEventArgs } from "../lib/structured-log";
import type { TelegramCreds } from "../telegram/delivery/telegram";
import {
  alertOnReserveTransitions,
  buildReserveSyncConditions,
  type ReserveAlertCondition,
  type ReserveAlertSection,
  type ReserveAlertTransitions,
} from "./reserve-sync-operator-alert";
import { SYNC_ORDERED_CONFIGURED_COINS } from "./sync-live-reserves-shared";
import { SNAPSHOT_KEYS } from "./telegram/sources/telegram-alert-snapshots";
import { resolveScheduledSlotPolicy } from "../lib/scheduled-slot-policy";

const PERSISTENTLY_STALE_WARNING_COUNT_THRESHOLD = 3;
const PERSISTENTLY_STALE_WARNING_MAX_AGE_SEC = 21 * DAY_SECONDS;
const CURATED_FALLBACK_WARNING_COUNT_THRESHOLD = 5;

export interface ReservePostSyncWatchdogOptions {
  /** Private operator chat; null suppresses delivery and leaves transitions pending. */
  operatorTelegramCreds?: TelegramCreds | null;
}

export async function runReservePostSyncWatchdog(
  db: D1Database,
  signal?: AbortSignal,
  options: ReservePostSyncWatchdogOptions = {},
): Promise<CronResult> {
  const degradedReasons: string[] = [];
  const firedRuleIds: string[] = [];
  const alertConditions: ReserveAlertCondition[] = [];
  const unknownSections: ReserveAlertSection[] = [];
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
      firedRuleIds.push("reserve-collateral-drift");
      alertConditions.push(...drift.driftCoins.map((entry): ReserveAlertCondition => ({
        section: "drift",
        id: entry.id,
        signature: "active",
        line: `${entry.id}: live=${entry.liveScore}, curated=${entry.curatedScore} (Δ${entry.delta})`,
      })));
    }
    if (drift.fallbackCoins.length > CURATED_FALLBACK_WARNING_COUNT_THRESHOLD) {
      logWorkerEventArgs("handler", "warn", `[live-reserves] ${drift.fallbackCoins.length} live-enabled coins using curated fallback`);
      firedRuleIds.push("reserve-curated-fallback");
      alertConditions.push({
        section: "rule",
        id: "reserve-curated-fallback",
        signature: "active",
        line: `${drift.fallbackCoins.length} live-enabled coins on curated fallback`,
      });
    }

    const reservePublishedAt = Math.floor(Date.now() / 1000);
    const previousReserveSource = await getCache(db, SNAPSHOT_KEYS.reserve);
    const reserveSourceEnvelope = buildAlertReserveSourceEnvelope(
      drift.driftCoins.map((entry) => entry.id),
      previousReserveSource,
      {
        nowSec: reservePublishedAt,
        producerIntervalSec: CRON_INTERVALS["sync-live-reserves"],
        observedIds: drift.observedIds,
        unavailableIds: drift.fallbackCoins,
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
    unknownSections.push("drift");
    recordCronFailure("reserve-post-sync-watchdog", error, { metadata: { stage: "drift-cache-age" } });
  }

  try {
    throwIfAborted(signal);
    const overview = await computeReserveCompositionOverview(db, Math.floor(Date.now() / 1000), resolveScheduledSlotPolicy("fourHourlyReserveSync"));
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
      firedRuleIds.push("reserve-persistent-stale-warning");
      alertConditions.push({
        section: "rule",
        id: "reserve-persistent-stale-warning",
        signature: "active",
        line: `${persistentlyStale.length} persistently stale independent sources (oldest ${Math.round(maxPersistentlyStaleAgeSec / DAY_SECONDS)}d): ${persistentlyStale.map((entry) => entry.stablecoinId).join(", ")}`,
      });
    }
  } catch (error) {
    rethrowIfAborted(error, signal);
    degradedReasons.push("persistent-stale-overview-failed");
    recordCronFailure("reserve-post-sync-watchdog", error, { metadata: { stage: "persistent-stale-overview" } });
  }

  // Both rule-section inputs must be read before a missing rule counts as cleared.
  if (degradedReasons.length > 0) unknownSections.push("rule");

  let syncDegradedCoinCount = 0;
  try {
    throwIfAborted(signal);
    const configuredIds = SYNC_ORDERED_CONFIGURED_COINS.map((coin) => coin.id);
    const coinConditions = buildReserveSyncConditions(await loadReserveSyncStateMap(db, configuredIds), configuredIds);
    throwIfAborted(signal);
    syncDegradedCoinCount = coinConditions.length;
    if (coinConditions.length > 0) firedRuleIds.push("reserve-sync-degraded");
    alertConditions.push(...coinConditions);
  } catch (error) {
    rethrowIfAborted(error, signal);
    degradedReasons.push("reserve-sync-state-read-failed");
    unknownSections.push("coin");
    recordCronFailure("reserve-post-sync-watchdog", error, { metadata: { stage: "reserve-sync-state" } });
  }

  let alertTransitions: ReserveAlertTransitions | null = null;
  try {
    alertTransitions = await alertOnReserveTransitions({
      db,
      conditions: alertConditions,
      unknownSections,
      nowSec: Math.floor(Date.now() / 1000),
      operatorTelegramCreds: options.operatorTelegramCreds ?? null,
      signal,
    });
    if (alertTransitions.deliveryFailed) degradedReasons.push("operator-alert-delivery-failed");
  } catch (error) {
    rethrowIfAborted(error, signal);
    degradedReasons.push("operator-alert-failed");
    recordCronFailure("reserve-post-sync-watchdog", error, { metadata: { stage: "operator-alert" } });
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
      syncDegradedCoinCount,
      firedRuleIds,
      alertTransitions,
    }),
  };
}
