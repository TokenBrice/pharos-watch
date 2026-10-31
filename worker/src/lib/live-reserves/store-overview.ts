import { emptyReserveCompositionOverview, ReserveContinuationExecutionStatusSchema } from "@shared/types/live-reserves";
import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { STATUS_RESERVE_COHORT_SLO } from "@shared/lib/status-thresholds";
import { percentileNearestRank } from "@shared/lib/stats";
import { WORKER_TRACKED_META_BY_ID, type WorkerLiveReserveStablecoinMeta } from "@shared/lib/stablecoins/worker-runtime-registry";
import type { ReserveCompositionOverview, ReserveCompositionRecord, ReserveSnapshotMetadataRecord } from "./store-shared";
import {
  getConfiguredLiveReserveCoins,
  LIVE_RESERVE_FRESHNESS_SEC,
  PERSISTENTLY_STALE_INDEPENDENT_THRESHOLD_SEC,
  type AuthoritativeReserveSnapshot,
  type LiveReserveScoringMap,
  type ReserveCompositionRow,
  type ReserveSyncStateRecord,
} from "./store-shared";
import { loadReserveCompositionRowMap, loadReserveSyncStateMap } from "./store-read";
import { loadReserveSyncReliabilityRollup } from "./store-history-read";
import { logWorkerEvent } from "../structured-log";
import {
  hasConsistentSnapshotState,
  evaluateLiveReserveAdmission,
  type LiveReserveAdmissionResult,
  hasUncertainWriteState,
} from "./store-snapshot-state";
import { parseReserveCompositionRow } from "./store-row-decoding";
import { matchReserveFeedReview, resolveReserveFeedReviews } from "../reserve-feed-reviews";


interface LiveReserveResumePointer {
  state: string;
  slot_started_at: number;
  next_item_key: string | null;
  items_done: number;
  items_total: number;
  updated_at: number;
  completed_at: number | null;
  recovery_lease_until: number | null;
  producer_disposition: string | null;
  producer_state: string | null;
  producer_finished_at: number | null;
  queue_execution_json: string | null;
}

async function loadLatestLiveReserveResumePointer(db: D1Database): Promise<LiveReserveResumePointer | null> {
  return db
    .prepare(
      `SELECT c.state, c.slot_started_at, c.next_item_key, c.items_done, c.items_total, c.updated_at,
              c.completed_at, c.recovery_lease_until,
              json_extract(c.child_dispositions_json, '$."sync-live-reserves"') AS producer_disposition,
              s.state AS producer_state, s.finished_at AS producer_finished_at,
              (SELECT json_object('deliveryId', q.delivery_id, 'phase', q.phase, 'state', q.state,
                'generation', q.execution_generation, 'startedAt', q.started_at, 'updatedAt', q.updated_at,
                'deadlineMs', q.deadline_ms, 'finishedAt', q.finished_at, 'resultStatus', q.result_status)
               FROM reserve_continuation_executions q
               WHERE q.schedule_key = c.schedule_key AND q.slot_started_at = c.slot_started_at
               ORDER BY q.started_at DESC, q.delivery_id DESC LIMIT 1) AS queue_execution_json
         FROM worker_scheduled_checkpoints c
         LEFT JOIN cron_slot_executions s
           ON s.slot_key = c.schedule_key AND s.slot_started_at = c.slot_started_at
        WHERE c.schedule_key = 'fourHourlyReserveSync'
          AND c.job = 'sync-live-reserves'
        ORDER BY c.slot_started_at DESC, c.attempt_no DESC
        LIMIT 1`,
    )
    .first<LiveReserveResumePointer>();
}

