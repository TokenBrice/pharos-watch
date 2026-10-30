import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mockTelegramD1 as mockD1 } from "../../../test-helpers/__shared/telegram";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { forgetSubscriber, migrateTelegramChatId, unsubscribeAll } from "../subscriber-lifecycle";
import { acquireTelegramMiniAppMutationBurst } from "../../mini-app/telegram-mini-app-rate-limit";
import { computeTelegramCurrentLifecycleSnapshot } from "../usage-analytics";

const fixtures = createLatestSchemaFixtureTracker({ uncached: true });
afterEach(() => fixtures.closeAll());

function setupChatMigrationSqlite(): { sqlite: DatabaseSync; db: D1Database } {
  return fixtures.open();
}

// Legacy pipeline tables that no runtime code reads or writes; a later
// migration drops them, so lifecycle coverage no longer applies.
const RETIRED_TELEGRAM_TABLES = new Set([
  "telegram_pending_disambiguation",
  "telegram_pending_alerts",
  "telegram_recap_preferences",
  "telegram_recap_targets",
  "telegram_freeze_alert_targets",
  "telegram_freeze_alert_events",
  "telegram_transport_failure_observations",
  "telegram_transport_circuit",
  "telegram_delivery_pauses",
  "telegram_webhook_operation_mutations",
]);

function isRetiredTelegramTable(name: string): boolean {
  return RETIRED_TELEGRAM_TABLES.has(name)
    || name.startsWith("telegram_alert_")
    || name.startsWith("telegram_adoption_");
}

function discoverTelegramChatIdTablesFromMigrations(): string[] {
  const { sqlite } = fixtures.open();
  const tables = sqlite.prepare(`
    SELECT tables.name
    FROM sqlite_master AS tables
    WHERE tables.type = 'table'
      AND tables.name GLOB 'telegram_*'
      AND EXISTS (
        SELECT 1 FROM pragma_table_info(tables.name) WHERE name = 'chat_id'
      )
    ORDER BY tables.name
  `).all() as { name: string }[];
  return tables.map((table) => table.name).filter((name) => !isRetiredTelegramTable(name));
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
  it("clears snooze and reserve preferences only for the unsubscribing chat", async () => {
    const { sqlite, db } = setupChatMigrationSqlite();
    for (const chatId of ["42", "neighbor"]) {
      insertRow(sqlite, "telegram_subscribers", {
        chat_id: chatId, created_at: 100, last_active_at: 100,
        alert_reserve: 1, global_alert_reserve: 1,
        alert_snooze_until_ts: 2_000_000_000, preference_generation: 7,
      });
      insertRow(sqlite, "telegram_subscriptions", {
        chat_id: chatId, stablecoin_id: "usdc-circle", alert_reserve: 1,
      });
    }
    await unsubscribeAll(db, "42");
    expect(sqlite.prepare(`
      SELECT chat_id, alert_reserve, global_alert_reserve, alert_snooze_until_ts,
             preference_generation FROM telegram_subscribers ORDER BY chat_id
    `).all()).toEqual([
      { chat_id: "42", alert_reserve: 0, global_alert_reserve: 0, alert_snooze_until_ts: null, preference_generation: 8 },
      { chat_id: "neighbor", alert_reserve: 1, global_alert_reserve: 1, alert_snooze_until_ts: 2_000_000_000, preference_generation: 7 },
    ]);
    expect(sqlite.prepare("SELECT chat_id FROM telegram_subscriptions").all()).toEqual([{ chat_id: "neighbor" }]);
  });
});

