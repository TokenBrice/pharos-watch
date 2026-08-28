import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { mockRegistry } from "../../test-helpers/cron";

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

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({ stablecoins: STABLECOINS_MOCK }));

vi.mock("@shared/lib/peg-score", () => ({
  PEG_SCORE_LOOKBACK_SEC: 126_230_400,
  NULL_PEG_SCORE_RESULT: {
    pegScore: null,
    pegPct: 100,
    severityScore: 100,
    spreadPenalty: 0,
    eventCount: 0,
    scoredEventCount: 0,
    excludedEventCount: 0,
    lowConfidenceEventCount: 0,
    qualityAdjusted: false,
    worstDeviationBps: null,
    activeDepeg: false,
    lastEventAt: null,
    trackingSpanDays: 0,
  },
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
  computeRecentPegStats: vi.fn(() => ({
    windowDays: 90,
    observedDays: 90,
    coverageLimited: false,
    pegPct: 99,
    incidentCount: 1,
    thresholdCrossingCount: 1,
    worstDeviationBps: 35,
  })),
  coinTrackingStart: vi.fn(() => 0),
}));

vi.mock("@shared/lib/peg-rates", () => ({
  derivePegRates: vi.fn(() => ({ rates: { USD: 1 }, sources: {} })),
  getPegReference: vi.fn(() => 1),
  normalizePegType: vi.fn((pegType: string | undefined) =>
    pegType === "peggedBRL" ? "peggedREAL" : pegType,
  ),
}));

vi.mock("@shared/lib/methodology-versions/depeg-dews", () => ({
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
import { coinTrackingStart, computePegScore } from "@shared/lib/peg-score";
import { getFirstSeenDates } from "../db";

describe("derivePegAnalyticsSnapshot", () => {
  let db: D1Database;

  beforeEach(() => {
    vi.mocked(getFirstSeenDates).mockResolvedValue(new Map<string, number>());
    vi.mocked(getFirstSeenDates).mockClear();
    vi.mocked(coinTrackingStart).mockClear();
    vi.mocked(computePegScore).mockClear();
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
            source: "live",
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

  it("loads depeg provenance so audited false positives are excluded from scoring", async () => {
    db = mockD1([
      {
        match: "depeg_events_with_provenance",
        rows: [
          {
            id: 123,
            stablecoin_id: "usdt-tether",
            symbol: "AAA",
            peg_type: "peggedUSD",
            started_at: 1_700_000_000,
            ended_at: 1_700_003_600,
            direction: "below",
            peak_deviation_bps: -500,
            source: "live",
            provenance_audit_verdict: "false_positive",
            provenance_confidence_tier: "medium",
          },
        ],
      },
    ]);

    const snapshot = await derivePegAnalyticsSnapshot(db, {
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

    const eventHistoryQuery = (db as MockD1Database)
      .getHistory()
      .find((entry) => entry.sql.includes("FROM depeg_events_with_provenance"));
    expect(eventHistoryQuery?.sql).toContain("FROM depeg_events_with_provenance");
    expect(snapshot.allEvents[0]?.provenance?.auditVerdict).toBe("false_positive");
    expect(vi.mocked(computePegScore)).toHaveBeenCalledWith(
      [expect.objectContaining({ provenance: expect.objectContaining({ auditVerdict: "false_positive" }) })],
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("includes NAV tokens as peg-ineligible rows when requested", async () => {
    db = mockD1([
      {
        match: "depeg_events",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            symbol: "NAV",
            started_at: 1_700_000_000,
            ended_at: null,
            direction: "above",
            peak_deviation_bps: 2500,
            source: "live",
          },
        ],
      },
    ]);

    const snapshot = await derivePegAnalyticsSnapshot(db, {
      peggedAssets: [
        {
          id: "usdc-circle",
          symbol: "NAV",
          name: "NAV Stable",
          pegType: "peggedUSD",
          price: 1.25,
          circulating: { peggedUSD: 2_000_000 },
        } as never,
      ],
      methodologyAsOf: 1_700_000_000,
      includeNavTokens: true,
    });

    const nav = snapshot.pegDataById.get("usdc-circle");
    expect(nav).toMatchObject({
      currentDeviationBps: null,
      pegScore: null,
      eventCount: 0,
      worstDeviationBps: null,
      activeDepeg: false,
      trackingSpanDays: 0,
    });
  });

  it("uses current priced assets as first-seen observations for PegScore anchoring", async () => {
    await derivePegAnalyticsSnapshot(db, {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "AAA",
          name: "AAA Stable",
          pegType: "peggedUSD",
          price: 1,
          priceSyncedAt: 1_700_000_500,
          priceUpdatedAt: 1_700_000_100,
          circulating: { peggedUSD: 2_000_000 },
        } as never,
        {
          id: "missing-price",
          symbol: "MISS",
          name: "Missing Price",
          pegType: "peggedUSD",
          price: null,
          priceSyncedAt: 1_700_000_600,
          circulating: { peggedUSD: 2_000_000 },
        } as never,
      ],
      methodologyAsOf: 1_700_000_000,
    });

    expect(vi.mocked(getFirstSeenDates)).toHaveBeenCalledWith(
      db,
      [{ id: "usdt-tether", observedAtSec: 1_700_000_500 }],
    );
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
    // A withheld deviation is not an unobserved one: the price itself was usable.
    expect(snapshot.pegDataById.get("usdt-tether")?.currentPriceUnavailable).toBeUndefined();
  });

  it("marks coins with no usable price observation so a null deviation is not read as at peg", async () => {
    const snapshot = await derivePegAnalyticsSnapshot(db, {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "AAA",
          name: "AAA Stable",
          pegType: "peggedUSD",
          price: null,
          circulating: { peggedUSD: 8_000_000 },
        } as never,
      ],
      methodologyAsOf: 1_700_000_000,
    });

    expect(snapshot.pegDataById.get("usdt-tether")?.currentPriceUnavailable).toBe(true);
    expect(snapshot.pegDataById.get("usdt-tether")?.currentDeviationBps).toBeNull();
    // An asset the price intake never reached at all is the same fact.
    const absent = await derivePegAnalyticsSnapshot(db, {
      peggedAssets: [],
      methodologyAsOf: 1_700_000_000,
    });
    expect(absent.pegDataById.get("usdt-tether")?.currentPriceUnavailable).toBe(true);
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

  it("uses an audited replay coverage start instead of pre-coverage asset age", async () => {
    const coin = STABLECOINS_MOCK[0] as typeof STABLECOINS_MOCK[0] & {
      pegScoreCoverage?: { startDate: string };
    };
    coin.pegScoreCoverage = { startDate: "2026-06-28" };

    try {
      const snapshot = await derivePegAnalyticsSnapshot(db, {
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
        methodologyAsOf: 1_783_000_000,
      });

      expect(vi.mocked(coinTrackingStart)).toHaveBeenLastCalledWith(
        expect.any(Array),
        expect.any(Number),
        1_782_604_800,
      );
      expect(snapshot.pegDataById.get("usdt-tether")?.historyCoverage).toMatchObject({
        source: "audited-replay",
        status: "verified",
      });
    } finally {
      delete coin.pegScoreCoverage;
    }
  });
});
