import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/registry";
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
  readDewsPublishedGeneration,
} from "../lib/dews-publication-pointer";
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
type DewsLatestRow = DewsRow & { computed_at: number };

const TELEGRAM_DEWS_LATEST_FALLBACK_AGE_SEC = 2 * 3600;

function areDewsLatestRowsStale(rows: DewsLatestRow[], nowSec: number): boolean {
  if (rows.length === 0) return true;
  const newestComputedAt = rows.reduce(
    (max, row) => Math.max(max, Number.isFinite(row.computed_at) ? row.computed_at : 0),
    0,
  );
  return newestComputedAt <= 0 || nowSec - newestComputedAt > TELEGRAM_DEWS_LATEST_FALLBACK_AGE_SEC;
}

function mergeNewestDewsRows(legacyRows: DewsLatestRow[], latestRows: DewsLatestRow[]): DewsRow[] {
  const byId = new Map<string, DewsLatestRow>();
  for (const row of legacyRows) {
    byId.set(row.stablecoin_id, row);
  }
  for (const row of latestRows) {
    const existing = byId.get(row.stablecoin_id);
    if (!existing || row.computed_at >= existing.computed_at) {
      byId.set(row.stablecoin_id, row);
    }
  }
  return [...byId.values()];
}

async function loadCompletedDewsComputedAt(db: D1Database, nowSec: number): Promise<number | null> {
  try {
    return await readDewsPublishedGeneration(db, nowSec);
  } catch {
    return null;
  }
}

export async function loadDewsRows(db: D1Database, nowSec: number): Promise<DewsRow[]> {
  const completedAt = await loadCompletedDewsComputedAt(db, nowSec);
  let latestRows: DewsLatestRow[] = [];
  try {
    const latestStmt = db.prepare(
      completedAt == null
        ?
        `SELECT /* pharos:telegram-dispatch:dews-latest */
           stablecoin_id, score, band, signals_json, computed_at
         FROM stress_signals_latest`
        :
        `SELECT /* pharos:telegram-dispatch:dews-latest */
           stablecoin_id, score, band, signals_json, computed_at
         FROM stress_signals_latest
         WHERE computed_at <= ?`,
    );
    const rows = await (
      completedAt == null
        ? latestStmt
        : latestStmt.bind(completedAt)
    ).all<DewsLatestRow>();
    latestRows = rows.results ?? [];
  } catch {
    latestRows = [];
  }

  // stress_signals_latest is the current primary source and is upserted as a
  // complete snapshot each DEWS run. When it is present and fresh it already
  // covers every current coin, so skip the legacy stress_signals query (and its
  // correlated MAX(computed_at) sub-query) entirely rather than always paying
  // for a redundant round-trip on every 5-minute dispatch.
  if (latestRows.length > 0 && !areDewsLatestRowsStale(latestRows, nowSec)) {
    return latestRows;
  }

  const legacyStmt = db.prepare(
    completedAt == null
      ?
      `SELECT /* pharos:telegram-dispatch:dews-legacy */
         s.stablecoin_id, s.score, s.band, s.signals_json, s.computed_at
         FROM stress_signals s
       INNER JOIN (
         SELECT stablecoin_id, MAX(computed_at) AS max_at
           FROM stress_signals GROUP BY stablecoin_id
      ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`
      :
      `SELECT /* pharos:telegram-dispatch:dews-legacy */
         s.stablecoin_id, s.score, s.band, s.signals_json, s.computed_at
         FROM stress_signals s
         INNER JOIN (
           SELECT stablecoin_id, MAX(computed_at) AS max_at
             FROM stress_signals
            WHERE computed_at <= ?
            GROUP BY stablecoin_id
      ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`,
  );
  const legacyRows = await (
    completedAt == null
      ? legacyStmt
      : legacyStmt.bind(completedAt)
  ).all<DewsLatestRow>();
  const legacyResults = legacyRows.results ?? [];
  if (legacyResults.length === 0) return latestRows;
  if (areDewsLatestRowsStale(latestRows, nowSec)) return legacyResults;
  return mergeNewestDewsRows(legacyResults, latestRows);
}

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

/** Parse a LAUNCH-STYLE id-set snapshot (reserve-drift, C123). */
function parseReserveSnapshotIds(cached: CachedValue): string[] | null {
  return parseLaunchSnapshotIds(cached);
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
  currentSafetySnapshot: AlertSafetySourceSnapshot | null;
  safetySnapshotNeedsSeed: boolean;
  currentSnapshots: {
    dews: DewsSnapshot;
    dewsAlertable: DewsSnapshot;
    depeg: DepegSnapshot;
    safety: AlertSafetySnapshotEnvelope | null;
    launch: string[];
    /** Dispatch baseline written back: the producer's current drift id-set. */
    reserveDispatched: string[];
  };
  /** Drift id-set the dispatcher last acted on (prior baseline). */
  previousReserveDriftIds: string[];
  /** Producer's current drift id-set (read-only in dispatch). */
  currentReserveDriftIds: string[];
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

  // Reserve-drift (C123): the producer (four-hourly reserve slot) owns the
  // current drift id-set; the dispatcher diffs it against its own last-acted-on
  // baseline. When the run is a seed (stale dews/depeg) we preserve the prior
  // baseline so a drift opening during the seed window is not absorbed and
  // fires on the next healthy run (mirrors the launch P1.7 pattern). When there
  // is no parseable baseline we seed with the current producer set (no
  // transition to lose).
  const currentReserveDriftIds = parseReserveSnapshotIds(sourceData.reserveCache) ?? [];
  const previousReserveDispatchedIds = parseReserveSnapshotIds(sourceData.reserveDispatchedCache);

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
    reserveDispatched:
      mustSeedSnapshots && previousReserveDispatchedIds != null
        ? previousReserveDispatchedIds
        : currentReserveDriftIds,
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
    // No prior baseline ⇒ this is a reserve seed: treat the current producer
    // set as the baseline so already-drifting coins produce no alert (the
    // transition gate). Once a baseline exists, diff against it normally.
    previousReserveDriftIds: previousReserveDispatchedIds ?? currentReserveDriftIds,
    currentReserveDriftIds,
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
