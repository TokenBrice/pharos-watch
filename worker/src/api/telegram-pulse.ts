import { withErrorHandler, jsonResponse } from "../lib/api-response";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  TelegramPulseSchema,
  type TelegramPulse,
  type TelegramWatcherHistoryPoint,
} from "@shared/types/status";
import { getCache, setCache, setCacheIfNewer } from "../lib/db-cache";
import { throwIfAborted } from "../lib/abort";
import { toErrorMessage } from "@shared/lib/error-utils";
import { logWorkerEvent } from "../lib/structured-log";
import {
  computeTelegramCurrentLifecycleSnapshot,
  loadTelegramLifecycleHistory,
  loadTelegramTopFollowedCoins,
  refreshTelegramLifecycleSnapshotIfStale,
} from "../lib/telegram/usage-analytics";
import {
  loadTelegramMiniAppDailyAggregate,
  utcDayFromUnixSeconds,
} from "../lib/status/telegram-bot-stats";
import {
  loadTelegramFirstMutationP50,
  refreshTelegramAdoptionRetention,
} from "../lib/telegram/adoption-analytics";

const TELEGRAM_PULSE_CACHE_SECONDS = 300;
const TELEGRAM_LIFECYCLE_HISTORY_SECONDS = 900;
const TELEGRAM_PULSE_HEAVY_SECTION_SECONDS = TELEGRAM_LIFECYCLE_HISTORY_SECONDS;
const TELEGRAM_PULSE_CACHE_KEY = "telegram:pulse:snapshot";
const TELEGRAM_PULSE_HEAVY_SECTION_CACHE_KEY = "telegram:pulse:heavy-sections-updated-at";
const PUBLIC_LOW_CARDINALITY_THRESHOLD = 5;

interface TelegramPulseSnapshotOptions {
  pendingCapacitySnapshot?: { active: number } | null;
  signal?: AbortSignal;
}

interface BuiltTelegramPulseSnapshot {
  pulse: TelegramPulse;
  heavySectionsRecomputed: boolean;
}

export interface TelegramPulsePublicationOutcome {
  pulse: TelegramPulse;
  status: "ok" | "degraded" | "error";
  snapshotPublished: boolean;
  heavySectionsRecomputed: boolean;
  heavyMarkerAdvanced: boolean;
  error: string | null;
  staleWriteSkipped: boolean;
}

interface CachedTelegramPulse {
  pulse: TelegramPulse;
  updatedAt: number;
}


function shouldSuppressLowCardinality(value: number): boolean {
  return value > 0 && value < PUBLIC_LOW_CARDINALITY_THRESHOLD;
}

function publicRequiredCount(
  value: number,
  field: string,
  suppressedFields: Set<string>,
): number | null {
  if (shouldSuppressLowCardinality(value)) {
    suppressedFields.add(field);
    return null;
  }
  return value;
}

function publicOptionalCount(
  value: number,
  field: string,
  suppressedFields: Set<string>,
): number | null | undefined {
  if (shouldSuppressLowCardinality(value)) {
    suppressedFields.add(field);
    return null;
  }
  return value;
}

function sanitizeWatcherHistory(
  points: TelegramWatcherHistoryPoint[],
  suppressedFields: Set<string>,
): TelegramWatcherHistoryPoint[] {
  return points.map((point) => ({
    ...point,
    newWatchers: point.newWatchers == null
      ? point.newWatchers
      : publicOptionalCount(point.newWatchers, "watcherHistory.newWatchers", suppressedFields),
    churnedWatchers: point.churnedWatchers == null
      ? point.churnedWatchers
      : publicOptionalCount(point.churnedWatchers, "watcherHistory.churnedWatchers", suppressedFields),
    reactivatedWatchers: point.reactivatedWatchers == null
      ? point.reactivatedWatchers
      : publicOptionalCount(point.reactivatedWatchers, "watcherHistory.reactivatedWatchers", suppressedFields),
  }));
}

