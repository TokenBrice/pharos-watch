import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mockTelegramD1 as mockD1 } from "../../../test-helpers/__shared/telegram";
import { createLatestSchemaSqlite } from "../../../test-helpers/latest-schema-sqlite";
import { forgetSubscriber, migrateTelegramChatId, unsubscribeAll } from "../../../lib/telegram/subscriber-lifecycle";

function setupChatMigrationSqlite(): { sqlite: DatabaseSync; db: D1Database } {
  return createLatestSchemaSqlite();
}

function discoverTelegramChatIdTablesFromMigrations(): string[] {
  const migrationDir = join(process.cwd(), "worker/migrations");
  const tables = new Set<string>();
  for (const file of readdirSync(migrationDir)) {
    if (!file.endsWith(".sql")) continue;
    const sql = readFileSync(join(migrationDir, file), "utf8");
    const createTablePattern = /CREATE TABLE IF NOT EXISTS\s+(telegram_[a-z0-9_]+)\s*\(([\s\S]*?)\);/giu;
    for (const match of sql.matchAll(createTablePattern)) {
      const table = match[1];
      const body = match[2] ?? "";
      if (table && /\bchat_id\b/iu.test(body)) tables.add(table);
    }
  }
  return [...tables].sort();
}

function collectTelegramTablesFromSql(history: Array<{ sql: string }>): Set<string> {
  const tables = new Set<string>();
  for (const entry of history) {
    for (const match of entry.sql.matchAll(/\btelegram_[a-z0-9_]+\b/giu)) {
      tables.add(match[0]);
    }
  }
  return tables;
}

const CHAT_ROW_MERGE_TABLES = [
  "telegram_subscribers",
  "telegram_subscriptions",
  "telegram_preset_subscriptions",
  "telegram_pending_disambiguation",
  "telegram_chat_delivery_diagnostics",
] as const;