async function loadReserveCohortCompletions(db: D1Database, now: number) {
  // Group by root slot, not attempts; continuations never inflate the sample.
  // Seven days contain at most 43 four-hour opportunities including endpoints.
  const rows = await db.prepare(
    `SELECT slot_started_at, MIN(completed_at) AS completed_at
       FROM worker_scheduled_checkpoints
      WHERE schedule_key = 'fourHourlyReserveSync' AND job = 'sync-live-reserves'
        AND state = 'completed' AND completed_at IS NOT NULL
        AND next_item_key IS NULL AND items_done = items_total
        AND slot_started_at <= ?
      GROUP BY slot_started_at
      HAVING slot_started_at >= ? OR MIN(completed_at) >= ?
      ORDER BY slot_started_at DESC LIMIT 64`,
  ).bind(now, now - STATUS_RESERVE_COHORT_SLO.windowSec, now - STATUS_RESERVE_COHORT_SLO.recoveryWindowSec)
    .all<{ slot_started_at: number; completed_at: number }>();
  const durations: number[] = [];
  let recentCompletionMaxSec: number | null = null;
  for (const row of rows.results ?? []) {
    if (!Number.isFinite(row.slot_started_at) || !Number.isFinite(row.completed_at)
      || row.completed_at < row.slot_started_at || row.completed_at > now) {
      throw new Error("reserve-cohort-completion-clock-invalid");
    }
    const duration = row.completed_at - row.slot_started_at;
    if (row.slot_started_at >= now - STATUS_RESERVE_COHORT_SLO.windowSec) durations.push(duration);
    if (row.completed_at >= now - STATUS_RESERVE_COHORT_SLO.recoveryWindowSec) {
      recentCompletionMaxSec = Math.max(recentCompletionMaxSec ?? duration, duration);
    }
  }
  return {
    completedCohorts: durations.length,
    completionP95Sec: percentileNearestRank(durations, 95),
    // A bounded page cannot certify that every recent completion met the SLO.
    recentCompletionMaxSec: rows.results?.length === 64 ? null : recentCompletionMaxSec,
  };
}

function isPersistentlyStaleIndependentStatus(syncState: ReserveSyncStateRecord): boolean {
  if (syncState.lastStatus === "degraded" || syncState.lastStatus === "error") {
    return true;
  }

  return syncState.lastStatus === "skipped"
    && syncState.metadata.failureCategory === "circuit-open";
}


interface CoinStatusCounts {
  freshCoins: number;
  staleCoins: number;
  missingCoins: number;
  degradedCoins: number;
  errorCoins: number;
  corruptCoins: number;
  independentFreshEligible: number;
  independentFreshUnverified: number;
  staticValidatedFresh: number;
  weakProbeFresh: number;
  writeTimeoutUncertain: number;
  deferredCoins: number;
  persistentlyStaleIndependentCoins: Array<{ stablecoinId: string; ageSec: number }>;
  lastSuccessAt: number | null;
  oldestFreshAgeSec: number | null;
}

/** Keep consistency-before-decoding identical across overview, scoring, and metadata reads. */
function* iterateReserveSnapshots(
  stablecoinIds: Iterable<string>,
  syncById: Map<string, ReserveSyncStateRecord>,
  compositionById: Map<string, ReserveCompositionRow>,
) {
  for (const stablecoinId of stablecoinIds) {
    const syncState = syncById.get(stablecoinId) ?? null;
    const row = compositionById.get(stablecoinId);
    const hasSnapshot = !!row && hasConsistentSnapshotState(syncState, {
      fetchedAt: row.fetched_at, attemptId: row.attempt_id ?? null,
    });
    const record = hasSnapshot ? parseReserveCompositionRow(row!, syncState).record : null;
    yield { stablecoinId, syncState, hasSnapshot, record };
  }
}

