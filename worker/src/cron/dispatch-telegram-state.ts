import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  ALERT_SAFETY_SOURCE_CACHE_KEY,
  alertSafetyIdentitiesAreComparable,
  assessAlertSafetySourceCache,
  buildAlertSafetySnapshotEnvelope,
  getAlertSafetySourceGeneration,
  parseAlertSafetySnapshotEnvelope,
  type AlertSafetySnapshotEnvelope,
  type AlertSafetySourceAssessment,
  type AlertSafetySourceSnapshot,
} from "../lib/alert-safety-source-cache";
import { getCache, setCache } from "../lib/db-cache";
import { logTelegramEvent } from "../lib/telegram-log";
import { loadTelegramDewsCurrentRows } from "../lib/stress-signals-current-rows";
import type { PendingCapacitySnapshot } from "./telegram-pending";
import {
  ALERT_RESERVE_SOURCE_GENERATION,
  assessAlertReserveSourceCache,
  type AlertReserveSourceAssessment,
} from "../lib/alert-reserve-source-cache";
import {
  SNAPSHOT_KEYS,
  buildDepegSnapshot,
  buildDewsAlertableSnapshot,
  buildDewsSnapshot,
  buildSafetySnapshot,
  filterAlertableBands,
  isSnapshotMissingOrStale,
  parseSnapshotMap,
  type ActiveDepegRow,
  type DepegSnapshot,
  type DewsRow,
  type DewsSnapshot,
  type SafetyRow,
  type SafetySnapshot,
} from "./telegram-alert-snapshots";

type CachedValue = { value: string; updatedAt: number } | null;

const TELEGRAM_DEWS_LATEST_FALLBACK_AGE_SEC = 2 * 3600;
const PRESET_QUERY_FAILURE_CACHE_KEY = "telegram:preset-query-failure-count";

export interface TelegramDispatchSharedState {
  pendingCapacitySnapshot?: PendingCapacitySnapshot;
  safetySourceAssessment?: AlertSafetySourceAssessment;
  dispatchStartedAtMs?: number;
  dispatchCompleted?: boolean;
  dispatchFailed?: boolean;
  dispatchDurationMs?: number;
}

export function assignSharedDispatchState(
  sharedState: TelegramDispatchSharedState | undefined,
  updates: Partial<TelegramDispatchSharedState>,
): void {
  if (!sharedState) return;
  Object.assign(sharedState, updates);
}

export async function readPresetFailureCount(db: D1Database): Promise<number> {
  try {
    const cached = await getCache(db, PRESET_QUERY_FAILURE_CACHE_KEY);
    if (!cached) return 0;
    const parsed = Number(cached.value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  } catch {
    return 0;
  }
}

export async function writePresetFailureCount(db: D1Database, value: number): Promise<void> {
  try {
    await setCache(db, PRESET_QUERY_FAILURE_CACHE_KEY, String(Math.max(0, Math.floor(value))));
  } catch {
    logTelegramEvent({
      level: "warn",
      message: "failed to persist preset failure count",
      action: "write-preset-failure-count",
      module: "dispatch-telegram-alerts",
    });
  }
}

export async function loadDewsRows(db: D1Database, nowSec: number): Promise<DewsRow[]> {
  return loadTelegramDewsCurrentRows(db, nowSec, {
    staleAfterSec: TELEGRAM_DEWS_LATEST_FALLBACK_AGE_SEC,
  });
}

function parseLaunchSnapshotIds(cached: CachedValue): string[] | null {
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached.value);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    /* expected: corrupted launch snapshot json */
    return null;
  }
}

export interface ActiveDepegRowWithEventId extends ActiveDepegRow {
  event_id: number;
}

export interface DispatchSourceData {
  chatsWithActiveSnooze: number;
  dewsRows: DewsRow[];
  activeDepegRows: ActiveDepegRowWithEventId[];
  safetyRows: SafetyRow[];
  dewsCache: CachedValue;
  dewsAlertableCache: CachedValue;
  depegCache: CachedValue;
  safetyCache: CachedValue;
  safetySourceCache: CachedValue;
  launchCache: CachedValue;
  /** Producer-written current drift id-set (four-hourly reserve slot). */
  reserveCache: CachedValue;
  /** Dispatch-owned baseline: the drift id-set the dispatcher last acted on. */
  reserveDispatchedCache: CachedValue;
}

