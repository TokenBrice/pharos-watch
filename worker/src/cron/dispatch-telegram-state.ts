import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins";
import {
  ALERT_SAFETY_SOURCE_CACHE_KEY,
  assessAlertSafetySourceCache,
  buildAlertSafetySnapshotEnvelope,
  getAlertSafetySourceGeneration,
  parseAlertSafetySnapshotEnvelope,
  type AlertSafetySnapshotEnvelope,
  type AlertSafetySourceAssessment,
  type AlertSafetySourceSnapshot,
} from "../lib/alert-safety-source-cache";
import { getCache } from "../lib/db-cache";
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

function parseLaunchSnapshotIds(cached: CachedValue): string[] | null {
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached.value);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((id): id is string => typeof id === "string");
  } catch { /* expected: corrupted launch snapshot json */
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
}

export interface DispatchSnapshotState {
  nowSec: number;
  previousDewsSnapshot: DewsSnapshot | null;
  previousDewsAlertableSnapshot: DewsSnapshot;
  previousDepegSnapshot: DepegSnapshot | null;
  previousSafetySnapshot: SafetySnapshot | null;
  safetySourceAssessment: AlertSafetySourceAssessment;
  currentSafetySnapshot: AlertSafetySourceSnapshot | null;
  safetySnapshotNeedsSeed: boolean;
  currentSnapshots: {
    dews: DewsSnapshot;
    dewsAlertable: DewsSnapshot;
    depeg: DepegSnapshot;
    safety: AlertSafetySnapshotEnvelope | null;
    launch: string[];
  };
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
      "SELECT chat_id FROM telegram_subscribers WHERE alert_snooze_until_ts IS NOT NULL AND alert_snooze_until_ts > ?",
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
  ] = await Promise.all([
    db
      .prepare(
        `SELECT s.stablecoin_id, s.score, s.band, s.signals_json
           FROM stress_signals s
           INNER JOIN (
             SELECT stablecoin_id, MAX(computed_at) AS max_at
               FROM stress_signals GROUP BY stablecoin_id
           ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`,
      )
      .all<DewsRow>()
      .then((result) => result.results ?? []),
    db
      .prepare(
        "SELECT id AS event_id, stablecoin_id, symbol, direction, peak_deviation_bps, start_price, peg_reference FROM depeg_events WHERE ended_at IS NULL",
      )
      .all<ActiveDepegRowWithEventId>()
      .then((result) => result.results ?? []),
    db
      .prepare(
        `SELECT h.stablecoin_id,
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
  };
}

export function buildDispatchSnapshotState(
  sourceData: DispatchSourceData,
  nowSec: number,
): DispatchSnapshotState {
  const previousDewsSnapshot = parseSnapshotMap<DewsSnapshot>(sourceData.dewsCache);
  const previousDewsAlertableSnapshot =
    parseSnapshotMap<DewsSnapshot>(sourceData.dewsAlertableCache) ??
    filterAlertableBands(previousDewsSnapshot);
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
    currentSafetySnapshot != null && (
      previousSafetyEnvelope == null ||
      isSnapshotMissingOrStale(sourceData.safetyCache, nowSec) ||
      previousSafetyEnvelope.generation !== (safetySourceAssessment.generation ?? "")
    );

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

  const mustSeedSnapshots =
    isSnapshotMissingOrStale(sourceData.dewsCache, nowSec) ||
    (sourceData.dewsAlertableCache != null &&
      isSnapshotMissingOrStale(sourceData.dewsAlertableCache, nowSec)) ||
    isSnapshotMissingOrStale(sourceData.depegCache, nowSec) ||
    previousDewsSnapshot == null ||
    previousDepegSnapshot == null;

  const currentSnapshots = {
    dews: buildDewsSnapshot(sourceData.dewsRows),
    dewsAlertable: buildDewsAlertableSnapshot(
      sourceData.dewsRows,
      previousDewsAlertableSnapshot,
    ),
    depeg: currentDepegSnapshot,
    safety:
      currentSafetySnapshot != null && safetySourceAssessment.generation != null
        ? buildAlertSafetySnapshotEnvelope(
            currentSafetySnapshot,
            safetySourceAssessment.generation,
          )
        : null,
    launch:
      mustSeedSnapshots && previousLaunchIds != null
        ? previousLaunchIds
        : PRE_LAUNCH_STABLECOINS.map((coin) => coin.id),
  };

  return {
    nowSec,
    previousDewsSnapshot,
    previousDewsAlertableSnapshot,
    previousDepegSnapshot,
    previousSafetySnapshot,
    safetySourceAssessment,
    currentSafetySnapshot,
    safetySnapshotNeedsSeed,
    currentSnapshots,
    mustSeedSnapshots,
    safeDewsSnapshot: previousDewsSnapshot ?? {},
    safeDewsAlertable: previousDewsAlertableSnapshot ?? {},
    safeDepegSnapshot: previousDepegSnapshot ?? {},
    safeSafetySnapshot:
      currentSafetySnapshot != null && !safetySnapshotNeedsSeed
        ? (previousSafetySnapshot ?? {})
        : {},
  };
}
