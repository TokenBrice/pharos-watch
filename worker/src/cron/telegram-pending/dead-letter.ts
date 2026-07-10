import { batchExecute, buildInClause, chunkArray, D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "../../lib/db";
import { TELEGRAM_PENDING_PRIORITY } from "../../lib/telegram-constants";
import { logTelegramEvent } from "../../lib/telegram-log";
import type { DeadLetterPendingRow, PendingDeadLetterReason } from "./types";

export const PENDING_DELETE_CHUNK_SIZE = D1_SAFE_IN_CLAUSE_BIND_LIMIT;

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
  await batchExecute(db, rows.map((row) =>
    db
      .prepare(
        `INSERT INTO telegram_alert_dead_letters (
           pending_id, chat_id, message_html, source_type, alert_type, priority,
           created_at, expired_at, attempts, last_error_class, reason, dedupe_key, chunk_index,
           source_event_id, alert_scope_json, preference_generation, markup_policy_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
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
      ),
  ));
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
  } catch (error) {
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
