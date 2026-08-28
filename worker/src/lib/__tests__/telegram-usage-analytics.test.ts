import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import {
  bucketTelegramCommandLatency,
  classifyTelegramStartSource,
  computeTelegramCurrentLifecycleSnapshot,
  loadTelegramTopFollowedCoins,
  recordTelegramDeliveryOutcomes,
  recordTelegramUsageEvent,
} from "../telegram-usage-analytics";

describe("telegram usage analytics", () => {
  it("includes freeze opt-ins in lifecycle counts and all-family watcher gating", async () => {
    const db = mockD1([
      {
        match: "FROM telegram_subscribers s",
        first: {
          active_watchers: 1,
          new_watchers: 0,
          explicit_coin_follows: 1,
          active_preset_followers: 0,
          active_dews_opt_ins: 0,
          active_depeg_opt_ins: 0,
          active_safety_opt_ins: 0,
          active_launch_opt_ins: 0,
          active_reserve_opt_ins: 0,
          active_freeze_opt_ins: 1,
          active_all_types_opt_ins: 1,
          quiet_hours_enabled_chats: 0,
        },
        rows: [],
      },
      { match: "FROM telegram_preset_subscriptions", rows: [] },
    ]);

    const snapshot = await computeTelegramCurrentLifecycleSnapshot(db, 1_771_833_600, {
      pendingDeliveryCount: 0,
    });

    expect(snapshot.alertTypeOptIns).toMatchObject({ freeze: 1, allTypes: 1 });
    const aggregateSql = db.getHistory().find((entry) => entry.sql.includes("FROM telegram_subscribers s"))?.sql;
    expect(aggregateSql).toContain("active_freeze_opt_ins");
    expect(aggregateSql).toContain("s.global_alert_freeze = 1");
    expect(aggregateSql).toContain("alert_freeze = 1");
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
    const db = mockD1([{ match: "INSERT INTO telegram_usage_daily", rows: [] }]);

    await recordTelegramUsageEvent(db, {
      nowSec: 1_771_833_600,
      eventType: "subscribe",
      sourceCategory: "deep link!",
      actionDetail: "usd-top25",
      outcome: "success",
      latencyMs: 700,
    });

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO telegram_usage_daily"));
    expect(insert?.sql).toContain("VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)");
    expect(insert?.sql).toContain("count = telegram_usage_daily.count + 1");
    expect(insert?.sql).toContain("last_seen_at = excluded.last_seen_at");
    expect(insert?.binds).toEqual([
      "2026-02-23",
      "subscribe",
      "deep_link_",
      "usd-top25",
      "success",
      "250ms_1s",
      "",
      1_771_833_600,
      1_771_833_600,
    ]);
    expect(insert?.binds).toHaveLength(9);
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
    expect(inserts[0]?.binds).toEqual(["42", 101, 101, null, 101]);
    expect(inserts[1]?.binds).toEqual(["43", null, 103, "network", 103]);
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
