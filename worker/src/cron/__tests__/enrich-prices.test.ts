import { describe, it, expect, vi, afterEach } from "vitest";
import { isReasonablePrice, hasMissingPrice, PRICE_BOUNDS, enrichMissingPrices, fetchPrimaryPrices } from "../enrich-prices";
import type { PeggedAsset } from "../enrich-prices";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

describe("PRICE_BOUNDS", () => {
  it("has entries for all major peg types", () => {
    const expected = [
      "USD", "EUR", "GBP", "CHF", "BRL", "REAL", "JPY", "IDR", "SGD",
      "TRY", "AUD", "RUB", "ZAR", "CAD", "CNY", "CNH", "PHP", "MXN", "UAH",
      "ARS", "GOLD", "SILVER",
    ];
    for (const key of expected) {
      expect(PRICE_BOUNDS[key]).toBeDefined();
      expect(PRICE_BOUNDS[key]).toHaveLength(2);
      expect(PRICE_BOUNDS[key][0]).toBeLessThan(PRICE_BOUNDS[key][1]);
    }
  });
});

describe("isReasonablePrice", () => {
  // --- USD peg ---

  describe("USD peg", () => {
    it("accepts 0.99", () => {
      expect(isReasonablePrice(0.99, "peggedUSD")).toBe(true);
    });

    it("accepts 1.01", () => {
      expect(isReasonablePrice(1.01, "peggedUSD")).toBe(true);
    });

    it("accepts 1.00", () => {
      expect(isReasonablePrice(1.0, "peggedUSD")).toBe(true);
    });

    it("rejects 0.009 (too low)", () => {
      expect(isReasonablePrice(0.009, "peggedUSD")).toBe(false);
    });

    it("rejects 1.20 (too high — CG artifact territory)", () => {
      expect(isReasonablePrice(1.20, "peggedUSD")).toBe(false);
    });

    it("accepts 1.18 (just within upper bound)", () => {
      expect(isReasonablePrice(1.18, "peggedUSD")).toBe(true);
    });

    it("rejects negative price", () => {
      expect(isReasonablePrice(-1, "peggedUSD")).toBe(false);
    });

    it("rejects zero", () => {
      expect(isReasonablePrice(0, "peggedUSD")).toBe(false);
    });

    it("rejects NaN", () => {
      expect(isReasonablePrice(NaN, "peggedUSD")).toBe(false);
    });

    it("rejects Infinity", () => {
      expect(isReasonablePrice(Infinity, "peggedUSD")).toBe(false);
    });
  });

  describe("NAV token override", () => {
    it("accepts high USD-denominated prices for NAV tokens", () => {
      expect(isReasonablePrice(11.02, "peggedUSD", undefined, { navToken: true })).toBe(true);
      expect(isReasonablePrice(113.4, "peggedUSD", undefined, { navToken: true })).toBe(true);
    });

    it("still rejects invalid NAV token prices", () => {
      expect(isReasonablePrice(0, "peggedUSD", undefined, { navToken: true })).toBe(false);
      expect(isReasonablePrice(100_000, "peggedUSD", undefined, { navToken: true })).toBe(false);
    });
  });

  // --- Non-USD pegs (hardcoded fallback) ---

  describe("EUR peg", () => {
    it("accepts typical EUR rate ~1.08", () => {
      expect(isReasonablePrice(1.08, "peggedEUR")).toBe(true);
    });

    it("rejects 0.005 (too low)", () => {
      expect(isReasonablePrice(0.005, "peggedEUR")).toBe(false);
    });

    it("rejects 3.0 (too high)", () => {
      expect(isReasonablePrice(3.0, "peggedEUR")).toBe(false);
    });
  });

  describe("JPY peg", () => {
    it("accepts typical JPY rate ~0.0067", () => {
      expect(isReasonablePrice(0.0067, "peggedJPY")).toBe(true);
    });

    it("rejects 0.0005 (too low)", () => {
      expect(isReasonablePrice(0.0005, "peggedJPY")).toBe(false);
    });

    it("rejects 0.1 (too high)", () => {
      expect(isReasonablePrice(0.1, "peggedJPY")).toBe(false);
    });
  });

  describe("IDR peg", () => {
    it("accepts typical IDR rate ~0.000062", () => {
      expect(isReasonablePrice(0.000062, "peggedIDR")).toBe(true);
    });

    it("rejects 0.000001 (too low)", () => {
      expect(isReasonablePrice(0.000001, "peggedIDR")).toBe(false);
    });

    it("rejects 0.01 (too high)", () => {
      expect(isReasonablePrice(0.01, "peggedIDR")).toBe(false);
    });
  });

  describe("GOLD peg", () => {
    it("accepts gold price ~2900", () => {
      expect(isReasonablePrice(2900, "peggedGOLD")).toBe(true);
    });

    it("accepts fractional-ounce gold tokens when commodityOunces is provided", () => {
      expect(
        isReasonablePrice(5.15, "peggedGOLD", { peggedGOLD: 2_915 }, { commodityOunces: 0.001 })
      ).toBe(true);
    });

    it("rejects fractional-ounce gold prices when commodityOunces is missing", () => {
      expect(isReasonablePrice(5.15, "peggedGOLD", { peggedGOLD: 2_915 })).toBe(false);
    });

    it("rejects 50 (too low)", () => {
      expect(isReasonablePrice(50, "peggedGOLD")).toBe(false);
    });

    it("rejects 200000 (too high)", () => {
      expect(isReasonablePrice(200000, "peggedGOLD")).toBe(false);
    });
  });

  describe("SILVER peg", () => {
    it("accepts silver price ~32", () => {
      expect(isReasonablePrice(32, "peggedSILVER")).toBe(true);
    });

    it("accepts fractional-ounce silver tokens when commodityOunces is provided", () => {
      expect(
        isReasonablePrice(0.4, "peggedSILVER", { peggedSILVER: 32 }, { commodityOunces: 0.01 })
      ).toBe(true);
    });

    it("rejects 2 (too low)", () => {
      expect(isReasonablePrice(2, "peggedSILVER")).toBe(false);
    });

    it("rejects 1000 (too high)", () => {
      expect(isReasonablePrice(1000, "peggedSILVER")).toBe(false);
    });
  });

  describe("SGD peg", () => {
    it("accepts typical SGD rate ~0.74", () => {
      expect(isReasonablePrice(0.74, "peggedSGD")).toBe(true);
    });
  });

  describe("TRY peg", () => {
    it("accepts typical TRY rate ~0.028", () => {
      expect(isReasonablePrice(0.028, "peggedTRY")).toBe(true);
    });
  });

  describe("AUD peg", () => {
    it("accepts typical AUD rate ~0.63", () => {
      expect(isReasonablePrice(0.63, "peggedAUD")).toBe(true);
    });
  });

  describe("RUB peg", () => {
    it("accepts typical RUB rate ~0.011", () => {
      expect(isReasonablePrice(0.011, "peggedRUB")).toBe(true);
    });
  });

  describe("ARS peg", () => {
    it("accepts typical ARS rate ~0.0009", () => {
      expect(isReasonablePrice(0.0009, "peggedARS")).toBe(true);
    });

    it("rejects 0.0000001 (too low)", () => {
      expect(isReasonablePrice(0.0000001, "peggedARS")).toBe(false);
    });
  });

  // --- FX-rate-aware bounds ---

  describe("FX-rate-aware bounds", () => {
    it("uses dynamic bounds when fxRates provided for EUR", () => {
      // FX rate for EUR is ~1.08, so bounds are 0.0108–2.16
      expect(isReasonablePrice(1.08, "peggedEUR", { peggedEUR: 1.08 })).toBe(true);
      expect(isReasonablePrice(0.005, "peggedEUR", { peggedEUR: 1.08 })).toBe(false);
      expect(isReasonablePrice(2.5, "peggedEUR", { peggedEUR: 1.08 })).toBe(false);
    });

    it("uses dynamic bounds for GBP", () => {
      expect(isReasonablePrice(1.25, "peggedGBP", { peggedGBP: 1.26 })).toBe(true);
    });

    it("falls back to hardcoded when fxRate is zero", () => {
      expect(isReasonablePrice(1.08, "peggedEUR", { peggedEUR: 0 })).toBe(true);
    });

    it("falls back to hardcoded when peg type not in fxRates", () => {
      expect(isReasonablePrice(1.08, "peggedEUR", { peggedJPY: 0.0067 })).toBe(true);
    });
  });

  // --- Edge cases ---

  describe("edge cases", () => {
    it("accepts any positive price for undefined pegType (up to 100k)", () => {
      expect(isReasonablePrice(50000, undefined)).toBe(true);
      expect(isReasonablePrice(0.001, undefined)).toBe(true);
    });

    it("rejects zero for undefined pegType", () => {
      expect(isReasonablePrice(0, undefined)).toBe(false);
    });

    it("rejects negative for undefined pegType", () => {
      expect(isReasonablePrice(-5, undefined)).toBe(false);
    });

    it("rejects >= 100k for undefined pegType", () => {
      expect(isReasonablePrice(100_000, undefined)).toBe(false);
    });

    it("accepts any positive price for unknown pegType (default bounds)", () => {
      expect(isReasonablePrice(500, "peggedXYZ")).toBe(true);
    });

    it("rejects 100k for unknown pegType", () => {
      expect(isReasonablePrice(100_000, "peggedXYZ")).toBe(false);
    });

    it("handles empty string pegType (like undefined → default)", () => {
      expect(isReasonablePrice(50, "")).toBe(true);
    });
  });
});

