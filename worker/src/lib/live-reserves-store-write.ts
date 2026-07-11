import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { chunkArray, D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "./collections";
import { buildInClause } from "./db";
import { runWithOverloadRetry } from "./cron-lease";
import { toErrorMessage } from "./error-utils";
import {
  LIVE_RESERVE_HISTORY_RETENTION_SEC,
  type LiveReserveHistoryPruneResult,
  type ReserveCompositionRecord,
  type ReserveSyncAttemptStartRecord,
  type ReserveSyncStateRecord,
} from "./live-reserves-store-shared";
import {
  buildReserveAuthoritativeHistoryRepairReadbackStatement,
  buildReserveCompositionHistoryRepairStatement,
  buildReserveCompositionHistoryInsertStatement,
  buildReserveCompositionFinalizeSuccessStatement,
  buildReserveCompositionUpsertStatement,
  buildReserveSuccessAuthoritativeReadbackStatement,
  buildReserveSyncAttemptHistoryRepairStatement,
  buildReserveSyncAttemptHistoryInsertStatement,
  buildReserveSyncAttemptStartStatement,
  buildReserveSyncFinalizeAttemptStatement,
  buildReserveSyncFinalizeSuccessStatement,
} from "./live-reserves-store-statements";

const LIVE_RESERVE_ARTIFACT_DELETE_CHUNK_SIZE = D1_SAFE_IN_CLAUSE_BIND_LIMIT;

export interface LiveReserveArtifactCleanupResult {
  syncStateDeleted: number;
  compositionDeleted: number;
  breakerCacheDeleted: number;
}

export async function upsertReserveComposition(
  db: D1Database,
  record: ReserveCompositionRecord,
): Promise<void> {
  await runWithOverloadRetry(() => buildReserveCompositionUpsertStatement(db, record).run());
}

export async function beginReserveSyncAttempt(
  db: D1Database,
  record: ReserveSyncAttemptStartRecord,
): Promise<void> {
  await runWithOverloadRetry(() => buildReserveSyncAttemptStartStatement(db, record).run());
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
    db
      .prepare(
        `SELECT 1 AS finalized
           FROM reserve_composition c
           JOIN reserve_sync_state s
             ON s.stablecoin_id = c.stablecoin_id
          WHERE c.stablecoin_id = ?
            AND c.attempt_id = ?
            AND s.last_success_at = c.fetched_at
            AND s.last_attempt_id = c.attempt_id
            AND s.last_success_attempt_id = c.attempt_id
            AND s.pending_attempt_id IS NULL
          LIMIT 1`,
      )
      .bind(stablecoinId, attemptId)
      .first<{ finalized: number }>(),
  );
  return row?.finalized === 1;
}

export async function repairAuthoritativeReserveSyncHistory(
  db: D1Database,
  stablecoinId: string,
  attemptId: string,
): Promise<boolean> {
  await runWithOverloadRetry(() =>
    db.batch([
      buildReserveCompositionHistoryRepairStatement(db, stablecoinId, attemptId),
      buildReserveSyncAttemptHistoryRepairStatement(db, stablecoinId, attemptId),
    ]),
  );
  const row = await runWithOverloadRetry(() =>
    buildReserveAuthoritativeHistoryRepairReadbackStatement(db, stablecoinId, attemptId)
      .first<{ repaired: number }>(),
  );
  return row?.repaired === 1;
}

export async function finalizeReserveSyncSuccess(
  db: D1Database,
  composition: ReserveCompositionRecord,
  syncState: ReserveSyncStateRecord,
  finalizeDeadlineMs: number,
  onAuthoritativeWrite?: () => Promise<void>,
): Promise<{ finalized: boolean; historyRecorded: boolean; historyError?: string }> {
  let compositionApplied = false;
  let finalized = false;

  try {
    const [compositionRes, finalizeRes] = await runWithOverloadRetry(() =>
      db.batch<unknown>([
        buildReserveCompositionFinalizeSuccessStatement(db, composition),
        buildReserveSyncFinalizeSuccessStatement(db, syncState, finalizeDeadlineMs),
      ]),
    );
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
      return { finalized: false, historyRecorded: false };
    }
  }

  await onAuthoritativeWrite?.();

  try {
    await runWithOverloadRetry(() =>
      db.batch([
        buildReserveCompositionHistoryInsertStatement(db, composition),
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
        }),
      ]),
    );
  } catch (error) {
    return {
      finalized: true,
      historyRecorded: false,
      historyError: toErrorMessage(error),
    };
  }

  return { finalized: true, historyRecorded: true };
}

export async function finalizeReserveSyncAttempt(
  db: D1Database,
  syncState: ReserveSyncStateRecord,
): Promise<{ finalized: boolean }> {
  const finalizeResult = await runWithOverloadRetry(() => buildReserveSyncFinalizeAttemptStatement(db, syncState).run());
  const finalized = (finalizeResult.meta.changes ?? 0) > 0;

  if (finalized) {
    await runWithOverloadRetry(() =>
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
      }).run(),
    );
  }

  return { finalized };
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
  const sql = `DELETE FROM ${table} WHERE ${column} < ? ${frozenClause} LIMIT ?`;
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