function latestLifecycleHistoryUpdatedAt(points: TelegramWatcherHistoryPoint[]): number | null {
  const latest = points.reduce<number | null>((max, point) => {
    if (point.snapshotAt == null) return max;
    return max == null ? point.snapshotAt : Math.max(max, point.snapshotAt);
  }, null);
  return latest;
}


function sanitizePublicPulse(pulse: TelegramPulse): TelegramPulse {
  const suppressedFields = new Set(pulse.privacy.suppressedFields);

  return {
    ...pulse,
    newWatchersToday: pulse.newWatchersToday == null
      ? pulse.newWatchersToday
      : publicOptionalCount(pulse.newWatchersToday, "newWatchersToday", suppressedFields),
    churnedWatchersToday: pulse.churnedWatchersToday == null
      ? pulse.churnedWatchersToday
      : publicOptionalCount(pulse.churnedWatchersToday, "churnedWatchersToday", suppressedFields),
    reactivatedWatchersToday: pulse.reactivatedWatchersToday == null
      ? pulse.reactivatedWatchersToday
      : publicOptionalCount(pulse.reactivatedWatchersToday, "reactivatedWatchersToday", suppressedFields),
    watcherHistory: sanitizeWatcherHistory(pulse.watcherHistory, suppressedFields),
    pendingDeliveries: pulse.pendingDeliveries == null
      ? pulse.pendingDeliveries
      : publicRequiredCount(pulse.pendingDeliveries, "pendingDeliveries", suppressedFields),
    miniAppSessionsToday: pulse.miniAppSessionsToday == null
      ? pulse.miniAppSessionsToday
      : publicOptionalCount(pulse.miniAppSessionsToday, "miniAppSessionsToday", suppressedFields),
    miniAppMutationsToday: pulse.miniAppMutationsToday == null
      ? pulse.miniAppMutationsToday
      : publicOptionalCount(pulse.miniAppMutationsToday, "miniAppMutationsToday", suppressedFields),
    privacy: {
      ...pulse.privacy,
      lowCardinalityThreshold: PUBLIC_LOW_CARDINALITY_THRESHOLD,
      suppressedFields: [...suppressedFields].sort(),
    },
  };
}

function parseCachedPulse(value: string): TelegramPulse | null {
  try {
    const result = TelegramPulseSchema.safeParse(JSON.parse(value));
    return result.success ? sanitizePublicPulse(result.data) : null;
  } catch {
    return null;
  }
}

function needsBootstrapHistoryRebuild(pulse: TelegramPulse): boolean {
  return pulse.historySource === "snapshot" && pulse.watcherHistory.length < 2;
}

async function loadCachedTelegramPulseSnapshot(db: D1Database): Promise<CachedTelegramPulse | null> {
  try {
    const cached = await getCache(db, TELEGRAM_PULSE_CACHE_KEY);
    if (!cached) return null;
    const pulse = parseCachedPulse(cached.value);
    return pulse ? { pulse, updatedAt: cached.updatedAt } : null;
  } catch {
    return null;
  }
}

