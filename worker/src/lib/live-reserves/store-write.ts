/**
 * Stage A: checkpoint start, ownership-gated domain begin, then atomic authority
 * and history (6 SQL / 3 RTT for scheduled success). Stage B may batch checkpoint
 * and begin only after proving exact-owner SQL gating, crash recovery before and
 * after commit, and ambiguous acknowledgements. Never batch a coin's begin with
 * its success: that would make its pending-attempt fence tautological.
 */
import { FROZEN_IDS, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { chunkArray, D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "../collections";
import { buildInClause, executeAtomicBatch } from "../db";
import { runWithOverloadRetry } from "../d1-overload-retry";
import { sha256Hex } from "../hash";
import {
  LIVE_RESERVE_HISTORY_RETENTION_SEC,
  type LiveReserveHistoryPruneResult,
  type ReserveCompositionRecord,
  type ReserveSyncAttemptStartRecord,
  type ReserveSyncStateRecord,
} from "./store-shared";
import {
  buildReserveAttemptAuthoritativeReadbackStatement,
  buildReserveCompositionHistoryInsertStatement,
  buildReserveCompositionFinalizeSuccessStatement,
  buildReserveSuccessAuthoritativeReadbackStatement,
  buildReserveSyncAttemptHistoryInsertStatement,
  buildReserveSyncAttemptStartStatement,
  buildReserveSyncFinalizeAttemptStatement,
  buildReserveSyncFinalizeSuccessStatement,
} from "./store-statements";

const LIVE_RESERVE_ARTIFACT_DELETE_CHUNK_SIZE = D1_SAFE_IN_CLAUSE_BIND_LIMIT;

interface ReserveCompositionPayloadRow {
  slices: string;
  metadata: string;
  warnings: string | null;
}

function reserveCompositionPayloadJson(payload: ReserveCompositionPayloadRow): string {
  return JSON.stringify(payload);
}

function reserveCompositionPayloadFromRecord(record: ReserveCompositionRecord): ReserveCompositionPayloadRow {
  const { diag: _diag, ...metadata } = record.metadata;
  return {
    slices: JSON.stringify(record.slices),
    metadata: JSON.stringify(metadata),
    warnings: record.warnings.length > 0 ? JSON.stringify(record.warnings) : null,
  };
}


export interface LiveReserveArtifactCleanupResult {
  syncStateDeleted: number;
  compositionDeleted: number;
  breakerCacheDeleted: number;
}

export async function beginReserveSyncAttempt(
  db: D1Database,
  record: ReserveSyncAttemptStartRecord,
): Promise<void> {
  const config = ACTIVE_STABLECOINS.find((coin) => coin.id === record.stablecoinId)?.liveReservesConfig;
  const persisted = { ...record, configFingerprint: record.configFingerprint ?? (config ? computeLiveReserveConfigFingerprint(config) : null) };
  await runWithOverloadRetry(async () => {
    if (record.deadlineMs != null && Date.now() > record.deadlineMs) throw new Error("Reserve attempt start deadline expired");
    const result = await buildReserveSyncAttemptStartStatement(db, persisted).run();
    if ((result.meta.changes ?? 0) === 0) throw new Error("Reserve attempt start lost checkpoint ownership or deadline");
  });
}

export async function didReserveSyncSuccessBecomeAuthoritative(
  db: D1Database,
  stablecoinId: string,
  fetchedAt: number,
  attemptId: string | null | undefined,
): Promise<boolean> {
  if (!attemptId) return false;
  const row = await runWithOverloadRetry(() =>
    buildReserveSuccessAuthoritativeReadbackStatement(db, stablecoinId, fetchedAt, attemptId)
      .first<{ finalized: number }>(),
  );
  return row?.finalized === 1;
}

export async function didReserveSyncAttemptBecomeAuthoritative(
  db: D1Database,
  stablecoinId: string,
  attemptId: string,
): Promise<boolean> {
  const row = await runWithOverloadRetry(() =>
    buildReserveAttemptAuthoritativeReadbackStatement(db, stablecoinId, attemptId)
      .first<{ finalized: number }>(),
  );
  return row?.finalized === 1;
}


export async function finalizeReserveSyncSuccess(
  db: D1Database,
  composition: ReserveCompositionRecord,
  syncState: ReserveSyncStateRecord,
  finalizeDeadlineMs: number,
  onAuthoritativeWrite?: () => Promise<void>,
): Promise<{ finalized: boolean }> {
  const config = ACTIVE_STABLECOINS.find((coin) => coin.id === composition.stablecoinId)?.liveReservesConfig;
  const configFingerprint = composition.configFingerprint ?? (config ? computeLiveReserveConfigFingerprint(config) : null);
  const payloadSha256 = await sha256Hex(
    reserveCompositionPayloadJson(reserveCompositionPayloadFromRecord(composition)),
  );
  let compositionApplied = false;
  let finalized = false;

  try {
    const [compositionRes, finalizeRes] = await executeAtomicBatch(db, [
        buildReserveCompositionFinalizeSuccessStatement(db, { ...composition, configFingerprint }, finalizeDeadlineMs),
        buildReserveSyncFinalizeSuccessStatement(db, { ...syncState, configFingerprint }, finalizeDeadlineMs),
        buildReserveCompositionHistoryInsertStatement(db, composition, payloadSha256),
        buildReserveSyncAttemptHistoryInsertStatement(db, {
          stablecoinId: syncState.stablecoinId,
          attemptedAt: syncState.lastAttemptedAt ?? composition.fetchedAt,
          adapterKey: syncState.adapterKey,
          breakerKey: syncState.breakerKey,
          status: syncState.lastStatus,
          warningCount: syncState.warningCount,
          warnings: syncState.warnings,
          lastError: syncState.lastError,
          metadata: syncState.metadata,
          attemptId: syncState.lastAttemptId ?? null,
        }, "success"),
      ], { returnResults: true });
    compositionApplied = ((compositionRes as D1Result).meta.changes ?? 0) > 0;
    finalized = ((finalizeRes as D1Result).meta.changes ?? 0) > 0;
  } catch (error) {
    if (
      await didReserveSyncSuccessBecomeAuthoritative(
        db,
        composition.stablecoinId,
        composition.fetchedAt,
        composition.attemptId,
      )
    ) {
      compositionApplied = true;
      finalized = true;
    } else {
      throw error;
    }
  }

  if (!finalized || !compositionApplied) {
    const authoritative = await didReserveSyncSuccessBecomeAuthoritative(
      db,
      composition.stablecoinId,
      composition.fetchedAt,
      composition.attemptId,
    );
    if (!authoritative) {
      return { finalized: false };
    }
  }

  await onAuthoritativeWrite?.();
  return { finalized: true };
}

export async function finalizeReserveSyncAttempt(
  db: D1Database,
  syncState: ReserveSyncStateRecord,
  deadlineMs = Number.MAX_SAFE_INTEGER,
): Promise<{ finalized: boolean }> {
  if (Date.now() > deadlineMs) throw new Error("Reserve attempt finalization deadline expired");
  const config = ACTIVE_STABLECOINS.find((coin) => coin.id === syncState.stablecoinId)?.liveReservesConfig;
  const configFingerprint = syncState.configFingerprint ?? (config ? computeLiveReserveConfigFingerprint(config) : null);
  const [finalizeResult] = await executeAtomicBatch(db, [
    buildReserveSyncFinalizeAttemptStatement(db, { ...syncState, configFingerprint }, deadlineMs),
    buildReserveSyncAttemptHistoryInsertStatement(db, {
      stablecoinId: syncState.stablecoinId,
      attemptedAt: syncState.lastAttemptedAt ?? Math.floor(Date.now() / 1000),
      adapterKey: syncState.adapterKey,
      breakerKey: syncState.breakerKey,
      status: syncState.lastStatus,
      warningCount: syncState.warningCount,
      warnings: syncState.warnings,
      lastError: syncState.lastError,
      metadata: syncState.metadata,
      attemptId: syncState.lastAttemptId ?? null,
    }),
  ], { returnResults: true });
  return { finalized: (finalizeResult.meta.changes ?? 0) > 0 };
}

async function loadStringColumn(
  db: D1Database,
  sql: string,
  column: string,
): Promise<string[]> {
  const rows = await runWithOverloadRetry(() => db.prepare(sql).all<Record<string, unknown>>());
  return Array.from(new Set(
    (rows.results ?? [])
      .map((row) => row[column])
      .filter((value): value is string => typeof value === "string"),
  ));
}

async function deleteExactMatchesInChunks(
  db: D1Database,
  sqlPrefix: string,
  values: readonly string[],
): Promise<number> {
  let totalDeleted = 0;
  for (const valueChunk of chunkArray(values, LIVE_RESERVE_ARTIFACT_DELETE_CHUNK_SIZE)) {
    const inClause = buildInClause(valueChunk);
    const result = await runWithOverloadRetry(() =>
      db
        .prepare(`${sqlPrefix} IN (${inClause.sql})`)
        .bind(...inClause.binds)
        .run(),
    );
    totalDeleted += Number(result.meta?.changes ?? 0);
  }
  return totalDeleted;
}

export async function cleanupStaleLiveReserveArtifacts(
  db: D1Database,
  activeCoinIds: readonly string[],
  activeBreakerKeys: ReadonlySet<string>,
): Promise<LiveReserveArtifactCleanupResult> {
  const activeCoinIdSet = new Set(activeCoinIds);
  const activeCacheKeySet = new Set(
    Array.from(activeBreakerKeys, (breakerKey) => `circuit:${breakerKey}`),
  );

  const [
    existingSyncStateIds,
    existingCompositionIds,
    existingBreakerCacheKeys,
  ] = await Promise.all([
    loadStringColumn(db, "SELECT stablecoin_id FROM reserve_sync_state", "stablecoin_id"),
    loadStringColumn(db, "SELECT stablecoin_id FROM reserve_composition", "stablecoin_id"),
    loadStringColumn(
      db,
      "SELECT key FROM cache WHERE key LIKE 'circuit:live-reserves:%'",
      "key",
    ),
  ]);

  const staleSyncStateIds = existingSyncStateIds.filter((stablecoinId) => !activeCoinIdSet.has(stablecoinId));
  const staleCompositionIds = existingCompositionIds.filter((stablecoinId) => !activeCoinIdSet.has(stablecoinId));
  const staleBreakerCacheKeys = existingBreakerCacheKeys.filter((cacheKey) => !activeCacheKeySet.has(cacheKey));

  const syncStateDeleted = await deleteExactMatchesInChunks(
    db,
    "DELETE FROM reserve_sync_state WHERE stablecoin_id",
    staleSyncStateIds,
  );
  const compositionDeleted = await deleteExactMatchesInChunks(
    db,
    "DELETE FROM reserve_composition WHERE stablecoin_id",
    staleCompositionIds,
  );
  const breakerCacheDeleted = await deleteExactMatchesInChunks(
    db,
    "DELETE FROM cache WHERE key",
    staleBreakerCacheKeys,
  );

  return {
    syncStateDeleted,
    compositionDeleted,
    breakerCacheDeleted,
  };
}

const DEFAULT_PRUNE_BATCH_SIZE = 5000;

async function deleteHistoryInBatches(
  db: D1Database,
  table: "reserve_composition_history" | "reserve_sync_attempt_history",
  column: "fetched_at" | "attempted_at",
  cutoff: number,
  batchSize: number,
): Promise<number> {
  const frozenIdsList = [...FROZEN_IDS];
  const frozenClause =
    frozenIdsList.length > 0
      ? `AND stablecoin_id NOT IN (${frozenIdsList.map(() => "?").join(",")})`
      : "";
  // SAFETY: table and column are TypeScript string literal union types; every call site passes a hardcoded allowlisted literal, not user input.
  // The status/admin gap checks and recovery fencing join history rows on the current
  // attempt_id regardless of age, so rows referenced by reserve_composition or
  // reserve_sync_state must survive the age cutoff (e.g. long-suspended feeds).
  const sql = `DELETE FROM ${table} WHERE rowid IN (
    SELECT t.rowid FROM ${table} t
     WHERE t.${column} < ? ${frozenClause}
       AND NOT EXISTS (
         SELECT 1 FROM reserve_composition c
          WHERE c.stablecoin_id = t.stablecoin_id AND c.attempt_id = t.attempt_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM reserve_sync_state s
          WHERE s.stablecoin_id = t.stablecoin_id
            AND t.attempt_id IN (s.last_attempt_id, s.last_success_attempt_id, s.pending_attempt_id)
       )
     LIMIT ?
  )`;
  let totalDeleted = 0;
  // Loop until a batch deletes fewer rows than the budget, which implies the
  // table is drained. Keeps each DELETE inside D1's 30s per-statement limit.
  for (;;) {
    const result = await runWithOverloadRetry(() =>
      db
        .prepare(sql)
        .bind(cutoff, ...frozenIdsList, batchSize)
        .run(),
    );
    const deleted = result.meta.changes ?? 0;
    totalDeleted += deleted;
    if (deleted < batchSize) break;
  }
  return totalDeleted;
}

export async function pruneLiveReserveHistory(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  retentionSec = LIVE_RESERVE_HISTORY_RETENTION_SEC,
  batchSize = DEFAULT_PRUNE_BATCH_SIZE,
): Promise<LiveReserveHistoryPruneResult> {
  const cutoff = now - retentionSec;
  const compositionHistoryDeleted = await deleteHistoryInBatches(
    db,
    "reserve_composition_history",
    "fetched_at",
    cutoff,
    batchSize,
  );
  const attemptHistoryDeleted = await deleteHistoryInBatches(
    db,
    "reserve_sync_attempt_history",
    "attempted_at",
    cutoff,
    batchSize,
  );

  return {
    cutoff,
    compositionHistoryDeleted,
    attemptHistoryDeleted,
  };
}