function countCoinsByStatus(
  configuredCoins: readonly WorkerLiveReserveStablecoinMeta[],
  syncById: Map<string, ReserveSyncStateRecord>,
  compositionById: Map<string, ReserveCompositionRow>,
  now: number,
  freshnessSec: number,
): CoinStatusCounts {
  let freshCoins = 0;
  let staleCoins = 0;
  let missingCoins = 0;
  let degradedCoins = 0;
  let errorCoins = 0;
  let corruptCoins = 0;
  let independentFreshEligible = 0;
  let independentFreshUnverified = 0;
  let staticValidatedFresh = 0;
  let weakProbeFresh = 0;
  let writeTimeoutUncertain = 0;
  let deferredCoins = 0;
  const persistentlyStaleIndependentCoins: Array<{ stablecoinId: string; ageSec: number }> = [];
  let lastSuccessAt: number | null = null;
  let oldestFreshAgeSec: number | null = null;

  const coinsById = new Map(configuredCoins.map((coin) => [coin.id, coin]));
  for (const { stablecoinId, syncState, hasSnapshot, record } of iterateReserveSnapshots(
    coinsById.keys(), syncById, compositionById,
  )) {
    const coin = coinsById.get(stablecoinId)!;

    // Persistently-stale independent detection runs against the sync state
    // independently of snapshot consistency so we still flag coins whose
    // source has been failing for weeks even when the stored composition
    // snapshot is missing or mismatched.
    if (
      coin.liveReservesConfig
      && syncState
      && syncState.lastSuccessAt != null
      && isPersistentlyStaleIndependentStatus(syncState)
      && now - syncState.lastSuccessAt > PERSISTENTLY_STALE_INDEPENDENT_THRESHOLD_SEC
    ) {
      const adapterDef = getLiveReserveAdapterDefinition(coin.liveReservesConfig.adapter);
      if (adapterDef?.evidenceClass === "independent") {
        persistentlyStaleIndependentCoins.push({
          stablecoinId: coin.id,
          ageSec: now - syncState.lastSuccessAt,
        });
      }
    }

    if (
      syncState?.lastStatus === "skipped" &&
      syncState.metadata.failureCategory === "run-budget-exhausted"
    ) {
      deferredCoins++;
    }

    const uncertainWrite = hasUncertainWriteState(syncState);

    if (!hasSnapshot) {
      if (syncState?.metadata.reason === "source-stale") {
        staleCoins++;
        if (uncertainWrite) writeTimeoutUncertain++;
        continue;
      }
      if (syncState?.lastStatus === "error") {
        errorCoins++;
        if (uncertainWrite) writeTimeoutUncertain++;
      } else {
        missingCoins++;
        if (uncertainWrite) writeTimeoutUncertain++;
      }
      continue;
    }

    if (!record) {
      corruptCoins++;
      if (uncertainWrite) writeTimeoutUncertain++;
      // A consistent row proves a recorded success even when its payload is
      // undecodable; the success clock is sync-state evidence, not the payload.
      const successfulAt = syncState?.lastSuccessAt;
      if (typeof successfulAt === "number" && Number.isFinite(successfulAt) && successfulAt > 0) {
        lastSuccessAt = lastSuccessAt == null ? successfulAt : Math.max(lastSuccessAt, successfulAt);
      }
      continue;
    }

    const admission = evaluateLiveReserveAdmission(record, syncState, coin, now, freshnessSec);
    if (admission.eligible) independentFreshEligible++;
    const ageSec = Math.max(0, now - record.fetchedAt);
    lastSuccessAt = lastSuccessAt == null ? record.fetchedAt : Math.max(lastSuccessAt, record.fetchedAt);
    if (syncState?.metadata.reason === "source-stale") {
      staleCoins++;
      if (uncertainWrite) writeTimeoutUncertain++;
      continue;
    }

    if (syncState?.lastStatus === "error") {
      errorCoins++;
      if (uncertainWrite) writeTimeoutUncertain++;
      continue;
    }

    if (syncState && syncState.lastStatus !== "ok") {
      degradedCoins++;
      if (uncertainWrite) writeTimeoutUncertain++;
      continue;
    }

    if (admission.freshness?.stale) {
      staleCoins++;
      if (uncertainWrite) writeTimeoutUncertain++;
      continue;
    }

    freshCoins++;
    if (uncertainWrite) writeTimeoutUncertain++;
    if (record.adapterEvidenceClass === "independent") {
      if (admission.reasons.includes("invalid-freshness")) {
        independentFreshUnverified++;
      }
    } else if (record.adapterEvidenceClass === "static-validated") {
      staticValidatedFresh++;
    } else if (record.adapterEvidenceClass === "weak-live-probe") {
      weakProbeFresh++;
    }

    oldestFreshAgeSec = oldestFreshAgeSec == null ? ageSec : Math.max(oldestFreshAgeSec, ageSec);
  }

  return {
    freshCoins,
    staleCoins,
    missingCoins,
    degradedCoins,
    errorCoins,
    corruptCoins,
    independentFreshEligible,
    independentFreshUnverified,
    staticValidatedFresh,
    weakProbeFresh,
    writeTimeoutUncertain,
    deferredCoins,
    persistentlyStaleIndependentCoins,
    lastSuccessAt,
    oldestFreshAgeSec,
  };
}

