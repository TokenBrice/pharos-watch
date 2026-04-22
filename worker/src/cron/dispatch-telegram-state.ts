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

export interface DispatchSourceData {
  chatsWithActiveSnooze: number;
  dewsRows: DewsRow[];
  activeDepegRows: ActiveDepegRow[];
  safetyRows: SafetyRow[];
  dewsCache: CachedValue;
  dewsAlertableCache: CachedValue;
  depegCache: CachedValue;
  safetyCache: CachedValue;
  safetySourceCache: CachedValue;
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
        "SELECT stablecoin_id, symbol, direction, peak_deviation_bps, start_price, peg_reference FROM depeg_events WHERE ended_at IS NULL",
      )
      .all<ActiveDepegRow>()
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

  const currentSnapshots = {
    dews: buildDewsSnapshot(sourceData.dewsRows),
    dewsAlertable: buildDewsAlertableSnapshot(
      sourceData.dewsRows,
      previousDewsAlertableSnapshot,
    ),
    depeg: buildDepegSnapshot(sourceData.activeDepegRows),
    safety:
      currentSafetySnapshot != null && safetySourceAssessment.generation != null
        ? buildAlertSafetySnapshotEnvelope(
            currentSafetySnapshot,
            safetySourceAssessment.generation,
          )
        : null,
    launch: PRE_LAUNCH_STABLECOINS.map((coin) => coin.id),
  };

  const mustSeedSnapshots =
    isSnapshotMissingOrStale(sourceData.dewsCache, nowSec) ||
    (sourceData.dewsAlertableCache != null &&
      isSnapshotMissingOrStale(sourceData.dewsAlertableCache, nowSec)) ||
    isSnapshotMissingOrStale(sourceData.depegCache, nowSec) ||
    previousDewsSnapshot == null ||
    previousDepegSnapshot == null;

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
