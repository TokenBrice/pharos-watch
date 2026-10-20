import { afterEach, describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  computeTelegramCurrentLifecycleSnapshot,
  loadTelegramLifecycleHistory,
  loadTelegramTopFollowedCoins,
  recordTelegramUsageEvent,
  refreshTelegramLifecycleSnapshotIfStale,
} from "../usage-analytics";
import { recordTelegramDeliveryOutcomes, recordTelegramReplyOutcome } from "../usage-analytics-writes";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { publishTelegramPulseSnapshot } from "../../webhook/telegram-pulse";
import { cachedPulse, pulseCacheTables } from "../../webhook/__tests__/telegram-pulse.test-support.ts";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(fixtures.closeAll);

function recordDiagnostic(
  mode: "reply" | "delivery",
  db: D1Database,
  input: Parameters<typeof recordTelegramReplyOutcome>[1],
) {
  return mode === "reply"
    ? recordTelegramReplyOutcome(db, input)
    : recordTelegramDeliveryOutcomes(db, [input]);
}

describe("telegram usage analytics", () => {
  it.each(["empty", "direct", "global", "preset", "mixed"])(
    "matches the previous lifecycle SQL for every family mask from %s sources",
    async (source) => {
      const { sqlite, db } = fixtures.open();
      const subscriber = sqlite.prepare(`INSERT INTO telegram_subscribers
        (chat_id, created_at, last_active_at, global_alert_dews, global_alert_depeg,
         global_alert_safety, global_alert_launch, global_alert_reserve, global_alert_freeze)
        VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?)`);
      const direct = sqlite.prepare(`INSERT INTO telegram_subscriptions
        (chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, alert_reserve, alert_freeze)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const preset = sqlite.prepare(`INSERT INTO telegram_preset_subscriptions
        (chat_id, preset_id, created_at, updated_at, alert_dews, alert_depeg, alert_safety)
        VALUES (?, 'mcap-ge-1b', 1, 1, ?, ?, ?)`);
      for (let mask = 0; source !== "empty" && mask < 64; mask++) {
        const flags = Array.from({ length: 6 }, (_, index) => (mask >> index) & 1);
        const chat = `${source}-${mask}`;
        subscriber.run(chat, ...flags.map((flag, index) =>
          source === "global" || (source === "mixed" && index % 2 === 1) ? flag : 0));
        if (source === "direct" || source === "mixed") {
          const directFlags = flags.map((flag, index) => source === "direct" || index % 2 === 0 ? flag : 0);
          direct.run(chat, "coin-a", ...directFlags);
          if (source === "mixed") direct.run(chat, "coin-b", ...directFlags);
        }
        if (source === "preset" || source === "mixed") preset.run(chat, ...flags.slice(0, 3));
      }
      // Independent pre-refactor predicates and rollups; no production SQL builders in the oracle.
      const previous = sqlite.prepare(`WITH sub AS (
        SELECT chat_id, MAX(alert_dews = 1) AS dews_enabled, MAX(alert_depeg = 1) AS depeg_enabled,
          MAX(alert_safety = 1) AS safety_enabled, MAX(alert_launch = 1) AS launch_enabled,
          MAX(alert_reserve = 1) AS reserve_enabled, MAX(alert_freeze = 1) AS freeze_enabled
        FROM telegram_subscriptions GROUP BY chat_id
      ), preset AS (
        SELECT chat_id, MAX(alert_dews = 1) AS dews_enabled, MAX(alert_depeg = 1) AS depeg_enabled,
          MAX(alert_safety = 1) AS safety_enabled FROM telegram_preset_subscriptions
        WHERE alert_dews = 1 OR alert_depeg = 1 OR alert_safety = 1 GROUP BY chat_id
      ), enabled AS (
        SELECT
          COALESCE(sub.dews_enabled, 0) = 1 OR COALESCE(preset.dews_enabled, 0) = 1 OR s.global_alert_dews = 1 AS dews,
          COALESCE(sub.depeg_enabled, 0) = 1 OR COALESCE(preset.depeg_enabled, 0) = 1 OR s.global_alert_depeg = 1 AS depeg,
          COALESCE(sub.safety_enabled, 0) = 1 OR COALESCE(preset.safety_enabled, 0) = 1 OR s.global_alert_safety = 1 AS safety,
          COALESCE(sub.launch_enabled, 0) = 1 OR s.global_alert_launch = 1 AS launch,
          COALESCE(sub.reserve_enabled, 0) = 1 OR s.global_alert_reserve = 1 AS reserve,
          COALESCE(sub.freeze_enabled, 0) = 1 OR s.global_alert_freeze = 1 AS freeze
        FROM telegram_subscribers s LEFT JOIN sub ON sub.chat_id = s.chat_id
        LEFT JOIN preset ON preset.chat_id = s.chat_id
      ) SELECT SUM(dews) AS dews, SUM(depeg) AS depeg, SUM(safety) AS safety,
        SUM(launch) AS launch, SUM(reserve) AS reserve, SUM(freeze) AS freeze,
        SUM(CASE WHEN dews AND depeg AND safety AND launch AND reserve AND freeze THEN 1 ELSE 0 END) AS allTypes
        FROM enabled`).get()!;
      const snapshot = await computeTelegramCurrentLifecycleSnapshot(db, 1_771_833_600, { pendingDeliveryCount: 0 });
      expect(snapshot.alertTypeOptIns).toEqual(Object.fromEntries(
        Object.entries(previous).map(([family, count]) => [family, Number(count ?? 0)]),
      ));
      expect(snapshot.activeWatchers).toBe(source === "empty" ? 0 : source === "preset" ? 56 : 63);
      expect(snapshot.explicitCoinFollows).toBe(source === "direct" ? 63 : source === "mixed" ? 112 : 0);
      expect(snapshot.activePresetFollowers).toBe(source === "preset" || source === "mixed" ? 56 : 0);
      if (source === "preset" || source === "mixed") {
        expect(snapshot.unavailableFields).toContain("presetImpliedCoinSubscriptions");
      }
    },
  );

  it("upserts every supported historical column without adding live-only families or overwriting unavailable evidence", async () => {
    const { sqlite, db } = fixtures.open();
    const current = await computeTelegramCurrentLifecycleSnapshot(db, 1_771_833_600, { pendingDeliveryCount: 0 });
    for (const offset of [0, 900]) {
      const value = offset === 0 ? 10 : 30;
      await refreshTelegramLifecycleSnapshotIfStale(db, current.snapshotAt + offset, {
        ...current, snapshotAt: current.snapshotAt + offset, activeWatchers: value,
        newWatchers: value + 1, churnedWatchers: value + 2, reactivatedWatchers: value + 3,
        explicitCoinFollows: value + 4, presetImpliedCoinFollows: value + 5, activePresetFollowers: value + 6,
        alertTypeOptIns: { dews: value + 7, depeg: value + 8, safety: value + 9, launch: value + 10,
          reserve: 101, freeze: 102, allTypes: 103 },
        quietHoursEnabledChats: value + 11, pendingDeliveries: value + 12,
      });
      expect(sqlite.prepare("SELECT * FROM telegram_watcher_lifecycle_daily").all()).toEqual([{
        day: current.day, snapshot_at: current.snapshotAt + offset, active_watchers: value,
        new_watchers: value + 1, churned_watchers: value + 2, reactivated_watchers: value + 3,
        explicit_coin_follows: value + 4, preset_implied_coin_follows: value + 5, active_preset_followers: value + 6,
        active_dews_opt_ins: value + 7, active_depeg_opt_ins: value + 8,
        active_safety_opt_ins: value + 9, active_launch_opt_ins: value + 10,
        quiet_hours_enabled_chats: value + 11, pending_deliveries: value + 12,
      }]);
    }
    for (const missing of ["newWatchers", "churnedWatchers", "reactivatedWatchers", "presetImpliedCoinFollows", "pendingDeliveries"]) {
      await refreshTelegramLifecycleSnapshotIfStale(db, current.snapshotAt + 1_800, {
        ...current, ...(missing === "pendingDeliveries" ? { unavailableFields: [missing] } : { [missing]: null }),
      });
      expect(sqlite.prepare("SELECT snapshot_at, active_watchers FROM telegram_watcher_lifecycle_daily").get())
        .toEqual({ snapshot_at: current.snapshotAt + 900, active_watchers: 30 });
    }
  });

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

describe("telegram delivery diagnostics", () => {
  it.each(["reply", "delivery"] as const)("keeps %s clocks monotonic across descending writes", async (mode) => {
    const { sqlite, db } = fixtures.open();
    await recordDiagnostic(mode, db, { chatId: "chat", ok: true, nowSec: 200 });
    await recordDiagnostic(mode, db, { chatId: "chat", ok: false, errorClass: "blocked", nowSec: 300 });
    await recordDiagnostic(mode, db, { chatId: "chat", ok: true, nowSec: 100 });
    await recordDiagnostic(mode, db, { chatId: "chat", ok: false, errorClass: "timeout", nowSec: 250 });

    expect(sqlite.prepare("SELECT * FROM telegram_chat_delivery_diagnostics").get()).toEqual({
      chat_id: "chat",
      last_successful_delivery_at: mode === "delivery" ? 200 : null,
      last_successful_reply_at: mode === "reply" ? 200 : null,
      last_delivery_attempt_at: 300,
      recent_failure_class: "blocked",
      updated_at: 300,
    });

    await recordDiagnostic(mode, db, { chatId: "chat", ok: true, nowSec: 400 });
    expect(sqlite.prepare("SELECT * FROM telegram_chat_delivery_diagnostics").get()).toMatchObject({
      last_successful_delivery_at: mode === "delivery" ? 400 : null,
      last_successful_reply_at: mode === "reply" ? 400 : null,
      last_delivery_attempt_at: 400,
      recent_failure_class: null,
      updated_at: 400,
    });
  });

  it.each([false, true])("preserves separate success clocks and latest failure across interleavings (reverse=%s)", async (reverse) => {
    const { sqlite, db } = fixtures.open();
    const outcomes = [
      { mode: "delivery", ok: false, errorClass: "blocked", nowSec: 300 },
      { mode: "reply", ok: true, nowSec: 100 },
      { mode: "delivery", ok: true, nowSec: 200 },
      { mode: "reply", ok: false, errorClass: "timeout", nowSec: 250 },
      { mode: "reply", ok: true, nowSec: 50 },
    ] as const;
    for (const { mode, ...outcome } of reverse ? [...outcomes].reverse() : outcomes) {
      await recordDiagnostic(mode, db, { chatId: "chat", ...outcome });
    }

    expect(sqlite.prepare("SELECT * FROM telegram_chat_delivery_diagnostics").get()).toEqual({
      chat_id: "chat",
      last_successful_delivery_at: 200,
      last_successful_reply_at: 100,
      last_delivery_attempt_at: 300,
      recent_failure_class: "blocked",
      updated_at: 300,
    });
  });

  it.each([
    ["reply", "reply"], ["delivery", "delivery"], ["reply", "delivery"], ["delivery", "reply"],
  ] as const)("retains equal-second %s failures with %s successes in either order", async (failureMode, successMode) => {
    const { sqlite, db } = fixtures.open();
    for (const failureFirst of [false, true]) {
      const failure = { chatId: String(failureFirst), ok: false, errorClass: "blocked", nowSec: 100 };
      const success = { chatId: String(failureFirst), ok: true, nowSec: 100 };
      if (failureFirst) {
        await recordDiagnostic(failureMode, db, failure);
        await recordDiagnostic(successMode, db, success);
      } else {
        await recordDiagnostic(successMode, db, success);
        await recordDiagnostic(failureMode, db, failure);
      }
      expect(sqlite.prepare("SELECT * FROM telegram_chat_delivery_diagnostics WHERE chat_id = ?")
        .get(String(failureFirst))).toEqual({
        chat_id: String(failureFirst),
        last_successful_delivery_at: successMode === "delivery" ? 100 : null,
        last_successful_reply_at: successMode === "reply" ? 100 : null,
        last_delivery_attempt_at: 100,
        recent_failure_class: "blocked",
        updated_at: 100,
      });
    }
  });

  it("uses the last observed failure among equal-second failures across and within batches", async () => {
    const { sqlite, db } = fixtures.open();
    await recordTelegramDeliveryOutcomes(db, [
      { chatId: "chat", ok: false, errorClass: "blocked", nowSec: 100 },
      { chatId: "chat", ok: false, errorClass: "timeout", nowSec: 100 },
    ]);
    expect(sqlite.prepare("SELECT recent_failure_class FROM telegram_chat_delivery_diagnostics").get())
      .toEqual({ recent_failure_class: "timeout" });
    await recordTelegramReplyOutcome(db, { chatId: "chat", ok: false, errorClass: "forbidden", nowSec: 100 });
    expect(sqlite.prepare("SELECT recent_failure_class FROM telegram_chat_delivery_diagnostics").get())
      .toEqual({ recent_failure_class: "forbidden" });
    await recordTelegramDeliveryOutcomes(db, [{ chatId: "chat", ok: false, errorClass: "unknown", nowSec: 100 }]);
    expect(sqlite.prepare("SELECT recent_failure_class FROM telegram_chat_delivery_diagnostics").get())
      .toEqual({ recent_failure_class: "unknown" });
  });

  it("fills nullable historical clocks without decreasing an existing update clock", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec("INSERT INTO telegram_chat_delivery_diagnostics (chat_id, updated_at) VALUES ('chat', 500)");
    await recordTelegramDeliveryOutcomes(db, [{ chatId: "chat", ok: true, nowSec: 100 }]);
    await recordTelegramReplyOutcome(db, { chatId: "chat", ok: true, nowSec: 90 });
    expect(sqlite.prepare("SELECT * FROM telegram_chat_delivery_diagnostics").get()).toEqual({
      chat_id: "chat",
      last_successful_delivery_at: 100,
      last_successful_reply_at: 90,
      last_delivery_attempt_at: 100,
      recent_failure_class: null,
      updated_at: 500,
    });
  });

  it.each(["reply", "delivery"] as const)("keeps %s diagnostics best-effort on persistence failure", async (mode) => {
    const db = mockD1([{
      match: "INSERT INTO telegram_chat_delivery_diagnostics",
      rows: [],
      throwError: new Error("diagnostics unavailable"),
    }]);
    await expect(recordDiagnostic(mode, db, { chatId: "chat", ok: true, nowSec: 100 })).resolves.toBeUndefined();
  });
});
