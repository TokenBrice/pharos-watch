import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../../test-helpers/sqlite-d1";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";
import {
  loadPresetSubscriberRowsBatch,
  mergeSubscriberMaps,
} from "../../../cron/dispatch-telegram-subscribers";
import type { SubscriberRow } from "../../../cron/dispatch-telegram-routing";
import { applySubscribeIntent, applyUnsubscribeIntent } from "../presets";

const NOW = 1_783_680_000;

function migrationDirectory(): string {
  return process.cwd().endsWith("/worker")
    ? join(process.cwd(), "migrations")
    : join(process.cwd(), "worker/migrations");
}

function openLatestSchema(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const dir = migrationDirectory();
  for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, file), "utf8"));
  }
  return { sqlite, db: createSqliteD1(sqlite) };
}

function insertSubscriber(sqlite: DatabaseSync, chatId: string): void {
  sqlite.prepare(
    `INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at)
     VALUES (?, ?, ?)`,
  ).run(chatId, NOW, NOW);
}

function presetIds(sqlite: DatabaseSync, chatId: string): string[] {
  return (sqlite.prepare(
    "SELECT preset_id FROM telegram_preset_subscriptions WHERE chat_id = ? ORDER BY preset_id",
  ).all(chatId) as Array<{ preset_id: string }>).map((row) => row.preset_id);
}

function directRows(sqlite: DatabaseSync, chatId: string): unknown[] {
  return sqlite.prepare(
    `SELECT stablecoin_id, alert_dews, alert_depeg, alert_dews_override,
            alert_depeg_override, depeg_worsening_bps_step
       FROM telegram_subscriptions
      WHERE chat_id = ?
      ORDER BY stablecoin_id`,
  ).all(chatId);
}