export interface DispatchSnapshotState {
  nowSec: number;
  previousDewsSnapshot: DewsSnapshot | null;
  previousDewsAlertableSnapshot: DewsSnapshot;
  previousDepegSnapshot: DepegSnapshot | null;
  previousSafetySnapshot: SafetySnapshot | null;
  safetySourceAssessment: AlertSafetySourceAssessment;
  reserveSourceAssessment: AlertReserveSourceAssessment;
  currentSafetySnapshot: AlertSafetySourceSnapshot | null;
  safetySnapshotNeedsSeed: boolean;
  currentSnapshots: {
    dews: DewsSnapshot;
    dewsAlertable: DewsSnapshot;
    depeg: DepegSnapshot;
    safety: AlertSafetySnapshotEnvelope | null;
    launch: string[];
    /**
     * Dispatch baseline written back: the producer's current drift id-set.
     * `null` means the producer snapshot was unavailable and there was no
     * prior baseline to preserve.
     */
    reserveDispatched: string[] | null;
  };
  /** Drift id-set the dispatcher last acted on (prior baseline). */
  previousReserveDriftIds: string[];
  /** Producer's current drift id-set (read-only in dispatch). */
  currentReserveDriftIds: string[];
  reserveSourceUnavailable: boolean;
  mustSeedSnapshots: boolean;
  safeDewsSnapshot: DewsSnapshot;
  safeDewsAlertable: DewsSnapshot;
  safeDepegSnapshot: DepegSnapshot;
  safeSafetySnapshot: SafetySnapshot;
}

export async function loadDispatchSourceData(db: D1Database): Promise<DispatchSourceData> {
  const snoozeNowSec = Math.floor(Date.now() / 1000);
  const snoozedRows = await db
    .prepare(
      `SELECT /* pharos:telegram-dispatch:active-snoozes */
         chat_id
       FROM telegram_subscribers
       WHERE alert_snooze_until_ts IS NOT NULL AND alert_snooze_until_ts > ?`,
    )
    .bind(snoozeNowSec)
    .all<{ chat_id: string }>();

  const [
    dewsRows,
    activeDepegRows,
    safetyRows,
    dewsCache,
    dewsAlertableCache,
    depegCache,
    safetyCache,
    safetySourceCache,
    launchCache,
    reserveCache,
    reserveDispatchedCache,
  ] = await Promise.all([
    loadDewsRows(db, snoozeNowSec),
    db
      .prepare(
        `SELECT /* pharos:telegram-dispatch:active-depegs */
           id AS event_id, stablecoin_id, symbol, direction, peak_deviation_bps, start_price, peg_reference
         FROM depeg_events WHERE ended_at IS NULL`,
      )
      .all<ActiveDepegRowWithEventId>()
      .then((result) => result.results ?? []),
    db
      .prepare(
        `SELECT /* pharos:telegram-dispatch:safety-latest */
                h.stablecoin_id,
                h.grade,
                h.score,
                h.prev_grade,
                h.prev_score,
                h.recorded_at,
                h.methodology_version
           FROM safety_grade_history h
           INNER JOIN (
             SELECT stablecoin_id, MAX(recorded_at) AS max_recorded_at
               FROM safety_grade_history
              GROUP BY stablecoin_id
           ) latest
             ON latest.stablecoin_id = h.stablecoin_id
            AND latest.max_recorded_at = h.recorded_at`,
      )
      .all<SafetyRow>()
      .then((result) => result.results ?? []),
    getCache(db, SNAPSHOT_KEYS.dews),
    getCache(db, SNAPSHOT_KEYS.dewsAlertable),
    getCache(db, SNAPSHOT_KEYS.depeg),
    getCache(db, SNAPSHOT_KEYS.safety),
    getCache(db, ALERT_SAFETY_SOURCE_CACHE_KEY),
    getCache(db, SNAPSHOT_KEYS.launch),
    getCache(db, SNAPSHOT_KEYS.reserve),
    getCache(db, SNAPSHOT_KEYS.reserveDispatched),
  ]);

  return {
    chatsWithActiveSnooze: (snoozedRows.results ?? []).length,
    dewsRows,
    activeDepegRows,
    safetyRows,
    dewsCache,
    dewsAlertableCache,
    depegCache,
    safetyCache,
    safetySourceCache,
    launchCache,
    reserveCache,
    reserveDispatchedCache,
  };
}