interface SqliteColumnInfo {
  cid: number;
  name: string;
  type: string;
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Insert one row from a named column map. Seeds in this suite carry 22 columns
 * whose meaning is not recoverable from a positional argument list — naming them
 * at the call site is what makes a wrong `alert_safety` visible in review.
 */
function insertRow(sqlite: DatabaseSync, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  sqlite
    .prepare(
      `INSERT INTO ${quoteSqlIdentifier(table)} (${columns.map(quoteSqlIdentifier).join(", ")}) `
      + `VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...(Object.values(row) as never[]));
}

function schemaSentinelValue(table: string, column: SqliteColumnInfo, oldChatId: string): unknown {
  if (column.name === "chat_id") return oldChatId;
  if (column.name === "stablecoin_id") return "schema-parity-coin";
  if (column.name === "preset_id") return "schema-parity-preset";

  const type = column.type.toUpperCase();
  if (type.includes("INT")) return 1_000 + column.cid;
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) {
    return 1_000.5 + column.cid;
  }
  if (type.includes("BLOB")) return new Uint8Array([column.cid % 256, 0x7f]);
  return `${table}:${column.name}:schema-parity`;
}

function insertSchemaSentinelRow(
  sqlite: DatabaseSync,
  table: (typeof CHAT_ROW_MERGE_TABLES)[number],
  oldChatId: string,
): Record<string, unknown> {
  const columns = sqlite
    .prepare("SELECT cid, name, type FROM pragma_table_info(?) ORDER BY cid")
    .all(table) as unknown as SqliteColumnInfo[];
  const values = columns.map((column) => schemaSentinelValue(table, column, oldChatId));
  const columnSql = columns.map((column) => quoteSqlIdentifier(column.name)).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  sqlite
    .prepare(`INSERT INTO ${quoteSqlIdentifier(table)} (${columnSql}) VALUES (${placeholders})`)
    .run(...(values as never[]));
  return Object.fromEntries(columns.map((column, index) => [column.name, values[index]]));
}

describe("unsubscribeAll", () => {
  it("clears alert_snooze_until_ts so a re-subscribe is not silently muted", async () => {
    const db = mockD1([]);
    await unsubscribeAll(db, "42");
    const update = db
      .getHistory()
      .find((entry) => /UPDATE telegram_subscribers/.test(entry.sql));
    expect(update).toBeDefined();
    expect(update!.sql).toContain("alert_snooze_until_ts = NULL");
  });

  it("clears reserve flags with the other per-chat and global alert flags", async () => {
    const db = mockD1([]);
    await unsubscribeAll(db, "42");
    const update = db
      .getHistory()
      .find((entry) => /UPDATE telegram_subscribers/.test(entry.sql));
    expect(update).toBeDefined();
    expect(update!.sql).toContain("alert_reserve = 0");
    expect(update!.sql).toContain("global_alert_reserve = 0");
  });
});

describe("forgetSubscriber", () => {
  it("covers every chat-owned Telegram table except retained processed updates", async () => {
    const chatTables = discoverTelegramChatIdTablesFromMigrations();
    const retainedOnForget = new Set(["telegram_processed_updates"]);
    const db = mockD1();

    await forgetSubscriber(db, "42");

    const deletedTables = new Set(
      db.getHistory()
        .map((entry) => entry.sql.match(/DELETE FROM\s+(telegram_[a-z0-9_]+)\s+WHERE chat_id = \?/iu)?.[1])
        .filter((table): table is string => typeof table === "string"),
    );
    expect([...deletedTables].sort()).toEqual(chatTables.filter((table) => !retainedOnForget.has(table)));
  });

  it("rolls back lifecycle deletes when an appended operation statement fails", async () => {
    const { sqlite, db } = setupChatMigrationSqlite();
    const chatId = "atomic-forget";
    sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES (?, ?, ?)")
      .run(chatId, 100, 100);

    const failingOperation = db.prepare("INSERT INTO telegram_operation_batch_failure DEFAULT VALUES");
    await expect(forgetSubscriber(db, chatId, { operationStatements: [failingOperation] })).rejects.toThrow();

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscribers WHERE chat_id = ?").get(chatId))
      .toEqual({ count: 1 });
  });

  it("clears chat-owned cache residue while preserving neighboring chat keys", async () => {
    const { sqlite, db } = setupChatMigrationSqlite();
    const chatId = "42";
    sqlite.prepare(`
      INSERT INTO telegram_subscribers (
        chat_id, username, created_at, last_active_at
      )
      VALUES (?, ?, ?, ?)
    `).run(chatId, "alice", 100, 200);
    sqlite.prepare(`
      INSERT INTO telegram_alert_job_targets (
        job_id, target_key, chat_id, alert_type, pending_dedupe_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run("job-1", "target-1", chatId, "depeg", "pending-1", 100);
    sqlite.prepare(`
      INSERT INTO telegram_alert_dead_letters (
        chat_id, message_html, created_at, expired_at, reason
      ) VALUES (?, ?, ?, ?, ?)
    `).run(chatId, "expired", 100, 200, "ttl_expired");
    const deletedCacheKeys = [
      `telegram:command-flood:${chatId}`,
      `telegram:command-flood:${chatId}:actor:99`,
      `telegram:command-cooldown:${chatId}:/status`,
      `telegram:chat-member:${chatId}:99`,
      `telegram:chat-admins:${chatId}`,
      `telegram:group-welcome:${chatId}`,
      `telegram:re-engagement-warned:${chatId}`,
    ];
    const neighboringCacheKeys = [
      "telegram:command-flood:420",
      "telegram:command-flood:420:actor:99",
      "telegram:command-cooldown:420:/status",
      "telegram:chat-member:420:99",
      "telegram:re-engagement-warned:420",
    ];
    const cacheRows = [...deletedCacheKeys, ...neighboringCacheKeys];
    for (const key of cacheRows) {
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(key, "1", 123);
    }
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      "telegram:burst-markers",
      JSON.stringify({
        [chatId]: { enteredAt: 1_700_000_000, coinIds: ["usdc-circle", "dai-makerdao"] },
        "420": { enteredAt: 1_700_000_000, coinIds: ["eurc-circle"] },
      }),
      123,
    );

    await forgetSubscriber(db, chatId);

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscribers WHERE chat_id = ?").get(chatId))
      .toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_targets WHERE chat_id = ?").get(chatId))
      .toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_dead_letters WHERE chat_id = ?").get(chatId))
      .toEqual({ count: 0 });
    for (const key of deletedCacheKeys) {
      expect(sqlite.prepare("SELECT key FROM cache WHERE key = ?").get(key)).toBeUndefined();
    }
    const burstMarkers = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get("telegram:burst-markers") as {
      value: string;
    };
    expect(JSON.parse(burstMarkers.value)).toEqual({
      "420": { enteredAt: 1_700_000_000, coinIds: ["eurc-circle"] },
    });
    expect(sqlite.prepare("SELECT key FROM cache WHERE key != ? ORDER BY key").all("telegram:burst-markers"))
      .toEqual([...neighboringCacheKeys].sort().map((key) => ({ key })));
  });

