import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../../test-helpers/sqlite-d1";
import {
  applySubscribeIntent,
  applyUnsubscribeIntent,
} from "../presets";
import { unsubscribeAll } from "../forget";
import { upsertGlobalAlertTypes } from "../subscribers";

const CHAT_ID = "42";
const NOW_MS = Date.UTC(2026, 6, 10, 12, 0, 0);

interface FaultOptions {
  failAtBoundary?: number;
  batchSizes?: number[];
}

function createFaultInjectingD1(
  sqlite: DatabaseSync,
  options: FaultOptions = {},
): D1Database {
  const base = createSqliteD1(sqlite);
  return {
    prepare: base.prepare.bind(base),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      options.batchSizes?.push(statements.length);
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results: D1Result<T>[] = [];
        for (let index = 0; index < statements.length; index += 1) {
          if (options.failAtBoundary === index) {
            throw new Error(`injected failure at boundary ${index}`);
          }
          results.push(await statements[index].run<T>());
        }
        if (options.failAtBoundary === statements.length) {
          throw new Error(`injected failure at boundary ${statements.length}`);
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

function openSqlite(): DatabaseSync {
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
      alert_freeze INTEGER NOT NULL DEFAULT 0,
      global_alert_dews INTEGER NOT NULL DEFAULT 0,
      global_alert_depeg INTEGER NOT NULL DEFAULT 0,
      global_alert_safety INTEGER NOT NULL DEFAULT 0,
      global_alert_launch INTEGER NOT NULL DEFAULT 0,
      global_alert_reserve INTEGER NOT NULL DEFAULT 0,
      global_alert_freeze INTEGER NOT NULL DEFAULT 0,
      global_depeg_worsening_bps_step INTEGER,
      alert_snooze_until_ts INTEGER,
      quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
      quiet_hours_start_utc INTEGER,
      quiet_hours_end_utc INTEGER,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      preference_generation INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE telegram_subscriptions (
      chat_id TEXT NOT NULL,
      stablecoin_id TEXT NOT NULL,
      alert_dews INTEGER NOT NULL DEFAULT 0,
      alert_depeg INTEGER NOT NULL DEFAULT 0,
      alert_safety INTEGER NOT NULL DEFAULT 0,
      alert_launch INTEGER NOT NULL DEFAULT 0,
      alert_reserve INTEGER NOT NULL DEFAULT 0,
      alert_freeze INTEGER NOT NULL DEFAULT 0,
      alert_dews_override INTEGER NOT NULL DEFAULT 0,
      alert_depeg_override INTEGER NOT NULL DEFAULT 0,
      alert_safety_override INTEGER NOT NULL DEFAULT 0,
      alert_launch_override INTEGER NOT NULL DEFAULT 0,
      alert_reserve_override INTEGER NOT NULL DEFAULT 0,
      alert_freeze_override INTEGER NOT NULL DEFAULT 0,
      depeg_worsening_bps_step INTEGER,
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
      chat_id TEXT PRIMARY KEY
    );
  `);
  return sqlite;
}

function insertPending(sqlite: DatabaseSync): void {
  sqlite
    .prepare("INSERT INTO telegram_pending_disambiguation (chat_id) VALUES (?)")
    .run(CHAT_ID);
}

function stateSnapshot(sqlite: DatabaseSync): unknown {
  return {
    subscriber: sqlite
      .prepare("SELECT * FROM telegram_subscribers WHERE chat_id = ?")
      .get(CHAT_ID),
    subscriptions: sqlite
      .prepare("SELECT * FROM telegram_subscriptions WHERE chat_id = ? ORDER BY stablecoin_id")
      .all(CHAT_ID),
    presets: sqlite
      .prepare("SELECT * FROM telegram_preset_subscriptions WHERE chat_id = ? ORDER BY preset_id")
      .all(CHAT_ID),
    pending: sqlite
      .prepare("SELECT * FROM telegram_pending_disambiguation WHERE chat_id = ?")
      .get(CHAT_ID),
  };
}

const subscribeInput = {
  chatId: CHAT_ID,
  username: "alice",
  directStablecoinIds: ["usdc-circle", "usdt-tether"],
  presetIds: ["usd-top25"],
  alertTypes: new Set(["dews", "depeg"]),
  clearPending: true,
  depegWorseningBpsStep: 250 as const,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("atomic Telegram subscribe intent", () => {
  it("commits subscriber, coin, preset, and pending-clear statements in one batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const sqlite = openSqlite();
    const batchSizes: number[] = [];
    try {
      insertPending(sqlite);
      await applySubscribeIntent(createFaultInjectingD1(sqlite, { batchSizes }), subscribeInput);

      expect(batchSizes).toEqual([5]);
      expect(sqlite.prepare(`
        SELECT username, alert_dews, alert_depeg, last_active_at, preference_generation
          FROM telegram_subscribers
         WHERE chat_id = ?
      `).get(CHAT_ID)).toEqual({
        username: "alice",
        alert_dews: 1,
        alert_depeg: 1,
        last_active_at: Math.floor(NOW_MS / 1000),
        preference_generation: 1,
      });
      expect(sqlite.prepare(`
        SELECT stablecoin_id, alert_dews, alert_depeg, depeg_worsening_bps_step
          FROM telegram_subscriptions
         WHERE chat_id = ?
         ORDER BY stablecoin_id
      `).all(CHAT_ID)).toEqual([
        { stablecoin_id: "usdc-circle", alert_dews: 1, alert_depeg: 1, depeg_worsening_bps_step: 250 },
        { stablecoin_id: "usdt-tether", alert_dews: 1, alert_depeg: 1, depeg_worsening_bps_step: 250 },
      ]);
      expect(sqlite.prepare(`
        SELECT preset_id, alert_dews, alert_depeg, depeg_worsening_bps_step
          FROM telegram_preset_subscriptions
         WHERE chat_id = ?
      `).get(CHAT_ID)).toEqual({
        preset_id: "usd-top25",
        alert_dews: 1,
        alert_depeg: 1,
        depeg_worsening_bps_step: 250,
      });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_disambiguation").get())
        .toEqual({ count: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("rolls back the whole intent at every statement boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const probe = openSqlite();
    const batchSizes: number[] = [];
    await expect(applySubscribeIntent(createFaultInjectingD1(probe, {
      failAtBoundary: 0,
      batchSizes,
    }), subscribeInput)).rejects.toThrow("injected failure at boundary 0");
    const statementCount = batchSizes[0];
    probe.close();

    for (let boundary = 0; boundary <= statementCount; boundary += 1) {
      const sqlite = openSqlite();
      try {
        insertPending(sqlite);
        const before = stateSnapshot(sqlite);
        const db = createFaultInjectingD1(sqlite, { failAtBoundary: boundary });

        await expect(applySubscribeIntent(db, subscribeInput))
          .rejects.toThrow(`injected failure at boundary ${boundary}`);
        expect(stateSnapshot(sqlite)).toEqual(before);
      } finally {
        sqlite.close();
      }
    }
  });
});

describe("atomic Telegram unsubscribe intent", () => {
  it("commits coin removal, preset removal, activity touch, and pending clear in one batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const sqlite = openSqlite();
    const batchSizes: number[] = [];
    try {
      await applySubscribeIntent(createSqliteD1(sqlite), {
        ...subscribeInput,
        clearPending: false,
      });
      insertPending(sqlite);
      vi.setSystemTime(NOW_MS + 60_000);

      await applyUnsubscribeIntent(createFaultInjectingD1(sqlite, { batchSizes }), {
        chatId: CHAT_ID,
        directStablecoinIds: subscribeInput.directStablecoinIds,
        presetIds: subscribeInput.presetIds,
        clearPending: true,
      });

      expect(batchSizes).toEqual([4]);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions").get())
        .toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_preset_subscriptions").get())
        .toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_disambiguation").get())
        .toEqual({ count: 0 });
      expect(sqlite.prepare(
        "SELECT last_active_at, preference_generation FROM telegram_subscribers WHERE chat_id = ?",
      ).get(CHAT_ID)).toEqual({
        last_active_at: Math.floor((NOW_MS + 60_000) / 1000),
        preference_generation: 2,
      });
    } finally {
      sqlite.close();
    }
  });

  it("rolls back the whole intent at every statement boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const input = {
      chatId: CHAT_ID,
      directStablecoinIds: subscribeInput.directStablecoinIds,
      presetIds: subscribeInput.presetIds,
      clearPending: true,
    };
    const probe = openSqlite();
    const batchSizes: number[] = [];
    await expect(applyUnsubscribeIntent(createFaultInjectingD1(probe, {
      failAtBoundary: 0,
      batchSizes,
    }), input)).rejects.toThrow("injected failure at boundary 0");
    const statementCount = batchSizes[0];
    probe.close();

    for (let boundary = 0; boundary <= statementCount; boundary += 1) {
      const sqlite = openSqlite();
      try {
        await applySubscribeIntent(createSqliteD1(sqlite), {
          ...subscribeInput,
          clearPending: false,
        });
        insertPending(sqlite);
        const before = stateSnapshot(sqlite);
        const db = createFaultInjectingD1(sqlite, { failAtBoundary: boundary });

        await expect(applyUnsubscribeIntent(db, input))
          .rejects.toThrow(`injected failure at boundary ${boundary}`);
        expect(stateSnapshot(sqlite)).toEqual(before);
      } finally {
        sqlite.close();
      }
    }
  });

  it("keeps every tracked-coin mutation inside one bounded D1 batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const sqlite = openSqlite();
    const batchSizes: number[] = [];
    const stablecoinIds = Array.from({ length: 410 }, (_, index) => `coin-${index}`);
    const presetIds = Array.from({ length: 10 }, (_, index) => `preset-${index}`);
    const db = createFaultInjectingD1(sqlite, { batchSizes });
    try {
      await applySubscribeIntent(db, {
        chatId: CHAT_ID,
        username: null,
        directStablecoinIds: stablecoinIds,
        presetIds,
        alertTypes: new Set(["dews"]),
        clearPending: true,
      });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions").get())
        .toEqual({ count: 410 });
      expect(batchSizes).toHaveLength(1);
      expect(batchSizes[0]).toBeLessThanOrEqual(100);

      await applyUnsubscribeIntent(db, {
        chatId: CHAT_ID,
        directStablecoinIds: stablecoinIds,
        presetIds,
        clearPending: true,
      });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions").get())
        .toEqual({ count: 0 });
      expect(batchSizes).toHaveLength(2);
      expect(batchSizes[1]).toBeLessThanOrEqual(100);
    } finally {
      sqlite.close();
    }
  });
});

describe("atomic Telegram bulk/setup variants", () => {
  it("rolls back global setup together with its pending clear", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    for (let boundary = 0; boundary <= 2; boundary += 1) {
      const sqlite = openSqlite();
      try {
        insertPending(sqlite);
        const before = stateSnapshot(sqlite);
        const db = createFaultInjectingD1(sqlite, { failAtBoundary: boundary });

        await expect(upsertGlobalAlertTypes(
          db,
          CHAT_ID,
          "alice",
          new Set(["dews", "reserve"]),
          { clearPending: true },
        )).rejects.toThrow(`injected failure at boundary ${boundary}`);
        expect(stateSnapshot(sqlite)).toEqual(before);
      } finally {
        sqlite.close();
      }
    }
  });

  it("rolls back unsubscribe-all together with its pending clear", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    for (let boundary = 0; boundary <= 4; boundary += 1) {
      const sqlite = openSqlite();
      try {
        await applySubscribeIntent(createSqliteD1(sqlite), {
          ...subscribeInput,
          clearPending: false,
        });
        insertPending(sqlite);
        const before = stateSnapshot(sqlite);
        const db = createFaultInjectingD1(sqlite, { failAtBoundary: boundary });

        await expect(unsubscribeAll(db, CHAT_ID, { clearPending: true }))
          .rejects.toThrow(`injected failure at boundary ${boundary}`);
        expect(stateSnapshot(sqlite)).toEqual(before);
      } finally {
        sqlite.close();
      }
    }
  });
});
