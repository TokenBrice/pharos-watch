import { emptyReserveCompositionOverview } from "@shared/types/live-reserves";
import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types/core";
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
  isReserveSnapshotStale,
  evaluateLiveReserveAdmission,
  type LiveReserveAdmissionResult,
  hasUncertainWriteState,
} from "./store-snapshot-state";
import { parseReserveCompositionRow } from "./store-row-decoding";


interface LiveReserveResumePointer {
  state: string;
  next_item_key: string | null;
  items_done: number;
  items_total: number;
  updated_at: number;
}

async function loadLatestLiveReserveResumePointer(db: D1Database): Promise<LiveReserveResumePointer | null> {
  try {
    return await db
      .prepare(
        `SELECT state, next_item_key, items_done, items_total, updated_at
           FROM worker_scheduled_checkpoints
          WHERE schedule_key = 'fourHourlyReserveSync'
            AND job = 'sync-live-reserves'
          ORDER BY slot_started_at DESC, attempt_no DESC
          LIMIT 1`,
      )
      .first<LiveReserveResumePointer>();
  } catch {
    return null;
  }
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
  configuredCoins: readonly StablecoinMeta[],
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
      continue;
    }

    const admission = evaluateLiveReserveAdmission(record, syncState, coin, now, freshnessSec);
    if (admission.eligible) independentFreshEligible++;
    const ageSec = Math.max(0, now - record.fetchedAt);
    lastSuccessAt = lastSuccessAt == null ? record.fetchedAt : Math.max(lastSuccessAt, record.fetchedAt);

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

    if (isReserveSnapshotStale(record, coin, now, freshnessSec)) {
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
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
): Promise<ReserveCompositionOverview> {
  const configuredCoins = getConfiguredLiveReserveCoins();
  if (configuredCoins.length === 0) {
    return emptyReserveCompositionOverview();
  }

  const [syncById, compositionById, checkpoint, adapterReliability] = await Promise.all([
    loadReserveSyncStateMap(db),
    loadReserveCompositionRowMap(db),
    loadLatestLiveReserveResumePointer(db),
    loadReserveSyncReliabilityRollup(db, now).catch((error) => {
      logWorkerEvent({
        scope: "status",
        level: "warn",
        event: "reserve_adapter_reliability_unavailable",
        route: "status",
        source: "reserve_composition",
        message: "Reserve adapter reliability rollup unavailable",
        error,
      });
      return [];
    }),
  ]);

  const pointerPending = checkpoint != null
    && (checkpoint.state === "running" || checkpoint.state === "recovering" || checkpoint.state === "ready")
    && checkpoint.next_item_key != null
    && checkpoint.items_done < checkpoint.items_total;
  const pointerDeferredCount = pointerPending
    ? Math.max(0, checkpoint!.items_total - checkpoint!.items_done)
    : 0;


  const counts = countCoinsByStatus(configuredCoins, syncById, compositionById, now, freshnessSec);

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
    runBudgetTruncated: pointerPending,
    deferredAt: pointerPending ? checkpoint!.updated_at : null,
    nextCursorStablecoinId: pointerPending ? checkpoint!.next_item_key : null,
    cursorRecordedAt: pointerPending ? checkpoint!.updated_at : null,
    persistentlyStaleIndependentCoins: counts.persistentlyStaleIndependentCoins.sort(
      (a, b) => b.ageSec - a.ageSec,
    ),
    lastSuccessAt: counts.lastSuccessAt,
    oldestFreshAgeSec: counts.oldestFreshAgeSec,
    adapterReliability,
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
        { source: snapshot.source, fetchedAt: snapshot.fetchedAt },
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
    const admission = evaluateLiveReserveAdmission(record, syncState, TRACKED_META_BY_ID.get(stablecoinId), now);
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