  it("deletes chat-prefixed job-target item lineage while preserving other chats", async () => {
    const { sqlite, db } = setupChatMigrationSqlite();
    const chatId = "42";
    const insertItem = sqlite.prepare(`
      INSERT INTO telegram_alert_job_target_items (
        job_id, target_key, source_event_id, item_key, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    // target_key is chat-prefixed: `<chatId>:v<split>:<chunk>:<hash>`.
    insertItem.run("job-1", `${chatId}:v3:0:abc`, "evt-1", "item-1", 100);
    insertItem.run("job-1", `${chatId}:v3:1:def`, "evt-1", "item-2", 100);
    // Neighbor whose chat id shares the forgotten chat's digits as a prefix.
    insertItem.run("job-1", "420:v3:0:ghi", "evt-1", "item-3", 100);

    await forgetSubscriber(db, chatId);

    const remaining = sqlite
      .prepare("SELECT target_key FROM telegram_alert_job_target_items ORDER BY target_key")
      .all();
    expect(remaining).toEqual([{ target_key: "420:v3:0:ghi" }]);
  });

  it("removes recap preferences, targets, and pending payloads on forget", async () => {
    const { sqlite, db } = setupChatMigrationSqlite();
    const chatId = "recap-forget";
    const now = 1_700_000_000;
    sqlite.prepare("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES (?, ?, ?)")
      .run(chatId, now, now);
    sqlite.prepare(`
      INSERT INTO telegram_recap_preferences
        (chat_id, enabled, delivery_hour_local, next_due_at, created_at, updated_at)
      VALUES (?, 1, 9, ?, ?, ?)
    `).run(chatId, now + 3600, now, now);
    sqlite.prepare(`
      INSERT INTO telegram_recap_targets
        (recap_key, chat_id, local_date, window_start_at, window_end_at,
         preference_generation, watchlist_fingerprint, status, created_at, updated_at)
      VALUES (?, ?, '2026-07-11', ?, ?, 0, 'fingerprint', 'queued', ?, ?)
    `).run(`recap:${chatId}:2026-07-11:v1`, chatId, now - 3600, now, now, now);
    sqlite.prepare(`
      INSERT INTO telegram_pending_alerts
        (chat_id, message_html, created_at, updated_at, dedupe_key, source_type, source_event_id)
      VALUES (?, 'recap', ?, ?, ?, 'personalized_recap', ?)
    `).run(chatId, now, now, `recap:${chatId}:2026-07-11:v1`, `recap:${chatId}:2026-07-11:v1`);

    await forgetSubscriber(db, chatId);

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_recap_preferences WHERE chat_id = ?").get(chatId))
      .toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_recap_targets WHERE chat_id = ?").get(chatId))
      .toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts WHERE chat_id = ?").get(chatId))
      .toEqual({ count: 0 });
  });

  it("deletes exact and actor-scoped command-flood keys", async () => {
    const chatId = "42";
    const db = mockD1();

    await forgetSubscriber(db, chatId);

    const cacheDeletes = db.getHistory().filter((entry) => entry.sql.includes("DELETE FROM cache"));
    expect(
      cacheDeletes.some(
        (entry) =>
          entry.sql.includes("WHERE key = ?") && entry.binds[0] === `telegram:command-flood:${chatId}`,
      ),
    ).toBe(true);
    expect(
      cacheDeletes.some(
        (entry) =>
          entry.sql.includes("WHERE key LIKE ?") && entry.binds[0] === `telegram:command-flood:${chatId}:%`,
      ),
    ).toBe(true);
    expect(
      cacheDeletes.some(
        (entry) =>
          entry.sql.includes("WHERE key LIKE ?") && entry.binds[0] === `telegram:command-cooldown:${chatId}:%`,
      ),
    ).toBe(true);
  });

  it("deletes the shared burst marker cache row when forgetting the only marked chat", async () => {
    const { sqlite, db } = setupChatMigrationSqlite();
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      "telegram:burst-markers",
      JSON.stringify({
        "42": { enteredAt: 1_700_000_000, coinIds: ["usdc-circle"] },
      }),
      123,
    );

    await forgetSubscriber(db, "42");

    expect(sqlite.prepare("SELECT key FROM cache WHERE key = ?").get("telegram:burst-markers"))
      .toBeUndefined();
  });
});

describe("migrateTelegramChatId", () => {
  it("touches every chat-owned Telegram table discovered in migrations", async () => {
    const chatTables = discoverTelegramChatIdTablesFromMigrations();
    const db = mockD1();

    await migrateTelegramChatId(db, "-123", "-100123");

    const touchedTables = collectTelegramTablesFromSql(db.getHistory());
    expect(chatTables.filter((table) => !touchedTables.has(table))).toEqual([]);
  });

  it("round-trips every current column in merge-owned chat tables from the latest schema", async () => {
    const { sqlite, db } = setupChatMigrationSqlite();
    const oldChatId = "-123";
    const newChatId = "-100123";
    sqlite.exec("PRAGMA ignore_check_constraints = ON");

    const expectedRows = new Map(
      CHAT_ROW_MERGE_TABLES.map((table) => {
        const sentinel = insertSchemaSentinelRow(sqlite, table, oldChatId);
        return [
          table,
          {
            ...sentinel,
            chat_id: newChatId,
            ...(table === "telegram_subscribers"
              ? { preference_generation: Number(sentinel.preference_generation) + 1 }
              : {}),
          },
        ];
      }),
    );

    await migrateTelegramChatId(db, oldChatId, newChatId);

    for (const table of CHAT_ROW_MERGE_TABLES) {
      const actual = sqlite
        .prepare(`SELECT * FROM ${quoteSqlIdentifier(table)} WHERE chat_id = ?`)
        .get(newChatId);
      expect(actual, `${table} migration columns drifted from the latest D1 schema`).toEqual(
        expectedRows.get(table),
      );
    }
  });

  it("merges conflicting group rows in SQLite and is idempotent", async () => {
    const { sqlite, db } = setupChatMigrationSqlite();
    const oldChatId = "-123";
    const newChatId = "-100123";

    insertRow(sqlite, "telegram_subscribers", {
      chat_id: oldChatId,
      username: "legacy-group",
      alert_dews: 1, alert_depeg: 0, alert_safety: 1, alert_launch: 0, alert_reserve: 1,
      global_alert_dews: 1, global_alert_depeg: 0, global_alert_safety: 1,
      global_alert_launch: 0, global_alert_reserve: 1,
      quiet_hours_enabled: 1, quiet_hours_start_utc: 22, quiet_hours_end_utc: 6,
      global_depeg_worsening_bps_step: 75,
      timezone: "Europe/Belgrade",
      alert_snooze_until_ts: 1_700_000_900,
      consecutive_block_count: 1,
      consecutive_block_first_at: 1_700_000_100,
      created_at: 100,
      last_active_at: 300,
    });
    insertRow(sqlite, "telegram_subscribers", {
      chat_id: newChatId,
      username: null,
      alert_dews: 0, alert_depeg: 1, alert_safety: 0, alert_launch: 1, alert_reserve: 0,
      global_alert_dews: 0, global_alert_depeg: 1, global_alert_safety: 0,
      global_alert_launch: 1, global_alert_reserve: 0,
      quiet_hours_enabled: 0, quiet_hours_start_utc: 8, quiet_hours_end_utc: 20,
      global_depeg_worsening_bps_step: null,
      timezone: null,
      alert_snooze_until_ts: null,
      consecutive_block_count: 3,
      consecutive_block_first_at: null,
      created_at: 200,
      last_active_at: 250,
    });

    const insertSubscription = (row: Record<string, unknown>): void =>
      insertRow(sqlite, "telegram_subscriptions", row);
    insertSubscription({
      chat_id: oldChatId, stablecoin_id: "usdc",
      alert_dews: 1, alert_depeg: 0, alert_safety: 1, alert_launch: 0, alert_reserve: 1,
      alert_dews_override: 0, alert_depeg_override: 1, alert_safety_override: 0,
      alert_launch_override: 1, alert_reserve_override: 0,
      dews_min_band: "ALERT", safety_mode: "downgrade",
      depeg_worsening_bps_step: 50, alert_snooze_until_ts: 500,
    });
    insertSubscription({
      chat_id: newChatId, stablecoin_id: "usdc",
      alert_dews: 0, alert_depeg: 1, alert_safety: 0, alert_launch: 1, alert_reserve: 0,
      alert_dews_override: 1, alert_depeg_override: 0, alert_safety_override: 1,
      alert_launch_override: 0, alert_reserve_override: 1,
      dews_min_band: null, safety_mode: null,
      depeg_worsening_bps_step: null, alert_snooze_until_ts: 900,
    });
    insertSubscription({
      chat_id: oldChatId, stablecoin_id: "dai",
      alert_dews: 0, alert_depeg: 0, alert_safety: 0, alert_launch: 0, alert_reserve: 0,
      alert_dews_override: 1, alert_depeg_override: 1, alert_safety_override: 1,
      alert_launch_override: 1, alert_reserve_override: 1,
      dews_min_band: null, safety_mode: null,
      depeg_worsening_bps_step: null, alert_snooze_until_ts: null,
    });

    insertRow(sqlite, "telegram_preset_subscriptions", {
      chat_id: oldChatId, preset_id: "usd-top25",
      alert_dews: 1, alert_depeg: 0, alert_safety: 1,
      depeg_worsening_bps_step: 100, created_at: 100, updated_at: 250,
    });
    insertRow(sqlite, "telegram_preset_subscriptions", {
      chat_id: newChatId, preset_id: "usd-top25",
      alert_dews: 0, alert_depeg: 1, alert_safety: 0,
      depeg_worsening_bps_step: null, created_at: 200, updated_at: 300,
    });

    insertRow(sqlite, "telegram_pending_disambiguation", {
      chat_id: oldChatId, alert_types: "dews", resolved_ids: "[]", ambiguous_ticker: "USD",
      candidates: "[]", remaining_tickers: "[]", expires_at: 1_700_001_000,
      action_type: "setup-step", action_payload: "{\"old\":true}", initiator_user_id: "42",
    });
    insertRow(sqlite, "telegram_pending_disambiguation", {
      chat_id: newChatId, alert_types: "safety", resolved_ids: "[]", ambiguous_ticker: "EUR",
      candidates: "[]", remaining_tickers: "[]", expires_at: 1_700_001_500,
      action_type: "subscribe", action_payload: "{\"new\":true}", initiator_user_id: "43",
    });

    insertRow(sqlite, "telegram_chat_delivery_diagnostics", {
      chat_id: oldChatId, last_successful_delivery_at: 300, last_successful_reply_at: 700,
      last_delivery_attempt_at: 800, recent_failure_class: "forbidden", updated_at: 900,
    });
    insertRow(sqlite, "telegram_chat_delivery_diagnostics", {
      chat_id: newChatId, last_successful_delivery_at: 500, last_successful_reply_at: null,
      last_delivery_attempt_at: 750, recent_failure_class: null, updated_at: 850,
    });

    insertRow(sqlite, "telegram_pending_alerts", {
      chat_id: oldChatId, message_html: "old duplicate", created_at: 100, dedupe_key: `${oldChatId}:same`,
    });
    insertRow(sqlite, "telegram_pending_alerts", {
      chat_id: newChatId, message_html: "new duplicate", created_at: 100, dedupe_key: `${newChatId}:same`,
    });
    insertRow(sqlite, "telegram_pending_alerts", {
      chat_id: oldChatId, message_html: "old unique", created_at: 100, dedupe_key: `${oldChatId}:unique`,
    });

    insertRow(sqlite, "telegram_alert_job_targets", {
      job_id: "job-old", target_key: `${oldChatId}:unique`, chat_id: oldChatId,
      alert_type: "depeg", pending_dedupe_key: `${oldChatId}:unique`, created_at: 100,
    });
    insertRow(sqlite, "telegram_alert_dead_letters", {
      chat_id: oldChatId, message_html: "expired", created_at: 100, expired_at: 200, reason: "ttl_expired",
    });
    sqlite.prepare(`
      INSERT INTO telegram_recap_preferences
        (chat_id, enabled, delivery_hour_local, next_due_at, created_at, updated_at)
      VALUES (?, 1, 9, 500, 100, 100)
    `).run(oldChatId);
    sqlite.prepare(`
      INSERT INTO telegram_recap_targets
        (recap_key, chat_id, local_date, window_start_at, window_end_at,
         preference_generation, watchlist_fingerprint, status, created_at, updated_at)
      VALUES (?, ?, '2026-07-11', 100, 200, 0, 'fingerprint', 'queued', 100, 100)
    `).run(`recap:${oldChatId}:2026-07-11:v1`, oldChatId);
    sqlite.prepare(`
      INSERT INTO telegram_pending_alerts
        (chat_id, message_html, created_at, updated_at, dedupe_key, source_type, source_event_id)
      VALUES (?, 'recap', 100, 100, ?, 'personalized_recap', ?)
    `).run(oldChatId, `${oldChatId}:recap`, `recap:${oldChatId}:2026-07-11:v1`);
    sqlite.prepare(`
      INSERT INTO telegram_processed_updates (update_id, received_at, chat_id)
      VALUES (?, ?, ?)
    `).run(700, 100, oldChatId);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      `telegram:group-welcome:${oldChatId}`,
      "legacy welcome",
      200,
    );
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      `telegram:group-welcome:${newChatId}`,
      "new welcome",
      100,
    );
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
      `telegram:chat-admins:${oldChatId}`,
      "legacy admins",
      100,
    );

    await migrateTelegramChatId(db, oldChatId, newChatId);
    await migrateTelegramChatId(db, oldChatId, newChatId);

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscribers WHERE chat_id = ?").get(oldChatId))
      .toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions WHERE chat_id = ?").get(oldChatId))
      .toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_preset_subscriptions WHERE chat_id = ?").get(oldChatId))
      .toEqual({ count: 0 });

    expect(sqlite.prepare(`
      SELECT username, alert_dews, alert_depeg, alert_safety, alert_launch,
             alert_reserve,
             global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch,
             global_alert_reserve,
             quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
             global_depeg_worsening_bps_step, timezone, alert_snooze_until_ts,
             consecutive_block_count, consecutive_block_first_at, created_at, last_active_at
        FROM telegram_subscribers
       WHERE chat_id = ?
    `).get(newChatId)).toEqual({
      username: "legacy-group",
      alert_dews: 1,
      alert_depeg: 1,
      alert_safety: 1,
      alert_launch: 1,
      alert_reserve: 1,
      global_alert_dews: 1,
      global_alert_depeg: 1,
      global_alert_safety: 1,
      global_alert_launch: 1,
      global_alert_reserve: 1,
      quiet_hours_enabled: 1,
      quiet_hours_start_utc: 22,
      quiet_hours_end_utc: 6,
      global_depeg_worsening_bps_step: 75,
      timezone: "Europe/Belgrade",
      alert_snooze_until_ts: 1_700_000_900,
      consecutive_block_count: 3,
      consecutive_block_first_at: 1_700_000_100,
      created_at: 100,
      last_active_at: 300,
    });

    expect(sqlite.prepare(`
      SELECT alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve,
             alert_dews_override, alert_depeg_override, alert_safety_override,
             alert_launch_override, alert_reserve_override,
             dews_min_band, safety_mode, depeg_worsening_bps_step, alert_snooze_until_ts
        FROM telegram_subscriptions
       WHERE chat_id = ? AND stablecoin_id = 'usdc'
    `).get(newChatId)).toEqual({
      alert_dews: 1,
      alert_depeg: 1,
      alert_safety: 1,
      alert_launch: 1,
      alert_reserve: 1,
      alert_dews_override: 1,
      alert_depeg_override: 1,
      alert_safety_override: 1,
      alert_launch_override: 1,
      alert_reserve_override: 1,
      dews_min_band: "ALERT",
      safety_mode: "downgrade",
      depeg_worsening_bps_step: 50,
      alert_snooze_until_ts: 900,
    });
    expect(sqlite.prepare(`
      SELECT alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve,
             alert_dews_override, alert_depeg_override, alert_safety_override,
             alert_launch_override, alert_reserve_override
        FROM telegram_subscriptions
       WHERE chat_id = ? AND stablecoin_id = 'dai'
    `).get(newChatId)).toEqual({
      alert_dews: 0,
      alert_depeg: 0,
      alert_safety: 0,
      alert_launch: 0,
      alert_reserve: 0,
      alert_dews_override: 1,
      alert_depeg_override: 1,
      alert_safety_override: 1,
      alert_launch_override: 1,
      alert_reserve_override: 1,
    });
    expect(sqlite.prepare(`
      SELECT alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step, created_at, updated_at
        FROM telegram_preset_subscriptions
       WHERE chat_id = ? AND preset_id = 'usd-top25'
    `).get(newChatId)).toEqual({
      alert_dews: 1,
      alert_depeg: 1,
      alert_safety: 1,
      depeg_worsening_bps_step: 100,
      created_at: 100,
      updated_at: 300,
    });
    expect(sqlite.prepare(`
      SELECT action_type, action_payload, initiator_user_id
        FROM telegram_pending_disambiguation
       WHERE chat_id = ?
    `).get(newChatId)).toEqual({
      action_type: "subscribe",
      action_payload: "{\"new\":true}",
      initiator_user_id: "43",
    });
    expect(sqlite.prepare(`
      SELECT last_successful_delivery_at, last_successful_reply_at,
             last_delivery_attempt_at, recent_failure_class, updated_at
        FROM telegram_chat_delivery_diagnostics
       WHERE chat_id = ?
    `).get(newChatId)).toEqual({
      last_successful_delivery_at: 500,
      last_successful_reply_at: 700,
      last_delivery_attempt_at: 800,
      recent_failure_class: "forbidden",
      updated_at: 900,
    });

    expect(sqlite.prepare(`
      SELECT message_html, dedupe_key
        FROM telegram_pending_alerts
       WHERE chat_id = ?
       ORDER BY message_html
    `).all(newChatId)).toEqual([
      { message_html: "new duplicate", dedupe_key: `${newChatId}:same` },
      { message_html: "old unique", dedupe_key: `${newChatId}:unique` },
    ]);
    expect(sqlite.prepare(`
      SELECT chat_id, pending_dedupe_key
        FROM telegram_alert_job_targets
       WHERE job_id = 'job-old'
    `).get()).toEqual({
      chat_id: newChatId,
      pending_dedupe_key: `${newChatId}:unique`,
    });
    expect(sqlite.prepare("SELECT chat_id FROM telegram_alert_dead_letters").get()).toEqual({ chat_id: newChatId });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_recap_preferences").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_recap_targets").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts WHERE source_type = 'personalized_recap'").get())
      .toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT chat_id FROM telegram_processed_updates").get()).toEqual({ chat_id: newChatId });
    expect(sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(`telegram:group-welcome:${newChatId}`))
      .toEqual({ value: "legacy welcome", updated_at: 200 });
    expect(sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(`telegram:chat-admins:${newChatId}`))
      .toEqual({ value: "legacy admins", updated_at: 100 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache WHERE key LIKE ?").get(`%${oldChatId}`))
      .toEqual({ count: 0 });
  });
});
