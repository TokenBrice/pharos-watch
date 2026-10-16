import { afterEach, describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  computeTelegramCurrentLifecycleSnapshot,
  loadTelegramLifecycleHistory,
  loadTelegramTopFollowedCoins,
  recordTelegramUsageEvent,
  refreshTelegramLifecycleSnapshotIfStale,
} from "../telegram/usage-analytics";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { publishTelegramPulseSnapshot } from "../../api/telegram-pulse";
import { cachedPulse, pulseCacheTables } from "../../api/__tests__/telegram-pulse.test-support";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(fixtures.closeAll);

describe("telegram usage analytics", () => {
  it("includes freeze opt-ins in lifecycle counts and all-family watcher gating", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`
      INSERT INTO telegram_subscribers
        (chat_id, created_at, last_active_at, global_alert_freeze)
      VALUES ('freeze-only', 1771833600, 1771833600, 1);
      INSERT INTO telegram_subscribers
        (chat_id, created_at, last_active_at, global_alert_dews, global_alert_depeg,
         global_alert_safety, global_alert_launch, global_alert_reserve, global_alert_freeze)
      VALUES ('all-families', 1771833600, 1771833600, 1, 1, 1, 1, 1, 1);
    `);

    const snapshot = await computeTelegramCurrentLifecycleSnapshot(db, 1_771_833_600, {
      pendingDeliveryCount: 0,
    });

    expect(snapshot.activeWatchers).toBe(2);
    expect(snapshot.alertTypeOptIns).toEqual({
      dews: 1, depeg: 1, safety: 1, launch: 1, reserve: 1, freeze: 2, allTypes: 1,
    });
  });

  it("counts only pending delivery rows in lifecycle snapshots", async () => {
    const { sqlite, db } = fixtures.open();
    const insert = sqlite.prepare(
      "INSERT INTO telegram_pending_alerts (chat_id, message_html, created_at, delivery_state) VALUES (?, 'test', ?, ?)",
    );
    for (let index = 0; index < 3; index += 1) {
      insert.run(`pending-${index}`, 1_771_833_600, "pending");
    }
    for (const state of ["sending", "sent", "execution_unknown"] as const) {
      for (let index = 0; index < 4; index += 1) {
        insert.run(`${state}-${index}`, 1_771_833_600, state);
      }
    }

    const snapshot = await computeTelegramCurrentLifecycleSnapshot(db, 1_771_833_600);

    expect(snapshot.pendingDeliveries).toBe(3);
  });

  it.each([
    { precomputed: false, existingSnapshotAt: null },
    { precomputed: true, existingSnapshotAt: null },
    { precomputed: false, existingSnapshotAt: 1_771_832_700 },
    { precomputed: true, existingSnapshotAt: 1_771_832_700 },
  ])("skips lifecycle upserts on failed pending reads ($precomputed, $existingSnapshotAt)", async ({
    precomputed,
    existingSnapshotAt,
  }) => {
    const nowSec = 1_771_833_600;
    const db = mockD1([
      { match: "FROM telegram_subscribers s", rows: [] },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
      { match: "FROM telegram_watcher_lifecycle_events_daily", rows: [] },
      { match: "FROM telegram_pending_alerts", rows: [], throwError: new Error("pending read failed") },
      {
        match: "SELECT snapshot_at FROM telegram_watcher_lifecycle_daily",
        rows: existingSnapshotAt == null ? [] : [{ snapshot_at: existingSnapshotAt }],
      },
    ]);
    const current = precomputed
      ? await computeTelegramCurrentLifecycleSnapshot(db, nowSec)
      : undefined;

    const snapshot = await refreshTelegramLifecycleSnapshotIfStale(db, nowSec, current);

    expect(snapshot.unavailableFields).toEqual(["pendingDeliveries"]);
    expect(snapshot.newWatchers).toBe(0);
    expect(snapshot.churnedWatchers).toBe(0);
    expect(snapshot.reactivatedWatchers).toBe(0);
    expect(snapshot.presetImpliedCoinFollows).toBe(0);
    expect(db.getHistory().filter((entry) => entry.sql.includes("FROM telegram_pending_alerts"))).toHaveLength(1);
    expect(db.getHistory().some((entry) =>
      entry.sql.includes("INSERT INTO telegram_watcher_lifecycle_daily"),
    )).toBe(false);
  });

  it.each([0, 7])("persists an observed pending-delivery count of %i", async (pendingCount) => {
    const nowSec = 1_771_833_600;
    const db = mockD1([
      { match: "FROM telegram_subscribers s", rows: [] },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
      { match: "FROM telegram_watcher_lifecycle_events_daily", rows: [] },
      { match: "FROM telegram_pending_alerts", rows: [{ pending_count: pendingCount }] },
      { match: "SELECT snapshot_at FROM telegram_watcher_lifecycle_daily", rows: [] },
      { match: "INSERT INTO telegram_watcher_lifecycle_daily", rows: [] },
    ]);

    const snapshot = await refreshTelegramLifecycleSnapshotIfStale(db, nowSec);

    expect(snapshot.pendingDeliveries).toBe(pendingCount);
    expect(snapshot.unavailableFields).toEqual([]);
    const upserts = db.getHistory().filter((entry) =>
      entry.sql.includes("INSERT INTO telegram_watcher_lifecycle_daily"),
    );
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.binds[14]).toBe(pendingCount);
  });

  it("keeps public pulse pending deliveries null with partial quality on a failed read", async () => {
    const nowSec = 1_771_833_600;
    const db = mockD1([
      ...pulseCacheTables(cachedPulse(nowSec), nowSec),
      { match: "FROM telegram_subscribers s", rows: [] },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
      { match: "FROM telegram_watcher_lifecycle_events_daily", rows: [] },
      { match: "FROM telegram_pending_alerts", rows: [], throwError: new Error("pending read failed") },
      { match: "SELECT snapshot_at FROM telegram_watcher_lifecycle_daily", rows: [] },
      // Empty cached history triggers a heavy-section rebuild; keep every other read available.
      { match: "FROM telegram_subscriptions", rows: [] },
      { match: "FROM telegram_watcher_lifecycle_daily", rows: [] },
      { match: "FROM telegram_usage_daily", rows: [] },
      { match: "FROM telegram_adoption_daily", rows: [] },
      { match: "FROM telegram_adoption_retention_daily", rows: [] },
      { match: "INSERT INTO telegram_adoption_retention_daily", rows: [] },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
      { match: "INSERT INTO cache", rows: [], runMeta: { changes: 1 } },
    ]);

    const pulse = await publishTelegramPulseSnapshot(db, nowSec);

    expect(pulse.pendingDeliveries).toBeNull();
    expect(pulse.quality).toEqual({ status: "partial", unavailableFields: ["pendingDeliveries"] });
    expect(pulse.privacy.suppressedFields).not.toContain("pendingDeliveries");
    expect(db.getHistory().some((entry) =>
      entry.sql.includes("INSERT INTO telegram_watcher_lifecycle_daily"),
    )).toBe(false);
  });

  it("counts subscribe, unsubscribe, and reactivate transitions independently", async () => {
    const { sqlite, db } = fixtures.open();
    const nowSec = Math.floor(Date.now() / 1000);
    sqlite.prepare(
      "INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('lifecycle', ?, ?)",
    ).run(nowSec, nowSec);
    sqlite.exec("UPDATE telegram_subscribers SET global_alert_dews = 1 WHERE chat_id = 'lifecycle'");
    sqlite.exec("UPDATE telegram_subscribers SET global_alert_dews = 0 WHERE chat_id = 'lifecycle'");
    sqlite.exec("UPDATE telegram_subscribers SET global_alert_dews = 1 WHERE chat_id = 'lifecycle'");

    const snapshot = await computeTelegramCurrentLifecycleSnapshot(db, nowSec, {
      pendingDeliveryCount: 0,
    });

    expect(snapshot.newWatchers).toBe(1);
    expect(snapshot.churnedWatchers).toBe(1);
    expect(snapshot.reactivatedWatchers).toBe(1);
  });

  it("bounds lifecycle history to complete days in the explicit window", async () => {
    const db = mockD1([{
      match: "FROM telegram_watcher_lifecycle_daily",
      rows: [{
        day: "2026-02-22",
        snapshot_at: 1_771_747_200,
        active_watchers: 10,
        new_watchers: 5,
        churned_watchers: 2,
        reactivated_watchers: 1,
      }],
    }]);

    const history = await loadTelegramLifecycleHistory(db, 1_771_833_600);

    expect(history.points.map((point) => point.date)).toEqual(["2026-02-22"]);
    const query = db.getHistory().find((entry) => entry.sql.includes("FROM telegram_watcher_lifecycle_daily"));
    expect(query?.sql).toContain("WHERE day >= ? AND day < ?");
    expect(query?.sql).toContain("LIMIT ?");
    expect(query?.binds[1]).toBe("2026-02-23");
  });
  it("publishes preset-implied adoption as unavailable when preset resolution fails", async () => {
    const { sqlite, db } = fixtures.open();
    const nowSec = Math.floor(Date.now() / 1000);
    sqlite.prepare(
      "INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('preset', ?, ?)",
    ).run(nowSec, nowSec);
    sqlite.prepare(
      `INSERT INTO telegram_preset_subscriptions
         (chat_id, preset_id, alert_dews, created_at, updated_at)
       VALUES ('preset', 'mcap-ge-1b', 1, ?, ?)`,
    ).run(nowSec, nowSec);

    const snapshot = await computeTelegramCurrentLifecycleSnapshot(db, nowSec, {
      pendingDeliveryCount: 0,
    });

    expect(snapshot.presetImpliedCoinFollows).toBeNull();
    expect(snapshot.unavailableFields).toEqual(
      expect.arrayContaining(["presetImpliedCoinSubscriptions", "topCoins"]),
    );
  });

  it("upserts usage events by incrementing daily aggregate counters", async () => {
    const { sqlite, db } = fixtures.open();
    for (const nowSec of [1_771_833_600, 1_771_833_700]) {
      await recordTelegramUsageEvent(db, {
        nowSec,
        eventType: "subscribe",
        sourceCategory: "deep link!",
        actionDetail: "usd-top25",
        outcome: "success",
        latencyMs: 700,
      });
    }
    expect(sqlite.prepare("SELECT * FROM telegram_usage_daily").all()).toEqual([{
      day: "2026-02-23",
      event_type: "subscribe",
      source_category: "deep_link_",
      action_detail: "usd-top25",
      outcome: "success",
      latency_bucket: "250ms_1s",
      failure_class: "",
      count: 2,
      first_seen_at: 1_771_833_600,
      last_seen_at: 1_771_833_700,
    }]);
  });

  it("normalizes unknown command action details to a fixed bucket", async () => {
    const db = mockD1([{ match: "INSERT INTO telegram_usage_daily", rows: [] }]);

    await recordTelegramUsageEvent(db, {
      nowSec: 1_771_833_600,
      eventType: "unknown_command",
      actionDetail: "/attacker-controlled-token",
      outcome: "unknown",
    });

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_usage_daily"));
    expect(insert?.binds[3]).toBe("unknown");
  });

  it("merges explicit top-coin follows with the preset-aware shape", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_subscriptions",
        rows: [
          { stablecoin_id: "usdc-circle", subscribers: "5" },
          { stablecoin_id: "usdt-tether", subscribers: "7" },
        ],
      },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
    ]);

    await expect(loadTelegramTopFollowedCoins(db, 2)).resolves.toEqual([
      {
        stablecoinId: "usdt-tether",
        explicitSubscribers: 7,
        presetImpliedSubscribers: 0,
        subscribers: 7,
      },
      {
        stablecoinId: "usdc-circle",
        explicitSubscribers: 5,
        presetImpliedSubscribers: 0,
        subscribers: 5,
      },
    ]);
  });
});
