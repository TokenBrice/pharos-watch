import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleRecentEvents } from "../recent-events";
import { RecentEventsResponseSchema } from "@shared/types/tape";

const URL_BASE = "https://x/api/recent-events";

// Pin `Date.now()` so the 24h staleness cutoff applied inside the handler
// behaves deterministically against the fixture timestamps below.
const NOW_SEC = 1_747_500_000;

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
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_SEC * 1000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
            started_at: NOW_SEC - 600,
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
      ts: NOW_SEC - 600,
    });
    expect(body.events[0]!.title).toContain("USDC depeg opened");
    expect(body.events[0]!.title).toContain("−1200 bps");
    expect(body.events[0]!.href).toContain("/stablecoin/usdc-circle");
  });

  it("renders a below-peg depeg with a signed (negative) peak_deviation_bps using a single minus sign", async () => {
    // peak_deviation_bps is stored signed; a below-peg event arrives with a
    // negative magnitude. The handler must not produce "−-1200 bps".
    const db = mockD1([
      { match: "ended_at IS NOT NULL", rows: [] },
      {
        match: "ended_at IS NULL",
        rows: [
          {
            id: 2,
            stablecoin_id: "usdxl-lightyear",
            symbol: "USDXL",
            direction: "below",
            peak_deviation_bps: -1200,
            started_at: NOW_SEC - 500,
          },
        ],
      },
      { match: "blacklist_events", rows: [] },
      { match: "safety_grade_history", rows: [] },
    ]);
    const res = await handleRecentEvents(db, new URL(URL_BASE));
    const body = RecentEventsResponseSchema.parse(await res.json());
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.title).toBe("USDXL depeg opened (−1200 bps)");
    // Severity must come from magnitude, not the signed value.
    expect(body.events[0]!.severity).toBe("severe");
  });

  it("renders an above-peg depeg with a positive sign", async () => {
    const db = mockD1([
      { match: "ended_at IS NOT NULL", rows: [] },
      {
        match: "ended_at IS NULL",
        rows: [
          {
            id: 3,
            stablecoin_id: "eurc-circle",
            symbol: "EURC",
            direction: "above",
            peak_deviation_bps: 450,
            started_at: NOW_SEC - 400,
          },
        ],
      },
      { match: "blacklist_events", rows: [] },
      { match: "safety_grade_history", rows: [] },
    ]);
    const res = await handleRecentEvents(db, new URL(URL_BASE));
    const body = RecentEventsResponseSchema.parse(await res.json());
    expect(body.events[0]!.title).toBe("EURC depeg opened (+450 bps)");
    expect(body.events[0]!.severity).toBe("warning"); // 450 bps -> warning
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
            started_at: NOW_SEC - 22_000,
            ended_at: NOW_SEC - 2000,
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
      ts: NOW_SEC - 2000,
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
            timestamp: NOW_SEC - 1000,
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
      ts: NOW_SEC - 1000,
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
            recorded_at: NOW_SEC - 100,
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

  it("drops events older than the 24h staleness cutoff", async () => {
    const db = mockD1([
      { match: "ended_at IS NOT NULL", rows: [] },
      {
        match: "ended_at IS NULL",
        rows: [
          // Fresh (well within 24h)
          {
            id: 1,
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: 400,
            started_at: NOW_SEC - 3600,
          },
          // Stale: ~26h old, must be dropped.
          {
            id: 2,
            stablecoin_id: "usdc-circle",
            symbol: "USDC",
            direction: "below",
            peak_deviation_bps: 400,
            started_at: NOW_SEC - 26 * 3600,
          },
        ],
      },
      { match: "blacklist_events", rows: [] },
      { match: "safety_grade_history", rows: [] },
    ]);
    const res = await handleRecentEvents(db, new URL(URL_BASE));
    const body = RecentEventsResponseSchema.parse(await res.json());
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.id).toBe("depeg.opened:1");
  });

  it("collapses ≥3 same-transition grade rows within 60s into one score.regrade.bulk event", async () => {
    const baseTs = NOW_SEC - 600;
    const db = mockD1([
      { match: "ended_at IS NOT NULL", rows: [] },
      { match: "ended_at IS NULL", rows: [] },
      { match: "blacklist_events", rows: [] },
      {
        match: "safety_grade_history",
        rows: [
          { stablecoin_id: "coin-1", recorded_at: baseTs, grade: "C", prev_grade: "B" },
          { stablecoin_id: "coin-2", recorded_at: baseTs + 5, grade: "C", prev_grade: "B" },
          { stablecoin_id: "coin-3", recorded_at: baseTs + 25, grade: "C", prev_grade: "B" },
          { stablecoin_id: "coin-4", recorded_at: baseTs + 55, grade: "C", prev_grade: "B" },
        ],
      },
    ]);
    const res = await handleRecentEvents(db, new URL(URL_BASE));
    const body = RecentEventsResponseSchema.parse(await res.json());
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      id: `score.regrade.bulk:B_to_C:${baseTs}`,
      type: "score.regrade.bulk",
      severity: "critical", // B(8) → C(5) = 3-rank delta → critical (reuses gradeSeverity)
      ts: baseTs + 55, // latest in the cluster
      stablecoinId: null,
      symbol: null,
      title: "4 stablecoins downgraded B → C",
      href: "/methodology",
    });
  });

  it("leaves a cluster of 2 same-transition grade rows as individual events", async () => {
    const baseTs = NOW_SEC - 600;
    const db = mockD1([
      { match: "ended_at IS NOT NULL", rows: [] },
      { match: "ended_at IS NULL", rows: [] },
      { match: "blacklist_events", rows: [] },
      {
        match: "safety_grade_history",
        rows: [
          // Both rows belong to coins present in ACTIVE_META_BY_ID; using
          // canonical ids keeps mapGrade's symbol lookup successful.
          { stablecoin_id: "usdt-tether", recorded_at: baseTs, grade: "C", prev_grade: "B" },
          { stablecoin_id: "usdc-circle", recorded_at: baseTs + 10, grade: "C", prev_grade: "B" },
        ],
      },
    ]);
    const res = await handleRecentEvents(db, new URL(URL_BASE));
    const body = RecentEventsResponseSchema.parse(await res.json());
    expect(body.events).toHaveLength(2);
    expect(body.events.every((e) => e.type === "score.downgraded")).toBe(true);
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
            started_at: NOW_SEC - 5000,
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
            timestamp: NOW_SEC - 1000,
          },
          {
            id: "eth-0xdef-13",
            stablecoin: "USDT",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "blacklist",
            amount_usd_at_event: 200,
            timestamp: NOW_SEC - 2000,
          },
        ],
      },
      { match: "safety_grade_history", rows: [] },
    ]);
    const res = await handleRecentEvents(db, new URL(`${URL_BASE}?limit=2`));
    const body = RecentEventsResponseSchema.parse(await res.json());
    expect(body.events).toHaveLength(2);
    expect(body.events.map((e) => e.ts)).toEqual([NOW_SEC - 1000, NOW_SEC - 2000]);
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
            timestamp: NOW_SEC - 1000,
          },
          {
            id: "eth-0xabc-12",
            stablecoin: "USDT",
            chain_id: "ethereum",
            chain_name: "Ethereum",
            event_type: "blacklist",
            amount_usd_at_event: 500,
            timestamp: NOW_SEC - 1000,
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
