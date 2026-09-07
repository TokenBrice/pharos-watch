import { batchExecute, buildInClause, chunkArray, D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "../../lib/db";
import { TELEGRAM_PENDING_PRIORITY } from "../../lib/telegram/constants";
import { logTelegramEvent } from "../../lib/telegram/log";
import type { DeadLetterPendingRow, PendingDeadLetterReason } from "./types";

export const PENDING_DELETE_CHUNK_SIZE = D1_SAFE_IN_CLAUSE_BIND_LIMIT;

export function pendingDeadLetterKey(row: Pick<DeadLetterPendingRow, "id" | "delivery_generation">): string {
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

export async function deletePendingAlertsByIds(db: D1Database, ids: readonly number[]): Promise<number> {
  if (ids.length === 0) return 0;
  let deleted = 0;
  for (const idChunk of chunkArray(ids, PENDING_DELETE_CHUNK_SIZE)) {
    const inClause = buildInClause(idChunk);
    const result = await db
      .prepare(`DELETE FROM telegram_pending_alerts WHERE id IN (${inClause.sql})`)
      .bind(...inClause.binds)
      .run();
    deleted += Number(result.meta?.changes ?? 0);
  }
  return deleted;
}

async function insertPendingDeadLetters(
  db: D1Database,
  rows: readonly DeadLetterPendingRow[],
  nowSec: number,
  reason: PendingDeadLetterReason,
): Promise<void> {
  if (rows.length === 0) return;
  const changed = await batchExecute(db, rows.map((row) =>
    db
      .prepare(
        `INSERT INTO telegram_alert_dead_letters (
           dead_letter_key, pending_id, chat_id, message_html, source_type, alert_type, priority,
           created_at, expired_at, attempts, last_error_class, reason, dedupe_key, chunk_index,
           source_event_id, alert_scope_json, preference_generation, markup_policy_json,
           delivery_state, delivery_owner, delivery_generation, delivery_started_at,
           delivery_completed_at, delivery_claim_expires_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      ),
  ));
  if (changed !== rows.length) {
    throw new Error(`Telegram pending dead-letter identity conflict (${changed}/${rows.length})`);
  }
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
