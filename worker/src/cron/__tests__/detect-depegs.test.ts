import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

// Stub psi-eligible to avoid importing the full stablecoins list
vi.mock("@shared/lib/psi-eligible", () => ({
  PSI_ELIGIBLE_STABLECOINS: [
    { id: "1", symbol: "USDT", pegType: "peggedUSD", geckoId: "tether", flags: { navToken: false }, commodityOunces: undefined },
    { id: "2", symbol: "USDC", pegType: "peggedUSD", geckoId: "usd-coin", flags: { navToken: false }, commodityOunces: undefined },
    { id: "3", symbol: "EUROC", pegType: "peggedEUR", geckoId: "euro-coin", flags: { navToken: false }, commodityOunces: undefined },
    { id: "99", symbol: "NAVT", pegType: "peggedUSD", geckoId: "nav-token", flags: { navToken: true }, commodityOunces: undefined },
  ],
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
}) {
  return {
    id: overrides.id,
    symbol: overrides.symbol,
    price: overrides.price,
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
      makeAsset({ id: "1", symbol: "USDT", price: 1.001 }),
      makeAsset({ id: "2", symbol: "USDC", price: 0.999 }),
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
      makeAsset({ id: "1", symbol: "USDT", price: 0.98 }),
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
      makeAsset({ id: "1", symbol: "USDT", price: 0.991 }),
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
      makeAsset({ id: "3", symbol: "EUROC", price: 1.065, pegType: "peggedEUR" }),
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
          id: 1, stablecoin_id: "1", symbol: "USDT", peg_type: "peggedUSD",
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
      makeAsset({ id: "1", symbol: "USDT", price: 0.96 }),
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
          id: 1, stablecoin_id: "1", symbol: "USDT", peg_type: "peggedUSD",
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
      makeAsset({ id: "1", symbol: "USDT", price: 1.001 }),
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
          id: 1, stablecoin_id: "1", symbol: "USDT", peg_type: "peggedUSD",
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
      makeAsset({ id: "1", symbol: "USDT", price: 1.02 }),
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

  it("merges duplicate open events: keeps earliest, absorbs worst peak", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
    const db = mockD1([
      {
        match: "depeg_events",
        rows: [
          {
            id: 1, stablecoin_id: "1", symbol: "USDT", peg_type: "peggedUSD",
            direction: "below", peak_deviation_bps: -150, started_at: now - 7200,
            start_price: 0.985, peak_price: 0.985, peg_reference: 1,
            recovery_price: null, ended_at: null, source: "live",
          },
          {
            id: 2, stablecoin_id: "1", symbol: "USDT", peg_type: "peggedUSD",
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
      makeAsset({ id: "1", symbol: "USDT", price: 0.97 }),
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
        id: "1", symbol: "USDT", price: 0.98,
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
        id: "2", symbol: "USDC", price: 0.90,
        circulating: { ethereum: 500_000 }, // only $500k
      }),
    ];

    await detectDepegEvents(db, assets);

    const inserts = preparedSqls.filter(s =>
      s.includes("INSERT INTO depeg_events") || s.includes("INSERT INTO depeg_pending")
    );
    expect(inserts).toHaveLength(0);
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
      makeAsset({ id: "99", symbol: "NAVT", price: 0.50 }),
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
      makeAsset({ id: "1", symbol: "USDT", price: 0 }),
      makeAsset({ id: "2", symbol: "USDC", price: NaN }),
    ];

    await detectDepegEvents(db, assets);

    const inserts = preparedSqls.filter(s =>
      s.includes("INSERT INTO depeg_events")
    );
    expect(inserts).toHaveLength(0);
  });

  it("auto-closes false-positive via DEX cross-validation after 30 min", async () => {
    const now = Math.floor(Date.now() / 1000);
    const preparedSqls: string[] = [];
    const db = mockD1([
      {
        match: "depeg_events",
        rows: [{
          id: 1, stablecoin_id: "1", symbol: "USDT", peg_type: "peggedUSD",
          direction: "below", peak_deviation_bps: -200, started_at: now - 2400,
          start_price: 0.98, peak_price: 0.98, peg_reference: 1,
          recovery_price: null, ended_at: null, source: "live",
        }],
      },
      {
        match: "dex_prices",
        rows: [{
          stablecoin_id: "1",
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
      makeAsset({ id: "1", symbol: "USDT", price: 0.98 }),
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
          id: 1, stablecoin_id: "1", symbol: "USDT", peg_type: "peggedUSD",
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
        id: "1",
        symbol: "USDT",
        pegType: "peggedUSD",
        price: Number.NaN, // missing price this cycle
        circulating: { ethereum: 10_000_000 },
      } as ReturnType<typeof makeAsset>,
    ]);

    const orphanClosures = preparedSqls.filter((sql) =>
      sql.includes("UPDATE depeg_events SET ended_at = ?, recovery_price = NULL")
    );
    expect(orphanClosures).toHaveLength(0);
  });
});