export async function computeReserveCompositionOverview(
  db: D1Database,
  now: number,
  checkpointLiveness: { readonly slotSilenceSec: number; readonly hardDeadSec: number },
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
): Promise<ReserveCompositionOverview> {
  const configuredCoins = getConfiguredLiveReserveCoins();
  if (configuredCoins.length === 0) {
    return { ...emptyReserveCompositionOverview(), adapterReliabilityAvailability: { status: "available" } };
  }

  const [syncById, compositionById, checkpoint, cohortCompletions, adapterReliability] = await Promise.all([
    loadReserveSyncStateMap(db),
    loadReserveCompositionRowMap(db),
    loadLatestLiveReserveResumePointer(db),
    loadReserveCohortCompletions(db, now),
    loadReserveSyncReliabilityRollup(db, now).then((rows) => ({
      rows,
      availability: { status: "available" as const },
    })).catch((error) => {
      logWorkerEvent({
        scope: "status",
        level: "warn",
        event: "reserve_adapter_reliability_unavailable",
        route: "status",
        source: "reserve_composition",
        message: "Reserve adapter reliability rollup unavailable",
        error,
      });
      return {
        rows: [],
        availability: { status: "unavailable" as const, reason: "reserve_adapter_reliability_query_failed" as const },
      };
    }),
  ]);

  const pointerPending = checkpoint != null
    && (checkpoint.state === "running" || checkpoint.state === "recovering" || checkpoint.state === "ready")
    && checkpoint.next_item_key != null
    && checkpoint.items_done < checkpoint.items_total;
  const pointerInProgress = pointerPending
    && ((checkpoint!.state === "running"
      && checkpoint!.producer_state === "running"
      && checkpoint!.producer_finished_at == null)
      || (checkpoint!.state === "recovering" && checkpoint!.producer_disposition === "running"
        && (checkpoint!.recovery_lease_until ?? 0) >= now))
    && Number.isFinite(checkpoint!.updated_at)
    && Number.isFinite(checkpoint!.slot_started_at)
    && checkpoint!.slot_started_at > 0
    && checkpoint!.slot_started_at <= checkpoint!.updated_at
    && checkpoint!.updated_at <= now
    && now - checkpoint!.updated_at <= checkpointLiveness.slotSilenceSec
    && (checkpoint!.state === "recovering" || now - checkpoint!.slot_started_at < checkpointLiveness.hardDeadSec);
  const pointerRemainingCount = pointerPending
    ? Math.max(0, checkpoint!.items_total - checkpoint!.items_done)
    : 0;
  const pointerDeferred = pointerPending && !pointerInProgress;
  const pointerDeferredCount = pointerDeferred && checkpoint!.producer_disposition !== "continuation_pending" ? pointerRemainingCount : 0;


  const counts = countCoinsByStatus(configuredCoins, syncById, compositionById, now, freshnessSec);
  const hasDeferredCheckpoint = (pointerDeferred && checkpoint!.producer_disposition !== "continuation_pending")
    || (pointerPending && counts.deferredCoins > 0);
  const completedAt = checkpoint?.state === "completed" ? checkpoint.completed_at ?? null : null;
  const cohort = checkpoint ? {
    slotStartedAt: checkpoint.slot_started_at,
    completedAt,
    ageSec: (completedAt ?? now) - checkpoint.slot_started_at,
    continuationPending: checkpoint.state !== "completed" && checkpoint.state !== "failed",
    queueExecution: checkpoint.queue_execution_json
      ? ReserveContinuationExecutionStatusSchema.parse(JSON.parse(checkpoint.queue_execution_json)) : null,
    ...cohortCompletions,
  } : null;
  const reviews = resolveReserveFeedReviews(now);
  const matched = await Promise.all(configuredCoins.map((coin) => {
    const state = syncById.get(coin.id) ?? null;
    const row = compositionById.get(coin.id);
    if (row && (!hasConsistentSnapshotState(state, { fetchedAt: row.fetched_at, attemptId: row.attempt_id ?? null })
      || !parseReserveCompositionRow(row, state).record)) return null;
    return matchReserveFeedReview(db, state, now, reviews.activeById);
  }));
  const acknowledgedFeeds = matched.filter((review) => review != null);
  const acknowledgedFeedIds = acknowledgedFeeds.map((review) => review.stablecoinId);
  // Re-evaluate the actual subset: removing only a denominator would invent coverage.
  const acknowledgedIds = new Set(acknowledgedFeedIds);
  const healthCounts = countCoinsByStatus(
    configuredCoins.filter((coin) => !acknowledgedIds.has(coin.id)),
    syncById, compositionById, now, freshnessSec,
  );

  return {
    configuredCoins: configuredCoins.length,
    freshCoins: counts.freshCoins,
    staleCoins: counts.staleCoins,
    missingCoins: counts.missingCoins,
    degradedCoins: counts.degradedCoins,
    errorCoins: counts.errorCoins,
    corruptCoins: counts.corruptCoins,
    independentFreshEligible: counts.independentFreshEligible,
    independentFreshUnverified: counts.independentFreshUnverified,
    staticValidatedFresh: counts.staticValidatedFresh,
    weakProbeFresh: counts.weakProbeFresh,
    writeTimeoutUncertain: counts.writeTimeoutUncertain,
    deferredCoins: Math.max(counts.deferredCoins, pointerDeferredCount),
    inProgressCoins: pointerInProgress ? pointerRemainingCount : 0,
    cohort,
    runBudgetTruncated: hasDeferredCheckpoint,
    deferredAt: hasDeferredCheckpoint ? checkpoint!.updated_at : null,
    nextCursorStablecoinId: pointerPending ? checkpoint!.next_item_key : null,
    cursorRecordedAt: pointerPending ? checkpoint!.updated_at : null,
    persistentlyStaleIndependentCoins: counts.persistentlyStaleIndependentCoins.sort(
      (a, b) => b.ageSec - a.ageSec,
    ),
    lastSuccessAt: counts.lastSuccessAt,
    oldestFreshAgeSec: counts.oldestFreshAgeSec,
    adapterReliability: adapterReliability.rows,
    adapterReliabilityAvailability: adapterReliability.availability,
    healthConfiguredCoins: configuredCoins.length - acknowledgedFeedIds.length,
    healthFreshCoins: healthCounts.freshCoins,
    healthAuthoritativeFreshCoins: healthCounts.independentFreshEligible
      + healthCounts.independentFreshUnverified + healthCounts.staticValidatedFresh,
    acknowledgedFeedIds,
    acknowledgedFeeds,
    expiredFeedReviewIds: reviews.expiredIds,
    invalidFeedReviewIds: reviews.invalidIds,
    unacknowledgedPersistentlyStaleIndependentCoins: healthCounts.persistentlyStaleIndependentCoins,
  };
}