describe("hasMissingPrice", () => {
  it("detects null price", () => {
    expect(hasMissingPrice({ price: null } as PeggedAsset)).toBe(true);
  });

  it("detects undefined price", () => {
    expect(hasMissingPrice({ price: undefined } as unknown as PeggedAsset)).toBe(true);
  });

  it("detects zero price", () => {
    expect(hasMissingPrice({ price: 0 } as PeggedAsset)).toBe(true);
  });

  it("detects non-number price (string)", () => {
    expect(hasMissingPrice({ price: "1.0" } as unknown as PeggedAsset)).toBe(true);
  });

  it("returns false for valid price", () => {
    expect(hasMissingPrice({ price: 1.0 } as PeggedAsset)).toBe(false);
  });

  it("returns false for small but valid price", () => {
    expect(hasMissingPrice({ price: 0.0001 } as PeggedAsset)).toBe(false);
  });
});

// --- enrichMissingPrices pipeline tests ---

describe("enrichMissingPrices", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns zero counts when no assets are missing prices", async () => {
    const assets: PeggedAsset[] = [
      { id: "usdt-tether", name: "Tether", symbol: "USDT", price: 1.0, pegType: "peggedUSD", circulating: {} },
      { id: "usdc-circle", name: "USD Coin", symbol: "USDC", price: 0.999, pegType: "peggedUSD", circulating: {} },
    ];

    const stats = await enrichMissingPrices(assets);

    expect(stats.totalMissing).toBe(0);
    expect(stats.pass1).toBe(0);
    expect(stats.passDex).toBe(0);
    expect(stats.finalMissing).toBe(0);
  });

  it("enriches via Pass 1 (contract address → DL coins API)", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "usdt-tether", name: "Tether", symbol: "USDT", price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        pegType: "peggedUSD", circulating: {},
      },
    ];

    mockFetch([
      {
        match: "coins.llama.fi/prices",
        body: {
          coins: {
            "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7": { price: 1.0, symbol: "USDT", timestamp: 1718650000, confidence: 0.99 },
          },
        },
      },
    ]);

    const stats = await enrichMissingPrices(assets);

    expect(stats.totalMissing).toBe(1);
    expect(stats.pass1).toBe(1);
    expect(assets[0].price).toBe(1.0);
    expect(stats.finalMissing).toBe(0);
  });

  it("does not enrich assets with 'wrong' geckoId via contract passes — falls through to CMC/DexScreener", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "usdt-tether", name: "SomeToken", symbol: "TOK", price: 0,
        geckoId: "sometoken-wrong", pegType: "peggedUSD", circulating: {},
      },
    ];

    // All APIs return empty — asset stays unpriced
    mockFetch([
      { match: "coins.llama.fi", body: { coins: {} } },
      { match: "dexscreener.com", body: { pairs: [] } },
    ]);

    const stats = await enrichMissingPrices(assets);

    // "wrong" geckoIds have no contract address, so pass 1/1b skip them.
    // Without CMC key or DexScreener match, asset stays missing.
    expect(stats.pass1).toBe(0);
    expect(stats.pass1b).toBe(0);
    expect(stats.finalMissing).toBe(1);
  });

  it("leaves assets unpriced when all APIs return empty data", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "usdt-tether", name: "Tether", symbol: "USDT", price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        geckoId: "tether", pegType: "peggedUSD", circulating: {},
      },
    ];

    // All APIs return 200 but with no useful price data
    mockFetch([
      { match: "coins.llama.fi", body: { coins: {} } },
      { match: "dexscreener.com", body: { pairs: [] } },
    ]);

    const stats = await enrichMissingPrices(assets);

    // Asset remains unpriced
    expect(stats.totalMissing).toBe(1);
    expect(stats.finalMissing).toBe(1);
    expect(stats.pass1).toBe(0);
    expect(stats.passDex).toBe(0);
  });

  it("still uses stale FX cache for DexScreener fallback in enrichment (characterization)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedJPY: 0.0067 }),
          updated_at: nowSec - (8 * 3600),
        },
      },
      { match: "circuit", rows: [] },
    ]);

    const assets: PeggedAsset[] = [
      {
        id: "jpyc-jpyc",
        name: "JPYC",
        symbol: "JPYC",
        price: 0,
        pegType: "peggedJPY",
        circulating: {},
      },
    ];

    mockFetch([
      {
        match: "dexscreener.com",
        body: {
          pairs: [
            {
              baseToken: { symbol: "JPYC" },
              quoteToken: { symbol: "USDT" },
              priceUsd: "0.0005",
              liquidity: { usd: 100_000 },
              chainId: "ethereum",
            },
          ],
        },
      },
    ]);

    const stats = await enrichMissingPrices(assets, undefined, db);

    expect(stats.passDex).toBe(1);
    expect(assets[0].price).toBe(0.0005);
  });

  it("does not retry failing DexScreener fallback searches", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "mystery-usd",
        name: "Mystery USD",
        symbol: "MUSD",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("dexscreener.com")) {
        return new Response("upstream error", { status: 500 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const stats = await enrichMissingPrices(assets);

    expect(stats.passDex).toBe(0);
    expect(stats.finalMissing).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("dexscreener.com");
  });
});

