import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import {
  ReserveAlertObservationsSchema,
  type AlertSafetySnapshotEnvelope,
  type AlertSafetySourceSnapshot,
} from "@shared/types/status/telegram";
import {
  alertSafetyIdentitiesAreComparable,
  buildAlertSafetySnapshotEnvelope,
  loadActiveAlertSafetySourceAssessment,
  parseAlertSafetySnapshotEnvelope,
  type AlertSafetySourceAssessment,
} from "../../../lib/alert-safety-source-cache";
import { getCache, setCache } from "../../../lib/db-cache";
import { loadSafetyScoreV9PublicationAttempt, type V9PublicationAttempt } from "../../../lib/safety-score-v9/publication-attempts";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../../lib/safety-score-v9/consumer-freshness";
import { logTelegramEvent } from "../../../telegram/common/log";
import { loadTelegramDewsCurrentRows } from "../../../lib/stress-signals-current-rows";
import type { PendingCapacitySnapshot } from "../delivery/types";
import {
  ALERT_RESERVE_SOURCE_GENERATION,
  assessAlertReserveSourceCache,
  type AlertReserveSourceAssessment,
} from "../../../lib/alert-reserve-source-cache";
import {
  SNAPSHOT_KEYS,
  buildDepegSnapshot,
  filterAlertableBands,
  isSnapshotMissingOrStale,
  parseSnapshotMap,
  type ActiveDepegRow,
  type DepegSnapshot,
  type DewsCandidateSnapshot,
  type DewsRow,
  type DewsSnapshot,
  type SafetySnapshot,
} from "../sources/telegram-alert-snapshots";
import { isDewsAlertable } from "../../../telegram/common/alerts-formatting";
import { holdSuppressedSafetyBaselines, planDewsAlerts, reseedSafetyBaseline } from "../sources/telegram-alert-changes";

type CachedValue = { value: string; updatedAt: number } | null;

const TELEGRAM_DEWS_LATEST_FALLBACK_AGE_SEC = 2 * 3600;
const PRESET_QUERY_FAILURE_CACHE_KEY = "telegram:preset-query-failure-count";

export interface TelegramDispatchSharedState {
  pendingCapacitySnapshot?: PendingCapacitySnapshot;
  safetySourceAssessment?: AlertSafetySourceAssessment;
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

export function parseSnapshotIds(cached: CachedValue): string[] | null {
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached.value);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    /* expected: corrupted snapshot json */
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
  dewsCache: CachedValue;
  dewsAlertableCache: CachedValue;
  dewsCandidatesCache?: CachedValue;
  depegCache: CachedValue;
  safetyCache: CachedValue;
  safetySourceAssessment?: AlertSafetySourceAssessment;
  publicationAttempt?: V9PublicationAttempt | null;
  /** Producer-written current drift id-set (four-hourly reserve slot). */
  reserveCache: CachedValue;
  /** Dispatch-owned baseline: the drift id-set the dispatcher last acted on. */
  reserveDispatchedCache: CachedValue;
  reserveObservedCache?: CachedValue;
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
    dewsCandidates: DewsCandidateSnapshot;
    dewsUnavailable: boolean;
    depeg: DepegSnapshot;
    safety: AlertSafetySnapshotEnvelope | null;
    /**
     * Dispatch baseline written back: the producer's current drift id-set.
     * `null` means the producer snapshot was unavailable and there was no
     * prior baseline to preserve.
     */
    reserveDispatched: string[] | null;
    reserveObserved?: Record<string, number> | null;
  };
  /** Drift id-set the dispatcher last acted on (prior baseline). */
  previousReserveDriftIds: string[];
  /** Producer's current drift id-set (read-only in dispatch). */
  currentReserveDriftIds: string[];
  reserveSourceUnavailable: boolean;
  mustSeedSnapshots: boolean;
  safeDewsSnapshot: DewsSnapshot;
  safeDewsAlertable: DewsSnapshot;
  safeDewsCandidates: DewsCandidateSnapshot;
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
    dewsCache,
    dewsAlertableCache,
    dewsCandidatesCache,
    depegCache,
    safetyCache,
    safetySourceAssessment,
    publicationAttempt,
    reserveCache,
    reserveDispatchedCache,
    reserveObservedCache,
  ] = await Promise.all([
    loadDewsRows(db, snoozeNowSec),
    db
      .prepare(
        `SELECT /* pharos:telegram-dispatch:active-depegs */
           id AS event_id, stablecoin_id, symbol, direction, peak_deviation_bps, start_price, peak_price, peg_reference, started_at
         FROM depeg_events WHERE ended_at IS NULL`,
      )
      .all<ActiveDepegRowWithEventId>()
      .then((result) => result.results ?? []),
    getCache(db, SNAPSHOT_KEYS.dews),
    getCache(db, SNAPSHOT_KEYS.dewsAlertable),
    getCache(db, SNAPSHOT_KEYS.dewsCandidates),
    getCache(db, SNAPSHOT_KEYS.depeg),
    getCache(db, SNAPSHOT_KEYS.safety),
    // Envelope-first: the publication writer persists a thin projection, so
    // the five-minute alert lane never decodes the full V9 publication when
    // the persisted envelope matches the active identity.
    loadActiveAlertSafetySourceAssessment(db, snoozeNowSec),
    loadSafetyScoreV9PublicationAttempt(db),
    getCache(db, SNAPSHOT_KEYS.reserve),
    getCache(db, SNAPSHOT_KEYS.reserveDispatched),
    getCache(db, SNAPSHOT_KEYS.reserveObserved),
  ]);

  return {
    chatsWithActiveSnooze: (snoozedRows.results ?? []).length,
    dewsRows,
    activeDepegRows,
    dewsCache,
    dewsAlertableCache,
    dewsCandidatesCache,
    depegCache,
    safetyCache,
    safetySourceAssessment,
    publicationAttempt,
    reserveCache,
    reserveDispatchedCache,
    reserveObservedCache,
  };
}

