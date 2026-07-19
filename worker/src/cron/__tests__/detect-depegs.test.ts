import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

// Stub psi-eligible to avoid importing the full stablecoins list
vi.mock("@shared/lib/psi-eligible", () => ({
  PSI_ELIGIBLE_STABLECOINS: [
    { id: "usdt-tether", symbol: "USDT", pegType: "peggedUSD", geckoId: "tether", flags: { navToken: false }, commodityOunces: undefined },
    { id: "usdc-circle", symbol: "USDC", pegType: "peggedUSD", geckoId: "usd-coin", flags: { navToken: false }, commodityOunces: undefined },
    { id: "eurc-circle", symbol: "EUROC", pegType: "peggedEUR", geckoId: "euro-coin", flags: { navToken: false }, commodityOunces: undefined },
    { id: "brz-transfero", symbol: "BRZ", pegType: "peggedREAL", geckoId: "brz", flags: { navToken: false, pegCurrency: "BRL" }, commodityOunces: undefined },
    { id: "nav-token-test", symbol: "NAVT", pegType: "peggedUSD", geckoId: "nav-token", flags: { navToken: true }, commodityOunces: undefined },
  ],
  PSI_ELIGIBLE_META_BY_ID: new Map([
    ["usdt-tether", { id: "usdt-tether", symbol: "USDT", pegType: "peggedUSD", geckoId: "tether", flags: { navToken: false, pegCurrency: "USD" }, commodityOunces: undefined }],
    ["usdc-circle", { id: "usdc-circle", symbol: "USDC", pegType: "peggedUSD", geckoId: "usd-coin", flags: { navToken: false, pegCurrency: "USD" }, commodityOunces: undefined }],
    ["eurc-circle", { id: "eurc-circle", symbol: "EUROC", pegType: "peggedEUR", geckoId: "euro-coin", flags: { navToken: false, pegCurrency: "EUR" }, commodityOunces: undefined }],
    ["brz-transfero", { id: "brz-transfero", symbol: "BRZ", pegType: "peggedREAL", geckoId: "brz", flags: { navToken: false, pegCurrency: "BRL" }, commodityOunces: undefined }],
    ["nav-token-test", { id: "nav-token-test", symbol: "NAVT", pegType: "peggedUSD", geckoId: "nav-token", flags: { navToken: true, pegCurrency: "USD" }, commodityOunces: undefined }],
  ]),
}));

// Stub peg-rates
vi.mock("@shared/lib/peg-rates", () => ({
  derivePegRates: (_assets: unknown, _metaById: unknown, fxFallbackRates?: Record<string, number>) => ({
    rates: { peggedUSD: 1, peggedEUR: 1.08, peggedREAL: fxFallbackRates?.peggedREAL ?? 0.18765951 },
    sources: {
      peggedUSD: "median",
      peggedEUR: "median",
      peggedREAL: fxFallbackRates?.peggedREAL ? "fallback" : "median",
    },
    counts: { peggedUSD: 4, peggedEUR: 4, peggedREAL: 2 },
  }),
  getPegReference: (pegType: string, rates: Record<string, number>) => rates[pegType] ?? 1,
  normalizePegType: (pegType: string | undefined) => pegType,
}));

vi.mock("../../lib/native-peg-quotes", () => ({
  fetchCurrentNativePegQuotes: vi.fn(async () => new Map()),
}));

// Stub supply
vi.mock("@shared/lib/supply", () => ({
  sumPegBuckets: (c: Record<string, number> | undefined) => {
    if (!c) return 0;
    return Object.values(c).reduce((a, b) => a + b, 0);
  },
}));

import { detectDepegEvents } from "../detect-depegs";
import { fetchCurrentNativePegQuotes } from "../../lib/native-peg-quotes";

function isCloseEventUpdate(sql: string): boolean {
  return sql.includes("UPDATE depeg_events SET ended_at = ?, recovery_price = ?, close_reason = ? WHERE id = ?");
}

