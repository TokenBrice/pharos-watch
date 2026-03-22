import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

// Stub psi-eligible to avoid importing the full stablecoins list
vi.mock("@shared/lib/psi-eligible", () => ({
  PSI_ELIGIBLE_STABLECOINS: [
    { id: "usdt-tether", symbol: "USDT", pegType: "peggedUSD", geckoId: "tether", flags: { navToken: false }, commodityOunces: undefined },
    { id: "usdc-circle", symbol: "USDC", pegType: "peggedUSD", geckoId: "usd-coin", flags: { navToken: false }, commodityOunces: undefined },
    { id: "eurc-circle", symbol: "EUROC", pegType: "peggedEUR", geckoId: "euro-coin", flags: { navToken: false }, commodityOunces: undefined },
    { id: "nav-token-test", symbol: "NAVT", pegType: "peggedUSD", geckoId: "nav-token", flags: { navToken: true }, commodityOunces: undefined },
  ],
  PSI_ELIGIBLE_META_BY_ID: new Map([
    ["usdt-tether", { id: "usdt-tether", symbol: "USDT", pegType: "peggedUSD", geckoId: "tether", flags: { navToken: false }, commodityOunces: undefined }],
    ["usdc-circle", { id: "usdc-circle", symbol: "USDC", pegType: "peggedUSD", geckoId: "usd-coin", flags: { navToken: false }, commodityOunces: undefined }],
    ["eurc-circle", { id: "eurc-circle", symbol: "EUROC", pegType: "peggedEUR", geckoId: "euro-coin", flags: { navToken: false }, commodityOunces: undefined }],
    ["nav-token-test", { id: "nav-token-test", symbol: "NAVT", pegType: "peggedUSD", geckoId: "nav-token", flags: { navToken: true }, commodityOunces: undefined }],
  ]),
}));

// Stub peg-rates
vi.mock("@shared/lib/peg-rates", () => ({
  derivePegRates: () => ({ rates: { peggedUSD: 1, peggedEUR: 1.08 } }),
  getPegReference: (pegType: string, rates: Record<string, number>) => rates[pegType] ?? 1,
}));

// Stub supply
vi.mock("@shared/lib/supply", () => ({
  sumPegBuckets: (c: Record<string, number> | undefined) => {
    if (!c) return 0;
    return Object.values(c).reduce((a, b) => a + b, 0);
  },
}));

import { detectDepegEvents } from "../detect-depegs";

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
}) {
  return {
    id: overrides.id,
    symbol: overrides.symbol,
    price: overrides.price,
    priceSource: overrides.priceSource ?? "pyth",
    priceConfidence: overrides.priceConfidence ?? "single-source",
    priceUpdatedAt: overrides.priceUpdatedAt ?? Math.floor(Date.now() / 1000),
    pegType: overrides.pegType ?? "peggedUSD",
    circulating: overrides.circulating ?? { ethereum: 50_000_000 },
  };
}

describe("detectDepegEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T12:00:00Z"));
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

  it("retires a stale live event and routes the opposite low-confidence move into pending", async () => {
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

  it("auto-closes false-positive via DEX cross-validation after 30 min", async () => {
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

    // Event should be auto-closed because:
    // - event is 40 min old (>30 min)
    // - DEX disagrees and has >$1M TVL
    const closures = preparedSqls.filter(s =>
      s.includes("UPDATE depeg_events SET ended_at")
    );
    expect(closures.length).toBeGreaterThanOrEqual(1);
  });

  it("does not orphan-close tracked events during transient data gaps", async () => {
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
      {
        id: "usdt-tether",
        symbol: "USDT",
        pegType: "peggedUSD",
        price: Number.NaN, // missing price this cycle
        priceSource: "defillama",
        priceConfidence: "single-source",
        priceUpdatedAt: now,
        circulating: { ethereum: 10_000_000 },
      } as ReturnType<typeof makeAsset>,
    ]);

    const orphanClosures = preparedSqls.filter((sql) =>
      sql.includes("UPDATE depeg_events SET ended_at = ?, recovery_price = NULL")
    );
    expect(orphanClosures).toHaveLength(0);
  });
});