describe("forgetSubscriber", () => {
  it("covers every chat-owned Telegram table except retained processed updates", async () => {
    const chatTables = discoverTelegramChatIdTablesFromMigrations();
    const retainedOnForget = new Set(["telegram_processed_updates"]);
    // Table-coverage discovery: every chat-owned table must appear in history,
    // so the write set is observed rather than declared.
    const db = mockD1([], { strictWrites: false });

    await forgetSubscriber(db, "42");

    const deletedTables = new Set(
      db.getHistory()
        .map((entry) => entry.sql.match(/DELETE FROM\s+(telegram_[a-z0-9_]+)\s+WHERE chat_id = \?/iu)?.[1])
        .filter((table): table is string => typeof table === "string"),
    );
    expect([...deletedTables].sort()).toEqual(chatTables.filter((table) => !retainedOnForget.has(table)));
    expect([...collectTelegramTablesFromSql(db.getHistory())].filter(isRetiredTelegramTable)).toEqual([]);
  });

  it("has no live Telegram table that names the user outside chat_id", () => {
    const { sqlite } = setupChatMigrationSqlite();
    const userColumns = sqlite.prepare(`
      SELECT tables.name AS table_name, columns.name AS column_name
        FROM sqlite_master AS tables, pragma_table_info(tables.name) AS columns
       WHERE tables.type = 'table' AND tables.name GLOB 'telegram_*' AND columns.name GLOB '*user_id'
       ORDER BY tables.name, columns.name
    `).all() as { table_name: string; column_name: string }[];
    // A new live user-keyed table must be added to forgetSubscriber's purge.
    expect(userColumns.filter((row) => !isRetiredTelegramTable(row.table_name))).toEqual([]);
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
    const deletedCacheKeys = [
      `telegram:chat-send-backoff:${chatId}`,
      `telegram:command-flood:${chatId}`,
      `telegram:command-flood:${chatId}:actor:99`,
      `telegram:command-cooldown:${chatId}:/status`,
      `telegram:chat-member:${chatId}:99`,
      `telegram:chat-admins:${chatId}`,
      `telegram:group-welcome:${chatId}`,
      `telegram:re-engagement-warned:${chatId}`,
      `telegram:mini-app-mutation-burst:${chatId}`,
      `telegram:adoption-mini-app-session:${chatId}`,
      `telegram:command-cooldown:${chatId}:mini-app:session`,
      `telegram:command-cooldown:${chatId}:mini-app:stale:mini_app_mutation_denied:0123456789abcdef`,
      `telegram:command-flood:inline:${chatId}`,
      `telegram:command-cooldown:inline:${chatId}:/status:usdc-circle`,
    ];
    const neighboringCacheKeys = [
      "telegram:chat-send-backoff:420",
      "telegram:command-flood:420",
      "telegram:command-flood:420:actor:99",
      "telegram:command-cooldown:420:/status",
      "telegram:chat-member:420:99",
      "telegram:re-engagement-warned:420",
      "telegram:command-cooldown:420:mini-app:stale:mini_app_mutation_denied:0123456789abcdef",
      "telegram:command-flood:inline:420",
      "telegram:command-cooldown:inline:420:/status:usdc-circle",
    ];
    const cacheRows = [...deletedCacheKeys, ...neighboringCacheKeys];
    for (const key of cacheRows) {
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(key, "1", 123);
    }

    await forgetSubscriber(db, chatId);

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscribers WHERE chat_id = ?").get(chatId))
      .toEqual({ count: 0 });
    for (const key of deletedCacheKeys) {
      expect(sqlite.prepare("SELECT key FROM cache WHERE key = ?").get(key)).toBeUndefined();
    }
    expect(sqlite.prepare("SELECT key FROM cache ORDER BY key").all())
      .toEqual([...neighboringCacheKeys].sort().map((key) => ({ key })));
  });

  it("erases the profile and watchlist without erasing its remaining anonymous admission budget", async () => {
    const { sqlite, db } = setupChatMigrationSqlite();
    insertRow(sqlite, "telegram_subscribers", {
      chat_id: "42", username: "alice", created_at: 100, last_active_at: 100,
    });
    insertRow(sqlite, "telegram_subscriptions", { chat_id: "42", stablecoin_id: "usdc-circle", alert_depeg: 1 });
    await acquireTelegramMiniAppMutationBurst(db, { userId: "42", botToken: "quota-secret", nowSec: 1_000 });
    const budgetBefore = sqlite.prepare("SELECT key, value, updated_at FROM cache").all();

    await forgetSubscriber(db, "42");
    await forgetSubscriber(db, "42");

    expect(sqlite.prepare("SELECT chat_id FROM telegram_subscribers").all()).toEqual([]);
    expect(sqlite.prepare("SELECT chat_id FROM telegram_subscriptions").all()).toEqual([]);
    expect(sqlite.prepare("SELECT key, value, updated_at FROM cache").all()).toEqual(budgetBefore);
    expect(budgetBefore).toEqual([{
      key: expect.stringMatching(/^telegram:mini-app-mutation-burst:anon:[a-f0-9]{64}$/),
      value: "1", updated_at: 1_000,
    }]);
  });

});

