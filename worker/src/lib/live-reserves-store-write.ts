import {
  LIVE_RESERVE_HISTORY_RETENTION_SEC,
  type LiveReserveHistoryPruneResult,
  type ReserveCompositionRecord,
  type ReserveSyncAttemptStartRecord,
  type ReserveSyncStateRecord,
} from "./live-reserves-store-shared";
import {
  buildReserveCompositionHistoryInsertStatement,
  buildReserveCompositionUpsertStatement,
  buildReserveSyncAttemptHistoryInsertStatement,
  buildReserveSyncAttemptStartStatement,
  buildReserveSyncFinalizeAttemptStatement,
  buildReserveSyncFinalizeSuccessStatement,
  buildReserveSyncRecordDeferredStatement,
  type ReserveSyncDeferredRecord,
} from "./live-reserves-store-statements";

export async function upsertReserveComposition(
  db: D1Database,
  record: ReserveCompositionRecord,
): Promise<void> {
  await buildReserveCompositionUpsertStatement(db, record).run();
}

export async function beginReserveSyncAttempt(
  db: D1Database,
  record: ReserveSyncAttemptStartRecord,
): Promise<void> {
  await buildReserveSyncAttemptStartStatement(db, record).run();
}

export async function recordReserveSyncDeferred(
  db: D1Database,
  record: ReserveSyncDeferredRecord,
): Promise<void> {
  await buildReserveSyncRecordDeferredStatement(db, record).run();
}

export async function finalizeReserveSyncSuccess(
  db: D1Database,
  composition: ReserveCompositionRecord,
  syncState: ReserveSyncStateRecord,
  finalizeDeadlineMs: number,
): Promise<{ finalized: boolean }> {
  const [compositionRes, finalizeRes] = await db.batch<unknown>([
    buildReserveCompositionUpsertStatement(db, composition),
    buildReserveSyncFinalizeSuccessStatement(db, syncState, finalizeDeadlineMs),
  ]);
  const compositionApplied = ((compositionRes as D1Result).meta.changes ?? 0) > 0;
  const finalized = ((finalizeRes as D1Result).meta.changes ?? 0) > 0;

  if (!finalized || !compositionApplied) {
    return { finalized: false };
  }

  await db.batch([
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
  ]);

  return { finalized: true };
}

export async function finalizeReserveSyncAttempt(
  db: D1Database,
  syncState: ReserveSyncStateRecord,
): Promise<{ finalized: boolean }> {
  const finalizeResult = await buildReserveSyncFinalizeAttemptStatement(db, syncState).run();
  const finalized = (finalizeResult.meta.changes ?? 0) > 0;

  if (finalized) {
    await buildReserveSyncAttemptHistoryInsertStatement(db, {
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
    }).run();
  }

  return { finalized };
}

const DEFAULT_PRUNE_BATCH_SIZE = 5000;

async function deleteHistoryInBatches(
  db: D1Database,
  table: "reserve_composition_history" | "reserve_sync_attempt_history",
  column: "fetched_at" | "attempted_at",
  cutoff: number,
  batchSize: number,
): Promise<number> {
  const sql = `DELETE FROM ${table} WHERE ${column} < ? LIMIT ?`;
  let totalDeleted = 0;
  // Loop until a batch deletes fewer rows than the budget, which implies the
  // table is drained. Keeps each DELETE inside D1's 30s per-statement limit.
  for (;;) {
    const result = await db.prepare(sql).bind(cutoff, batchSize).run();
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