async function loadFreshAuthoritativeReserveSnapshots(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
  minSlices = 1,
): Promise<Map<string, AuthoritativeReserveSnapshot>> {
  const configuredCoins = getConfiguredLiveReserveCoins();
  const [syncById, compositionById] = await Promise.all([
    loadReserveSyncStateMap(db),
    loadReserveCompositionRowMap(db),
  ]);
  const snapshots = new Map<string, AuthoritativeReserveSnapshot>();

  const coinsById = new Map(configuredCoins.map((coin) => [coin.id, coin]));
  for (const { stablecoinId, record } of iterateReserveSnapshots(coinsById.keys(), syncById, compositionById)) {
    const coin = coinsById.get(stablecoinId)!;
    if (!record) continue;
    const admission = evaluateLiveReserveAdmission(record, syncById.get(stablecoinId) ?? null, coin, now, freshnessSec, minSlices);
    if (!admission.eligible) continue;

    snapshots.set(coin.id, {
      stablecoinId: coin.id,
      slices: record.slices,
      fetchedAt: record.fetchedAt,
      source: record.source,
      metadata: record.metadata,
      warningCount: record.warningCount,
      warnings: record.warnings,
      sourceModel: record.adapterSourceModel,
      evidenceClass: record.adapterEvidenceClass,
    });
  }

  return snapshots;
}