describe("migrateTelegramChatId", () => {
  it.each([[900, 600], [600, 900]])("preserves the greatest chat deadline across migration (%s, %s)", async (oldDeadline, newDeadline) => {
    const { sqlite, db } = setupChatMigrationSqlite();
    for (const chatId of ["-123", "-100123"]) {
      insertRow(sqlite, "telegram_subscribers", { chat_id: chatId, created_at: 100, last_active_at: 100 });
    }
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run("telegram:chat-send-backoff:-123", String(oldDeadline), 100);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run("telegram:chat-send-backoff:-100123", String(newDeadline), 200);
    await migrateTelegramChatId(db, "-123", "-100123");
    expect(sqlite.prepare("SELECT key, value FROM cache WHERE key GLOB 'telegram:chat-send-backoff:*'").all())
      .toEqual([{ key: "telegram:chat-send-backoff:-100123", value: "900" }]);
  });

  it("touches every chat-owned Telegram table discovered in migrations", async () => {
    const chatTables = discoverTelegramChatIdTablesFromMigrations();
    // Table-coverage discovery: every chat-owned table must appear in history,
    // so the write set is observed rather than declared.
    const db = mockD1([], { strictWrites: false });

    await migrateTelegramChatId(db, "-123", "-100123");

    const touchedTables = collectTelegramTablesFromSql(db.getHistory());
    expect(chatTables.filter((table) => !touchedTables.has(table))).toEqual([]);
    expect([...touchedTables].filter(isRetiredTelegramTable)).toEqual([]);
  });

  it("does not fabricate watcher lifecycle events for a chat-id move", async () => {
    const { sqlite, db } = setupChatMigrationSqlite();
    const oldChatId = "-4242";
    const newChatId = "-1001234567890";
    // The group followed DEWS before Telegram upgraded it. The 0246 triggers
    // initialize `watcher_active`; the daily counters describe preference
    // transitions only, so they start empty.
    insertRow(sqlite, "telegram_subscribers", {
      chat_id: oldChatId, created_at: 100, last_active_at: 100, global_alert_dews: 1,
    });
    insertRow(sqlite, "telegram_subscriptions", {
      chat_id: oldChatId, stablecoin_id: "usdc-circle", alert_dews: 1,
    });
    sqlite.exec("DELETE FROM telegram_watcher_lifecycle_events_daily");
    expect(sqlite.prepare("SELECT watcher_active FROM telegram_subscribers WHERE chat_id = ?").get(oldChatId))
      .toEqual({ watcher_active: 1 });

    await migrateTelegramChatId(db, oldChatId, newChatId);

    // The move carries the existing following over; it is neither a
    // `newWatchers` subscribe nor a `churnedWatchers` unsubscribe.
    expect(sqlite.prepare("SELECT chat_id, global_alert_dews, watcher_active FROM telegram_subscribers").all())
      .toEqual([{ chat_id: newChatId, global_alert_dews: 1, watcher_active: 1 }]);
    const snapshot = await computeTelegramCurrentLifecycleSnapshot(
      db,
      Math.floor(Date.now() / 1000),
      { pendingDeliveryCount: 0 },
    );
    expect({ newWatchers: snapshot.newWatchers, churnedWatchers: snapshot.churnedWatchers })
      .toEqual({ newWatchers: 0, churnedWatchers: 0 });
    expect(sqlite.prepare(`
      SELECT COALESCE(SUM(subscribe_events), 0) AS subscribed,
             COALESCE(SUM(unsubscribe_events), 0) AS unsubscribed,
             COALESCE(SUM(reactivate_events), 0) AS reactivated
        FROM telegram_watcher_lifecycle_events_daily
    `).get()).toEqual({ subscribed: 0, unsubscribed: 0, reactivated: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache WHERE key LIKE 'telegram:watcher-migration-suppress:%'").get())
      .toEqual({ count: 0 });
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
              ? {
                  preference_generation: Number(sentinel.preference_generation) + 1,
                  // Migration 0246 derives current activity from the migrated preferences.
                  watcher_active: 0,
                }
              : {}),
          },
        ];
      }),
    );

    await migrateTelegramChatId(db, oldChatId, newChatId);
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

  it.each([
    [0, 0, 0, 8, 20, 8],
    [1, 0, 6, 22, 6, 8],
    [0, 1, 7, 8, 20, 9],
    [1, 1, 20, 8, 20, 22],
  ])("preserves paired quiet hours and generation arithmetic (%s, %s, %s)", async (
    oldEnabled, newEnabled, oldGeneration, start, end, generation,
  ) => {
    const { sqlite, db } = setupChatMigrationSqlite();
    for (const [chatId, enabled, hour, until, first, gen] of [
      ["-123", oldEnabled, 22, 6, 100, oldGeneration],
      ["-100123", newEnabled, 8, 20, null, 7],
    ] as const) insertRow(sqlite, "telegram_subscribers", {
      chat_id: chatId, created_at: 100, last_active_at: 200,
      quiet_hours_enabled: enabled, quiet_hours_start_utc: hour, quiet_hours_end_utc: until,
      preference_generation: gen, consecutive_block_first_at: first,
      first_follow_at: first, first_setup_completed_at: first, alert_snooze_until_ts: 0,
    });
    const destination = sqlite.prepare("SELECT * FROM telegram_subscribers WHERE chat_id = ?").get("-100123");
    await migrateTelegramChatId(db, "-123", "-100123");
    await migrateTelegramChatId(db, "-123", "-100123");
    expect(sqlite.prepare("SELECT * FROM telegram_subscribers").all()).toEqual([{
      ...destination, quiet_hours_enabled: Math.max(oldEnabled, newEnabled),
      quiet_hours_start_utc: start, quiet_hours_end_utc: end, preference_generation: generation,
      consecutive_block_first_at: 100, first_follow_at: 100, first_setup_completed_at: 100,
      alert_snooze_until_ts: null,
    }]);
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

    insertRow(sqlite, "telegram_chat_delivery_diagnostics", {
      chat_id: oldChatId, last_successful_delivery_at: 300, last_successful_reply_at: 700,
      last_delivery_attempt_at: 800, recent_failure_class: "forbidden", updated_at: 900,
    });
    insertRow(sqlite, "telegram_chat_delivery_diagnostics", {
      chat_id: newChatId, last_successful_delivery_at: 500, last_successful_reply_at: null,
      last_delivery_attempt_at: 750, recent_failure_class: null, updated_at: 850,
    });

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
    const firstMigrationRows = CHAT_ROW_MERGE_TABLES.map((table) =>
      sqlite.prepare(`SELECT * FROM ${quoteSqlIdentifier(table)} ORDER BY chat_id`).all(),
    );
    await migrateTelegramChatId(db, oldChatId, newChatId);
    expect(CHAT_ROW_MERGE_TABLES.map((table) =>
      sqlite.prepare(`SELECT * FROM ${quoteSqlIdentifier(table)} ORDER BY chat_id`).all(),
    )).toEqual(firstMigrationRows);

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscribers WHERE chat_id = ?").get(oldChatId))
      .toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions WHERE chat_id = ?").get(oldChatId))
      .toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_preset_subscriptions WHERE chat_id = ?").get(oldChatId))
      .toEqual({ count: 0 });

    expect(sqlite.prepare(`
      SELECT * FROM telegram_subscribers
       WHERE chat_id = ?
    `).get(newChatId)).toEqual({
      chat_id: newChatId,
      alert_freeze: 0, global_alert_freeze: 0,
      watcher_active: 1, watcher_ever_active: 1,
      preference_generation: 2, first_follow_at: null, first_setup_completed_at: null,
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
      SELECT * FROM telegram_subscriptions
       WHERE chat_id = ? AND stablecoin_id = 'usdc'
    `).get(newChatId)).toEqual({
      chat_id: newChatId, stablecoin_id: "usdc", alert_freeze: 0, alert_freeze_override: 0,
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
      SELECT * FROM telegram_subscriptions
       WHERE chat_id = ? AND stablecoin_id = 'dai'
    `).get(newChatId)).toEqual({
      chat_id: newChatId, stablecoin_id: "dai", alert_freeze: 0, alert_freeze_override: 0,
      dews_min_band: null, safety_mode: null, depeg_worsening_bps_step: null, alert_snooze_until_ts: null,
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
      SELECT * FROM telegram_preset_subscriptions
       WHERE chat_id = ? AND preset_id = 'usd-top25'
    `).get(newChatId)).toEqual({
      chat_id: newChatId, preset_id: "usd-top25",
      alert_dews: 1,
      alert_depeg: 1,
      alert_safety: 1,
      depeg_worsening_bps_step: 100,
      created_at: 100,
      updated_at: 300,
    });
    expect(sqlite.prepare(`
      SELECT * FROM telegram_chat_delivery_diagnostics
       WHERE chat_id = ?
    `).get(newChatId)).toEqual({
      chat_id: newChatId,
      last_successful_delivery_at: 500,
      last_successful_reply_at: 700,
      last_delivery_attempt_at: 800,
      recent_failure_class: "forbidden",
      updated_at: 900,
    });

    expect(sqlite.prepare("SELECT chat_id FROM telegram_processed_updates").get()).toEqual({ chat_id: newChatId });
    expect(sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(`telegram:group-welcome:${newChatId}`))
      .toEqual({ value: "legacy welcome", updated_at: 200 });
    expect(sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(`telegram:chat-admins:${newChatId}`))
      .toEqual({ value: "legacy admins", updated_at: 100 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache WHERE key LIKE ?").get(`%${oldChatId}`))
      .toEqual({ count: 0 });
  });
});
