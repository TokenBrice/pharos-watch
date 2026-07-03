import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { forgetSubscriber, migrateTelegramChatId, unsubscribeAll } from "../forget";

interface SqliteD1Statement {
  bind(...values: unknown[]): SqliteD1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta: { changes: number } }>;
}

function createSqliteD1(sqlite: DatabaseSync): D1Database {
  function makeStatement(sql: string, values: unknown[] = []): SqliteD1Statement {
    return {
      bind: (...nextValues: unknown[]) => makeStatement(sql, nextValues),
      first: async <T>() => (sqlite.prepare(sql).get(...(values as never[])) ?? null) as T | null,
      all: async <T>() => ({ results: sqlite.prepare(sql).all(...(values as never[])) as T[] }),
      run: async () => {
        const result = sqlite.prepare(sql).run(...(values as never[]));
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
  }

  return {
    prepare: (sql: string) => makeStatement(sql),
    batch: async (statements: D1PreparedStatement[]) =>
      Promise.all(statements.map((statement) => statement.run())),
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

function setupChatMigrationSqlite(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE telegram_subscribers (
      chat_id TEXT PRIMARY KEY,
      username TEXT,
      alert_dews INTEGER NOT NULL DEFAULT 0,
      alert_depeg INTEGER NOT NULL DEFAULT 0,
      alert_safety INTEGER NOT NULL DEFAULT 0,
      alert_launch INTEGER NOT NULL DEFAULT 0,
      alert_reserve INTEGER NOT NULL DEFAULT 0,
      global_alert_dews INTEGER NOT NULL DEFAULT 0,
      global_alert_depeg INTEGER NOT NULL DEFAULT 0,
      global_alert_safety INTEGER NOT NULL DEFAULT 0,
      global_alert_launch INTEGER NOT NULL DEFAULT 0,
      global_alert_reserve INTEGER NOT NULL DEFAULT 0,
      quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
      quiet_hours_start_utc INTEGER,
      quiet_hours_end_utc INTEGER,
      global_depeg_worsening_bps_step INTEGER,
      timezone TEXT,
      alert_snooze_until_ts INTEGER,
      consecutive_block_count INTEGER NOT NULL DEFAULT 0,
      consecutive_block_first_at INTEGER,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    );

    CREATE TABLE telegram_subscriptions (
      chat_id TEXT NOT NULL,
      stablecoin_id TEXT NOT NULL,
      alert_dews INTEGER NOT NULL DEFAULT 0,
      alert_depeg INTEGER NOT NULL DEFAULT 0,
      alert_safety INTEGER NOT NULL DEFAULT 0,
      alert_launch INTEGER NOT NULL DEFAULT 0,
      alert_reserve INTEGER NOT NULL DEFAULT 0,
      dews_min_band TEXT,
      safety_mode TEXT,
      depeg_worsening_bps_step INTEGER,
      alert_snooze_until_ts INTEGER,
      PRIMARY KEY (chat_id, stablecoin_id)
    );

    CREATE TABLE telegram_preset_subscriptions (
      chat_id TEXT NOT NULL,
      preset_id TEXT NOT NULL,
      alert_dews INTEGER NOT NULL DEFAULT 0,
      alert_depeg INTEGER NOT NULL DEFAULT 0,
      alert_safety INTEGER NOT NULL DEFAULT 0,
      depeg_worsening_bps_step INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, preset_id)
    );

    CREATE TABLE telegram_pending_disambiguation (
      chat_id TEXT PRIMARY KEY,
      alert_types TEXT NOT NULL,
      resolved_ids TEXT NOT NULL,
      ambiguous_ticker TEXT NOT NULL,
      candidates TEXT NOT NULL,
      remaining_tickers TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      action_type TEXT NOT NULL DEFAULT 'subscribe',
      action_payload TEXT NOT NULL DEFAULT '{}',
      initiator_user_id TEXT
    );

    CREATE TABLE telegram_chat_delivery_diagnostics (
      chat_id TEXT PRIMARY KEY,
      last_successful_delivery_at INTEGER,
      last_successful_reply_at INTEGER,
      last_delivery_attempt_at INTEGER,
      recent_failure_class TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE telegram_pending_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      message_html TEXT NOT NULL,
      dedupe_key TEXT UNIQUE
    );

    CREATE TABLE telegram_alert_job_targets (
      job_id TEXT NOT NULL,
      target_key TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      pending_dedupe_key TEXT NOT NULL,
      PRIMARY KEY (job_id, target_key)
    );

    CREATE TABLE telegram_alert_dead_letters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT
    );

    CREATE TABLE telegram_processed_updates (
      update_id INTEGER PRIMARY KEY,
      chat_id TEXT
    );

    CREATE TABLE cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function discoverTelegramChatIdTablesFromMigrations(): string[] {
  const migrationDir = join(process.cwd(), "worker/migrations");
  const tables = new Set<string>();
  for (const file of readdirSync(migrationDir)) {
    if (!file.endsWith(".sql")) continue;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test scans checked-in Worker migrations only.
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

  it("clears chat-owned cache residue while preserving neighboring chat keys", async () => {
    const { sqlite, db } = setupChatMigrationSqlite();
    const chatId = "42";
    sqlite.prepare(`
      INSERT INTO telegram_subscribers (
        chat_id, username, created_at, last_active_at
      )
      VALUES (?, ?, ?, ?)
    `).run(chatId, "alice", 100, 200);
    sqlite.prepare("INSERT INTO telegram_alert_job_targets (job_id, target_key, chat_id, pending_dedupe_key) VALUES (?, ?, ?, ?)")
      .run("job-1", "target-1", chatId, "pending-1");
    sqlite.prepare("INSERT INTO telegram_alert_dead_letters (chat_id) VALUES (?)").run(chatId);
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

  it("merges conflicting group rows in SQLite and is idempotent", async () => {
    const { sqlite, db } = setupChatMigrationSqlite();
    const oldChatId = "-123";
    const newChatId = "-100123";

    sqlite.prepare(`
      INSERT INTO telegram_subscribers (
        chat_id, username, alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve,
        global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch, global_alert_reserve,
        quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
        global_depeg_worsening_bps_step, timezone, alert_snooze_until_ts,
        consecutive_block_count, consecutive_block_first_at, created_at, last_active_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      oldChatId,
      "legacy-group",
      1,
      0,
      1,
      0,
      1,
      1,
      0,
      1,
      0,
      1,
      1,
      22,
      6,
      75,
      "Europe/Belgrade",
      1_700_000_900,
      1,
      1_700_000_100,
      100,
      300,
    );
    sqlite.prepare(`
      INSERT INTO telegram_subscribers (
        chat_id, username, alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve,
        global_alert_dews, global_alert_depeg, global_alert_safety, global_alert_launch, global_alert_reserve,
        quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc,
        global_depeg_worsening_bps_step, timezone, alert_snooze_until_ts,
        consecutive_block_count, consecutive_block_first_at, created_at, last_active_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newChatId,
      null,
      0,
      1,
      0,
      1,
      0,
      0,
      1,
      0,
      1,
      0,
      0,
      8,
      20,
      null,
      null,
      null,
      3,
      null,
      200,
      250,
    );

    sqlite.prepare(`
      INSERT INTO telegram_subscriptions (
        chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve,
        dews_min_band, safety_mode, depeg_worsening_bps_step, alert_snooze_until_ts
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(oldChatId, "usdc", 1, 0, 1, 0, 1, "ALERT", "downgrade", 50, 500);
    sqlite.prepare(`
      INSERT INTO telegram_subscriptions (
        chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve,
        dews_min_band, safety_mode, depeg_worsening_bps_step, alert_snooze_until_ts
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(newChatId, "usdc", 0, 1, 0, 1, 0, null, null, null, 900);

    sqlite.prepare(`
      INSERT INTO telegram_preset_subscriptions (
        chat_id, preset_id, alert_dews, alert_depeg, alert_safety,
        depeg_worsening_bps_step, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(oldChatId, "usd-top25", 1, 0, 1, 100, 100, 250);
    sqlite.prepare(`
      INSERT INTO telegram_preset_subscriptions (
        chat_id, preset_id, alert_dews, alert_depeg, alert_safety,
        depeg_worsening_bps_step, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(newChatId, "usd-top25", 0, 1, 0, null, 200, 300);

    sqlite.prepare(`
      INSERT INTO telegram_pending_disambiguation (
        chat_id, alert_types, resolved_ids, ambiguous_ticker, candidates,
        remaining_tickers, expires_at, action_type, action_payload, initiator_user_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(oldChatId, "dews", "[]", "USD", "[]", "[]", 1_700_001_000, "setup-step", "{\"old\":true}", "42");
    sqlite.prepare(`
      INSERT INTO telegram_pending_disambiguation (
        chat_id, alert_types, resolved_ids, ambiguous_ticker, candidates,
        remaining_tickers, expires_at, action_type, action_payload, initiator_user_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(newChatId, "safety", "[]", "EUR", "[]", "[]", 1_700_001_500, "subscribe", "{\"new\":true}", "43");

    sqlite.prepare(`
      INSERT INTO telegram_chat_delivery_diagnostics (
        chat_id, last_successful_delivery_at, last_successful_reply_at,
        last_delivery_attempt_at, recent_failure_class, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(oldChatId, 300, 700, 800, "forbidden", 900);
    sqlite.prepare(`
      INSERT INTO telegram_chat_delivery_diagnostics (
        chat_id, last_successful_delivery_at, last_successful_reply_at,
        last_delivery_attempt_at, recent_failure_class, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(newChatId, 500, null, 750, null, 850);

    sqlite.prepare("INSERT INTO telegram_pending_alerts (chat_id, message_html, dedupe_key) VALUES (?, ?, ?)")
      .run(oldChatId, "old duplicate", `${oldChatId}:same`);
    sqlite.prepare("INSERT INTO telegram_pending_alerts (chat_id, message_html, dedupe_key) VALUES (?, ?, ?)")
      .run(newChatId, "new duplicate", `${newChatId}:same`);
    sqlite.prepare("INSERT INTO telegram_pending_alerts (chat_id, message_html, dedupe_key) VALUES (?, ?, ?)")
      .run(oldChatId, "old unique", `${oldChatId}:unique`);

    sqlite.prepare(`
      INSERT INTO telegram_alert_job_targets (job_id, target_key, chat_id, pending_dedupe_key)
      VALUES (?, ?, ?, ?)
    `).run("job-old", `${oldChatId}:unique`, oldChatId, `${oldChatId}:unique`);
    sqlite.prepare("INSERT INTO telegram_alert_dead_letters (chat_id) VALUES (?)").run(oldChatId);
    sqlite.prepare("INSERT INTO telegram_processed_updates (update_id, chat_id) VALUES (?, ?)").run(700, oldChatId);
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
             dews_min_band, safety_mode, depeg_worsening_bps_step, alert_snooze_until_ts
        FROM telegram_subscriptions
       WHERE chat_id = ? AND stablecoin_id = 'usdc'
    `).get(newChatId)).toEqual({
      alert_dews: 1,
      alert_depeg: 1,
      alert_safety: 1,
      alert_launch: 1,
      alert_reserve: 1,
      dews_min_band: "ALERT",
      safety_mode: "downgrade",
      depeg_worsening_bps_step: 50,
      alert_snooze_until_ts: 900,
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
    expect(sqlite.prepare("SELECT chat_id FROM telegram_processed_updates").get()).toEqual({ chat_id: newChatId });
    expect(sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(`telegram:group-welcome:${newChatId}`))
      .toEqual({ value: "legacy welcome", updated_at: 200 });
    expect(sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(`telegram:chat-admins:${newChatId}`))
      .toEqual({ value: "legacy admins", updated_at: 100 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache WHERE key LIKE ?").get(`%${oldChatId}`))
      .toEqual({ count: 0 });
  });
});