export async function loadFreshIndependentLiveReserveMap(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
  minSlices = 1,
): Promise<LiveReserveScoringMap> {
  const snapshots = await loadFreshAuthoritativeReserveSnapshots(db, now, freshnessSec, minSlices);
  const eligibleSnapshots = Array.from(snapshots.entries());
  const map = new Map(
    eligibleSnapshots.map(([coinId, snapshot]) => [coinId, snapshot.slices]),
  ) as LiveReserveScoringMap;
  Object.defineProperty(map, "provenanceById", {
    value: new Map(
      eligibleSnapshots.map(([coinId, snapshot]) => [
        coinId,
        {
          source: snapshot.source,
          fetchedAt: snapshot.fetchedAt,
          ...(snapshot.metadata.balanceSheetScope === undefined ? {} : { balanceSheetScope: snapshot.metadata.balanceSheetScope }),
          ...(snapshot.metadata.sharedBookAssetIds === undefined ? {} : { sharedBookAssetIds: snapshot.metadata.sharedBookAssetIds }),
          ...(snapshot.metadata.sharedBookMeasuredHoldings === undefined ? {} : { sharedBookMeasuredHoldings: snapshot.metadata.sharedBookMeasuredHoldings }),
          ...(snapshot.metadata.reserveObservation === undefined ? {} : { reserveObservation: snapshot.metadata.reserveObservation }),
          ...(snapshot.metadata.boundedFactsGeneration === undefined ? {} : { boundedFactsGeneration: snapshot.metadata.boundedFactsGeneration }),
          ...(snapshot.metadata.lenderBookObservation === undefined ? {} : { lenderBookObservation: snapshot.metadata.lenderBookObservation }),
          ...(snapshot.metadata.lenderBookLatestAttemptFailure === undefined ? {} : { lenderBookLatestAttemptFailure: snapshot.metadata.lenderBookLatestAttemptFailure }),
        },
      ]),
    ),
    enumerable: false,
  });
  return map;
}

function buildReserveSnapshotMetadataRecord(
  stablecoinId: string,
  record: ReserveCompositionRecord,
  syncState: ReserveSyncStateRecord | null,
  admission: LiveReserveAdmissionResult,
): ReserveSnapshotMetadataRecord {
  return {
    stablecoinId,
    fetchedAt: record.fetchedAt,
    source: record.source,
    metadata: record.metadata,
    warningCount: record.warningCount,
    warnings: record.warnings,
    sourceModel: record.adapterSourceModel,
    evidenceClass: record.adapterEvidenceClass,
    syncStatus: syncState?.lastStatus ?? "error",
    admission,
  };
}

export async function loadReserveSnapshotMetadataMap(
  db: D1Database,
  stablecoinIds: readonly string[],
  now = Math.floor(Date.now() / 1000),
): Promise<Map<string, ReserveSnapshotMetadataRecord>> {
  if (stablecoinIds.length === 0) {
    return new Map();
  }

  const [syncById, compositionById] = await Promise.all([
    loadReserveSyncStateMap(db, stablecoinIds),
    loadReserveCompositionRowMap(db, stablecoinIds),
  ]);

  const records = new Map<string, ReserveSnapshotMetadataRecord>();
  for (const { stablecoinId, syncState, record } of iterateReserveSnapshots(stablecoinIds, syncById, compositionById)) {
    if (!record) continue;
    const admission = evaluateLiveReserveAdmission(record, syncState, WORKER_TRACKED_META_BY_ID.get(stablecoinId), now);
    if (admission.reasons.includes("config-mismatch")) continue;
    records.set(stablecoinId, buildReserveSnapshotMetadataRecord(stablecoinId, record, syncState, admission));
  }

  return records;
}

export async function getLatestSuccessfulReserveSnapshotMetadata(
  db: D1Database,
  stablecoinId: string,
  now = Math.floor(Date.now() / 1000),
): Promise<ReserveSnapshotMetadataRecord | null> {
  const records = await loadReserveSnapshotMetadataMap(db, [stablecoinId], now);
  return records.get(stablecoinId) ?? null;
}
