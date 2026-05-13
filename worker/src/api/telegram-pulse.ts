import { withErrorHandler, jsonResponse } from "../lib/api-utils";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { TelegramPulse, TelegramWatcherHistoryPoint } from "@shared/types/status";
import { getCache, setCache } from "../lib/db-cache";
import {
  computeTelegramCurrentLifecycleSnapshot,
  loadTelegramLifecycleHistory,
  loadTelegramTopFollowedCoins,
  refreshTelegramLifecycleSnapshotIfStale,
} from "../lib/telegram-usage-analytics";

const TELEGRAM_PULSE_CACHE_SECONDS = 300;
const TELEGRAM_PULSE_CACHE_KEY = "telegram:pulse:snapshot";

const ACTIVE_WATCHER_SQL_CONDITION = `s.global_alert_dews = 1
  OR s.global_alert_depeg = 1
  OR s.global_alert_safety = 1
  OR s.global_alert_launch = 1
  OR COALESCE(sub.active_sub_count, 0) > 0
  OR COALESCE(preset.active_preset_count, 0) > 0`;

const ACTIVE_SUBSCRIPTION_COUNTS_SQL = `SELECT chat_id,
        SUM(
          CASE
            WHEN alert_dews = 1
              OR alert_depeg = 1
              OR alert_safety = 1
              OR alert_launch = 1
            THEN 1 ELSE 0
          END
        ) AS active_sub_count
   FROM telegram_subscriptions
  GROUP BY chat_id`;

const ACTIVE_PRESET_COUNTS_SQL = `SELECT chat_id,
        SUM(
          CASE
            WHEN alert_dews = 1
              OR alert_depeg = 1
              OR alert_safety = 1
            THEN 1 ELSE 0
          END
        ) AS active_preset_count
   FROM telegram_preset_subscriptions
  GROUP BY chat_id`;

function coerceCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadFallbackWatcherHistory(db: D1Database): Promise<TelegramWatcherHistoryPoint[]> {
  const historyRows = await db
    .prepare(
      `SELECT
         date(s.created_at, 'unixepoch') AS day,
         strftime('%s', date(s.created_at, 'unixepoch')) AS day_ts,
         COUNT(*) AS new_watchers
       FROM telegram_subscribers s
       LEFT JOIN (
         ${ACTIVE_SUBSCRIPTION_COUNTS_SQL}
       ) sub ON sub.chat_id = s.chat_id
       LEFT JOIN (
         ${ACTIVE_PRESET_COUNTS_SQL}
       ) preset ON preset.chat_id = s.chat_id
       WHERE ${ACTIVE_WATCHER_SQL_CONDITION}
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all<{ day: string | null; day_ts: string | number | null; new_watchers: number | string | null }>();

  let cumulativeWatchers = 0;
  return (historyRows.results ?? [])
    .map((row) => {
      const newWatchers = Math.max(0, coerceCount(row.new_watchers));
      cumulativeWatchers += newWatchers;
      return {
        date: row.day ?? "",
        timestamp: Number(row.day_ts ?? 0) * 1000,
        newWatchers,
        activeWatchers: cumulativeWatchers,
      };
    })
    .filter((point) => point.date && Number.isFinite(point.timestamp) && point.timestamp > 0);
}

function parseCachedPulse(value: string): TelegramPulse | null {
  try {
    const parsed = JSON.parse(value) as Partial<TelegramPulse>;
    if (
      typeof parsed.activeWatchers !== "number" ||
      typeof parsed.coinSubscriptions !== "number" ||
      typeof parsed.updatedAt !== "number" ||
      !Array.isArray(parsed.watcherHistory)
    ) {
      return null;
    }
    return parsed as TelegramPulse;
  } catch {
    return null;
  }
}

async function loadFreshTelegramPulseSnapshot(
  db: D1Database,
  nowSec: number,
): Promise<TelegramPulse | null> {
  try {
    const cached = await getCache(db, TELEGRAM_PULSE_CACHE_KEY);
    if (!cached || nowSec - cached.updatedAt > TELEGRAM_PULSE_CACHE_SECONDS) return null;
    return parseCachedPulse(cached.value);
  } catch {
    return null;
  }
}

async function buildTelegramPulseSnapshot(
  db: D1Database,
  nowSec: number,
): Promise<TelegramPulse> {
  const currentSnapshot = await computeTelegramCurrentLifecycleSnapshot(db, nowSec);
  await refreshTelegramLifecycleSnapshotIfStale(db, nowSec, currentSnapshot);
  const [topRows, snapshotHistory] = await Promise.all([
    loadTelegramTopFollowedCoins(db, 5),
    loadTelegramLifecycleHistory(db),
  ]);
  const fallbackHistory =
    snapshotHistory.points.length > 0 ? [] : await loadFallbackWatcherHistory(db);
  const watcherHistory = snapshotHistory.points.length > 0
    ? snapshotHistory.points
    : fallbackHistory;
  const historySource = snapshotHistory.points.length > 0
    ? snapshotHistory.source
    : "live-fallback";

  return {
    activeWatchers: currentSnapshot.activeWatchers,
    coinSubscriptions: currentSnapshot.explicitCoinFollows + currentSnapshot.presetImpliedCoinFollows,
    explicitCoinSubscriptions: currentSnapshot.explicitCoinFollows,
    presetImpliedCoinSubscriptions: currentSnapshot.presetImpliedCoinFollows,
    activePresetFollowers: currentSnapshot.activePresetFollowers,
    newWatchersToday: currentSnapshot.newWatchers,
    churnedWatchersToday: currentSnapshot.churnedWatchers,
    reactivatedWatchersToday: currentSnapshot.reactivatedWatchers,
    historySource,
    topCoins: topRows.map(
      (row) => TRACKED_META_BY_ID.get(row.stablecoinId)?.symbol ?? row.stablecoinId,
    ),
    watcherHistory,
    alertTypeChats: currentSnapshot.alertTypeOptIns,
    quietHoursEnabledChats: currentSnapshot.quietHoursEnabledChats,
    pendingDeliveries: currentSnapshot.pendingDeliveries,
    updatedAt: nowSec,
    updatedEverySeconds: TELEGRAM_PULSE_CACHE_SECONDS,
  };
}

export async function publishTelegramPulseSnapshot(
  db: D1Database,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<TelegramPulse> {
  const pulse = await buildTelegramPulseSnapshot(db, nowSec);
  try {
    await setCache(db, TELEGRAM_PULSE_CACHE_KEY, JSON.stringify(pulse));
  } catch {
    // Snapshot cache writes must not block status/pulse responses or cron sidecars.
  }
  return pulse;
}

/**
 * Lightweight public endpoint returning vanity metrics for the PharosWatchBot landing page.
 * No admin auth required. Safe subset of the full TelegramBotStats.
 */
export const handleTelegramPulse = withErrorHandler(
  "telegram-pulse",
  async (db: D1Database): Promise<Response> => {
    const nowSec = Math.floor(Date.now() / 1000);
    const pulse = await loadFreshTelegramPulseSnapshot(db, nowSec)
      ?? await publishTelegramPulseSnapshot(db, nowSec);

    return jsonResponse(pulse, {
      "Cache-Control": `public, max-age=${TELEGRAM_PULSE_CACHE_SECONDS}, s-maxage=${TELEGRAM_PULSE_CACHE_SECONDS}`,
    });
  },
);
