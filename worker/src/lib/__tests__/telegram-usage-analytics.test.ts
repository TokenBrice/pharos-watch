import { afterEach, describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  bucketTelegramCommandLatency,
  classifyTelegramStartSource,
  computeTelegramCurrentLifecycleSnapshot,
  loadTelegramTopFollowedCoins,
  recordTelegramDeliveryOutcomes,
  recordTelegramUsageEvent,
} from "../telegram/usage-analytics";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

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

  it("classifies deep-link payloads without storing raw payloads", () => {
    expect(classifyTelegramStartSource("")).toBe("none");
    expect(classifyTelegramStartSource("setup")).toBe("setup");
    expect(classifyTelegramStartSource("sample")).toBe("sample");
    expect(classifyTelegramStartSource("sub_dews-depeg_usd-top25")).toBe("subscribe");
    expect(classifyTelegramStartSource("status_usdc-circle")).toBe("status");
    expect(classifyTelegramStartSource("why_usdc-circle")).toBe("why");
    expect(classifyTelegramStartSource("coverage_usdc-circle")).toBe("coverage");
    expect(classifyTelegramStartSource("unexpected_payload")).toBe("unknown");
  });

  it("buckets command latency for aggregate telemetry", () => {
    expect(bucketTelegramCommandLatency(null)).toBe("unknown");
    expect(bucketTelegramCommandLatency(120)).toBe("lt_250ms");
    expect(bucketTelegramCommandLatency(900)).toBe("250ms_1s");
    expect(bucketTelegramCommandLatency(2_500)).toBe("1s_3s");
    expect(bucketTelegramCommandLatency(8_000)).toBe("3s_10s");
    expect(bucketTelegramCommandLatency(12_000)).toBe("gte_10s");
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

  it("coalesces delivery diagnostics by chat before writing", async () => {
    const db = mockD1([{ match: "INSERT INTO telegram_chat_delivery_diagnostics", rows: [] }]);

    await recordTelegramDeliveryOutcomes(db, [
      { chatId: "42", ok: false, errorClass: "timeout", nowSec: 100 },
      { chatId: "42", ok: true, nowSec: 101 },
      { chatId: "43", ok: false, errorClass: "rate_limit", nowSec: 102 },
      { chatId: "43", ok: false, errorClass: "network", nowSec: 103 },
    ]);

    const inserts = db.getHistory().filter((entry) => entry.sql.includes("INSERT INTO telegram_chat_delivery_diagnostics"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.binds).toEqual(["42", 101, null, 101, null, 101]);
    expect(inserts[1]?.binds).toEqual(["43", null, null, 103, "network", 103]);
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
