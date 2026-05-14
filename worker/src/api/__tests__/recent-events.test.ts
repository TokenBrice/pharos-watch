import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleRecentEvents } from "../recent-events";
import { RecentEventsResponseSchema } from "@shared/types/tape";

const URL_BASE = "https://x/api/recent-events";

// Mock ordering note: "ended_at IS NULL" is a substring of "ended_at IS NOT NULL",
// so the resolved-depeg config must come BEFORE the open-depeg config for the
// substring matcher to route correctly.
function emptyDb() {
  return mockD1([
    { match: "ended_at IS NOT NULL", rows: [] },
    { match: "ended_at IS NULL", rows: [] },
    { match: "blacklist_events", rows: [] },
    { match: "safety_grade_history", rows: [] },
  ]);
}

describe("handleRecentEvents", () => {
  it("returns 200 with empty events array when all sources are empty", async () => {
    const res = await handleRecentEvents(emptyDb(), new URL(URL_BASE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toEqual([]);
  });

  it("maps an open depeg row with severity from peak_deviation_bps", async () => {
    const db = mockD1([
      { match: "ended_at IS NOT NULL", rows: [] },
      {
        match: "ended_at IS NULL",
        rows: [
          {
            id: 1,
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: 1200,
            started_at: 1_747_201_000,
          },
        ],
      },
      { match: "blacklist_events", rows: [] },
      { match: "safety_grade_history", rows: [] },
    ]);
    const res = await handleRecentEvents(db, new URL(URL_BASE));
    const body = RecentEventsResponseSchema.parse(await res.json());
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      type: "depeg.opened",
      severity: "severe", // 1200 bps -> severe
      stablecoinId: "usdc-circle",
      symbol: "USDC",
      ts: 1_747_201_000,
    });
    expect(body.events[0]!.title).toContain("USDC depeg opened");
    expect(body.events[0]!.title).toContain("−1200 bps");
    expect(body.events[0]!.href).toContain("/stablecoin/usdc-circle");
  });

  it("maps a resolved depeg row using ended_at as ts", async () => {
    const db = mockD1([
      {
        match: "ended_at IS NOT NULL",
        rows: [
          {
            id: 7,
            stablecoin_id: "dai-makerdao",
            symbol: "DAI",
            direction: "below",
            peak_deviation_bps: 250,
            started_at: 1_747_100_000,
            ended_at: 1_747_120_000,
          },
        ],
      },
      { match: "ended_at IS NULL", rows: [] },
      { match: "blacklist_events", rows: [] },
      { match: "safety_grade_history", rows: [] },
    ]);
    const res = await handleRecentEvents(db, new URL(URL_BASE));
    const body = RecentEventsResponseSchema.parse(await res.json());
    expect(body.events[0]).toMatchObject({
      type: "depeg.resolved",
      severity: "info",
      ts: 1_747_120_000,
    });
  });

  it("maps a destroy freeze row with severity from amount", async () => {
    const db = mockD1([
      { match: "ended_at IS NOT NULL", rows: [] },
      { match: "ended_at IS NULL", rows: [] },
      {
        match: "blacklist_events",
        rows: [
          {
            id: "eth-0xabc-12",
            stablecoin: "USDT",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "destroy",
            amount_usd_at_event: 15_000_000,
            timestamp: 1_747_300_000,
          },
        ],
      },
      { match: "safety_grade_history", rows: [] },
    ]);
    const res = await handleRecentEvents(db, new URL(URL_BASE));
    const body = RecentEventsResponseSchema.parse(await res.json());
    expect(body.events[0]).toMatchObject({
      type: "freeze.destroyed",
      severity: "severe", // $15M -> severe
      symbol: "USDT",
      ts: 1_747_300_000,
    });
    expect(body.events[0]!.title).toContain("$15.0M");
    expect(body.events[0]!.href).toBe("/freezewatch/");
  });

  it("maps a grade downgrade with severity from tier delta", async () => {
    const db = mockD1([
      { match: "ended_at IS NOT NULL", rows: [] },
      { match: "ended_at IS NULL", rows: [] },
      { match: "blacklist_events", rows: [] },
      {
        match: "safety_grade_history",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            recorded_at: 1_747_400_000,
            grade: "B",
            prev_grade: "A",
          },
        ],
      },
    ]);
    const res = await handleRecentEvents(db, new URL(URL_BASE));
    const body = RecentEventsResponseSchema.parse(await res.json());
    expect(body.events[0]).toMatchObject({
      type: "score.downgraded",
      severity: "critical", // A(11) -> B(8) = 3-tier delta -> critical
      stablecoinId: "usdt-tether",
      symbol: "USDT",
    });
    expect(body.events[0]!.title).toBe("USDT grade A → B");
  });

  it("sorts merged events by ts DESC and clamps to requested limit", async () => {
    const db = mockD1([
      { match: "ended_at IS NOT NULL", rows: [] },
      {
        match: "ended_at IS NULL",
        rows: [
          {
            id: 1,
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: 50,
            started_at: 1_747_100_000,
          },
        ],
      },
      {
        match: "blacklist_events",
        rows: [
          {
            id: "eth-0xabc-12",
            stablecoin: "USDT",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "blacklist",
            amount_usd_at_event: 500,
            timestamp: 1_747_300_000,
          },
          {
            id: "eth-0xdef-13",
            stablecoin: "USDT",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "blacklist",
            amount_usd_at_event: 200,
            timestamp: 1_747_200_000,
          },
        ],
      },
      { match: "safety_grade_history", rows: [] },
    ]);
    const res = await handleRecentEvents(db, new URL(`${URL_BASE}?limit=2`));
    const body = RecentEventsResponseSchema.parse(await res.json());
    expect(body.events).toHaveLength(2);
    expect(body.events.map((e) => e.ts)).toEqual([1_747_300_000, 1_747_200_000]);
  });

  it("uses event id as a deterministic tie-breaker for same-second rows", async () => {
    const db = mockD1([
      { match: "ended_at IS NOT NULL", rows: [] },
      { match: "ended_at IS NULL", rows: [] },
      {
        match: "blacklist_events",
        rows: [
          {
            id: "eth-0xdef-13",
            stablecoin: "USDT",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "blacklist",
            amount_usd_at_event: 200,
            timestamp: 1_747_300_000,
          },
          {
            id: "eth-0xabc-12",
            stablecoin: "USDT",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "blacklist",
            amount_usd_at_event: 500,
            timestamp: 1_747_300_000,
          },
        ],
      },
      { match: "safety_grade_history", rows: [] },
    ]);
    const res = await handleRecentEvents(db, new URL(URL_BASE));
    const body = RecentEventsResponseSchema.parse(await res.json());
    expect(body.events.map((e) => e.id)).toEqual([
      "freeze.blocked:eth-0xabc-12",
      "freeze.blocked:eth-0xdef-13",
    ]);
  });

  it("emits freshness headers", async () => {
    const res = await handleRecentEvents(emptyDb(), new URL(URL_BASE));
    expect(res.headers.get("X-Data-Age")).toMatch(/^\d+$/);
    expect(res.headers.get("Cache-Control")).toBeTruthy();
  });
});
