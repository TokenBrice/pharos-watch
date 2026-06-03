import { getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import type { ReserveCompositionOverview, ReserveCompositionRecord, ReserveSnapshotMetadataRecord } from "./live-reserves-store-shared";
import { getCache } from "./db-cache";
import {
  getConfiguredLiveReserveCoins,
  LIVE_RESERVE_FRESHNESS_SEC,
  PERSISTENTLY_STALE_INDEPENDENT_THRESHOLD_SEC,
  SCORING_LIVE_RESERVE_EVIDENCE_CLASSES,
  emptyReserveCompositionOverview,
  type AuthoritativeReserveSnapshot,
  type ReserveSyncStateRecord,
} from "./live-reserves-store-shared";
import { loadReserveCompositionRowMap, loadReserveSyncStateMap } from "./live-reserves-store-read";
import {
  hasConsistentSnapshotState,
  hasScoringEligibleLiveReserveFreshness,
  hasUncertainWriteState,
} from "./live-reserves-store-snapshot-state";
import { parseReserveCompositionRow } from "./live-reserves-store-row-decoding";

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

export async function computeReserveCompositionOverview(
  db: D1Database,
  now: number,
  freshnessSec = LIVE_RESERVE_FRESHNESS_SEC,
): Promise<ReserveCompositionOverview> {
  const configuredCoins = getConfiguredLiveReserveCoins();
  if (configuredCoins.length === 0) {
    return emptyReserveCompositionOverview();
  }

  const coinIds = configuredCoins.map((coin) => coin.id);
  const [syncById, compositionById] = await Promise.all([
    loadReserveSyncStateMap(db, coinIds),
    loadReserveCompositionRowMap(db, coinIds),
  ]);

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
  let runBudgetTruncated = false;
  let deferredAt: number | null = null;
  let cursorDeferredCount: number | null = null;
  let cursorTailState: ReserveCompositionOverview["cursorTailState"] = null;
  let cursorTailError: string | null = null;
  let cursorRecordedAt: number | null = null;
  let cursorTailCompletedAt: number | null = null;
  let cursorTailFailedAt: number | null = null;
  let runBudgetTruncationCount = 0;
  let historyWriteGaps: NonNullable<ReserveCompositionOverview["historyWriteGaps"]> = [];
  const persistentlyStaleIndependentCoins: Array<{ stablecoinId: string; ageSec: number }> = [];
  let lastSuccessAt: number | null = null;
  let oldestFreshAgeSec: number | null = null;
  let nextCursorStablecoinId: string | null = null;

  const cursorCache = await getCache(db, "live-reserves:run-cursor");
  if (cursorCache) {
    try {
      const parsed = JSON.parse(cursorCache.value) as {
        nextStablecoinId?: unknown;
        deferredCount?: unknown;
        deferredAt?: unknown;
        tailState?: unknown;
        tailError?: unknown;
        cursorRecordedAt?: unknown;
        tailCompletedAt?: unknown;
        tailFailedAt?: unknown;
        runBudgetTruncationCount?: unknown;
      };
      if (typeof parsed.nextStablecoinId === "string") {
        nextCursorStablecoinId = parsed.nextStablecoinId;
      }
      cursorDeferredCount = typeof parsed.deferredCount === "number" ? parsed.deferredCount : null;
      runBudgetTruncated = cursorDeferredCount != null && cursorDeferredCount > 0;
      deferredAt = typeof parsed.deferredAt === "number" ? parsed.deferredAt : null;
      cursorTailState =
        parsed.tailState === "recording" || parsed.tailState === "incomplete" || parsed.tailState === "complete"
          ? parsed.tailState
          : null;
      cursorTailError = typeof parsed.tailError === "string" ? parsed.tailError : null;
      cursorRecordedAt = typeof parsed.cursorRecordedAt === "number" ? parsed.cursorRecordedAt : null;
      cursorTailCompletedAt = typeof parsed.tailCompletedAt === "number" ? parsed.tailCompletedAt : null;
      cursorTailFailedAt = typeof parsed.tailFailedAt === "number" ? parsed.tailFailedAt : null;
      runBudgetTruncationCount =
        typeof parsed.runBudgetTruncationCount === "number" && parsed.runBudgetTruncationCount > 0
          ? parsed.runBudgetTruncationCount
          : runBudgetTruncated
            ? 1
            : 0;
    } catch {
      nextCursorStablecoinId = null;
      runBudgetTruncated = false;
      deferredAt = null;
      cursorDeferredCount = null;
      cursorTailState = null;
      cursorTailError = null;
      cursorRecordedAt = null;
      cursorTailCompletedAt = null;
      cursorTailFailedAt = null;
      runBudgetTruncationCount = 0;
    }
  }

  try {
    historyWriteGaps = await loadLiveReserveHistoryWriteGaps(db);
  } catch (error) {
    console.warn("[live-reserves] Failed to reconcile reserve history write gaps:", error);
  }

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

    if (ageSec > freshnessSec) {
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
    configuredCoins: configuredCoins.length,
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
    deferredCoins: Math.max(deferredCoins, cursorDeferredCount ?? 0),
    runBudgetTruncated,
    deferredAt,
    nextCursorStablecoinId,
    cursorTailState,
    cursorTailError,
    cursorRecordedAt,
    cursorTailCompletedAt,
    cursorTailFailedAt,
    runBudgetTruncationCount,
    historyWriteGaps,
    persistentlyStaleIndependentCoins: persistentlyStaleIndependentCoins.sort(
      (a, b) => b.ageSec - a.ageSec,
    ),
    lastSuccessAt,
    oldestFreshAgeSec,
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
    if (now - parsed.record.fetchedAt > freshnessSec) continue;
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
): Promise<Map<string, ReserveCompositionRecord["slices"]>> {
  const snapshots = await loadFreshAuthoritativeReserveSnapshots(db, now, freshnessSec, {
    minSlices,
    evidenceClasses: SCORING_LIVE_RESERVE_EVIDENCE_CLASSES,
    requireOkStatus: true,
  });
  return new Map(
    Array.from(snapshots.entries())
      .filter(([, snapshot]) => hasScoringEligibleLiveReserveFreshness(snapshot.metadata))
      .map(([coinId, snapshot]) => [coinId, snapshot.slices]),
  );
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
