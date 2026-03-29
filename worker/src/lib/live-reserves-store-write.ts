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

export async function finalizeReserveSyncSuccess(
  db: D1Database,
  composition: ReserveCompositionRecord,
  syncState: ReserveSyncStateRecord,
  finalizeDeadlineMs: number,
): Promise<{ finalized: boolean }> {
  await buildReserveCompositionUpsertStatement(db, composition).run();
  await buildReserveCompositionHistoryInsertStatement(db, composition).run();
  const finalizeResult = await buildReserveSyncFinalizeSuccessStatement(db, syncState, finalizeDeadlineMs).run();
  const finalized = (finalizeResult.meta.changes ?? 0) > 0;

  if (finalized) {
    await buildReserveSyncAttemptHistoryInsertStatement(db, {
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
    }).run();
  }

  return { finalized };
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

export async function pruneLiveReserveHistory(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
  retentionSec = LIVE_RESERVE_HISTORY_RETENTION_SEC,
): Promise<LiveReserveHistoryPruneResult> {
  const cutoff = now - retentionSec;
  const compositionDelete = await db
    .prepare("DELETE FROM reserve_composition_history WHERE fetched_at < ?")
    .bind(cutoff)
    .run();
  const attemptDelete = await db
    .prepare("DELETE FROM reserve_sync_attempt_history WHERE attempted_at < ?")
    .bind(cutoff)
    .run();

  return {
    cutoff,
    compositionHistoryDeleted: compositionDelete.meta.changes ?? 0,
    attemptHistoryDeleted: attemptDelete.meta.changes ?? 0,
  };
}