function writeStablecoinsCache(sqlite: DatabaseSync, marketCaps: Record<string, number>): void {
  const value = JSON.stringify({
    peggedAssets: Object.entries(marketCaps).map(([id, circulating]) => ({
      id,
      symbol: id,
      name: id,
      circulating: { usd: circulating },
    })),
  });
  sqlite.prepare(
    `INSERT INTO cache (key, value, updated_at) VALUES ('stablecoins', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(value, NOW);
}

function subscriberRow(overrides: Partial<SubscriberRow> = {}): SubscriberRow {
  return {
    chat_id: "42",
    last_active_at: NOW,
    dews_min_band: null,
    safety_mode: null,
    depeg_worsening_bps_step: null,
    quiet_hours_enabled: 0,
    quiet_hours_start_utc: null,
    quiet_hours_end_utc: null,
    timezone: null,
    isGlobal: false,
    ...overrides,
  };
}

describe("Telegram direct/preset provenance on the latest schema", () => {
  it("preserves a direct follow when the same preset is followed and unfollowed", async () => {
    const { sqlite, db } = openLatestSchema();
    try {
      await applySubscribeIntent(db, {
        chatId: "direct-and-preset",
        username: "alice",
        directStablecoinIds: ["usdc-circle"],
        alertTypes: new Set(["dews"]),
      });
      const beforePreset = directRows(sqlite, "direct-and-preset");

      await applySubscribeIntent(db, {
        chatId: "direct-and-preset",
        username: "alice",
        directStablecoinIds: [],
        presetIds: ["usd-top25"],
        alertTypes: new Set(["dews", "depeg"]),
        depegWorseningBpsStep: 250,
      });
      expect(directRows(sqlite, "direct-and-preset")).toEqual(beforePreset);

      await applyUnsubscribeIntent(db, {
        chatId: "direct-and-preset",
        directStablecoinIds: [],
        presetIds: ["usd-top25"],
      });
      expect(directRows(sqlite, "direct-and-preset")).toEqual(beforePreset);
      expect(presetIds(sqlite, "direct-and-preset")).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("preserves explicit local off and tuning rows across preset lifecycle", async () => {
    const { sqlite, db } = openLatestSchema();
    try {
      insertSubscriber(sqlite, "local-policy");
      sqlite.prepare(
        `INSERT INTO telegram_subscriptions (
           chat_id, stablecoin_id, alert_dews, alert_dews_override,
           alert_depeg, alert_depeg_override, depeg_worsening_bps_step
         ) VALUES (?, 'usdc-circle', 0, 1, 1, 1, 500)`,
      ).run("local-policy");
      const localPolicy = directRows(sqlite, "local-policy");

      await applySubscribeIntent(db, {
        chatId: "local-policy",
        username: null,
        directStablecoinIds: [],
        presetIds: ["usd-top25"],
        alertTypes: new Set(["dews", "depeg"]),
        depegWorseningBpsStep: 100,
      });
      await applyUnsubscribeIntent(db, {
        chatId: "local-policy",
        directStablecoinIds: [],
        presetIds: ["usd-top25"],
      });

      expect(directRows(sqlite, "local-policy")).toEqual(localPolicy);
    } finally {
      sqlite.close();
    }
  });

  it("removes only the named source when presets overlap", async () => {
    const { sqlite, db } = openLatestSchema();
    try {
      await applySubscribeIntent(db, {
        chatId: "overlap",
        username: null,
        directStablecoinIds: [],
        presetIds: ["usd-top10", "usd-top25"],
        alertTypes: new Set(["dews"]),
      });
      expect(presetIds(sqlite, "overlap")).toEqual(["usd-top10", "usd-top25"]);
      expect(directRows(sqlite, "overlap")).toEqual([]);

      await applyUnsubscribeIntent(db, {
        chatId: "overlap",
        directStablecoinIds: [],
        presetIds: ["usd-top10"],
      });
      expect(presetIds(sqlite, "overlap")).toEqual(["usd-top25"]);

      await applyUnsubscribeIntent(db, {
        chatId: "overlap",
        directStablecoinIds: [],
        presetIds: ["usd-top25"],
      });
      expect(presetIds(sqlite, "overlap")).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("keeps ambiguous legacy materialized rows as conservative direct intent", async () => {
    const { sqlite, db } = openLatestSchema();
    try {
      insertSubscriber(sqlite, "legacy");
      sqlite.prepare(
        `INSERT INTO telegram_subscriptions (
           chat_id, stablecoin_id, alert_dews, alert_depeg, depeg_worsening_bps_step
         ) VALUES ('legacy', 'usdc-circle', 1, 1, 250)`,
      ).run();
      const legacy = directRows(sqlite, "legacy");

      await applySubscribeIntent(db, {
        chatId: "legacy",
        username: null,
        directStablecoinIds: [],
        presetIds: ["usd-top25"],
        alertTypes: new Set(["dews", "depeg"]),
      });
      await applyUnsubscribeIntent(db, {
        chatId: "legacy",
        directStablecoinIds: [],
        presetIds: ["usd-top25"],
      });

      expect(directRows(sqlite, "legacy")).toEqual(legacy);
    } finally {
      sqlite.close();
    }
  });

  it("resolves dynamic preset membership from the current cache at dispatch", async () => {
    const { sqlite, db } = openLatestSchema();
    try {
      insertSubscriber(sqlite, "dynamic");
      sqlite.prepare(
        `INSERT INTO telegram_preset_subscriptions (
           chat_id, preset_id, alert_dews, created_at, updated_at
         ) VALUES ('dynamic', 'mcap-ge-1b', 1, ?, ?)`,
      ).run(NOW, NOW);

      writeStablecoinsCache(sqlite, {
        "usdc-circle": 2_000_000_000,
        "usdt-tether": 500_000_000,
      });
      const first = await loadPresetSubscriberRowsBatch(
        db,
        ["usdc-circle", "usdt-tether"],
        "dews",
        NOW,
      );
      expect(first.kind).toBe("ok");
      if (first.kind !== "ok") return;
      expect([...first.rows.keys()]).toEqual(["usdc-circle"]);

      writeStablecoinsCache(sqlite, {
        "usdc-circle": 500_000_000,
        "usdt-tether": 2_000_000_000,
      });
      const second = await loadPresetSubscriberRowsBatch(
        db,
        ["usdc-circle", "usdt-tether"],
        "dews",
        NOW,
      );
      expect(second.kind).toBe("ok");
      if (second.kind !== "ok") return;
      expect([...second.rows.keys()]).toEqual(["usdt-tether"]);
      expect(directRows(sqlite, "dynamic")).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("keeps direct tuning authoritative in either merge order", () => {
    const direct = subscriberRow({ depeg_worsening_bps_step: 500, hasLocalOverride: true });
    const preset = subscriberRow({ depeg_worsening_bps_step: 100, hasLocalOverride: false });

    const directFirst = mergeSubscriberMaps(
      new Map([["usdc-circle", [direct]]]),
      new Map([["usdc-circle", [preset]]]),
    );
    const presetFirst = mergeSubscriberMaps(
      new Map([["usdc-circle", [preset]]]),
      new Map([["usdc-circle", [direct]]]),
    );
    expect(directFirst.get("usdc-circle")?.[0]?.depeg_worsening_bps_step).toBe(500);
    expect(presetFirst.get("usdc-circle")?.[0]?.depeg_worsening_bps_step).toBe(500);
  });

  it("combines overlapping preset tuning deterministically", () => {
    const first = subscriberRow({ depeg_worsening_bps_step: 500, hasLocalOverride: false });
    const second = subscriberRow({ depeg_worsening_bps_step: 100, hasLocalOverride: false });
    const merged = mergeSubscriberMaps(
      new Map([["usdc-circle", [first]]]),
      new Map([["usdc-circle", [second]]]),
    );
    expect(merged.get("usdc-circle")?.[0]?.depeg_worsening_bps_step).toBe(100);
  });

  it("rolls back direct and preset facts together at every statement boundary", async () => {
    for (let boundary = 0; boundary <= 3; boundary += 1) {
      const { sqlite } = openLatestSchema();
      const base = createSqliteD1(sqlite);
      const db = makeNoopD1({
        prepare: base.prepare.bind(base),
        batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
          sqlite.exec("BEGIN IMMEDIATE");
          try {
            const results: D1Result<T>[] = [];
            for (let index = 0; index < statements.length; index += 1) {
              if (index === boundary) throw new Error(`boundary ${boundary}`);
              results.push(await statements[index].run<T>());
            }
            if (boundary === statements.length) throw new Error(`boundary ${boundary}`);
            sqlite.exec("COMMIT");
            return results;
          } catch (error) {
            sqlite.exec("ROLLBACK");
            throw error;
          }
        },
      });
      try {
        await expect(applySubscribeIntent(db, {
          chatId: "rollback",
          username: null,
          directStablecoinIds: ["usdc-circle"],
          presetIds: ["usd-top25"],
          alertTypes: new Set(["dews"]),
        })).rejects.toThrow(`boundary ${boundary}`);
        expect(sqlite.prepare(
          "SELECT COUNT(*) AS count FROM telegram_subscribers WHERE chat_id = 'rollback'",
        ).get()).toEqual({ count: 0 });
        expect(directRows(sqlite, "rollback")).toEqual([]);
        expect(presetIds(sqlite, "rollback")).toEqual([]);
      } finally {
        sqlite.close();
      }
    }
  }, 30_000);
});
