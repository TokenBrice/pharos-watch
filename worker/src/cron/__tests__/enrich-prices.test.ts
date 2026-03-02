import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isReasonablePrice, hasMissingPrice, PRICE_BOUNDS, enrichMissingPrices, fetchDualPrimaryPrices } from "../enrich-prices";
import type { PeggedAsset } from "../enrich-prices";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { mockFetch } from "../../api/__tests__/helpers/mock-fetch";

describe("PRICE_BOUNDS", () => {
  it("has entries for all major peg types", () => {
    const expected = [
      "USD", "EUR", "GBP", "CHF", "BRL", "REAL", "JPY", "IDR", "SGD",
      "TRY", "AUD", "RUB", "ZAR", "CAD", "CNY", "PHP", "MXN", "UAH",
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
      { id: "1", name: "Tether", symbol: "USDT", price: 1.0, pegType: "peggedUSD", circulating: {} },
      { id: "2", name: "USD Coin", symbol: "USDC", price: 0.999, pegType: "peggedUSD", circulating: {} },
    ];

    const stats = await enrichMissingPrices(assets);

    expect(stats.totalMissing).toBe(0);
    expect(stats.pass1).toBe(0);
    expect(stats.pass2).toBe(0);
    expect(stats.pass3).toBe(0);
    expect(stats.pass4).toBe(0);
    expect(stats.finalMissing).toBe(0);
  });

  it("enriches via Pass 1 (contract address → DL coins API)", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "1", name: "Tether", symbol: "USDT", price: 0,
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

  it("enriches via Pass 2 (geckoId → DL coins API)", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "1", name: "Tether", symbol: "USDT", price: 0,
        geckoId: "tether", pegType: "peggedUSD", circulating: {},
      },
    ];

    mockFetch([
      {
        match: "coins.llama.fi/prices",
        body: {
          coins: {
            "coingecko:tether": { price: 1.001, symbol: "USDT", timestamp: 1718650000, confidence: 0.99 },
          },
        },
      },
    ]);

    const stats = await enrichMissingPrices(assets);

    expect(stats.totalMissing).toBe(1);
    expect(stats.pass2).toBe(1);
    expect(assets[0].price).toBe(1.001);
    expect(stats.finalMissing).toBe(0);
  });

  it("falls through to Pass 3 (CG direct) when DL returns no price", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "1", name: "Tether", symbol: "USDT", price: 0,
        geckoId: "tether", pegType: "peggedUSD", circulating: {},
      },
    ];

    // Call counter to differentiate DL coins vs CG calls
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      callCount++;
      if (url.includes("coins.llama.fi")) {
        // DL coins API returns no price for this asset
        return new Response(JSON.stringify({ coins: {} }), { status: 200 });
      }
      if (url.includes("coingecko.com")) {
        // CG returns the price
        return new Response(JSON.stringify({ tether: { usd: 0.998 } }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const stats = await enrichMissingPrices(assets);

    expect(stats.totalMissing).toBe(1);
    expect(stats.pass2).toBe(0);
    expect(stats.pass3).toBe(1);
    expect(assets[0].price).toBe(0.998);
  });

  it("skips assets with 'wrong' geckoId from Pass 2, routes to Pass 3", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "1", name: "SomeToken", symbol: "TOK", price: 0,
        geckoId: "sometoken-wrong", pegType: "peggedUSD", circulating: {},
      },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("coins.llama.fi")) {
        return new Response(JSON.stringify({ coins: {} }), { status: 200 });
      }
      if (url.includes("coingecko.com")) {
        return new Response(JSON.stringify({ sometoken: { usd: 0.95 } }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const stats = await enrichMissingPrices(assets);

    // "wrong" geckoIds skip Pass 2, go straight to Pass 3
    expect(stats.pass2).toBe(0);
    expect(stats.pass3).toBe(1);
    expect(assets[0].price).toBe(0.95);
  });

  it("leaves assets unpriced when all APIs return empty data", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "1", name: "Tether", symbol: "USDT", price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        geckoId: "tether", pegType: "peggedUSD", circulating: {},
      },
    ];

    // All APIs return 200 but with no useful price data
    mockFetch([
      { match: "coins.llama.fi", body: { coins: {} } },
      { match: "coingecko.com", body: {} },
      { match: "dexscreener.com", body: { pairs: [] } },
    ]);

    const stats = await enrichMissingPrices(assets);

    // Asset remains unpriced
    expect(stats.totalMissing).toBe(1);
    expect(stats.finalMissing).toBe(1);
    expect(stats.pass1).toBe(0);
    expect(stats.pass2).toBe(0);
    expect(stats.pass3).toBe(0);
    expect(stats.pass4).toBe(0);
  });
});

// --- fetchDualPrimaryPrices tests ---

describe("fetchDualPrimaryPrices", () => {
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
      { id: "1", name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD", circulating: {} },
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
    const { results, stats } = await fetchDualPrimaryPrices(assets, db);

    expect(results.size).toBe(1);
    const result = results.get("1")!;
    expect(result.confidence).toBe("high");
    expect(result.source).toBe("defillama+coingecko");
    expect(stats.high).toBe(1);
    expect(stats.low).toBe(0);
  });

  it("returns low confidence when DL and CG prices diverge beyond 50bps", async () => {
    const assets: PeggedAsset[] = [
      { id: "1", name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD", circulating: {} },
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
    const { results, stats } = await fetchDualPrimaryPrices(assets, db);

    expect(results.size).toBe(1);
    const result = results.get("1")!;
    expect(result.confidence).toBe("low");
    expect(stats.low).toBe(1);
    expect(stats.divergences.length).toBe(1);
  });

  it("returns single-source when only one API has data", async () => {
    const assets: PeggedAsset[] = [
      { id: "1", name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD", circulating: {} },
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
    const { results, stats } = await fetchDualPrimaryPrices(assets, db);

    expect(results.size).toBe(1);
    const result = results.get("1")!;
    expect(result.confidence).toBe("single-source");
    expect(result.source).toBe("defillama");
    expect(stats.singleSource).toBe(1);
  });

  it("skips assets without geckoId", async () => {
    const assets: PeggedAsset[] = [
      { id: "1", name: "NoGecko", symbol: "NG", pegType: "peggedUSD", circulating: {} },
    ];

    const fetchSpy = vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 200 })
    ));

    const db = makeTestDb();
    const { results, stats } = await fetchDualPrimaryPrices(assets, db);

    expect(results.size).toBe(0);
    expect(stats.attempted).toBe(0);
  });

  it("filters out assets with 'wrong' in geckoId", async () => {
    const assets: PeggedAsset[] = [
      { id: "1", name: "BadGecko", symbol: "BG", geckoId: "something-wrong", pegType: "peggedUSD", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 200 })
    ));

    const db = makeTestDb();
    const { results, stats } = await fetchDualPrimaryPrices(assets, db);

    expect(results.size).toBe(0);
    expect(stats.attempted).toBe(0);
  });
});
