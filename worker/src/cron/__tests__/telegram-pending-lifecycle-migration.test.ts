import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, URL as NodeUrl } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = fileURLToPath(
  new NodeUrl("../../../migrations/0189_telegram_pending_lifecycle_safety.sql", import.meta.url),
);

function setupPreMigrationSchema(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE telegram_pending_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      message_html TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivery_state TEXT NOT NULL DEFAULT 'pending',
      delivery_started_at INTEGER,
      delivery_completed_at INTEGER,
      processing_expires_at INTEGER
    );
    CREATE TABLE telegram_alert_dead_letters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pending_id INTEGER,
      chat_id TEXT NOT NULL,
      message_html TEXT NOT NULL,
      source_type TEXT,
      alert_type TEXT,
      priority INTEGER,
      created_at INTEGER NOT NULL,
      expired_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error_class TEXT,
      reason TEXT NOT NULL,
      dedupe_key TEXT,
      chunk_index INTEGER,
      source_event_id TEXT,
      alert_scope_json TEXT,
      preference_generation INTEGER,
      markup_policy_json TEXT
    );
  `);
  return sqlite;
}

function insertLegacyDeadLetter(sqlite: DatabaseSync, pendingId: number, chatId: string): void {
  sqlite.prepare(
    `INSERT INTO telegram_alert_dead_letters (
       pending_id, chat_id, message_html, created_at, expired_at, reason
     ) VALUES (?, ?, '<b>legacy</b>', 100, 200, 'ttl_expired')`,
  ).run(pendingId, chatId);
}

describe("Telegram pending lifecycle migration", () => {
  it("preserves historical duplicates and remains writable by the rolling old Worker", () => {
    const sqlite = setupPreMigrationSchema();
    insertLegacyDeadLetter(sqlite, 42, "first");
    insertLegacyDeadLetter(sqlite, 42, "duplicate");

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed checked-in migration path.
    sqlite.exec(readFileSync(MIGRATION_PATH, "utf8"));

    expect(sqlite.prepare(
      "SELECT dead_letter_key FROM telegram_alert_dead_letters ORDER BY id ASC",
    ).all()).toEqual([
      { dead_letter_key: "pending:42:delivery:0" },
      { dead_letter_key: "legacy-duplicate:2" },
    ]);

    insertLegacyDeadLetter(sqlite, 43, "rolling-old-worker");
    sqlite.prepare(
      `INSERT INTO telegram_pending_alerts (chat_id, message_html, created_at)
       VALUES ('rolling', '<b>pending</b>', 300)`,
    ).run();
    expect(sqlite.prepare(
      `SELECT delivery_state, delivery_owner, delivery_generation, delivery_claim_expires_at
         FROM telegram_pending_alerts WHERE chat_id = 'rolling'`,
    ).get()).toEqual({
      delivery_state: "pending",
      delivery_owner: null,
      delivery_generation: 0,
      delivery_claim_expires_at: null,
    });
    expect(sqlite.prepare(
      "SELECT dead_letter_key FROM telegram_alert_dead_letters WHERE pending_id = 43",
    ).get()).toEqual({ dead_letter_key: "pending:43:delivery:0" });
    expect(() => sqlite.prepare(
      `INSERT INTO telegram_alert_dead_letters (
         dead_letter_key, pending_id, chat_id, message_html, created_at, expired_at, reason
       ) VALUES ('pending:43:delivery:0', 43, 'new-worker', '<b>new</b>', 300, 400, 'manual_clear')`,
    ).run()).toThrow(/UNIQUE/);
    sqlite.close();
  });

  it("enforces bounded lifecycle values and canonical key uniqueness", () => {
    const sqlite = setupPreMigrationSchema();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed checked-in migration path.
    sqlite.exec(readFileSync(MIGRATION_PATH, "utf8"));

    expect(() => sqlite.prepare(
      `INSERT INTO telegram_pending_alerts (
         chat_id, message_html, created_at, delivery_owner, delivery_generation
       ) VALUES ('bad', '<b>bad</b>', 1, ?, -1)`,
    ).run("x".repeat(201))).toThrow();
    sqlite.prepare(
      `INSERT INTO telegram_alert_dead_letters (
         dead_letter_key, pending_id, chat_id, message_html, created_at, expired_at,
         reason, delivery_state, delivery_generation
       ) VALUES ('pending:1:delivery:0', 1, 'one', 'one', 1, 2, 'ttl_expired', 'pending', 0)`,
    ).run();
    expect(() => sqlite.prepare(
      `INSERT INTO telegram_alert_dead_letters (
         dead_letter_key, pending_id, chat_id, message_html, created_at, expired_at,
         reason, delivery_state, delivery_generation
       ) VALUES ('pending:1:delivery:0', 1, 'two', 'two', 1, 2, 'manual_clear', 'pending', 0)`,
    ).run()).toThrow(/UNIQUE/);
    expect(() => sqlite.prepare(
      `INSERT INTO telegram_alert_dead_letters (
         dead_letter_key, pending_id, chat_id, message_html, created_at, expired_at,
         reason, delivery_state, delivery_generation
       ) VALUES (?, 2, 'bad', 'bad', 1, 2, 'ttl_expired', 'retryable', 0)`,
    ).run("x".repeat(201))).toThrow();
    sqlite.close();
  });
});
