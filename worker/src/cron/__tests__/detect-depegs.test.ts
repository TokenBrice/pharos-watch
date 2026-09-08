import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockD1Preset } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "../../test-helpers/latest-schema-sqlite";
import { seedOpenEvent, seedDexEvidence } from "./detect-depegs.test-support";

const sqliteFixtures = createLatestSchemaFixtureTracker();

const mockD1 = createMockD1Preset([
  { match: "FROM dex_price_challenger_snapshots", rows: [] },
  { match: "FROM dex_price_challengers", rows: [] },
  { match: "SELECT stablecoin_id, top_pools_json", rows: [] },
  { match: "INSERT INTO depeg_pending", rows: [] },
]);

// Stub psi-eligible to avoid importing the full stablecoins list
vi.mock("@shared/lib/psi-eligible", () => ({
  PSI_ELIGIBLE_STABLECOINS: [
    { id: "usdt-tether", symbol: "USDT", pegType: "peggedUSD", geckoId: "tether", flags: { navToken: false }, commodityOunces: undefined },
    { id: "usdc-circle", symbol: "USDC", pegType: "peggedUSD", geckoId: "usd-coin", flags: { navToken: false }, commodityOunces: undefined },
    { id: "eurc-circle", symbol: "EUROC", pegType: "peggedEUR", geckoId: "euro-coin", flags: { navToken: false }, commodityOunces: undefined },
    { id: "brz-transfero", symbol: "BRZ", pegType: "peggedREAL", geckoId: "brz", flags: { navToken: false, pegCurrency: "BRL" }, commodityOunces: undefined },
    { id: "a7a5-old-vector", symbol: "A7A5", pegType: "peggedRUB", geckoId: "a7a5", flags: { navToken: false, pegCurrency: "RUB" }, commodityOunces: undefined },
    { id: "nav-token-test", symbol: "NAVT", pegType: "peggedUSD", geckoId: "nav-token", flags: { navToken: true }, commodityOunces: undefined },
  ],
  PSI_ELIGIBLE_META_BY_ID: new Map([
    ["usdt-tether", { id: "usdt-tether", symbol: "USDT", pegType: "peggedUSD", geckoId: "tether", flags: { navToken: false, pegCurrency: "USD" }, commodityOunces: undefined }],
    ["usdc-circle", { id: "usdc-circle", symbol: "USDC", pegType: "peggedUSD", geckoId: "usd-coin", flags: { navToken: false, pegCurrency: "USD" }, commodityOunces: undefined }],
    ["eurc-circle", { id: "eurc-circle", symbol: "EUROC", pegType: "peggedEUR", geckoId: "euro-coin", flags: { navToken: false, pegCurrency: "EUR" }, commodityOunces: undefined }],
    ["brz-transfero", { id: "brz-transfero", symbol: "BRZ", pegType: "peggedREAL", geckoId: "brz", flags: { navToken: false, pegCurrency: "BRL" }, commodityOunces: undefined }],
    ["a7a5-old-vector", { id: "a7a5-old-vector", symbol: "A7A5", pegType: "peggedRUB", geckoId: "a7a5", flags: { navToken: false, pegCurrency: "RUB" }, commodityOunces: undefined }],
    ["nav-token-test", { id: "nav-token-test", symbol: "NAVT", pegType: "peggedUSD", geckoId: "nav-token", flags: { navToken: true, pegCurrency: "USD" }, commodityOunces: undefined }],
  ]),
}));

// Stub peg-rates
vi.mock("@shared/lib/peg-rates", () => ({
  derivePegRates: (_assets: unknown, _metaById: unknown, fxFallbackRates?: Record<string, number>) => ({
    rates: {
      peggedUSD: 1,
      peggedEUR: 1.08,
      peggedREAL: fxFallbackRates?.peggedREAL ?? 0.18765951,
      ...(fxFallbackRates?.peggedRUB ? { peggedRUB: fxFallbackRates.peggedRUB } : {}),
    },
    sources: {
      peggedUSD: "median",
      peggedEUR: "median",
      peggedREAL: fxFallbackRates?.peggedREAL ? "fallback" : "median",
      peggedRUB: fxFallbackRates?.peggedRUB ? "fallback" : "median",
    },
    counts: { peggedUSD: 4, peggedEUR: 4, peggedREAL: 2, peggedRUB: 1 },
  }),
  getPegReference: (pegType: string, rates: Record<string, number>) => rates[pegType] ?? 1,
  normalizePegType: (pegType: string | undefined) => pegType,
}));

vi.mock("../../lib/native-peg-quotes", () => ({
  fetchCurrentNativePegQuotes: vi.fn(async () => new Map()),
}));

// Stub supply
vi.mock("@shared/lib/supply", () => ({
  getCirculatingRaw: (asset: { circulating?: Record<string, number> }) => {
    const c = asset.circulating;
    if (!c) return 0;
    return Object.values(c).reduce((a, b) => a + b, 0);
  },
}));

import { detectDepegEvents } from "../detect-depegs";
import { fetchCurrentNativePegQuotes } from "../../lib/native-peg-quotes";