export function buildDispatchSnapshotState(sourceData: DispatchSourceData, nowSec: number): DispatchSnapshotState {
  const previousDewsSnapshot = parseSnapshotMap<DewsSnapshot>(sourceData.dewsCache);
  const previousDewsAlertableSnapshot =
    parseSnapshotMap<DewsSnapshot>(sourceData.dewsAlertableCache) ?? filterAlertableBands(previousDewsSnapshot);
  const previousDewsCandidates =
    parseSnapshotMap<DewsCandidateSnapshot>(sourceData.dewsCandidatesCache ?? null) ?? {};
  // No DEWS rows means the read was unavailable (stale or failed), never a
  // genuine empty set: keep the DEWS baselines and skip their write (R2).
  const dewsAvailable = sourceData.dewsRows.length > 0;
  // Snapshot-side replay of the event planner; identity symbols are never rendered.
  const dewsPlan = planDewsAlerts(
    sourceData.dewsRows,
    previousDewsAlertableSnapshot,
    previousDewsSnapshot ?? {},
    previousDewsCandidates,
    (id) => id,
    nowSec,
  );
  const previousDepegSnapshot = parseSnapshotMap<DepegSnapshot>(sourceData.depegCache);
  const safetySourceAssessment: AlertSafetySourceAssessment =
    sourceData.safetySourceAssessment ?? {
      state: "missing",
      ageSeconds: null,
      generation: null,
      envelope: null,
      failureReason: "v9-snapshot-unavailable",
      sourcePublicationGenerationId: null,
      acceptedPublicationGenerationId: null,
      freshnessMaxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
      assessedAtSec: nowSec,
    };
  const affectedAssetIds = new Set(
    sourceData.publicationAttempt?.outcome ===
        "published-partial" &&
      sourceData.publicationAttempt.publicationGenerationId ===
        safetySourceAssessment.envelope?.publicationGenerationId
      ? sourceData.publicationAttempt.affectedAssetIds
      : [],
  );
  const currentSafetySnapshot =
    safetySourceAssessment.state === "ok" &&
    safetySourceAssessment.envelope
      ? Object.fromEntries(
          Object.entries(
            safetySourceAssessment.envelope.snapshot,
          ).map(([assetId, row]) => [
            assetId,
            {
              ...row,
              operationallyAffected:
                affectedAssetIds.has(assetId),
            },
          ]),
        )
      : null;
  const previousSafetyEnvelope = parseAlertSafetySnapshotEnvelope(sourceData.safetyCache);
  const previousSafetySnapshot = previousSafetyEnvelope?.snapshot ?? null;
  const safetyBaselineContinuityLost =
    sourceData.safetyCache != null &&
    nowSec - sourceData.safetyCache.updatedAt >=
      CRON_INTERVALS["dispatch-telegram-alerts"] * 2;
  const safetyIdentitiesComparable =
    previousSafetyEnvelope?.safetyScoreIdentity != null &&
    safetySourceAssessment.envelope?.safetyScoreIdentity != null &&
    alertSafetyIdentitiesAreComparable(
      previousSafetyEnvelope.safetyScoreIdentity,
      safetySourceAssessment.envelope.safetyScoreIdentity,
    );
  const safetySnapshotNeedsSeed =
    currentSafetySnapshot != null &&
    (previousSafetyEnvelope == null ||
      safetyBaselineContinuityLost ||
      isSnapshotMissingOrStale(sourceData.safetyCache, nowSec) ||
      previousSafetyEnvelope.generation !== (safetySourceAssessment.generation ?? "") ||
      !safetyIdentitiesComparable);

  // The canonical builder persists event identity. Legacy snapshots without
  // eventId retain the stablecoin-only diff until the next baseline write.
  const currentDepegSnapshot = buildDepegSnapshot(sourceData.activeDepegRows);

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
  const previousReserveDispatchedIds = parseSnapshotIds(sourceData.reserveDispatchedCache);
  const parsedObservedBaseline = ReserveAlertObservationsSchema.safeParse(
    parseSnapshotMap<Record<string, number>>(sourceData.reserveObservedCache ?? null),
  );
  const previousObserved = parsedObservedBaseline.success ? parsedObservedBaseline.data : {};
  const currentObserved = reserveSourceAssessment.envelope?.observedSince ?? {};

  // An unavailable DEWS read keeps its stale clock instead of blocking depeg;
  // the first available read after a long gap still reseeds silently.
  const mustSeedSnapshots =
    (dewsAvailable && (
      isSnapshotMissingOrStale(sourceData.dewsCache, nowSec) ||
      (sourceData.dewsAlertableCache != null && isSnapshotMissingOrStale(sourceData.dewsAlertableCache, nowSec)) ||
      previousDewsSnapshot == null
    )) ||
    isSnapshotMissingOrStale(sourceData.depegCache, nowSec) ||
    previousDepegSnapshot == null;
  // A seed run adopts current bands as already alerted and drops pending
  // escalations, so conditions present at the seed never alert afterwards.
  const seededDews = { observed: {} as DewsSnapshot, alertable: { ...previousDewsAlertableSnapshot } };
  for (const row of sourceData.dewsRows) {
    seededDews.observed[row.stablecoin_id] = row.band;
    if (isDewsAlertable(row.band)) seededDews.alertable[row.stablecoin_id] = row.band;
  }
  const reserveNeedsColdSeed = reserveSourceAssessment.state === "recovering" && parsedCurrentReserveDriftIds != null;
  const reserveDispatched = reserveNeedsColdSeed
    ? parsedCurrentReserveDriftIds
    : parsedCurrentReserveDriftIds == null
      ? (previousReserveDispatchedIds ?? null)
      : mustSeedSnapshots && previousReserveDispatchedIds != null
        ? previousReserveDispatchedIds
        : parsedCurrentReserveDriftIds;

  const currentSnapshots = {
    dews: !dewsAvailable ? (previousDewsSnapshot ?? {}) : mustSeedSnapshots ? seededDews.observed : dewsPlan.nextObserved,
    dewsAlertable: !dewsAvailable ? previousDewsAlertableSnapshot : mustSeedSnapshots ? seededDews.alertable : dewsPlan.nextAlertable,
    dewsCandidates: !dewsAvailable ? previousDewsCandidates : mustSeedSnapshots ? {} : dewsPlan.nextCandidates,
    dewsUnavailable: !dewsAvailable,
    // A seed run sends nothing, so a fresh depeg baseline stays put and a depeg
    // that opened in this run is still detected on the next normal run.
    depeg: mustSeedSnapshots && previousDepegSnapshot != null && !isSnapshotMissingOrStale(sourceData.depegCache, nowSec)
      ? previousDepegSnapshot
      : currentDepegSnapshot,
    safety:
      currentSafetySnapshot != null && safetySourceAssessment.generation != null
        ? buildAlertSafetySnapshotEnvelope(
            !safetySnapshotNeedsSeed && previousSafetySnapshot != null
              ? holdSuppressedSafetyBaselines(currentSafetySnapshot, previousSafetySnapshot, nowSec, {
                // Seed runs send nothing: a due alert must survive to the next run.
                deferAlerts: mustSeedSnapshots,
              })
              : reseedSafetyBaseline(currentSafetySnapshot, previousSafetySnapshot, safetyIdentitiesComparable),
            safetySourceAssessment.generation,
            safetySourceAssessment.envelope!.safetyScoreIdentity,
          )
        : null,
    reserveDispatched,
    reserveObserved: parsedCurrentReserveDriftIds == null ||
      (mustSeedSnapshots && !reserveNeedsColdSeed && previousReserveDispatchedIds != null)
      ? (parsedObservedBaseline.success ? previousObserved : null)
      : currentObserved,
  };
  const currentReserveDriftIds =
    parsedCurrentReserveDriftIds == null ? (previousReserveDispatchedIds ?? []) : parsedCurrentReserveDriftIds;
  // An unavailable member has no comparable observation. Returning members are
  // cold-seeded by their continuity epoch, including gaps dispatch never saw.
  const previousReserveDriftIds = parsedCurrentReserveDriftIds == null
    ? (previousReserveDispatchedIds ?? [])
    : currentReserveDriftIds.filter((id) => reserveNeedsColdSeed ||
      previousReserveDispatchedIds == null ||
      previousObserved[id] !== currentObserved[id] ||
      previousReserveDispatchedIds.includes(id));

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
    safeDewsCandidates: previousDewsCandidates,
    safeDepegSnapshot: previousDepegSnapshot ?? {},
    safeSafetySnapshot: currentSafetySnapshot != null && !safetySnapshotNeedsSeed ? (previousSafetySnapshot ?? {}) : {},
  };
}