// --- fetchPrimaryPrices tests ---

describe("fetchPrimaryPrices", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeTestDb() {
    return mockD1([
      { match: "circuit", rows: [] },
    ]);
  }

  it("returns high confidence when DL and CG prices agree within 50bps", async () => {
    const assets: PeggedAsset[] = [
      { id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coins.llama.fi")) {
        return new Response(JSON.stringify({
          coins: { "coingecko:tether": { price: 1.0002 } },
        }), { status: 200 });
      }
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({
          tether: { usd: 1.0001 },
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const db = makeTestDb();
    const { results, stats, cgPrices } = await fetchPrimaryPrices(assets, db);

    expect(results.size).toBe(1);
    const result = results.get("usdt-tether")!;
    expect(result.confidence).toBe("high");
    expect(result.source).toBe("coingecko+defillama");
    expect(result.price).toBe(1.0001);
    expect(cgPrices.get("tether")).toBe(1.0001);
    expect(stats.high).toBe(1);
    expect(stats.low).toBe(0);
  });

  it("returns low confidence when DL and CG prices diverge beyond 50bps", async () => {
    const assets: PeggedAsset[] = [
      { id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coins.llama.fi")) {
        return new Response(JSON.stringify({
          coins: { "coingecko:tether": { price: 1.05 } },
        }), { status: 200 });
      }
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({
          tether: { usd: 0.99 },
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const db = makeTestDb();
    const { results, stats } = await fetchPrimaryPrices(assets, db);

    expect(results.size).toBe(1);
    const result = results.get("usdt-tether")!;
    expect(result.confidence).toBe("low");
    expect(stats.low).toBe(1);
    expect(stats.divergences.length).toBe(1);
  });

  it("chooses the peg-closer candidate for non-USD divergences when references are available", async () => {
    const assets: PeggedAsset[] = [
      { id: "eurc-circle", name: "EURC", symbol: "EURC", geckoId: "euro-coin", pegType: "peggedEUR", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coins.llama.fi")) {
        return new Response(JSON.stringify({
          coins: { "coingecko:euro-coin": { price: 1.8 } },
        }), { status: 200 });
      }
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({
          "euro-coin": { usd: 1.08 },
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const db = makeTestDb();
    const { results, stats } = await fetchPrimaryPrices(
      assets,
      db,
      undefined,
      { rates: { peggedEUR: 1.08 }, type: "fresh", updatedAt: Math.floor(Date.now() / 1000) },
    );

    expect(results.size).toBe(1);
    const result = results.get("eurc-circle")!;
    expect(result.confidence).toBe("low");
    expect(result.source).toBe("coingecko");
    expect(result.price).toBe(1.08);
    expect(result.cgPrice).toBe(1.08);
    expect(stats.low).toBe(1);
  });

  it("does not force closer-to-$1 selection for NAV tokens during divergence", async () => {
    const assets: PeggedAsset[] = [
      { id: "ousg-ondo-finance", name: "OUSG", symbol: "OUSG", geckoId: "ousg", pegType: "peggedUSD", navToken: true, circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coins.llama.fi")) {
        return new Response(JSON.stringify({
          coins: { "coingecko:ousg": { price: 110 } },
        }), { status: 200 });
      }
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({
          ousg: { usd: 1.01 },
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const db = makeTestDb();
    const { results, stats } = await fetchPrimaryPrices(assets, db);

    expect(results.size).toBe(1);
    const result = results.get("ousg-ondo-finance")!;
    expect(result.confidence).toBe("low");
    expect(result.source).toBe("coingecko");
    expect(result.price).toBe(1.01);
    expect(stats.low).toBe(1);
  });

  it("returns single-source when only one API has data", async () => {
    const assets: PeggedAsset[] = [
      { id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coins.llama.fi")) {
        return new Response(JSON.stringify({
          coins: { "coingecko:tether": { price: 1.0 } },
        }), { status: 200 });
      }
      if (typeof url === "string" && url.includes("coingecko.com")) {
        // CG returns empty — no price data
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const db = makeTestDb();
    const { results, stats } = await fetchPrimaryPrices(assets, db);

    expect(results.size).toBe(1);
    const result = results.get("usdt-tether")!;
    expect(result.confidence).toBe("single-source");
    expect(result.source).toBe("defillama");
    expect(stats.singleSource).toBe(1);
  });

  it("skips assets without geckoId", async () => {
    const assets: PeggedAsset[] = [
      { id: "usdt-tether", name: "NoGecko", symbol: "NG", pegType: "peggedUSD", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 200 })
    ));

    const db = makeTestDb();
    const { results, stats } = await fetchPrimaryPrices(assets, db);

    expect(results.size).toBe(0);
    expect(stats.attempted).toBe(0);
  });

  it("filters out assets with 'wrong' in geckoId", async () => {
    const assets: PeggedAsset[] = [
      { id: "usdt-tether", name: "BadGecko", symbol: "BG", geckoId: "something-wrong", pegType: "peggedUSD", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 200 })
    ));

    const db = makeTestDb();
    const { results, stats } = await fetchPrimaryPrices(assets, db);

    expect(results.size).toBe(0);
    expect(stats.attempted).toBe(0);
  });

  it("tracks cgOnly and dlOnly in stats", async () => {
    const assets: PeggedAsset[] = [
      { id: "a", name: "A", symbol: "A", geckoId: "a-id", pegType: "peggedUSD", circulating: {} },
      { id: "b", name: "B", symbol: "B", geckoId: "b-id", pegType: "peggedUSD", circulating: {} },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coins.llama.fi")) {
        return new Response(JSON.stringify({
          coins: { "coingecko:a-id": { price: 1.0 } }, // only A in DL
        }), { status: 200 });
      }
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({
          "b-id": { usd: 1.0 }, // only B in CG
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));
    const db = makeTestDb();
    const { stats } = await fetchPrimaryPrices(assets, db);
    expect(stats.dlOnly).toBe(1);
    expect(stats.cgOnly).toBe(1);
    expect(stats.singleSource).toBe(2);
  });

  it("uses Pyth as a single source when Hermes returns an unprefixed feed id", async () => {
    const assets: PeggedAsset[] = [
      { id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coins.llama.fi")) {
        return new Response(JSON.stringify({ coins: {} }), { status: 200 });
      }
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (typeof url === "string" && url.includes("hermes.pyth.network")) {
        return new Response(JSON.stringify({
          parsed: [
            {
              id: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
              price: { price: "100010000", expo: -8, conf: "5000", publish_time: 1710000000 },
            },
          ],
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const db = makeTestDb();
    const { results, stats } = await fetchPrimaryPrices(assets, db);

    expect(results.size).toBe(1);
    const result = results.get("usdt-tether")!;
    expect(result.source).toBe("pyth");
    expect(result.confidence).toBe("single-source");
    expect(result.price).toBeCloseTo(1.0001, 4);
    expect(stats.singleSource).toBe(1);
  });

  it("uses exact-case RedStone symbols and recovers batch-dropped results with solo retry", async () => {
    const assets: PeggedAsset[] = [
      { id: "usde-ethena", name: "Ethena USDe", symbol: "USDe", geckoId: "ethena-usde", pegType: "peggedUSD", circulating: {} },
      { id: "fxusd-f-x-protocol", name: "fxUSD", symbol: "fxUSD", geckoId: "fxusd", pegType: "peggedUSD", circulating: {} },
    ];

    const fetchMock = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coins.llama.fi")) {
        return new Response(JSON.stringify({ coins: {} }), { status: 200 });
      }
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (typeof url === "string" && url.includes("hermes.pyth.network")) {
        return new Response(JSON.stringify({ parsed: [] }), { status: 200 });
      }
      if (typeof url === "string" && url.includes("api.redstone.finance")) {
        if (url.includes("symbols=USDe%2CfxUSD")) {
          return new Response(JSON.stringify({
            USDe: {
              value: 1.0003,
              source: { curve: 1.0003 },
              timestamp: 1710000000000,
            },
          }), { status: 200 });
        }
        if (url.includes("symbols=fxUSD")) {
          return new Response(JSON.stringify({
            fxUSD: {
              value: 0.9997,
              source: { curve: 0.9997 },
              timestamp: 1710000000000,
            },
          }), { status: 200 });
        }
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const db = makeTestDb();
    const { results, stats } = await fetchPrimaryPrices(assets, db);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("symbols=USDe%2CfxUSD"),
      expect.any(Object),
    );
    expect(results.get("usde-ethena")?.source).toBe("redstone");
    expect(results.get("usde-ethena")?.confidence).toBe("single-source");
    expect(results.get("fxusd-f-x-protocol")?.source).toBe("redstone");
    expect(results.get("fxusd-f-x-protocol")?.price).toBeCloseTo(0.9997, 4);
    expect(stats.singleSource).toBe(2);
  });
});