function isCloseEventUpdate(sql: string): boolean {
  return sql.includes(
    "UPDATE depeg_events SET ended_at = ?, recovery_price = ?, close_reason = ?, recovery_first_seen_at = NULL, recovery_last_seen_at = NULL WHERE id = ?",
  );
}

// Helper to build a minimal asset
function makeAsset(overrides: {
  id: string;
  symbol: string;
  price: number | null;
  pegType?: string;
  circulating?: Record<string, number>;
  priceSource?: string;
  priceConfidence?: "high" | "single-source" | "low" | "fallback";
  priceUpdatedAt?: number;
  priceObservedAt?: number;
  priceObservedAtMode?: "upstream" | "local_fetch" | "unknown" | null;
  agreeSources?: string[];
}) {
  return {
    id: overrides.id,
    symbol: overrides.symbol,
    price: overrides.price,
    priceSource: overrides.priceSource ?? "pyth",
    priceConfidence: overrides.priceConfidence ?? "single-source",
    priceUpdatedAt: overrides.priceUpdatedAt ?? Math.floor(Date.now() / 1000),
    priceObservedAt: overrides.priceObservedAt,
    priceObservedAtMode: overrides.priceObservedAtMode,
    agreeSources: overrides.agreeSources,
    pegType: overrides.pegType ?? "peggedUSD",
    circulating: overrides.circulating ?? { ethereum: 50_000_000 },
  };
}

