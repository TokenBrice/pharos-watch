import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

vi.mock("../../../../src/lib/stablecoins", () => ({
  TRACKED_STABLECOINS: [
    {
      id: "1",
      symbol: "AAA",
      name: "AAA Stable",
      commodityOunces: undefined,
      flags: { pegCurrency: "USD", governance: "centralized", navToken: false },
    },
    {
      id: "2",
      symbol: "NAV",
      name: "NAV Stable",
      commodityOunces: undefined,
      flags: { pegCurrency: "USD", governance: "centralized", navToken: true },
    },
  ],
}));

vi.mock("../../../../src/lib/peg-score", () => ({
  computePegScore: vi.fn(() => ({
    pegScore: 91,
    pegPct: 0.91,
    severityScore: 9,
    spreadPenalty: 0,
    eventCount: 1,
    worstDeviationBps: 35,
    activeDepeg: false,
    lastEventAt: null,
    trackingSpanDays: 120,
  })),
  coinTrackingStart: vi.fn(() => 0),
}));

vi.mock("../../../../src/lib/peg-rates", () => ({
  derivePegRates: vi.fn(() => ({ rates: { USD: 1 }, sources: {} })),
  getPegReference: vi.fn(() => 1),
}));

vi.mock("../../../../src/lib/depeg-dews-version", () => ({
  getDepegDewsMethodologyVersionAt: vi.fn(() => "test-methodology"),
}));

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return {
    ...actual,
    getFirstSeenDates: vi.fn(async () => new Map<string, number>()),
  };
});

import { derivePegAnalyticsSnapshot } from "../peg-analytics";

describe("derivePegAnalyticsSnapshot", () => {
  let db: D1Database;

  beforeEach(() => {
    db = mockD1([
      {
        match: "depeg_events",
        rows: [
          {
            stablecoin_id: "1",
            symbol: "AAA",
            started_at: 1_700_000_000,
            ended_at: null,
            direction: "below",
            peak_deviation_bps: 35,
            source: "primary",
          },
        ],
      },
    ]);
  });

  it("builds shared events and peg data maps", async () => {
    const snapshot = await derivePegAnalyticsSnapshot(db, {
      peggedAssets: [
        {
          id: "1",
          symbol: "AAA",
          name: "AAA Stable",
          pegType: "peggedUSD",
          price: 1.01,
          circulating: { peggedUSD: 2_000_000 },
        } as never,
      ],
      methodologyAsOf: 1_700_000_000,
    });

    expect(snapshot.eventsByCoin.has("1")).toBe(true);
    expect(snapshot.pegDataById.has("1")).toBe(true);
    expect(snapshot.pegDataById.has("2")).toBe(false); // nav token excluded by default
    expect(snapshot.pegDataById.get("1")?.currentDeviationBps).toBe(100);
  });
});
