import { emptyReserveCompositionOverview } from "@shared/types/live-reserves";
import { logWorkerEventArgs } from "../structured-log";
import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
import type { ReserveCompositionOverview, ReserveCompositionRecord, ReserveSnapshotMetadataRecord } from "./store-shared";
import {
  getConfiguredLiveReserveCoins,
  LIVE_RESERVE_FRESHNESS_SEC,
  PERSISTENTLY_STALE_INDEPENDENT_THRESHOLD_SEC,
  SCORING_LIVE_RESERVE_EVIDENCE_CLASSES,
  type AuthoritativeReserveSnapshot,
  type LiveReserveScoringMap,
  type ReserveCompositionRow,
  type ReserveSyncStateRecord,
} from "./store-shared";
import { loadReserveCompositionRowMap, loadReserveSyncStateMap } from "./store-read";
import {
  hasConsistentSnapshotState,
  isReserveSnapshotStale,
  hasScoringEligibleLiveReserveFreshness,
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

export async function loadLiveReserveHistoryWriteGaps(
  db: D1Database,
  limit = 20,
): Promise<NonNullable<ReserveCompositionOverview["historyWriteGaps"]>> {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = await db
    .prepare(
      `SELECT
         c.stablecoin_id AS stablecoin_id,
         c.fetched_at AS fetched_at,
         c.attempt_id AS attempt_id,
         CASE WHEN ch.attempt_id IS NULL THEN 1 ELSE 0 END AS composition_history_missing,
         CASE WHEN ah.attempt_id IS NULL THEN 1 ELSE 0 END AS attempt_history_missing
       FROM reserve_composition c
       JOIN reserve_sync_state s
         ON s.stablecoin_id = c.stablecoin_id
       LEFT JOIN reserve_composition_history ch
         ON ch.stablecoin_id = c.stablecoin_id
        AND ch.attempt_id = c.attempt_id
       LEFT JOIN reserve_sync_attempt_history ah
         ON ah.stablecoin_id = c.stablecoin_id
        AND ah.attempt_id = c.attempt_id
       WHERE c.attempt_id IS NOT NULL
         AND s.last_success_at = c.fetched_at
         AND s.last_success_attempt_id = c.attempt_id
         AND s.pending_attempt_id IS NULL
         AND (ch.attempt_id IS NULL OR ah.attempt_id IS NULL)
       ORDER BY c.fetched_at DESC
       LIMIT ?`,
    )
    .bind(boundedLimit)
    .all<{
      stablecoin_id: string;
      fetched_at: number;
      attempt_id: string;
      composition_history_missing: number;
      attempt_history_missing: number;
    }>();

  return (rows.results ?? [])
    .filter((row) => typeof row.stablecoin_id === "string" && typeof row.attempt_id === "string")
    .map((row) => ({
      stablecoinId: row.stablecoin_id,
      fetchedAt: Number(row.fetched_at),
      attemptId: row.attempt_id,
      compositionHistoryMissing: Number(row.composition_history_missing) === 1,
      attemptHistoryMissing: Number(row.attempt_history_missing) === 1,
    }));
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

  for (const coin of configuredCoins) {
    const syncState = syncById.get(coin.id) ?? null;
    const compositionRow = compositionById.get(coin.id);

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
    const hasSnapshot = hasConsistentSnapshotState(syncState, compositionRow
      ? { fetchedAt: compositionRow.fetched_at, attemptId: compositionRow.attempt_id ?? null }
      : null);

    if (!hasSnapshot || !compositionRow) {
      if (syncState?.lastStatus === "error") {
        errorCoins++;
        if (uncertainWrite) writeTimeoutUncertain++;
      } else {
        missingCoins++;
        if (uncertainWrite) writeTimeoutUncertain++;
      }
      continue;
    }

    const parsed = parseReserveCompositionRow(compositionRow, syncState);
    if (!parsed.record) {
      corruptCoins++;
      continue;
    }

    const ageSec = Math.max(0, now - parsed.record.fetchedAt);
    lastSuccessAt = lastSuccessAt == null ? parsed.record.fetchedAt : Math.max(lastSuccessAt, parsed.record.fetchedAt);

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

    if (isReserveSnapshotStale(parsed.record, coin, now, freshnessSec)) {
      staleCoins++;
      if (uncertainWrite) writeTimeoutUncertain++;
      continue;
    }

    freshCoins++;
    if (uncertainWrite) writeTimeoutUncertain++;
    if (parsed.record.adapterEvidenceClass === "independent") {
      if (hasScoringEligibleLiveReserveFreshness(parsed.record.metadata)) {
        independentFreshEligible++;
      } else {
        independentFreshUnverified++;
      }
    } else if (parsed.record.adapterEvidenceClass === "static-validated") {
      staticValidatedFresh++;
    } else if (parsed.record.adapterEvidenceClass === "weak-live-probe") {
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
): Promise<ReserveCompositionOverview & { historyWriteGapCheckFailed: boolean }> {
  const configuredCoins = getConfiguredLiveReserveCoins();
  if (configuredCoins.length === 0) {
    return {
      ...emptyReserveCompositionOverview(),
      historyWriteGapCheckFailed: false,
    };
  }

  const coinIds = configuredCoins.map((coin) => coin.id);
  const [syncById, compositionById, checkpoint] = await Promise.all([
    loadReserveSyncStateMap(db, coinIds),
    loadReserveCompositionRowMap(db, coinIds),
    loadLatestLiveReserveResumePointer(db),
  ]);

  const pointerPending = checkpoint != null
    && (checkpoint.state === "running" || checkpoint.state === "recovering" || checkpoint.state === "ready")
    && checkpoint.next_item_key != null
    && checkpoint.items_done < checkpoint.items_total;
  const pointerDeferredCount = pointerPending
    ? Math.max(0, checkpoint!.items_total - checkpoint!.items_done)
    : 0;

  let historyWriteGaps: NonNullable<ReserveCompositionOverview["historyWriteGaps"]> = [];
  let historyWriteGapCheckFailed = false;
  try {
    historyWriteGaps = await loadLiveReserveHistoryWriteGaps(db);
  } catch (error) {
    historyWriteGapCheckFailed = true;
    logWorkerEventArgs("lib", "warn", "[live-reserves] Failed to reconcile reserve history write gaps:", error);
  }

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
    cursorTailState: null,
    cursorTailError: null,
    cursorRecordedAt: pointerPending ? checkpoint!.updated_at : null,
    cursorTailCompletedAt: null,
    cursorTailFailedAt: null,
    runBudgetTruncationCount: pointerPending ? 1 : 0,
    historyWriteGaps,
    historyWriteGapCheckFailed,
    persistentlyStaleIndependentCoins: counts.persistentlyStaleIndependentCoins.sort(
      (a, b) => b.ageSec - a.ageSec,
    ),
    lastSuccessAt: counts.lastSuccessAt,
    oldestFreshAgeSec: counts.oldestFreshAgeSec,
  };
}

async function loadFreshAuthoritativeReserveSnapshots(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
  options?: {
    minSlices?: number;
    sourceModels?: readonly ReserveCompositionRecord["adapterSourceModel"][];
    evidenceClasses?: readonly ReserveCompositionRecord["adapterEvidenceClass"][];
    requireOkStatus?: boolean;
  },
): Promise<Map<string, AuthoritativeReserveSnapshot>> {
  const configuredCoins = getConfiguredLiveReserveCoins();
  const coinIds = configuredCoins.map((coin) => coin.id);
  const [syncById, compositionById] = await Promise.all([
    loadReserveSyncStateMap(db, coinIds),
    loadReserveCompositionRowMap(db, coinIds),
  ]);
  const allowedSourceModels = options?.sourceModels ? new Set(options.sourceModels) : null;
  const allowedEvidenceClasses = options?.evidenceClasses ? new Set(options.evidenceClasses) : null;
  const minSlices = options?.minSlices ?? 1;
  const snapshots = new Map<string, AuthoritativeReserveSnapshot>();

  for (const coin of configuredCoins) {
    const syncState = syncById.get(coin.id) ?? null;
    const compositionRow = compositionById.get(coin.id);
    if (!compositionRow || !hasConsistentSnapshotState(syncState, {
      fetchedAt: compositionRow.fetched_at,
      attemptId: compositionRow.attempt_id ?? null,
    })) {
      continue;
    }

    const parsed = parseReserveCompositionRow(compositionRow, syncState);
    if (!parsed.record) continue;
    if (options?.requireOkStatus && syncState?.lastStatus !== "ok") continue;
    if (isReserveSnapshotStale(parsed.record, coin, now, freshnessSec)) continue;
    if (parsed.record.slices.length < minSlices) continue;

    if (allowedSourceModels && !allowedSourceModels.has(parsed.record.adapterSourceModel)) {
      continue;
    }
    if (allowedEvidenceClasses && !allowedEvidenceClasses.has(parsed.record.adapterEvidenceClass)) {
      continue;
    }

    snapshots.set(coin.id, {
      stablecoinId: coin.id,
      slices: parsed.record.slices,
      fetchedAt: parsed.record.fetchedAt,
      source: parsed.record.source,
      metadata: parsed.record.metadata,
      warningCount: parsed.record.warningCount,
      warnings: parsed.record.warnings,
      sourceModel: parsed.record.adapterSourceModel,
      evidenceClass: parsed.record.adapterEvidenceClass,
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
  const snapshots = await loadFreshAuthoritativeReserveSnapshots(db, now, freshnessSec, {
    minSlices,
    evidenceClasses: SCORING_LIVE_RESERVE_EVIDENCE_CLASSES,
    requireOkStatus: true,
  });
  const eligibleSnapshots = Array.from(snapshots.entries())
    .filter(([, snapshot]) => hasScoringEligibleLiveReserveFreshness(snapshot.metadata));
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
  };
}

export async function loadReserveSnapshotMetadataMap(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<Map<string, ReserveSnapshotMetadataRecord>> {
  if (stablecoinIds.length === 0) {
    return new Map();
  }

  const [syncById, compositionById] = await Promise.all([
    loadReserveSyncStateMap(db, stablecoinIds),
    loadReserveCompositionRowMap(db, stablecoinIds),
  ]);

  const records = new Map<string, ReserveSnapshotMetadataRecord>();
  for (const stablecoinId of stablecoinIds) {
    const syncState = syncById.get(stablecoinId) ?? null;
    const compositionRow = compositionById.get(stablecoinId);
    if (!compositionRow || !hasConsistentSnapshotState(syncState, {
      fetchedAt: compositionRow.fetched_at,
      attemptId: compositionRow.attempt_id ?? null,
    })) {
      continue;
    }

    const parsed = parseReserveCompositionRow(compositionRow, syncState);
    if (!parsed.record) continue;
    records.set(stablecoinId, buildReserveSnapshotMetadataRecord(stablecoinId, parsed.record, syncState));
  }

  return records;
}

export async function getLatestSuccessfulReserveSnapshotMetadata(
  db: D1Database,
  stablecoinId: string,
): Promise<ReserveSnapshotMetadataRecord | null> {
  const records = await loadReserveSnapshotMetadataMap(db, [stablecoinId]);
  return records.get(stablecoinId) ?? null;
}