describe("detectDepegEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
    vi.mocked(fetchCurrentNativePegQuotes).mockReset().mockResolvedValue(new Map());
  });

  afterEach(() => {
    vi.useRealTimers();
    sqliteFixtures.closeAll();
    vi.restoreAllMocks();
  });

  it("rejects pre-aborted detection before hydration or writes", async () => {
    const { db } = sqliteFixtures.open();
    const prepare = vi.spyOn(db, "prepare");
    const controller = new AbortController();
    const reason = new Error("cancel detection");
    controller.abort(reason);
    await expect(detectDepegEvents(db, [], undefined, controller.signal)).rejects.toBe(reason);
    expect(prepare).not.toHaveBeenCalled();
    expect(fetchCurrentNativePegQuotes).not.toHaveBeenCalled();
  });

  it("does not repair duplicates or persist candidates when hydration is cancelled", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    seedOpenEvent(sqlite);
    seedOpenEvent(sqlite, { id: 2, started_at: Math.floor(Date.now() / 1000) - 7200 });
    const controller = new AbortController();
    const reason = new Error("cancel hydration");
    vi.mocked(fetchCurrentNativePegQuotes).mockImplementationOnce(async () => {
      controller.abort(reason);
      return new Map();
    });
    await expect(detectDepegEvents(db, [makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.96 })], undefined, controller.signal)).rejects.toBe(reason);
    expect(sqlite.prepare("SELECT id, peak_deviation_bps FROM depeg_events ORDER BY id").all()).toEqual([
      { id: 1, peak_deviation_bps: -200 }, { id: 2, peak_deviation_bps: -200 },
    ]);
    expect(sqlite.prepare("SELECT * FROM depeg_pending").all()).toEqual([]);
  });

  it("rejects main persistence failure without continuing orphan cleanup", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    seedOpenEvent(sqlite);
    seedOpenEvent(sqlite, { id: 99, stablecoin_id: "removed-coin" });
    sqlite.exec("CREATE TRIGGER fail_peak BEFORE UPDATE OF peak_deviation_bps ON depeg_events BEGIN SELECT RAISE(ABORT, 'peak write failed'); END");
    await expect(detectDepegEvents(db, [makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.96 })])).rejects.toThrow("peak write failed");
    expect(sqlite.prepare("SELECT id, peak_deviation_bps, ended_at FROM depeg_events ORDER BY id").all()).toEqual([
      { id: 1, peak_deviation_bps: -200, ended_at: null },
      { id: 99, peak_deviation_bps: -200, ended_at: null },
    ]);
  });

  it("skips detection and emits a degraded warning when open-event hydration reaches its limit", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const openRows = Array.from({ length: 200 }, (_, id) => ({
      id,
      stablecoin_id: `open-${id}`,
      symbol: `OPEN${id}`,
      peg_type: "peggedUSD",
      direction: "below",
      peak_deviation_bps: -200,
      started_at: 1_700_000_000,
      ended_at: null,
      start_price: 0.98,
      peak_price: 0.98,
      recovery_price: null,
      peg_reference: 1,
      source: "live",
      recovery_first_seen_at: null,
    }));
    const preparedSqls: string[] = [];
    const db = mockD1([
      { match: "depeg_events", rows: openRows },
      { match: "dex_prices", rows: [] },
    ]);
    const originalPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return originalPrepare(sql);
    }) as typeof db.prepare;

    try {
      await detectDepegEvents(db, [makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.98 })]);

      expect(preparedSqls.some((sql) => sql.includes("INSERT INTO depeg_pending"))).toBe(false);
      expect(warnSpy.mock.calls.map(([message]) => String(message))).toContainEqual(
        expect.stringContaining('"event":"depeg_open_event_limit_reached"'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("skips orphan cleanup and emits a degraded warning when its open-event query reaches the limit", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const openRows = Array.from({ length: 200 }, (_, id) => ({
      id,
      stablecoin_id: `orphan-${id}`,
      started_at: 1_700_000_000,
    }));
    const preparedSqls: string[] = [];
    const db = mockD1([
      { match: "SELECT id, stablecoin_id, symbol", rows: [] },
      { match: "SELECT id, stablecoin_id, started_at FROM depeg_events", rows: openRows },
      { match: "dex_prices", rows: [] },
    ]);
    const originalPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return originalPrepare(sql);
    }) as typeof db.prepare;

    try {
      await detectDepegEvents(db, [makeAsset({ id: "usdt-tether", symbol: "USDT", price: 1.001 })]);

      expect(preparedSqls.some((sql) => sql.includes("UPDATE depeg_events SET ended_at"))).toBe(false);
      expect(warnSpy.mock.calls.map(([message]) => String(message))).toContainEqual(
        expect.stringContaining('"pass":"orphan-cleanup"'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("creates neither pending nor live rows for stable prices, NAV tokens, or invalid prices", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    await detectDepegEvents(db, [
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 1.001 }),
      makeAsset({ id: "usdc-circle", symbol: "USDC", price: 0.999 }),
      makeAsset({ id: "nav-token-test", symbol: "NAVT", price: 0.5 }),
      makeAsset({ id: "eurc-circle", symbol: "EUROC", price: null }),
      makeAsset({ id: "brz-transfero", symbol: "BRZ", price: NaN }),
      makeAsset({ id: "a7a5-old-vector", symbol: "A7A5", price: 0 }),
    ]);
    expect(sqlite.prepare("SELECT * FROM depeg_pending").all()).toEqual([]);
    expect(sqlite.prepare("SELECT * FROM depeg_events").all()).toEqual([]);
  });

  it.each([
    ["usdt-tether", "USDT", "peggedUSD", 1, 99, false],
    ["usdt-tether", "USDT", "peggedUSD", 1, 100, true],
    ["usdt-tether", "USDT", "peggedUSD", 1, 101, true],
    ["eurc-circle", "EUROC", "peggedEUR", 1.08, 149, false],
    ["eurc-circle", "EUROC", "peggedEUR", 1.08, 150, true],
    ["eurc-circle", "EUROC", "peggedEUR", 1.08, 151, true],
  ] as const)("routes %s at %i reference and %i bps to pending=%s", async (id, symbol, pegType, reference, bps, pending) => {
    const { sqlite, db } = sqliteFixtures.open();
    await detectDepegEvents(db, [makeAsset({ id, symbol, pegType, price: reference * (1 - bps / 10000) })]);
    expect(sqlite.prepare("SELECT stablecoin_id, direction, first_seen_bps FROM depeg_pending").all()).toEqual(
      pending ? [{ stablecoin_id: id, direction: "below", first_seen_bps: -bps }] : [],
    );
    expect(sqlite.prepare("SELECT * FROM depeg_events").all()).toEqual([]);
  });

  it("persists a worsening peak without replacing the event's origin", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    const now = Math.floor(Date.now() / 1000);
    seedOpenEvent(sqlite, { started_at: now - 600 });
    await detectDepegEvents(db, [makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.96 })]);
    expect(sqlite.prepare("SELECT id, started_at, start_price, peak_deviation_bps, peak_price, ended_at FROM depeg_events").all()).toEqual([
      { id: 1, started_at: now - 600, start_price: 0.98, peak_deviation_bps: -400, peak_price: 0.96, ended_at: null },
    ]);
  });

  it("persists sustained recovery at the observed price and time", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    const now = Math.floor(Date.now() / 1000);
    seedOpenEvent(sqlite, { recovery_first_seen_at: now - 900, recovery_last_seen_at: now - 900 });
    await detectDepegEvents(db, [makeAsset({ id: "usdt-tether", symbol: "USDT", price: 1.001 })]);
    expect(sqlite.prepare("SELECT id, ended_at, recovery_price, recovery_first_seen_at FROM depeg_events").all()).toEqual([
      { id: 1, ended_at: now, recovery_price: 1.001, recovery_first_seen_at: null },
    ]);
  });

  it("closes a stale live event when fresh multi-source primary agreement is back inside threshold", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
    const db = mockD1([
      {
        match: "depeg_events",
        rows: [{
          id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
          direction: "below", peak_deviation_bps: -220, started_at: now - 3600,
          start_price: 0.978, peak_price: 0.978, peg_reference: 1,
          recovery_price: null, ended_at: null, source: "live",
          recovery_first_seen_at: now - 900,
          recovery_last_seen_at: now - 900,
        }],
      },
      { match: "dex_prices", rows: [] },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    await detectDepegEvents(db, [
      makeAsset({
        id: "usdt-tether",
        symbol: "USDT",
        pegType: "peggedUSD",
        price: 0.9992,
        priceSource: "coingecko+defillama-list",
        priceConfidence: "high",
        priceObservedAt: now - 60,
        priceObservedAtMode: "unknown",
        agreeSources: ["coingecko", "defillama-list"],
      }),
    ]);

    const closures = preparedSqls.filter((sql) =>
      sql.includes("UPDATE depeg_events SET ended_at")
    );
    expect(closures.length).toBeGreaterThanOrEqual(1);
  });

  it("closes the old direction and persists the opposite pending candidate", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    const now = Math.floor(Date.now() / 1000);
    seedOpenEvent(sqlite);
    await detectDepegEvents(db, [makeAsset({ id: "usdt-tether", symbol: "USDT", price: 1.02 })]);
    expect(sqlite.prepare("SELECT id, direction, ended_at, recovery_price, close_reason FROM depeg_events").all()).toEqual([
      { id: 1, direction: "below", ended_at: now, recovery_price: null, close_reason: "superseded-direction" },
    ]);
    expect(sqlite.prepare("SELECT stablecoin_id, direction, first_price FROM depeg_pending").all()).toEqual([
      { stablecoin_id: "usdt-tether", direction: "above", first_price: 1.02 },
    ]);
  });

  it("keeps a live event open through an opposite low-confidence tick without DEX support", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
    const db = mockD1([
      {
        match: "depeg_events",
        rows: [{
          id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
          direction: "above", peak_deviation_bps: 220, started_at: now - 3600,
          start_price: 1.022, peak_price: 1.022, peg_reference: 1,
          recovery_price: null, ended_at: null, source: "live",
        }],
      },
      { match: "dex_prices", rows: [] },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    await detectDepegEvents(db, [
      makeAsset({
        id: "usdt-tether",
        symbol: "USDT",
        price: 0.55,
        priceSource: "coingecko",
        priceConfidence: "low",
        priceUpdatedAt: now,
      }),
    ]);

    const closures = preparedSqls.filter((sql) =>
      sql.includes("UPDATE depeg_events SET ended_at")
    );
    const pending = preparedSqls.filter((sql) =>
      sql.includes("INSERT INTO depeg_pending")
    );
    const liveInserts = preparedSqls.filter((sql) =>
      sql.includes("INSERT INTO depeg_events")
    );

    expect(closures).toHaveLength(0);
    expect(pending).toHaveLength(0);
    expect(liveInserts).toHaveLength(0);
  });

  it("retires a stale live event when an opposite low-confidence move has same-direction DEX support", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
    const db = mockD1([
      {
        match: "depeg_events",
        rows: [{
          id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
          direction: "above", peak_deviation_bps: 220, started_at: now - 3600,
          start_price: 1.022, peak_price: 1.022, peg_reference: 1,
          recovery_price: null, ended_at: null, source: "live",
        }],
      },
      {
        match: "SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at FROM dex_prices",
        rows: [{
          stablecoin_id: "usdt-tether",
          dex_price_usd: 0.55,
          deviation_from_primary_bps: 0,
          source_pool_count: 5,
          source_total_tvl: 5_000_000,
          updated_at: now - 60,
        }],
      },
      {
        match: "price_sources_json",
        rows: [{
          stablecoin_id: "usdt-tether",
          price_sources_json: JSON.stringify([
            { protocol: "curve", sourceFamily: "curve", chain: "ethereum", price: 0.55, tvl: 3_000_000 },
            { protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum", price: 0.551, tvl: 2_000_000 },
          ]),
          updated_at: now - 60,
        }],
      },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    await detectDepegEvents(db, [
      makeAsset({
        id: "usdt-tether",
        symbol: "USDT",
        price: 0.55,
        priceSource: "coingecko",
        priceConfidence: "low",
        priceUpdatedAt: now,
      }),
    ]);

    const closures = preparedSqls.filter((sql) =>
      sql.includes("UPDATE depeg_events SET ended_at")
    );
    const pending = preparedSqls.filter((sql) =>
      sql.includes("INSERT INTO depeg_pending")
    );
    const liveInserts = preparedSqls.filter((sql) =>
      sql.includes("INSERT INTO depeg_events")
    );

    expect(closures.length).toBeGreaterThanOrEqual(1);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(liveInserts).toHaveLength(0);
  });

  it("merges duplicates into the earliest event and absorbs the worst peak", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    const now = Math.floor(Date.now() / 1000);
    seedOpenEvent(sqlite, { id: 2, started_at: now - 3600, peak_deviation_bps: -300, peak_price: 0.97 });
    seedOpenEvent(sqlite, { id: 7, started_at: now - 7200, start_price: 0.985, peak_deviation_bps: -150, peak_price: 0.985 });
    await detectDepegEvents(db, [makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.98 })]);
    expect(sqlite.prepare("SELECT id, started_at, start_price, peak_deviation_bps, peak_price, ended_at FROM depeg_events").all()).toEqual([
      { id: 7, started_at: now - 7200, start_price: 0.985, peak_deviation_bps: -300, peak_price: 0.97, ended_at: null },
    ]);
  });

  it("inserts into depeg_pending for >$1B coins", async () => {
    const preparedSqls: string[] = [];
    const db = mockD1([
      { match: "depeg_events", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    // >$1B supply coin with depeg
    const assets = [
      makeAsset({
        id: "usdt-tether", symbol: "USDT", price: 0.98,
        circulating: { ethereum: 2_000_000_000 },
      }),
    ];

    await detectDepegEvents(db, assets);

    const pendingInserts = preparedSqls.filter(s =>
      s.includes("INSERT INTO depeg_pending")
    );
    expect(pendingInserts.length).toBeGreaterThanOrEqual(1);
    expect(pendingInserts.some((sql) => sql.includes("ON CONFLICT(stablecoin_id) DO UPDATE SET"))).toBe(true);

    // Should NOT insert into depeg_events directly
    const eventInserts = preparedSqls.filter(s =>
      s.includes("INSERT INTO depeg_events")
    );
    expect(eventInserts).toHaveLength(0);
  });

  it("skips coins with supply < $1M", async () => {
    const preparedSqls: string[] = [];
    const db = mockD1([
      { match: "depeg_events", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    const assets = [
      makeAsset({
        id: "usdc-circle", symbol: "USDC", price: 0.90,
        circulating: { ethereum: 500_000 }, // only $500k
      }),
    ];

    await detectDepegEvents(db, assets);

    const inserts = preparedSqls.filter(s =>
      s.includes("INSERT INTO depeg_events") || s.includes("INSERT INTO depeg_pending")
    );
    expect(inserts).toHaveLength(0);
  });

  it("closes an existing live event when tracked supply drops below the live-event floor", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "depeg_events",
        rows: [{
          id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
          direction: "below", peak_deviation_bps: -200, started_at: now - 3600,
          start_price: 0.98, peak_price: 0.98, peg_reference: 1,
          recovery_price: null, ended_at: null, source: "live",
        }],
      },
      { match: "dex_prices", rows: [] },
    ]);

    await detectDepegEvents(db, [
      makeAsset({
        id: "usdt-tether",
        symbol: "USDT",
        price: 0.90,
        circulating: { ethereum: 500_000 },
      }),
    ]);

    const closeCall = db.getHistory().find((entry) => isCloseEventUpdate(entry.sql));
    expect(closeCall?.binds).toEqual([now, null, "coverage-lost-supply", 1]);
    const inserts = db.getHistory().filter((entry) =>
      entry.sql.includes("INSERT INTO depeg_events") || entry.sql.includes("INSERT INTO depeg_pending"),
    );
    expect(inserts).toHaveLength(0);
  });

  it("does not suppress a new event when fresh DEX data is below the depeg trust TVL floor", async () => {
    const preparedSqls: string[] = [];
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "depeg_events", rows: [] },
      {
        match: "dex_prices",
        rows: [{
          stablecoin_id: "usdt-tether",
          dex_price_usd: 1.0005,
          deviation_from_primary_bps: 5,
          source_pool_count: 1,
          source_total_tvl: 250_000,
          updated_at: now - 60,
        }],
      },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    await detectDepegEvents(db, [
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.98 }),
    ]);

    const inserts = preparedSqls.filter((sql) => sql.includes("INSERT INTO depeg_pending"));
    expect(inserts.length).toBeGreaterThanOrEqual(1);
  });

  it("fails closed without a live or cached RUB reference and writes no A7A5 depeg", async () => {
    const preparedSqls: string[] = [];
    const db = mockD1([
      { match: "depeg_events", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    await detectDepegEvents(db, [
      makeAsset({
        id: "a7a5-old-vector",
        symbol: "A7A5",
        pegType: "peggedRUB",
        price: 0.02,
        priceSource: "pyth",
        priceConfidence: "single-source",
      }),
    ]);

    const inserts = preparedSqls.filter((sql) =>
      sql.includes("INSERT INTO depeg_events") || sql.includes("INSERT INTO depeg_pending")
    );
    expect(inserts).toHaveLength(0);
  });

  it("suppresses a BRZ depeg when the direct BRL quote is back inside threshold", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
    vi.mocked(fetchCurrentNativePegQuotes).mockResolvedValue(new Map([
      ["brz-transfero", {
        stablecoinId: "brz-transfero",
        geckoId: "brz",
        pegCurrency: "BRL",
        price: 0.995,
        updatedAt: now - 60,
      }],
    ]));

    const db = mockD1([
      { match: "depeg_events", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    await detectDepegEvents(
      db,
      [
        makeAsset({
          id: "brz-transfero",
          symbol: "BRZ",
          pegType: "peggedREAL",
          price: 0.190587,
          priceSource: "pyth",
          priceConfidence: "single-source",
        }),
      ],
      { peggedREAL: 0.18765951 },
    );

    const inserts = preparedSqls.filter((sql) =>
      sql.includes("INSERT INTO depeg_events") || sql.includes("INSERT INTO depeg_pending")
    );
    expect(inserts).toHaveLength(0);
  });

  it("closes an open BRZ event after sustained recovery in the BRL quote", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
    vi.mocked(fetchCurrentNativePegQuotes).mockResolvedValue(new Map([
      ["brz-transfero", {
        stablecoinId: "brz-transfero",
        geckoId: "brz",
        pegCurrency: "BRL",
        price: 0.995,
        updatedAt: now - 60,
      }],
    ]));

    const db = mockD1([
      {
        match: "depeg_events",
        rows: [{
          id: 1,
          stablecoin_id: "brz-transfero",
          symbol: "BRZ",
          peg_type: "peggedREAL",
          direction: "above",
          peak_deviation_bps: 180,
          started_at: now - 3600,
          start_price: 0.1909,
          peak_price: 0.191,
          peg_reference: 0.18765951,
          recovery_price: null,
          ended_at: null,
          source: "live",
          recovery_first_seen_at: now - 900,
          recovery_last_seen_at: now - 900,
        }],
      },
      { match: "dex_prices", rows: [] },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    await detectDepegEvents(
      db,
      [
        makeAsset({
          id: "brz-transfero",
          symbol: "BRZ",
          pegType: "peggedREAL",
          price: 0.190587,
          priceSource: "pyth",
          priceConfidence: "single-source",
        }),
      ],
      { peggedREAL: 0.18765951 },
    );

    expect(preparedSqls.some(isCloseEventUpdate)).toBe(true);
  });


  it.each([[5, "above"], [0.01, "below"]] as const)("routes extreme price %s into %s pending confirmation", async (price, direction) => {
    const { sqlite, db } = sqliteFixtures.open();
    await detectDepegEvents(db, [makeAsset({ id: "usdt-tether", symbol: "USDT", price })]);
    expect(sqlite.prepare("SELECT stablecoin_id, direction, first_price FROM depeg_pending").all()).toEqual([
      { stablecoin_id: "usdt-tether", direction, first_price: price },
    ]);
    expect(sqlite.prepare("SELECT * FROM depeg_events").all()).toEqual([]);
  });

  it("routes fresh multi-source extreme downside moves through pending confirmation", async () => {
    const preparedSqls: string[] = [];
    const db = mockD1([
      { match: "depeg_events", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    const now = Math.floor(Date.now() / 1000);
    const assets = [
      makeAsset({
        id: "usdt-tether",
        symbol: "USDT",
        price: 0.2,
        priceSource: "coingecko+defillama-list",
        priceConfidence: "high",
        agreeSources: ["coingecko", "defillama-list"],
        priceUpdatedAt: now - 60,
        circulating: { ethereum: 20_000_000 },
      }),
    ];

    await detectDepegEvents(db, assets);

    expect(preparedSqls.some((sql) => sql.includes("INSERT INTO depeg_events"))).toBe(false);
    expect(preparedSqls.some((sql) => sql.includes("INSERT INTO depeg_pending"))).toBe(true);
  });

  it("allows legitimate depeg prices within bounds", async () => {
    const preparedSqls: string[] = [];
    const db = mockD1([
      { match: "depeg_events", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    // 0.85 is 85% of peg - severe depeg but within 0.5-2.0 range
    const assets = [
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.85 }),
    ];

    await detectDepegEvents(db, assets);

    const inserts = preparedSqls.filter(s =>
      s.includes("INSERT INTO depeg_pending")
    );
    expect(inserts.length).toBeGreaterThanOrEqual(1);
  });

  it("does not open a live event from cached fallback prices", async () => {
    const preparedSqls: string[] = [];
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "depeg_events", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    await detectDepegEvents(db, [
      makeAsset({
        id: "usdt-tether",
        symbol: "USDT",
        price: 0.98,
        priceSource: "cached",
        priceConfidence: "fallback",
        priceUpdatedAt: now - 600,
      }),
    ]);

    expect(preparedSqls.some((sql) => sql.includes("INSERT INTO depeg_events"))).toBe(false);
    expect(preparedSqls.some((sql) => sql.includes("INSERT INTO depeg_pending"))).toBe(true);
  });

  it("updates peak for confirmed extreme moves below 50% of peg on an ongoing event", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
    const db = mockD1([
      {
        match: "depeg_events",
        rows: [{
          id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
          direction: "below", peak_deviation_bps: -4000, started_at: now - 3600,
          start_price: 0.6, peak_price: 0.6, peg_reference: 1,
          recovery_price: null, ended_at: null, source: "live",
        }],
      },
      {
        match: "dex_prices",
        rows: [{
          stablecoin_id: "usdt-tether",
          dex_price_usd: 0.3,
          deviation_from_primary_bps: 0,
          source_pool_count: 4,
          source_total_tvl: 5_000_000,
          updated_at: now - 60,
        }],
      },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    await detectDepegEvents(db, [
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.3 }),
    ]);

    expect(preparedSqls.some((sql) => sql.includes("UPDATE depeg_events SET peak_deviation_bps"))).toBe(true);
  });

  it("updates a worse same-direction peak when low-confidence primary is corroborated by DEX at the secondary bar", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "depeg_events",
        rows: [{
          id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
          direction: "below", peak_deviation_bps: -200, started_at: now - 3600,
          start_price: 0.98, peak_price: 0.98, peg_reference: 1,
          recovery_price: null, ended_at: null, source: "live",
        }],
      },
      {
        match: "SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at FROM dex_prices",
        rows: [{
          stablecoin_id: "usdt-tether",
          dex_price_usd: 0.985,
          deviation_from_primary_bps: 240,
          source_pool_count: 4,
          source_total_tvl: 4_000_000,
          updated_at: now - 60,
        }],
      },
      {
        match: "price_sources_json",
        rows: [{
          stablecoin_id: "usdt-tether",
          price_sources_json: JSON.stringify([
            { protocol: "curve", sourceFamily: "curve", chain: "ethereum", price: 0.985, tvl: 2_000_000 },
            { protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum", price: 0.9845, tvl: 2_000_000 },
          ]),
          updated_at: now - 60,
        }],
      },
    ]);

    await detectDepegEvents(db, [
      makeAsset({
        id: "usdt-tether",
        symbol: "USDT",
        price: 0.97,
        priceSource: "coingecko",
        priceConfidence: "low",
        priceUpdatedAt: now,
      }),
    ]);

    const peakUpdate = db.getHistory().find((entry) =>
      entry.sql.includes("UPDATE depeg_events SET peak_deviation_bps = ?, peak_price = ? WHERE id = ?"),
    );
    expect(peakUpdate?.binds).toEqual([-300, 0.97, 1]);
  });

  it("keeps an ongoing event open when only aggregate DEX disagrees", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
    const db = mockD1([
      {
        match: "depeg_events",
        rows: [{
          id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
          direction: "below", peak_deviation_bps: -200, started_at: now - 2400,
          start_price: 0.98, peak_price: 0.98, peg_reference: 1,
          recovery_price: null, ended_at: null, source: "live",
        }],
      },
      {
        match: "dex_prices",
        rows: [{
          stablecoin_id: "usdt-tether",
          dex_price_usd: 1.001, // DEX says price is fine
          source_pool_count: 5,
          source_total_tvl: 5_000_000, // >$1M TVL
          updated_at: now - 60, // Fresh DEX data
        }],
      },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    // Primary source still shows depeg
    const assets = [
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.98 }),
    ];

    await detectDepegEvents(db, assets);

    const closures = preparedSqls.filter(s =>
      s.includes("UPDATE depeg_events SET ended_at")
    );
    expect(closures).toHaveLength(0);
  });

  it("keeps an ongoing event open when ambiguous recovery is backed by only one near-peg DEX protocol and challengers still show the old depeg", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
    const db = mockD1([
      {
        match: "depeg_events",
        rows: [{
          id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
          direction: "below", peak_deviation_bps: -8800, started_at: now - 7200,
          start_price: 0.12, peak_price: 0.11, peg_reference: 1,
          recovery_price: null, ended_at: null, source: "live",
        }],
      },
      {
        match: "SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at FROM dex_prices",
        rows: [{
          stablecoin_id: "usdt-tether",
          dex_price_usd: 0.9993,
          deviation_from_primary_bps: 5,
          source_pool_count: 6,
          source_total_tvl: 2_143_513,
          updated_at: now - 60,
        }],
      },
      {
        match: "price_sources_json",
        rows: [{
          stablecoin_id: "usdt-tether",
          price_sources_json: JSON.stringify([
            { protocol: "bunni-ethereum", sourceFamily: "bunni-ethereum", chain: "ethereum", price: 0.9993, tvl: 1_451_774 },
            { protocol: "uniswap-v4-ethereum", sourceFamily: "uniswap-v4-ethereum", chain: "ethereum", price: 0.31388474, tvl: 627_528 },
            { protocol: "curve", sourceFamily: "curve", chain: "ethereum", price: 0.111775, tvl: 64_711 },
          ]),
          updated_at: now - 60,
        }],
      },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    await detectDepegEvents(db, [
      makeAsset({
        id: "usdt-tether",
        symbol: "USDT",
        price: 1.0001,
        priceSource: "cached",
        priceConfidence: "fallback",
        priceUpdatedAt: now - 600,
      }),
    ]);

    const closures = preparedSqls.filter((sql) =>
      sql.includes("UPDATE depeg_events SET ended_at")
    );
    expect(closures).toHaveLength(0);
  });

  it("persists ambiguous recovery corroborated by independent DEX protocols", async () => {
    const { sqlite, db } = sqliteFixtures.open();
    const now = Math.floor(Date.now() / 1000);
    seedOpenEvent(sqlite, { recovery_first_seen_at: now - 900, recovery_last_seen_at: now - 900 });
    seedDexEvidence(sqlite, 0.9998, [
      { protocol: "fluid", price: 0.9997, tvl: 900_000 },
      { protocol: "balancer", price: 1.0001, tvl: 700_000 },
      { protocol: "curve", price: 0.9999, tvl: 300_000 },
    ]);
    await detectDepegEvents(db, [makeAsset({
      id: "usdt-tether", symbol: "USDT", price: 0.9999,
      priceSource: "cached", priceConfidence: "fallback", priceUpdatedAt: now - 600,
    })]);
    expect(sqlite.prepare("SELECT id, ended_at, recovery_price, close_reason FROM depeg_events").all()).toEqual([
      { id: 1, ended_at: now, recovery_price: 0.9998, close_reason: "recovered-dex" },
    ]);
  });

  it("keeps an ongoing event open when authoritative primary recovery conflicts with trusted DEX depeg evidence", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
    const db = mockD1([
      {
        match: "depeg_events",
        rows: [{
          id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
          direction: "below", peak_deviation_bps: -1059, started_at: now - 10 * 24 * 3600,
          start_price: 0.989, peak_price: 0.894, peg_reference: 1,
          recovery_price: null, ended_at: null, source: "live",
        }],
      },
      {
        match: "SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at FROM dex_prices",
        rows: [{
          stablecoin_id: "usdt-tether",
          dex_price_usd: 0.9439,
          deviation_from_primary_bps: -566,
          source_pool_count: 6,
          source_total_tvl: 19_900_000,
          updated_at: now - 60,
        }],
      },
      {
        match: "price_sources_json",
        rows: [{
          stablecoin_id: "usdt-tether",
          price_sources_json: JSON.stringify([
            { protocol: "curve", sourceFamily: "curve", chain: "ethereum", price: 0.9438, tvl: 11_000_000 },
            { protocol: "pancakeswap", sourceFamily: "pancakeswap", chain: "bsc", price: 0.9461, tvl: 5_000_000 },
            { protocol: "uniswap-v4", sourceFamily: "uniswap-v4", chain: "ethereum", price: 0.9442, tvl: 3_000_000 },
          ]),
          updated_at: now - 60,
        }],
      },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    await detectDepegEvents(db, [
      makeAsset({
        id: "usdt-tether",
        symbol: "USDT",
        price: 1.0006,
        priceSource: "coingecko",
        priceConfidence: "high",
        priceUpdatedAt: now - 60,
      }),
    ]);

    const closures = preparedSqls.filter((sql) =>
      sql.includes("UPDATE depeg_events SET ended_at")
    );
    expect(closures).toHaveLength(0);
  });

  it("does not suppress a new event when aggregate DEX recovery lacks corroborating protocol support", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
    const db = mockD1([
      { match: "depeg_events", rows: [] },
      {
        match: "SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at FROM dex_prices",
        rows: [{
          stablecoin_id: "usdt-tether",
          dex_price_usd: 0.9993,
          deviation_from_primary_bps: 5,
          source_pool_count: 6,
          source_total_tvl: 2_143_513,
          updated_at: now - 60,
        }],
      },
      {
        match: "price_sources_json",
        rows: [{
          stablecoin_id: "usdt-tether",
          price_sources_json: JSON.stringify([
            { protocol: "bunni-ethereum", sourceFamily: "bunni-ethereum", chain: "ethereum", price: 0.9993, tvl: 1_451_774 },
            { protocol: "uniswap-v4-ethereum", sourceFamily: "uniswap-v4-ethereum", chain: "ethereum", price: 0.31388474, tvl: 627_528 },
            { protocol: "curve", sourceFamily: "curve", chain: "ethereum", price: 0.111775, tvl: 64_711 },
          ]),
          updated_at: now - 60,
        }],
      },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    await detectDepegEvents(db, [
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.98 }),
    ]);

    const inserts = preparedSqls.filter((sql) => sql.includes("INSERT INTO depeg_pending"));
    expect(inserts.length).toBeGreaterThanOrEqual(1);
  });

  it("does not orphan-close tracked events during transient invalid-price data gaps", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
    const db = mockD1([
      {
        match: "depeg_events",
        rows: [{
          id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
          direction: "below", peak_deviation_bps: -240, started_at: now - 7200,
          start_price: 0.976, peak_price: 0.976, peg_reference: 1,
          recovery_price: null, ended_at: null, source: "live",
        }],
      },
      { match: "dex_prices", rows: [] },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    await detectDepegEvents(db, [
      makeAsset({
        id: "usdt-tether",
        symbol: "USDT",
        pegType: "peggedUSD",
        price: Number.NaN, // missing price this cycle
        priceSource: "defillama",
        priceConfidence: "single-source",
        priceUpdatedAt: now,
        circulating: { ethereum: 10_000_000 },
      }),
    ]);

    const orphanClosures = preparedSqls.filter(isCloseEventUpdate);
    expect(orphanClosures).toHaveLength(0);
  });

  it("does not orphan-close tracked events when a partial payload omits the coin entirely", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "depeg_events",
        rows: [{
          id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
          direction: "below", peak_deviation_bps: -240, started_at: now - 7200,
          start_price: 0.976, peak_price: 0.976, peg_reference: 1,
          recovery_price: null, ended_at: null, source: "live",
        }],
      },
      { match: "dex_prices", rows: [] },
    ]);

    await detectDepegEvents(db, [
      makeAsset({
        id: "usdc-circle",
        symbol: "USDC",
        pegType: "peggedUSD",
        price: 1,
      }),
    ]);

    const orphanClosures = db.getHistory().filter((entry) => isCloseEventUpdate(entry.sql));
    expect(orphanClosures).toHaveLength(0);
  });

  it("still orphan-closes open events for coins removed from the tracked universe", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "depeg_events",
        rows: [{
          id: 99, stablecoin_id: "removed-coin", symbol: "OLD", peg_type: "peggedUSD",
          direction: "below", peak_deviation_bps: -240, started_at: now - 7200,
          start_price: 0.976, peak_price: 0.976, peg_reference: 1,
          recovery_price: null, ended_at: null, source: "live",
        }],
      },
      { match: "dex_prices", rows: [] },
    ]);

    await detectDepegEvents(db, [
      makeAsset({
        id: "usdc-circle",
        symbol: "USDC",
        pegType: "peggedUSD",
        price: 1,
      }),
    ]);

    const orphanClosure = db.getHistory().find((entry) => isCloseEventUpdate(entry.sql));
    expect(orphanClosure?.binds).toEqual([now, null, "orphan-tracking-removed", 99]);
  });
});
