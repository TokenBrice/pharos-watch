import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import {
  applySubscribeIntent,
  applyUnsubscribeIntent,
  prepareSubscriberAndPresetPatchStatements,
} from "../presets";
import { unsubscribeAll } from "../subscriber-lifecycle";
import { upsertGlobalAlertTypes } from "../subscribers";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";

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
  return makeNoopD1({
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
  });
}

function openSqlite(): DatabaseSync {
  const sqlite = createLatestSchemaSqlite().sqlite;
  return sqlite;
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
  };
}

const subscribeInput = {
  chatId: CHAT_ID,
  username: "alice",
  directStablecoinIds: ["usdc-circle", "usdt-tether"],
  presetIds: ["usd-top25"],
  alertTypes: new Set(["dews", "depeg"]),
  depegWorseningBpsStep: 250 as const,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("atomic Telegram subscribe intent", () => {
  it("keeps repeated command subscriptions additive while Mini App edits replace exact families", async () => {
    const sqlite = openSqlite();
    const db = createSqliteD1(sqlite);
    try {
      await applySubscribeIntent(db, { ...subscribeInput, directStablecoinIds: [], alertTypes: new Set(["dews"]), depegWorseningBpsStep: undefined });
      await applySubscribeIntent(db, { ...subscribeInput, directStablecoinIds: [], alertTypes: new Set(["safety"]), depegWorseningBpsStep: undefined });
      expect(sqlite.prepare("SELECT alert_dews, alert_depeg, alert_safety FROM telegram_preset_subscriptions").get())
        .toEqual({ alert_dews: 1, alert_depeg: 0, alert_safety: 1 });
      await db.batch(prepareSubscriberAndPresetPatchStatements(db, CHAT_ID, "alice", "usd-top25", { dews: false, depeg: false, safety: true }, null));
      expect(sqlite.prepare("SELECT alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step FROM telegram_preset_subscriptions").get())
        .toEqual({ alert_dews: 0, alert_depeg: 0, alert_safety: 1, depeg_worsening_bps_step: null });
    } finally {
      sqlite.close();
    }
  });

  it("rolls preset replacement, subscriber activity and generation back together on failure", async () => {
    const sqlite = openSqlite();
    try {
      await applySubscribeIntent(createSqliteD1(sqlite), subscribeInput);
      const before = stateSnapshot(sqlite);
      const db = createFaultInjectingD1(sqlite, { failAtBoundary: 1 });
      await expect(db.batch(prepareSubscriberAndPresetPatchStatements(
        db, CHAT_ID, "changed-name", "usd-top25", { dews: false, depeg: false, safety: true }, null,
      ))).rejects.toThrow("injected failure at boundary 1");
      expect(stateSnapshot(sqlite)).toEqual(before);
    } finally {
      sqlite.close();
    }
  });

  it("commits subscriber, coin, and preset statements in one batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const sqlite = openSqlite();
    const batchSizes: number[] = [];
    try {
      await applySubscribeIntent(createFaultInjectingD1(sqlite, { batchSizes }), subscribeInput);

      // Both direct and preset enable kernels enlist their idempotent first-follow claims.
      expect(batchSizes).toEqual([8]);
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
  it("commits coin removal, preset removal, and activity touch in one batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const sqlite = openSqlite();
    const batchSizes: number[] = [];
    try {
      await applySubscribeIntent(createSqliteD1(sqlite), subscribeInput);
      vi.setSystemTime(NOW_MS + 60_000);

      await applyUnsubscribeIntent(createFaultInjectingD1(sqlite, { batchSizes }), {
        chatId: CHAT_ID,
        directStablecoinIds: subscribeInput.directStablecoinIds,
        presetIds: subscribeInput.presetIds,
      });

      expect(batchSizes).toEqual([3]);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions").get())
        .toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_preset_subscriptions").get())
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
        await applySubscribeIntent(createSqliteD1(sqlite), subscribeInput);
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
      });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_subscriptions").get())
        .toEqual({ count: 410 });
      expect(batchSizes).toHaveLength(1);
      expect(batchSizes[0]).toBeLessThanOrEqual(100);

      await applyUnsubscribeIntent(db, {
        chatId: CHAT_ID,
        directStablecoinIds: stablecoinIds,
        presetIds,
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
  it("rolls back global setup atomically", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    for (let boundary = 0; boundary <= 2; boundary += 1) {
      const sqlite = openSqlite();
      try {
        const before = stateSnapshot(sqlite);
        const db = createFaultInjectingD1(sqlite, { failAtBoundary: boundary });

        await expect(upsertGlobalAlertTypes(
          db,
          CHAT_ID,
          "alice",
          new Set(["dews", "reserve"]),
        )).rejects.toThrow(`injected failure at boundary ${boundary}`);
        expect(stateSnapshot(sqlite)).toEqual(before);
      } finally {
        sqlite.close();
      }
    }
  });

  it("rolls back unsubscribe-all atomically", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    for (let boundary = 0; boundary <= 3; boundary += 1) {
      const sqlite = openSqlite();
      try {
        await applySubscribeIntent(createSqliteD1(sqlite), subscribeInput);
        const before = stateSnapshot(sqlite);
        const db = createFaultInjectingD1(sqlite, { failAtBoundary: boundary });

        await expect(unsubscribeAll(db, CHAT_ID))
          .rejects.toThrow(`injected failure at boundary ${boundary}`);
        expect(stateSnapshot(sqlite)).toEqual(before);
      } finally {
        sqlite.close();
      }
    }
  });
});