async function loadPulseHeavySectionsUpdatedAt(
  db: D1Database,
  cachedPulse: CachedTelegramPulse | null,
): Promise<number | null> {
  try {
    const cached = await getCache(db, TELEGRAM_PULSE_HEAVY_SECTION_CACHE_KEY);
    const parsed = Number(cached?.value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  } catch {
    // Fall back to the pulse cache timestamp below.
  }
  return cachedPulse?.updatedAt ?? null;
}

async function recordPulseHeavySectionsUpdatedAt(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  await setCache(db, TELEGRAM_PULSE_HEAVY_SECTION_CACHE_KEY, String(nowSec), signal);
}

async function loadFreshTelegramPulseSnapshot(
  db: D1Database,
  nowSec: number,
): Promise<TelegramPulse | null> {
  const cached = await loadCachedTelegramPulseSnapshot(db);
  if (!cached || nowSec - cached.updatedAt > TELEGRAM_PULSE_CACHE_SECONDS) return null;
  return cached.pulse;
}

async function buildTelegramPulseSnapshot(
  db: D1Database,
  nowSec: number,
  options: TelegramPulseSnapshotOptions = {},
): Promise<BuiltTelegramPulseSnapshot> {
  throwIfAborted(options.signal);
  const cachedPulse = await loadCachedTelegramPulseSnapshot(db);
  const heavySectionsUpdatedAt = await loadPulseHeavySectionsUpdatedAt(db, cachedPulse);
  const reusablePulse =
    cachedPulse &&
    heavySectionsUpdatedAt != null &&
    nowSec - heavySectionsUpdatedAt < TELEGRAM_PULSE_HEAVY_SECTION_SECONDS &&
    utcDayFromUnixSeconds(heavySectionsUpdatedAt) === utcDayFromUnixSeconds(nowSec) &&
    !needsBootstrapHistoryRebuild(cachedPulse.pulse)
      ? cachedPulse.pulse
      : null;
  const currentSnapshot = await computeTelegramCurrentLifecycleSnapshot(db, nowSec, {
    pendingDeliveryCount: options.pendingCapacitySnapshot?.active,
  });
  await refreshTelegramLifecycleSnapshotIfStale(db, nowSec, currentSnapshot);
  const unavailableFields = new Set(currentSnapshot.unavailableFields ?? []);
  const suppressedFields = new Set<string>(
    reusablePulse?.privacy.suppressedFields.filter((field) => field !== "pendingDeliveries") ?? [],
  );
  const heavySections = reusablePulse
    ? {
        topCoins: reusablePulse.topCoins,
        historySource: "snapshot" as const,
        watcherHistory: reusablePulse.watcherHistory.filter(
          (point) => point.date < utcDayFromUnixSeconds(nowSec),
        ),
        lifecycleHistoryUpdatedAt: reusablePulse.lifecycleHistoryUpdatedAt,
        miniAppSessionsToday: reusablePulse.miniAppSessionsToday,
        miniAppMutationsToday: reusablePulse.miniAppMutationsToday,
        miniAppDeniedToday: reusablePulse.miniAppDeniedToday,
        miniAppReplayClaimsToday: reusablePulse.miniAppReplayClaimsToday,
        miniAppOpenToFirstMutationP50Sec: reusablePulse.miniAppOpenToFirstMutationP50Sec,
      }
    : await (async () => {
        const [topRows, snapshotHistory, miniAppDailyAggregate, miniAppFirstMutation] = await Promise.all([
          loadTelegramTopFollowedCoins(db, 5).catch((error) => {
            logWorkerEvent({ scope: "api", level: "warn", message: "Telegram pulse top followed coin telemetry unavailable", error });
            unavailableFields.add("topCoins");
            return [];
          }),
          loadTelegramLifecycleHistory(db, nowSec).catch((error) => {
            logWorkerEvent({ scope: "api", level: "warn", message: "Telegram pulse lifecycle history unavailable", error });
            unavailableFields.add("watcherHistory");
            return { source: "snapshot" as const, points: [] };
          }),
          loadTelegramMiniAppDailyAggregate(db, utcDayFromUnixSeconds(nowSec)).catch((error) => {
            logWorkerEvent({ scope: "api", level: "warn", message: "Telegram pulse mini-app daily aggregate unavailable", error });
            unavailableFields.add("miniAppDailyAggregate");
            return null;
          }),
          loadTelegramFirstMutationP50(db, utcDayFromUnixSeconds(nowSec)).catch((error) => {
            logWorkerEvent({ scope: "api", level: "warn", message: "Telegram pulse mini-app first-mutation latency unavailable", error });
            unavailableFields.add("miniAppOpenToFirstMutationP50Sec");
            return null;
          }),
        ]);
        const lifecycleHistory = snapshotHistory;
        if (miniAppFirstMutation && shouldSuppressLowCardinality(miniAppFirstMutation.sampleCount)) {
          suppressedFields.add("miniAppOpenToFirstMutationP50Sec");
        }
        return {
          topCoins: topRows.map(
            (row) => WORKER_TRACKED_META_BY_ID.get(row.stablecoinId)?.symbol ?? row.stablecoinId,
          ),
          historySource: lifecycleHistory.source,
          watcherHistory: sanitizeWatcherHistory(lifecycleHistory.points, suppressedFields),
          lifecycleHistoryUpdatedAt: latestLifecycleHistoryUpdatedAt(snapshotHistory.points),
          miniAppSessionsToday: miniAppDailyAggregate
            ? publicOptionalCount(miniAppDailyAggregate.sessions, "miniAppSessionsToday", suppressedFields)
            : null,
          miniAppMutationsToday: miniAppDailyAggregate
            ? publicOptionalCount(miniAppDailyAggregate.mutations, "miniAppMutationsToday", suppressedFields)
            : null,
          // Denied/replay counts are abuse-health counters, not adoption counters.
          miniAppDeniedToday: miniAppDailyAggregate
            ? miniAppDailyAggregate.denied
            : null,
          miniAppReplayClaimsToday: miniAppDailyAggregate
            ? miniAppDailyAggregate.replayClaimed
            : null,
          miniAppOpenToFirstMutationP50Sec: miniAppFirstMutation == null
            || shouldSuppressLowCardinality(miniAppFirstMutation.sampleCount)
            ? null
            : miniAppFirstMutation.p50Sec,
        };
      })();
  if (reusablePulse) {
    for (const field of reusablePulse.quality.unavailableFields) {
      if (field !== "pendingDeliveries") unavailableFields.add(field);
    }
  }
  const qualityUnavailableFields = [...unavailableFields].sort();

  const pulse: TelegramPulse = {
    activeWatchers: currentSnapshot.activeWatchers,
    coinSubscriptions: currentSnapshot.presetImpliedCoinFollows == null
      ? null
      : currentSnapshot.explicitCoinFollows + currentSnapshot.presetImpliedCoinFollows,
    explicitCoinSubscriptions: currentSnapshot.explicitCoinFollows,
    presetImpliedCoinSubscriptions: currentSnapshot.presetImpliedCoinFollows,
    activePresetFollowers: currentSnapshot.activePresetFollowers,
    newWatchersToday: currentSnapshot.newWatchers == null
      ? null
      : publicOptionalCount(currentSnapshot.newWatchers, "newWatchersToday", suppressedFields),
    churnedWatchersToday: currentSnapshot.churnedWatchers == null
      ? null
      : publicOptionalCount(currentSnapshot.churnedWatchers, "churnedWatchersToday", suppressedFields),
    reactivatedWatchersToday: currentSnapshot.reactivatedWatchers == null
      ? null
      : publicOptionalCount(
          currentSnapshot.reactivatedWatchers,
          "reactivatedWatchersToday",
          suppressedFields,
        ),
    historySource: heavySections.historySource,
    topCoins: heavySections.topCoins,
    watcherHistory: heavySections.watcherHistory,
    pendingDeliveries: unavailableFields.has("pendingDeliveries")
      ? null
      : publicRequiredCount(currentSnapshot.pendingDeliveries, "pendingDeliveries", suppressedFields),
    miniAppSessionsToday: heavySections.miniAppSessionsToday,
    miniAppMutationsToday: heavySections.miniAppMutationsToday,
    miniAppDeniedToday: heavySections.miniAppDeniedToday,
    miniAppReplayClaimsToday: heavySections.miniAppReplayClaimsToday,
    miniAppOpenToFirstMutationP50Sec: heavySections.miniAppOpenToFirstMutationP50Sec,
    currentSnapshotAt: currentSnapshot.snapshotAt,
    lifecycleHistoryUpdatedAt: heavySections.lifecycleHistoryUpdatedAt,
    lifecycleHistoryEverySeconds: TELEGRAM_LIFECYCLE_HISTORY_SECONDS,
    quality: {
      status: qualityUnavailableFields.length > 0 ? "partial" : "complete",
      unavailableFields: qualityUnavailableFields,
    },
    privacy: {
      exactActiveWatchers: true,
      lowCardinalityThreshold: PUBLIC_LOW_CARDINALITY_THRESHOLD,
      suppressedFields: [...suppressedFields].sort(),
    },
    updatedAt: nowSec,
    updatedEverySeconds: TELEGRAM_PULSE_CACHE_SECONDS,
  };
  return { pulse, heavySectionsRecomputed: !reusablePulse };
}

export async function publishTelegramPulseSnapshotWithOutcome(
  db: D1Database,
  nowSec = Math.floor(Date.now() / 1000),
  options: TelegramPulseSnapshotOptions = {},
): Promise<TelegramPulsePublicationOutcome> {
  const built = await buildTelegramPulseSnapshot(db, nowSec, options);
  throwIfAborted(options.signal);
  try {
    const write = await setCacheIfNewer(
      db,
      TELEGRAM_PULSE_CACHE_KEY,
      JSON.stringify(built.pulse),
      built.pulse.updatedAt,
      options.signal,
    );
    if (!write.written) {
      const published = await loadCachedTelegramPulseSnapshot(db);
      return {
        pulse: published?.pulse ?? built.pulse,
        status: published?.pulse.quality.status === "partial" ? "degraded" : "ok",
        snapshotPublished: false,
        heavySectionsRecomputed: built.heavySectionsRecomputed,
        heavyMarkerAdvanced: false,
        staleWriteSkipped: true,
        error: null,
      };
    }
  } catch (error) {
    throwIfAborted(options.signal);
    return {
      pulse: built.pulse,
      status: "error",
      snapshotPublished: false,
      heavySectionsRecomputed: built.heavySectionsRecomputed,
      heavyMarkerAdvanced: false,
      staleWriteSkipped: false,
      error: toErrorMessage(error),
    };
  }

  let heavyMarkerAdvanced = !built.heavySectionsRecomputed;
  let markerError: string | null = null;
  if (built.heavySectionsRecomputed) {
    try {
      await recordPulseHeavySectionsUpdatedAt(db, nowSec, options.signal);
      heavyMarkerAdvanced = true;
    } catch (error) {
      throwIfAborted(options.signal);
      markerError = toErrorMessage(error);
    }
    try {
      throwIfAborted(options.signal);
      await refreshTelegramAdoptionRetention(db, nowSec);
    } catch (error) {
      throwIfAborted(options.signal);
      logWorkerEvent({
        scope: "api",
        level: "warn",
        message: "Telegram adoption retention refresh failed",
        error,
      });
    }
  }

  return {
    pulse: built.pulse,
    status: markerError || built.pulse.quality.status !== "complete" ? "degraded" : "ok",
    snapshotPublished: true,
    heavySectionsRecomputed: built.heavySectionsRecomputed,
    heavyMarkerAdvanced,
    staleWriteSkipped: false,
    error: markerError,
  };
}

export async function publishTelegramPulseSnapshot(
  db: D1Database,
  nowSec = Math.floor(Date.now() / 1000),
  options: TelegramPulseSnapshotOptions = {},
): Promise<TelegramPulse> {
  return (await publishTelegramPulseSnapshotWithOutcome(db, nowSec, options)).pulse;
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
      headers: {
        "Cache-Control": `public, max-age=${TELEGRAM_PULSE_CACHE_SECONDS}, s-maxage=${TELEGRAM_PULSE_CACHE_SECONDS}`,
      },
    });
  },
);