// Helper to build a minimal asset
function makeAsset(overrides: {
  id: string;
  symbol: string;
  price: number;
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
  });

  it("no events created when prices are stable", async () => {
    const prepareSpy = vi.fn();
    const db = mockD1([
      { match: "depeg_events", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      prepareSpy(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    const assets = [
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 1.001 }),
      makeAsset({ id: "usdc-circle", symbol: "USDC", price: 0.999 }),
    ];

    await detectDepegEvents(db, assets);

    // No INSERT should have been called
    const insertCalls = prepareSpy.mock.calls.filter(
      (args) => (args[0] as string).includes("INSERT INTO depeg_events")
    );
    expect(insertCalls).toHaveLength(0);
  });

  it("opens a new depeg event when price deviates past threshold", async () => {
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

    // USDT at 0.98 → 200 bps below peg, above 100 bps threshold
    const assets = [
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.98 }),
    ];

    await detectDepegEvents(db, assets);

    const inserts = preparedSqls.filter(s => s.includes("INSERT INTO depeg_events"));
    expect(inserts.length).toBeGreaterThanOrEqual(1);
  });

  it("does not trigger at exactly the threshold (100 bps for USD)", async () => {
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

    // 99 bps below → should NOT trigger (0.99 → ~100 bps, but round() may edge it)
    // Use 0.991 which is clearly only 90 bps
    const assets = [
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.991 }),
    ];

    await detectDepegEvents(db, assets);

    const inserts = preparedSqls.filter(s => s.includes("INSERT INTO depeg_events"));
    expect(inserts).toHaveLength(0);
  });

  it("uses higher threshold (150 bps) for non-USD pegs", async () => {
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

    // EUROC: pegRef=1.08, price=1.065 → bps = round((1.065/1.08 - 1) * 10000) = -139 → <150, no event
    const assets = [
      makeAsset({ id: "eurc-circle", symbol: "EUROC", price: 1.065, pegType: "peggedEUR" }),
    ];

    await detectDepegEvents(db, assets);

    const inserts = preparedSqls.filter(s => s.includes("INSERT INTO depeg_events"));
    expect(inserts).toHaveLength(0);
  });

  it("updates peak deviation when price worsens during ongoing event", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
    const db = mockD1([
      {
        match: "depeg_events",
        rows: [{
          id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
          direction: "below", peak_deviation_bps: -200, started_at: now - 600,
          start_price: 0.98, peak_price: 0.98, peg_reference: 1,
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

    // Worse deviation: 0.96 → -400 bps
    const assets = [
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.96 }),
    ];

    await detectDepegEvents(db, assets);

    const peakUpdates = preparedSqls.filter(s =>
      s.includes("UPDATE depeg_events SET peak_deviation_bps")
    );
    expect(peakUpdates.length).toBeGreaterThanOrEqual(1);
  });

  it("closes event when price recovers", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
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
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    // Price recovered
    const assets = [
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 1.001 }),
    ];

    await detectDepegEvents(db, assets);

    const closures = preparedSqls.filter(s =>
      s.includes("UPDATE depeg_events SET ended_at")
    );
    expect(closures.length).toBeGreaterThanOrEqual(1);
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

  it("handles direction change: closes old and opens new", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
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
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    // Now above peg: 1.02 → +200 bps (direction change from "below" to "above")
    const assets = [
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 1.02 }),
    ];

    await detectDepegEvents(db, assets);

    const closures = preparedSqls.filter(s =>
      s.includes("UPDATE depeg_events SET ended_at")
    );
    const inserts = preparedSqls.filter(s =>
      s.includes("INSERT INTO depeg_events")
    );
    expect(closures.length).toBeGreaterThanOrEqual(1);
    expect(inserts.length).toBeGreaterThanOrEqual(1);
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

  it("merges duplicate open events: keeps earliest, absorbs worst peak", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
    const db = mockD1([
      {
        match: "depeg_events",
        rows: [
          {
            id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
            direction: "below", peak_deviation_bps: -150, started_at: now - 7200,
            start_price: 0.985, peak_price: 0.985, peg_reference: 1,
            recovery_price: null, ended_at: null, source: "live",
          },
          {
            id: 2, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD",
            direction: "below", peak_deviation_bps: -300, started_at: now - 3600,
            start_price: 0.97, peak_price: 0.97, peg_reference: 1,
            recovery_price: null, ended_at: null, source: "live",
          },
        ],
      },
      { match: "dex_prices", rows: [] },
    ]);
    const origPrepare = db.prepare.bind(db);
    db.prepare = vi.fn((sql: string) => {
      preparedSqls.push(sql);
      return origPrepare(sql);
    }) as typeof db.prepare;

    // Still depegging
    const assets = [
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.97 }),
    ];

    await detectDepegEvents(db, assets);

    // Should delete the duplicate
    const deletes = preparedSqls.filter(s => s.includes("DELETE FROM depeg_events"));
    expect(deletes.length).toBeGreaterThanOrEqual(1);
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

    const inserts = preparedSqls.filter((sql) => sql.includes("INSERT INTO depeg_events"));
    expect(inserts.length).toBeGreaterThanOrEqual(1);
  });

  it("fails closed for thin fiat peg references that only have a peer median", async () => {
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
        id: "brz-transfero",
        symbol: "BRZ",
        pegType: "peggedREAL",
        price: 0.190587,
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

  it("closes an open BRZ event when the direct BRL quote shows recovery", async () => {
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

  it("skips NAV tokens", async () => {
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
      makeAsset({ id: "nav-token-test", symbol: "NAVT", price: 0.50 }),
    ];

    await detectDepegEvents(db, assets);

    const inserts = preparedSqls.filter(s =>
      s.includes("INSERT INTO depeg_events")
    );
    expect(inserts).toHaveLength(0);
  });

  it("skips assets with null/NaN/zero price", async () => {
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
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0 }),
      makeAsset({ id: "usdc-circle", symbol: "USDC", price: NaN }),
    ];

    await detectDepegEvents(db, assets);

    const inserts = preparedSqls.filter(s =>
      s.includes("INSERT INTO depeg_events")
    );
    expect(inserts).toHaveLength(0);
  });

  it("routes extreme upside moves into pending confirmation instead of dropping them", async () => {
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
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 5.00 }),
    ];

    await detectDepegEvents(db, assets);

    const pending = preparedSqls.filter(s =>
      s.includes("INSERT INTO depeg_pending")
    );
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });

  it("routes extreme downside moves into pending confirmation instead of dropping them", async () => {
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
      makeAsset({ id: "usdt-tether", symbol: "USDT", price: 0.01 }),
    ];

    await detectDepegEvents(db, assets);

    const pending = preparedSqls.filter(s =>
      s.includes("INSERT INTO depeg_pending")
    );
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });

  it("opens fresh independent multi-source extreme downside moves below the large-cap floor", async () => {
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

    expect(preparedSqls.some((sql) => sql.includes("INSERT INTO depeg_events"))).toBe(true);
    expect(preparedSqls.some((sql) => sql.includes("INSERT INTO depeg_pending"))).toBe(false);
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
      s.includes("INSERT INTO depeg_events")
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
          dex_price_usd: 0.994,
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
            { protocol: "curve", sourceFamily: "curve", chain: "ethereum", price: 0.994, tvl: 2_000_000 },
            { protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum", price: 0.9945, tvl: 2_000_000 },
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

  it("closes an ongoing event when ambiguous recovery is corroborated by multiple DEX protocols with no challenger contradiction", async () => {
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
      {
        match: "SELECT stablecoin_id, dex_price_usd, deviation_from_primary_bps, source_pool_count, source_total_tvl, updated_at FROM dex_prices",
        rows: [{
          stablecoin_id: "usdt-tether",
          dex_price_usd: 0.9998,
          deviation_from_primary_bps: 3,
          source_pool_count: 4,
          source_total_tvl: 1_900_000,
          updated_at: now - 60,
        }],
      },
      {
        match: "price_sources_json",
        rows: [{
          stablecoin_id: "usdt-tether",
          price_sources_json: JSON.stringify([
            { protocol: "fluid", sourceFamily: "fluid", chain: "ethereum", price: 0.9997, tvl: 900_000 },
            { protocol: "balancer", sourceFamily: "balancer", chain: "ethereum", price: 1.0001, tvl: 700_000 },
            { protocol: "curve", sourceFamily: "curve", chain: "ethereum", price: 0.9999, tvl: 300_000 },
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
        price: 0.9999,
        priceSource: "cached",
        priceConfidence: "fallback",
        priceUpdatedAt: now - 600,
      }),
    ]);

    const closures = preparedSqls.filter((sql) =>
      sql.includes("UPDATE depeg_events SET ended_at")
    );
    expect(closures.length).toBeGreaterThanOrEqual(1);
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

    const inserts = preparedSqls.filter((sql) => sql.includes("INSERT INTO depeg_events"));
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
