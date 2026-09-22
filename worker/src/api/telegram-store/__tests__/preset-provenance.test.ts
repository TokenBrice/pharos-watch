import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { mergeSubscriberMaps } from "../../../cron/dispatch-telegram-subscribers";
import { loadTelegramSourcePresetSubscribersForChats } from "../../../cron/telegram-alert-source-memberships";
import type { SubscriberRow } from "../../../cron/dispatch-telegram-routing";
import { applySubscribeIntent, applyUnsubscribeIntent } from "../presets";

const NOW = 1_783_680_000;


function openLatestSchema(): { sqlite: DatabaseSync; db: D1Database } {
  return createLatestSchemaSqlite();
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

  it("loads captured preset provenance through the source-scoped dispatch path", async () => {
    const { sqlite, db } = openLatestSchema();
    try {
      insertSubscriber(sqlite, "dynamic");
      sqlite.prepare(
        `INSERT INTO telegram_preset_subscriptions (
           chat_id, preset_id, alert_dews, created_at, updated_at
         ) VALUES ('dynamic', 'mcap-ge-1b', 1, ?, ?)`,
      ).run(NOW, NOW);
      sqlite.prepare(
        `INSERT INTO telegram_alert_source_resolution_pages (
           source_event_id, page_key, alert_type, page_index, memberships_resolved,
           status, created_at, updated_at, completed_at
         ) VALUES ('source-1', 'dews:0', 'dews', 0, 1, 'complete', ?, ?, ?)`,
      ).run(NOW, NOW, NOW);
      sqlite.prepare(
        `INSERT INTO telegram_alert_source_resolution_memberships (
           source_event_id, alert_type, preset_id, stablecoin_id, created_at
         ) VALUES ('source-1', 'dews', 'mcap-ge-1b', 'usdc-circle', ?)`,
      ).run(NOW);
      sqlite.prepare(
        `INSERT INTO telegram_alert_source_resolution_targets (
           source_event_id, page_key, preset_id, chat_id, created_at
         ) VALUES ('source-1', 'dews:0', 'mcap-ge-1b', 'dynamic', ?)`,
      ).run(NOW);

      const loaded = await loadTelegramSourcePresetSubscribersForChats(
        db,
        "source-1",
        "dews",
        ["dynamic"],
        NOW,
      );
      expect(loaded.kind).toBe("ok");
      if (loaded.kind !== "ok") return;
      expect([...loaded.rows.keys()]).toEqual(["usdc-circle"]);
      expect(loaded.rows.get("usdc-circle")?.[0]).toMatchObject({
        chat_id: "dynamic",
        hasLocalOverride: false,
      });
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

});