export function buildDispatchSnapshotState(sourceData: DispatchSourceData, nowSec: number): DispatchSnapshotState {
  const previousDewsSnapshot = parseSnapshotMap<DewsSnapshot>(sourceData.dewsCache);
  const previousDewsAlertableSnapshot =
    parseSnapshotMap<DewsSnapshot>(sourceData.dewsAlertableCache) ?? filterAlertableBands(previousDewsSnapshot);
  const previousDepegSnapshot = parseSnapshotMap<DepegSnapshot>(sourceData.depegCache);
  const safetySourceAssessment = assessAlertSafetySourceCache(sourceData.safetySourceCache, {
    expectedGeneration: getAlertSafetySourceGeneration(),
    nowSec,
    producerIntervalSec: CRON_INTERVALS["publish-report-card-cache"],
  });
  const currentSafetySnapshot =
    safetySourceAssessment.state === "ok"
      ? (safetySourceAssessment.envelope?.snapshot ?? buildSafetySnapshot(sourceData.safetyRows))
      : null;
  const previousSafetyEnvelope = parseAlertSafetySnapshotEnvelope(sourceData.safetyCache);
  const previousSafetySnapshot = previousSafetyEnvelope?.snapshot ?? null;
  const safetySnapshotNeedsSeed =
    currentSafetySnapshot != null &&
    (previousSafetyEnvelope == null ||
      isSnapshotMissingOrStale(sourceData.safetyCache, nowSec) ||
      previousSafetyEnvelope.generation !== (safetySourceAssessment.generation ?? "") ||
      !previousSafetyEnvelope.safetyScoreIdentity ||
      !safetySourceAssessment.envelope?.safetyScoreIdentity ||
      !alertSafetyIdentitiesAreComparable(
        previousSafetyEnvelope.safetyScoreIdentity,
        safetySourceAssessment.envelope.safetyScoreIdentity,
      ));

  // Augment the current depeg snapshot with the active event id per coin so the
  // close-then-reopen-within-one-window diff in dispatch-telegram-events can tell
  // event #1 (now ended) and event #2 (now active) apart. Legacy snapshots
  // without `eventId` still diff on stablecoin_id alone (backward compatible).
  const currentDepegSnapshot = buildDepegSnapshot(sourceData.activeDepegRows);
  for (const row of sourceData.activeDepegRows) {
    const entry = currentDepegSnapshot[row.stablecoin_id];
    if (entry) {
      (entry as DepegSnapshot[string] & { eventId?: number }).eventId = row.event_id;
    }
  }

  // P1.7: when dews/depeg snapshots are stale we enter the seed branch and skip
  // fan-out. If we ALSO overwrite the launch snapshot here, any pre-launch coin
  // that flipped to active between the prior healthy run and this seed is
  // silently absorbed. Preserve the prior launch snapshot so the next healthy
  // run can detect the transition. When there is no parseable prior snapshot
  // we still seed with the current pre-launch set (no transition to lose).
  const previousLaunchIds = parseLaunchSnapshotIds(sourceData.launchCache);

  // Reserve-drift (C123): the four-hourly producer owns a versioned source
  // envelope. A missing, corrupt, stale, or wrong-generation source is never
  // alertable. The first fresh publish after a gap is marked `recovering`; it
  // cold-seeds the dispatch baseline so changes accumulated during the blind
  // interval cannot be misreported as fresh transitions.
  const reserveSourceAssessment = assessAlertReserveSourceCache(sourceData.reserveCache, {
    expectedGeneration: ALERT_RESERVE_SOURCE_GENERATION,
    nowSec,
    producerIntervalSec: CRON_INTERVALS["sync-live-reserves"],
  });
  const reserveSourceUnavailable = reserveSourceAssessment.state !== "ok";
  const parsedCurrentReserveDriftIds =
    reserveSourceAssessment.state === "ok" || reserveSourceAssessment.state === "recovering"
      ? (reserveSourceAssessment.envelope?.driftIds ?? null)
      : null;
  const previousReserveDispatchedIds = parseLaunchSnapshotIds(sourceData.reserveDispatchedCache);

  const mustSeedSnapshots =
    isSnapshotMissingOrStale(sourceData.dewsCache, nowSec) ||
    (sourceData.dewsAlertableCache != null && isSnapshotMissingOrStale(sourceData.dewsAlertableCache, nowSec)) ||
    isSnapshotMissingOrStale(sourceData.depegCache, nowSec) ||
    previousDewsSnapshot == null ||
    previousDepegSnapshot == null;
  const reserveNeedsColdSeed = reserveSourceAssessment.state === "recovering" && parsedCurrentReserveDriftIds != null;
  const reserveDispatched = reserveNeedsColdSeed
    ? parsedCurrentReserveDriftIds
    : parsedCurrentReserveDriftIds == null
      ? (previousReserveDispatchedIds ?? null)
      : mustSeedSnapshots && previousReserveDispatchedIds != null
        ? previousReserveDispatchedIds
        : parsedCurrentReserveDriftIds;

  const currentSnapshots = {
    dews: buildDewsSnapshot(sourceData.dewsRows),
    dewsAlertable: buildDewsAlertableSnapshot(sourceData.dewsRows, previousDewsAlertableSnapshot),
    depeg: currentDepegSnapshot,
    safety:
      currentSafetySnapshot != null && safetySourceAssessment.generation != null
        ? buildAlertSafetySnapshotEnvelope(
            currentSafetySnapshot,
            safetySourceAssessment.generation,
            safetySourceAssessment.envelope!.safetyScoreIdentity,
          )
        : null,
    launch:
      mustSeedSnapshots && previousLaunchIds != null
        ? previousLaunchIds
        : PRE_LAUNCH_STABLECOINS.map((coin) => coin.id),
    reserveDispatched,
  };
  const previousReserveDriftIds = reserveNeedsColdSeed
    ? parsedCurrentReserveDriftIds
    : parsedCurrentReserveDriftIds == null
      ? (previousReserveDispatchedIds ?? [])
      : (previousReserveDispatchedIds ?? parsedCurrentReserveDriftIds);
  const currentReserveDriftIds =
    parsedCurrentReserveDriftIds == null ? (previousReserveDispatchedIds ?? []) : parsedCurrentReserveDriftIds;

  return {
    nowSec,
    previousDewsSnapshot,
    previousDewsAlertableSnapshot,
    previousDepegSnapshot,
    previousSafetySnapshot,
    safetySourceAssessment,
    reserveSourceAssessment,
    currentSafetySnapshot,
    safetySnapshotNeedsSeed,
    currentSnapshots,
    // No prior baseline ⇒ this is a reserve seed: treat the current producer
    // set as the baseline so already-drifting coins produce no alert (the
    // transition gate). If the producer snapshot is unavailable, preserve the
    // prior baseline and suppress reserve transitions for this run.
    previousReserveDriftIds,
    currentReserveDriftIds,
    reserveSourceUnavailable,
    mustSeedSnapshots,
    safeDewsSnapshot: previousDewsSnapshot ?? {},
    safeDewsAlertable: previousDewsAlertableSnapshot ?? {},
    safeDepegSnapshot: previousDepegSnapshot ?? {},
    safeSafetySnapshot: currentSafetySnapshot != null && !safetySnapshotNeedsSeed ? (previousSafetySnapshot ?? {}) : {},
  };
}
