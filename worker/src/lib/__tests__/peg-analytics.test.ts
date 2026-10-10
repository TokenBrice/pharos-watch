import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { mockWorkerRuntimeRegistry } from "../../test-helpers/cron";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { loadPegAnalyticsCache, publishPegAnalyticsCache } from "../peg-analytics-cache";

const sqliteFixtures = createLatestSchemaFixtureTracker();
afterEach(() => sqliteFixtures.closeAll());

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

vi.mock("@shared/lib/stablecoins/worker-runtime-registry", () => mockWorkerRuntimeRegistry({ stablecoins: STABLECOINS_MOCK }));

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

vi.mock("@shared/lib/methodology-versions/registry", () => ({
  getMethodologyVersionAt: vi.fn(() => "test-methodology"),
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
  it("publishes the uncapped observation boundary separately from scoring coverage", async () => {
    const firstObservation = 1_500_000_000;
    vi.mocked(getFirstSeenDates).mockResolvedValue(new Map([["usdt-tether", firstObservation]]));
    const snapshot = await derivePegAnalyticsSnapshot(db, {
      peggedAssets: [makeStablecoin({ id: "usdt-tether", price: 1 })], methodologyAsOf: 1_700_000_000,
    });
    expect(snapshot.pegDataById.get("usdt-tether")?.observationStartedAt).toBe(firstObservation);
    const { db: cacheDb } = sqliteFixtures.open();
    expect(await publishPegAnalyticsCache(cacheDb, snapshot)).toBe(true);
    const retained = await loadPegAnalyticsCache(cacheDb);
    expect(retained.kind).toBe("ok");
    if (retained.kind === "ok") {
      expect(retained.pegDataById.get("usdt-tether")?.observationStartedAt).toBe(firstObservation);
    }
  });
  it.each(["failed-read", "malformed-row"] as const)("withholds canonical analytics on %s projection and retains the accepted incident chronology", async (failure) => {
    const { sqlite, db: sqliteDb } = sqliteFixtures.open();
    const now = Math.floor(Date.now() / 1000);
    const first = now - 86_400;
    const current = now - 3600;
    const incidentKey = `ddr2:${"a".repeat(32)}`;
    const insertEvent = sqlite.prepare(`INSERT INTO depeg_events
      (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at,
       ended_at, start_price, peak_price, peg_reference, source)
      VALUES (?, 'usdt-tether', 'USDT', 'peggedUSD', 'below', -300, ?, ?, 0.97, 0.97, 1, 'live')`);
    insertEvent.run(1, first, current - 300);
    insertEvent.run(2, current, null);
    const link = sqlite.prepare(`INSERT INTO depeg_resolver_incident_event_links
      (incident_key, event_id, relation, linked_at) VALUES (?, ?, 'observed', ?)`);
    link.run(incidentKey, 1, first);
    link.run(incidentKey, 2, current);
    sqlite.prepare(`INSERT INTO depeg_resolver_incidents
      (incident_key, stablecoin_id, peg_currency, direction, first_event_id, current_event_id,
       first_started_at, current_started_at, first_observed_peak_bucket_bps, source_fingerprint,
       created_at, updated_at) VALUES (?, 'usdt-tether', 'USD', 'below', 1, 2, ?, ?, 300, ?, ?, ?)`)
      .run(incidentKey, first, current, "a".repeat(64), first, current);
    const options = { peggedAssets: [makeStablecoin({ id: "usdt-tether", price: 0.97 })], methodologyAsOf: now };
    const accepted = await derivePegAnalyticsSnapshot(sqliteDb, options);
    expect(accepted.allEvents).toHaveLength(1);
    expect(accepted.allEvents[0]).toMatchObject({ id: 2, startedAt: first, constituentEventCount: 2 });
    expect(await publishPegAnalyticsCache(sqliteDb, accepted)).toBe(true);
    const acceptedCache = await loadPegAnalyticsCache(sqliteDb);
    const prepare = sqliteDb.prepare.bind(sqliteDb);
    if (failure === "malformed-row") {
      sqlite.prepare("UPDATE depeg_events SET start_price = -1 WHERE id = 1").run();
    } else {
      vi.spyOn(sqliteDb, "prepare").mockImplementation((sql) => {
        if (sql.includes("pharos:depeg-event-projection:active-incidents")) throw new Error("D1 projection timeout");
        return prepare(sql);
      });
    }
    await expect(derivePegAnalyticsSnapshot(sqliteDb, options)).rejects.toMatchObject({
      reason: failure === "failed-read" ? "incident-projection-read-failed" : "incident-projection-invalid",
    });
    expect(await loadPegAnalyticsCache(sqliteDb)).toEqual(acceptedCache);
  });

  let db: D1Database;

  beforeEach(() => {
    vi.mocked(getFirstSeenDates).mockResolvedValue(new Map<string, number>());
    vi.mocked(getFirstSeenDates).mockClear();
    vi.mocked(coinTrackingStart).mockClear();
    vi.mocked(computePegScore).mockClear();
    db = mockD1([
      { match: "pharos:depeg-event-projection:active-incidents", rows: [] },
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
      { match: "pharos:depeg-event-projection:active-incidents", rows: [] },
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
      { match: "pharos:depeg-event-projection:active-incidents", rows: [] },
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

  it("admits sub-floor current deviation while marking event coverage limited", async () => {
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

    expect(snapshot.pegDataById.get("usdt-tether")?.currentDeviationBps).toBe(-1000);
    expect(snapshot.pegDataById.get("usdt-tether")?.depegEventCoverageLimited).toBe(true);
    expect(snapshot.pegDataById.get("usdt-tether")?.currentPriceUnavailable).toBeUndefined();
  });

  it("marks unknown supply separately instead of claiming the coin is below or above the event floor", async () => {
    const snapshotFor = (circulating: Record<string, number> | undefined) =>
      derivePegAnalyticsSnapshot(db, {
        peggedAssets: [
          { id: "usdt-tether", symbol: "AAA", name: "AAA Stable", pegType: "peggedUSD", price: 0.9, circulating } as never,
        ],
        methodologyAsOf: 1_700_000_000,
      });

    for (const circulating of [undefined, {}, { peggedUSD: Number.NaN }] as Array<Record<string, number> | undefined>) {
      const coin = (await snapshotFor(circulating)).pegDataById.get("usdt-tether");
      expect(coin?.currentSupplyUnavailable).toBe(true);
      expect(coin?.depegEventCoverageLimited).toBe(false);
      expect(coin?.currentDeviationBps).toBe(-1000);
    }

    // Observed supply (sub-floor or above-floor) is never marked unavailable.
    const lowCap = (await snapshotFor({ peggedUSD: 500_000 })).pegDataById.get("usdt-tether");
    expect(lowCap?.currentSupplyUnavailable).toBeUndefined();
    expect(lowCap?.depegEventCoverageLimited).toBe(true);
    const observed = (await snapshotFor({ peggedUSD: 8_000_000 })).pegDataById.get("usdt-tether");
    expect(observed?.currentSupplyUnavailable).toBeUndefined();
    expect(observed?.currentDeviationBps).not.toBeNull();
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
