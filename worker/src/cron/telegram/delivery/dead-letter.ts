import { batchExecute, buildInClause, chunkArray, D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "../../../lib/db";
import { PENDING_TTL_SEC, TELEGRAM_PENDING_PRIORITY } from "../../../telegram/common/constants";
import { logTelegramEvent } from "../../../telegram/common/log";
import type {
  DeadLetterPendingRow,
  PendingDeadLetterReason,
  PendingDeliveryClaim,
} from "./types";
import {
  prepareTelegramAlertJobCounterReconciliation,
  prepareTelegramJobTargetFinalDeliveryProjection,
  resolveTelegramJobTargetIdentityForPending,
} from "./telegram-alert-job-target-outcomes";

export const PENDING_DELETE_CHUNK_SIZE = D1_SAFE_IN_CLAUSE_BIND_LIMIT;

function pendingDeadLetterKey(row: Pick<DeadLetterPendingRow, "id" | "delivery_generation">): string {
  if (!Number.isSafeInteger(row.id) || row.id < 0) {
    throw new Error("Telegram pending dead-letter id is invalid");
  }
  const generation = Number.isSafeInteger(row.delivery_generation) && (row.delivery_generation ?? -1) >= 0
    ? row.delivery_generation
    : 0;
  const key = `pending:${row.id}:delivery:${generation}`;
  if (key.length > 200) throw new Error("Telegram pending dead-letter key exceeds schema limit");
  return key;
}


/**
 * Delete rows whose delivery claims the caller observed, fenced on owner and
 * generation. Rows are grouped to retain chunked `IN` deletes without
 * weakening the per-generation fence.
 */
export async function claimedDeleteByDeliveryClaims(
  db: D1Database,
  claims: readonly PendingDeliveryClaim[],
): Promise<number> {
  if (claims.length === 0) return 0;
  const claimsByOwner = new Map<string, Map<number, number[]>>();
  for (const claim of claims) {
    const claimsByGeneration = claimsByOwner.get(claim.owner) ?? new Map<number, number[]>();
    const ids = claimsByGeneration.get(claim.generation);
    if (ids) ids.push(claim.id);
    else claimsByGeneration.set(claim.generation, [claim.id]);
    claimsByOwner.set(claim.owner, claimsByGeneration);
  }
  let deleted = 0;
  for (const [owner, claimsByGeneration] of claimsByOwner) {
    for (const [generation, ids] of claimsByGeneration) {
      for (const idChunk of chunkArray(ids, PENDING_DELETE_CHUNK_SIZE)) {
        const inClause = buildInClause(idChunk);
        const result = await db
          .prepare(
            `DELETE FROM telegram_pending_alerts WHERE id IN (${inClause.sql}) AND delivery_state IN ('sending', 'sent') AND delivery_owner IS ? AND delivery_generation = ?`,
          )
          .bind(...inClause.binds, owner, generation)
          .run();
        deleted += Number(result.meta?.changes ?? 0);
      }
    }
  }
  return deleted;
}

function preparePendingDeadLetter(
  db: D1Database,
  row: DeadLetterPendingRow,
  nowSec: number,
  reason: PendingDeadLetterReason,
  guard?: { sql: string; binds: readonly unknown[] },
): D1PreparedStatement {
  return db.prepare(
        `INSERT INTO telegram_alert_dead_letters (
           dead_letter_key, pending_id, chat_id, message_html, source_type, alert_type, priority,
           created_at, expired_at, attempts, last_error_class, reason, dedupe_key, chunk_index,
           source_event_id, alert_scope_json, preference_generation, markup_policy_json,
           delivery_state, delivery_owner, delivery_generation, delivery_started_at,
           delivery_completed_at, delivery_claim_expires_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE ${guard?.sql ?? "1"}
         ON CONFLICT(dead_letter_key) WHERE dead_letter_key IS NOT NULL DO UPDATE SET
           dead_letter_key = excluded.dead_letter_key
         WHERE telegram_alert_dead_letters.pending_id IS excluded.pending_id
           AND telegram_alert_dead_letters.chat_id IS excluded.chat_id
           AND telegram_alert_dead_letters.message_html IS excluded.message_html
           AND telegram_alert_dead_letters.source_type IS excluded.source_type
           AND telegram_alert_dead_letters.alert_type IS excluded.alert_type
           AND telegram_alert_dead_letters.priority IS excluded.priority
           AND telegram_alert_dead_letters.created_at IS excluded.created_at
           AND telegram_alert_dead_letters.attempts IS excluded.attempts
           AND telegram_alert_dead_letters.last_error_class IS excluded.last_error_class
           AND telegram_alert_dead_letters.reason IS excluded.reason
           AND telegram_alert_dead_letters.dedupe_key IS excluded.dedupe_key
           AND telegram_alert_dead_letters.chunk_index IS excluded.chunk_index
           AND telegram_alert_dead_letters.source_event_id IS excluded.source_event_id
           AND telegram_alert_dead_letters.alert_scope_json IS excluded.alert_scope_json
           AND telegram_alert_dead_letters.preference_generation IS excluded.preference_generation
           AND telegram_alert_dead_letters.markup_policy_json IS excluded.markup_policy_json
           AND telegram_alert_dead_letters.delivery_state IS excluded.delivery_state
           AND telegram_alert_dead_letters.delivery_owner IS excluded.delivery_owner
           AND telegram_alert_dead_letters.delivery_generation IS excluded.delivery_generation
           AND telegram_alert_dead_letters.delivery_started_at IS excluded.delivery_started_at
           AND telegram_alert_dead_letters.delivery_completed_at IS excluded.delivery_completed_at
           AND telegram_alert_dead_letters.delivery_claim_expires_at IS excluded.delivery_claim_expires_at`,
      )
      .bind(
        pendingDeadLetterKey(row),
        row.id,
        row.chat_id,
        row.message_html,
        row.source_type ?? "legacy",
        row.alert_type ?? null,
        row.priority ?? TELEGRAM_PENDING_PRIORITY.legacy,
        row.created_at,
        nowSec,
        row.attempts ?? 0,
        row.last_error_class ?? null,
        reason,
        row.dedupe_key ?? null,
        row.chunk_index ?? 0,
        row.source_event_id ?? null,
        row.alert_scope_json ?? null,
        row.preference_generation ?? null,
        row.markup_policy_json ?? null,
        row.delivery_state ?? "pending",
        row.delivery_owner ?? null,
        row.delivery_generation ?? 0,
        row.delivery_started_at ?? null,
        row.delivery_completed_at ?? null,
        row.delivery_claim_expires_at ?? null,
        ...(guard?.binds ?? []),
      );
}

async function insertPendingDeadLetters(
  db: D1Database,
  rows: readonly DeadLetterPendingRow[],
  nowSec: number,
  reason: PendingDeadLetterReason,
): Promise<void> {
  const changed = await batchExecute(db, rows.map((row) => preparePendingDeadLetter(db, row, nowSec, reason)));
  if (changed !== rows.length) {
    throw new Error(`Telegram pending dead-letter identity conflict (${changed}/${rows.length})`);
  }
}

/** Every cleanup write repeats the selected lifecycle, not merely its reusable row id. */
export function pendingLifecycleGuard(
  row: DeadLetterPendingRow,
  nowSec: number,
  reason: PendingDeadLetterReason,
  processingOwner: string | null,
): { sql: string; binds: unknown[] } {
  return {
    sql: `EXISTS (
      SELECT 1 FROM telegram_pending_alerts current
       WHERE current.id = ?
         AND current.delivery_state = 'pending'
         AND current.created_at = ?
         AND current.source_event_id IS ?
         AND current.dedupe_key IS ?
         AND current.expires_at IS ?
         AND current.delivery_generation = ?
         AND current.processing_owner IS ?
         AND current.processing_started_at IS ?
         AND current.processing_expires_at IS ?
         AND (? IS NOT NULL AND current.processing_owner = ?
              OR current.processing_owner IS NULL
              OR current.processing_expires_at IS NULL
              OR current.processing_expires_at <= ?)
         ${reason === "ttl_expired" ? "AND COALESCE(current.expires_at, current.created_at + ?) <= ?" : ""}
    )`,
    binds: [
      row.id, row.created_at, row.source_event_id ?? null, row.dedupe_key ?? null,
      row.expires_at ?? null, row.delivery_generation ?? 0,
      row.processing_owner ?? null, row.processing_started_at ?? null, row.processing_expires_at ?? null,
      processingOwner, processingOwner, nowSec,
      ...(reason === "ttl_expired" ? [PENDING_TTL_SEC, nowSec] : []),
    ],
  };
}

/**
 * Archive and settle only a still-current, unstarted lifecycle. The audit copy
 * is guarded too; all terminal projections and deletion then share one atomic
 * checkpoint with the identical guard. Expiry alone may bypass failed audit.
 */
export async function settleUnstartedPendingRows(
  db: D1Database,
  rows: readonly DeadLetterPendingRow[],
  nowSec: number,
  reason: PendingDeadLetterReason,
  processingOwner: string | null = null,
): Promise<number> {
  let deleted = 0;
  for (const row of rows) {
    const guard = pendingLifecycleGuard(row, nowSec, reason, processingOwner);
    try {
      const audit = await preparePendingDeadLetter(db, row, nowSec, reason, guard).run();
      if (Number(audit.meta?.changes ?? 0) !== 1) {
        // A stale selection is a no-op. A real audit-key conflict on a later
        // refreshed lifecycle is diagnostic failure, not permission to keep
        // expired work alive indefinitely.
        const current = reason === "ttl_expired"
          ? await db.prepare(`SELECT 1 AS present WHERE ${guard.sql}`).bind(...guard.binds).first()
          : null;
        if (!current) continue;
        throw new Error("Telegram pending dead-letter identity conflict");
      }
    } catch {
      if (reason !== "ttl_expired") {
        logTelegramEvent({
          level: "warn",
          message: "Failed to dead-letter terminal pending alerts",
          action: "dead-letter-terminal-pending",
          module: "telegram-pending-dead-letter",
          reason,
          rowCount: 1,
        });
        continue;
      }
      logTelegramEvent({
        level: "error",
        message: "expired pending Telegram alert removed without dead-letter copy after dead-letter write failure",
        action: "cleanup-expired-pending-dead-letter-bypass",
        module: "telegram-pending-cleanup",
        reason,
        rowCount: 1,
        affectedChatCount: 1,
        dedupeKeyCount: row.dedupe_key ? 1 : 0,
      });
    }
    const state = reason === "ttl_expired" ? "expired"
      : reason === "preference_changed" ? "cancelled" : "failed";
    const error = reason === "preference_changed" ? row.last_error_class ?? reason : reason;
    const statements: D1PreparedStatement[] = [];
    if (row.dedupe_key && row.source_event_id) {
      const identity = await resolveTelegramJobTargetIdentityForPending(db, {
        pendingDedupeKey: row.dedupe_key,
        sourceEventId: row.source_event_id,
      });
      if (identity) {
        statements.push(prepareTelegramJobTargetFinalDeliveryProjection(
          db, identity, { state, at: nowSec, error }, { pendingGuard: guard },
        ));
        statements.push(prepareTelegramAlertJobCounterReconciliation(db, identity.jobId, nowSec, {
          targetKey: identity.targetKey,
          finalDeliveryState: state,
          pendingGuard: guard,
        }));
      }
    }
    statements.push(db.prepare(
      `DELETE FROM telegram_pending_alerts WHERE id = ? AND (${guard.sql})`,
    ).bind(row.id, ...guard.binds));
    const results = await db.batch(statements);
    deleted += Number(results[results.length - 1]?.meta?.changes ?? 0);
  }
  return deleted;
}

export async function deadLetterTerminalPendingRows(
  db: D1Database,
  rows: readonly DeadLetterPendingRow[],
  nowSec: number,
  reason: PendingDeadLetterReason,
): Promise<boolean> {
  if (rows.length === 0) return true;
  try {
    await insertPendingDeadLetters(db, rows, nowSec, reason);
    return true;
  } catch {
    logTelegramEvent({
      level: "warn",
      message: "Failed to dead-letter terminal pending alerts",
      action: "dead-letter-terminal-pending",
      module: "telegram-pending-dead-letter",
      reason,
      rowCount: rows.length,
    });
    return false;
  }
}
