import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  bucketTelegramCommandLatency,
  classifyTelegramStartSource,
  loadTelegramTopFollowedCoins,
  recordTelegramUsageEvent,
} from "../telegram-usage-analytics";

describe("telegram usage analytics", () => {
  it("classifies deep-link payloads without storing raw payloads", () => {
    expect(classifyTelegramStartSource("")).toBe("none");
    expect(classifyTelegramStartSource("setup")).toBe("setup");
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
