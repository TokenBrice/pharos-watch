/**
 * Builders for `telegram_pending_alerts` D1 row shapes used by cron tests.
 *
 * Two complementary helpers cover the two consumption patterns:
 *
 * 1. `buildPendingAlertRow()` — plain-object row builder for `mockD1` matches.
 *    Mirrors the inline literals scattered across
 *    `dispatch-telegram-alerts.test.ts` (e.g. the `SELECT p.id, p.chat_id, ...`
 *    rows returned by the pending-queue drain phase).
 *
 * 2. `insertPendingSqliteRow()` — wrapper around `node:sqlite` INSERT used in
 *    `telegram-pending-queue.test.ts`, where a real in-memory SQLite database
 *    backs the mock D1. Mirrors the inline `insertPendingSqlite()` helper.
 *
 * Both flavors share the same overrides shape so a test can swap between
 * mockD1 rows and real-SQLite inserts without re-learning the column names.
 */

import type { DatabaseSync } from "node:sqlite";
import { TELEGRAM_PENDING_PRIORITY } from "../../lib/telegram-constants";

export interface PendingAlertRowOverrides {
  id?: number;
  chatId?: string;
  html?: string;
  disableNotification?: number;
  createdAt?: number;
  attempts?: number;
  notBeforeAt?: number | null;
  dedupeKey?: string | null;
  chunkIndex?: number | null;
  priority?: number | null;
  sourceType?: string | null;
  alertType?: string | null;
  expiresAt?: number | null;
}

/**
 * Build a plain `telegram_pending_alerts` row for use with `mockD1` rows.
 * Column names are snake_case to match the D1 schema as returned by `.all<T>()`.
 */
export function buildPendingAlertRow(
  overrides: PendingAlertRowOverrides = {},
): {
  id: number;
  chat_id: string;
  message_html: string;
  disable_notification: number;
  created_at: number;
  attempts: number;
  not_before_at: number | null;
  dedupe_key: string | null;
  chunk_index: number | null;
  priority: number | null;
  source_type: string | null;
  alert_type: string | null;
  expires_at: number | null;
} {
  const createdAt = overrides.createdAt ?? Math.floor(Date.now() / 1000);
  return {
    id: overrides.id ?? 1,
    chat_id: overrides.chatId ?? "chat-1",
    message_html: overrides.html ?? "<b>Pending alert</b>",
    disable_notification: overrides.disableNotification ?? 0,
    created_at: createdAt,
    attempts: overrides.attempts ?? 0,
    not_before_at: overrides.notBeforeAt ?? null,
    dedupe_key: overrides.dedupeKey ?? null,
    chunk_index: overrides.chunkIndex ?? 0,
    priority: overrides.priority ?? TELEGRAM_PENDING_PRIORITY.legacy,
    source_type: overrides.sourceType ?? "legacy",
    alert_type: overrides.alertType ?? null,
    expires_at: overrides.expiresAt ?? null,
  };
}

/**
 * Insert a `telegram_pending_alerts` row directly into a `node:sqlite`
 * database used to back a sqlite-d1 mock. Mirrors `insertPendingSqlite()`
 * defined inline in `worker/src/cron/__tests__/telegram-pending-queue.test.ts`.
 */
export function insertPendingSqliteRow(
  sqlite: DatabaseSync,
  overrides: PendingAlertRowOverrides & { id: number; chatId: string; html: string; createdAt: number },
): void {
  sqlite
    .prepare(
      `INSERT INTO telegram_pending_alerts (
         id, chat_id, message_html, disable_notification, created_at, attempts,
         not_before_at, dedupe_key, chunk_index, priority, source_type, alert_type, expires_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides.id,
      overrides.chatId,
      overrides.html,
      overrides.disableNotification ?? 0,
      overrides.createdAt,
      overrides.attempts ?? 0,
      overrides.notBeforeAt ?? null,
      overrides.dedupeKey ?? null,
      overrides.chunkIndex ?? 0,
      overrides.priority ?? TELEGRAM_PENDING_PRIORITY.legacy,
      overrides.sourceType ?? "legacy",
      overrides.alertType ?? null,
      overrides.expiresAt ?? null,
    );
}
