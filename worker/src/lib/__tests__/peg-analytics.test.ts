import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

const { STABLECOINS_MOCK } = vi.hoisted(() => ({
  STABLECOINS_MOCK: [
    {
      id: "usdt-tether",
      symbol: "AAA",
      name: "AAA Stable",
      launchDate: "2019-07-19",
      commodityOunces: undefined,
      flags: { pegCurrency: "USD", governance: "centralized", navToken: false },
    },
    {
      id: "usdc-circle",
      symbol: "NAV",
      name: "NAV Stable",
      commodityOunces: undefined,
      flags: { pegCurrency: "USD", governance: "centralized", navToken: true },
    },
  ],
}));

vi.mock("@shared/lib/stablecoins", () => ({
  TRACKED_STABLECOINS: STABLECOINS_MOCK,
  ACTIVE_STABLECOINS: STABLECOINS_MOCK,
  TRACKED_META_BY_ID: new Map(STABLECOINS_MOCK.map((coin: { id: string }) => [coin.id, coin])),
}));

vi.mock("@shared/lib/peg-score", () => ({
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

vi.mock("@shared/lib/peg-rates", () => ({
  derivePegRates: vi.fn(() => ({ rates: { USD: 1 }, sources: {} })),
  getPegReference: vi.fn(() => 1),
}));

vi.mock("@shared/lib/depeg-dews-version", () => ({
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
import { coinTrackingStart } from "@shared/lib/peg-score";
import { getFirstSeenDates } from "../db";

describe("derivePegAnalyticsSnapshot", () => {
  let db: D1Database;

  beforeEach(() => {
    vi.mocked(getFirstSeenDates).mockResolvedValue(new Map<string, number>());
    vi.mocked(coinTrackingStart).mockClear();
    db = mockD1([
      {
        match: "depeg_events",
        rows: [
          {
            stablecoin_id: "usdt-tether",
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
          id: "usdt-tether",
          symbol: "AAA",
          name: "AAA Stable",
          pegType: "peggedUSD",
          price: 1.01,
          circulating: { peggedUSD: 2_000_000 },
        } as never,
      ],
      methodologyAsOf: 1_700_000_000,
    });

    expect(snapshot.eventsByCoin.has("usdt-tether")).toBe(true);
    expect(snapshot.pegDataById.has("usdt-tether")).toBe(true);
    expect(snapshot.pegDataById.has("usdc-circle")).toBe(false); // nav token excluded by default
    expect(snapshot.pegDataById.get("usdt-tether")?.currentDeviationBps).toBe(100);
    expect(snapshot.pegDataById.get("usdt-tether")?.depegEventCoverageLimited).toBe(false);
  });

  it("flags low-cap coins as coverage-limited while keeping current deviation null", async () => {
    const snapshot = await derivePegAnalyticsSnapshot(db, {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "AAA",
          name: "AAA Stable",
          pegType: "peggedUSD",
          price: 0.9,
          circulating: { peggedUSD: 500_000 },
        } as never,
      ],
      methodologyAsOf: 1_700_000_000,
    });

    expect(snapshot.pegDataById.get("usdt-tether")?.currentDeviationBps).toBeNull();
    expect(snapshot.pegDataById.get("usdt-tether")?.depegEventCoverageLimited).toBe(true);
  });

  it("prefers curated launchDate over supply-history firstSeen when anchoring peg tracking", async () => {
    vi.mocked(getFirstSeenDates).mockResolvedValue(new Map<string, number>([
      ["usdt-tether", 1_743_120_000],
    ]));

    await derivePegAnalyticsSnapshot(db, {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "AAA",
          name: "AAA Stable",
          pegType: "peggedUSD",
          price: 1,
          circulating: { peggedUSD: 2_000_000 },
        } as never,
      ],
      methodologyAsOf: 1_700_000_000,
    });

    expect(vi.mocked(coinTrackingStart)).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Number),
      1_563_494_400,
    );
  });
});
