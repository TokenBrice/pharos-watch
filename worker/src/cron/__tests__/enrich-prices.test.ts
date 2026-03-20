import { describe, it, expect, vi, afterEach } from "vitest";
import { isReasonablePrice, hasMissingPrice, PRICE_BOUNDS, enrichMissingPrices, fetchPrimaryPrices, applyResolvedPrice, applyPoolChallenge } from "../enrich-prices";
import type { PeggedAsset, PrimaryPriceResult, PriceValidationStats } from "../enrich-prices";
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

  it("prefers exact DexScreener token-address lookups before symbol search", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "mystery-usd",
        name: "Mystery USD",
        symbol: "MUSD",
        price: 0,
        address: "0xabc",
        chains: ["Base"],
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("coins.llama.fi")) {
        return new Response(JSON.stringify({ coins: {} }), { status: 200 });
      }
      if (url.includes("api.dexscreener.com/tokens/v1/base/0xabc")) {
        return new Response(JSON.stringify([
          {
            chainId: "base",
            dexId: "aerodrome",
            pairAddress: "0xpair",
            baseToken: { address: "0xabc", name: "Mystery USD", symbol: "MUSD" },
            quoteToken: { address: "0xdef", name: "USD Coin", symbol: "USDC" },
            priceUsd: "1.0004",
            priceNative: "1.0004",
            liquidity: { usd: 250_000, base: 125_000, quote: 125_000 },
            volume: { h24: 1_000, h6: 500, h1: 100, m5: 10 },
            pairCreatedAt: Date.now(),
          },
        ]), { status: 200 });
      }
      if (url.includes("dexscreener.com/latest/dex/search")) {
        return new Response(JSON.stringify({ pairs: [] }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const stats = await enrichMissingPrices(assets);

    expect(stats.passDex).toBe(1);
    expect(assets[0].price).toBe(1.0004);
    expect(assets[0].priceSource).toBe("dexscreener");
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("latest/dex/search"))).toBe(false);
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

  it("prefers cmcSlug-based matching over symbol for CMC fallback (BUG-1)", async () => {
    // Two coins share symbol "GUSD" — slug-based matching should pick the right price
    const assets: PeggedAsset[] = [
      {
        id: "gusd-gemini", name: "Gemini Dollar", symbol: "GUSD", price: 0,
        cmcSlug: "gemini-dollar", pegType: "peggedUSD", circulating: {},
      },
      {
        id: "gusd-gate", name: "Gate USD", symbol: "GUSD", price: 0,
        cmcSlug: "gatechain-token", pegType: "peggedUSD", circulating: {},
      },
    ];

    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["cmc_last_fetch"],
        rows: [],
        first: null,
      },
      { match: "circuit", rows: [] },
    ]);

    mockFetch([
      {
        match: "pro-api.coinmarketcap.com",
        body: {
          data: {
            coins: [
              { slug: "gemini-dollar", symbol: "GUSD", quote: { USD: { price: 1.0001 } } },
              { slug: "gatechain-token", symbol: "GUSD", quote: { USD: { price: 0.998 } } },
            ],
          },
        },
      },
    ]);

    const stats = await enrichMissingPrices(assets, "test-cmc-key", db);

    // Both should be priced correctly via slug, not clobbered by symbol collision
    expect(assets[0].price).toBe(1.0001);
    expect(assets[0].priceSource).toBe("coinmarketcap");
    expect(assets[1].price).toBe(0.998);
    expect(assets[1].priceSource).toBe("coinmarketcap");
    expect(stats.passCmc).toBe(2);
  });

  it("fills missing Solana prices from Jupiter when liquidity is sufficient", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "usdg-paxos", name: "USDG", symbol: "USDG", price: 0,
        pegType: "peggedUSD", circulating: {},
      },
    ];

    mockFetch([
      { match: "coins.llama.fi", body: { coins: {} } },
      {
        match: "lite-api.jup.ag/price/v3",
        body: {
          "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": {
            usdPrice: 1.0002,
            liquidity: 250_000,
            createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          },
        },
      },
    ]);

    const stats = await enrichMissingPrices(assets);

    expect(stats.passJupiter).toBe(1);
    expect(assets[0].price).toBe(1.0002);
    expect(assets[0].priceSource).toBe("jupiter");
    expect(stats.finalMissing).toBe(0);
  });

  it("does not reject Jupiter V3 quotes solely because createdAt is old", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "usdg-paxos", name: "USDG", symbol: "USDG", price: 0,
        pegType: "peggedUSD", circulating: {},
      },
    ];

    mockFetch([
      { match: "coins.llama.fi", body: { coins: {} } },
      {
        match: "lite-api.jup.ag/price/v3",
        body: {
          "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": {
            usdPrice: 0.9998,
            liquidity: 250_000,
            createdAt: "2025-01-06T18:38:31Z",
          },
        },
      },
    ]);

    const stats = await enrichMissingPrices(assets);

    expect(stats.passJupiter).toBe(1);
    expect(assets[0].price).toBe(0.9998);
    expect(assets[0].priceSource).toBe("jupiter");
    expect(stats.finalMissing).toBe(0);
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

  it("downgrades CG+DL-only consensus to single-source (DESIGN-4)", async () => {
    const assets: PeggedAsset[] = [
      { id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({
          tether: { usd: 1.0001 },
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const db = makeTestDb();
    const dlListPrices = new Map([["usdt-tether", 1.0002]]);
    const { results, stats, cgPrices } = await fetchPrimaryPrices(assets, db, undefined, undefined, undefined, undefined, dlListPrices);

    expect(results.size).toBe(1);
    const result = results.get("usdt-tether")!;
    // CG+DL-only gets downgraded from high to single-source
    expect(result.confidence).toBe("single-source");
    expect(result.source).toBe("coingecko+defillama-list");
    expect(result.price).toBe(1.0001);
    expect(cgPrices.get("tether")).toBe(1.0001);
    expect(stats.high).toBe(0);
    expect(stats.singleSource).toBe(1);
    expect(stats.low).toBe(0);
  });

  it("returns single-source when CG is the only source (no DL list price)", async () => {
    const assets: PeggedAsset[] = [
      { id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({
          tether: { usd: 1.0001 },
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const db = makeTestDb();
    const { results, stats } = await fetchPrimaryPrices(assets, db);

    expect(results.size).toBe(1);
    const result = results.get("usdt-tether")!;
    expect(result.confidence).toBe("single-source");
    expect(result.source).toBe("coingecko");
    expect(stats.singleSource).toBe(1);
    expect(stats.cgOnly).toBe(1);
  });

  it("includes Kraken and Bitstamp in the consensus cluster when they agree", async () => {
    const assets: PeggedAsset[] = [
      { id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("coingecko.com")) {
        return new Response(JSON.stringify({ tether: { usd: 1.0001 } }), { status: 200 });
      }
      if (url.includes("api.kraken.com")) {
        return new Response(JSON.stringify({
          error: [],
          result: { USDTZUSD: { c: ["1.0000"] } },
        }), { status: 200 });
      }
      if (url.includes("bitstamp.net")) {
        return new Response(JSON.stringify([
          { pair: "USDT/USD", market: "USDT/USD", last: "1.0002" },
        ]), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const db = makeTestDb();
    const { results } = await fetchPrimaryPrices(assets, db);
    const result = results.get("usdt-tether");

    expect(result).toBeDefined();
    expect(result!.agreeSources).toEqual(expect.arrayContaining(["coingecko", "kraken", "bitstamp"]));
    expect(result!.confidence).toBe("high");
  });

  it("returns low confidence when CG and DL list prices diverge beyond 50bps", async () => {
    const assets: PeggedAsset[] = [
      { id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({
          tether: { usd: 0.99 },
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const db = makeTestDb();
    const dlListPrices = new Map([["usdt-tether", 1.05]]);
    const { results, stats } = await fetchPrimaryPrices(assets, db, undefined, undefined, undefined, undefined, dlListPrices);

    expect(results.size).toBe(1);
    const result = results.get("usdt-tether")!;
    expect(result.confidence).toBe("low");
    expect(stats.low).toBe(1);
  });

  it("chooses the peg-closer candidate for non-USD divergences when references are available", async () => {
    const assets: PeggedAsset[] = [
      { id: "eurc-circle", name: "EURC", symbol: "EURC", geckoId: "euro-coin", pegType: "peggedEUR", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({
          "euro-coin": { usd: 1.08 },
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const db = makeTestDb();
    const dlListPrices = new Map([["eurc-circle", 1.8]]);
    const { results, stats } = await fetchPrimaryPrices(
      assets,
      db,
      undefined,
      { rates: { peggedEUR: 1.08 }, type: "fresh", updatedAt: Math.floor(Date.now() / 1000) },
      undefined,
      undefined,
      dlListPrices,
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
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({
          ousg: { usd: 1.01 },
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const db = makeTestDb();
    const dlListPrices = new Map([["ousg-ondo-finance", 110]]);
    const { results, stats } = await fetchPrimaryPrices(assets, db, undefined, undefined, undefined, undefined, dlListPrices);

    expect(results.size).toBe(1);
    const result = results.get("ousg-ondo-finance")!;
    expect(result.confidence).toBe("low");
    expect(result.source).toBe("coingecko");
    expect(result.price).toBe(1.01);
    expect(stats.low).toBe(1);
  });

  it("returns single-source when DL list is the only source", async () => {
    const assets: PeggedAsset[] = [
      { id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coingecko.com")) {
        // CG returns empty — no price data
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const db = makeTestDb();
    const dlListPrices = new Map([["usdt-tether", 1.0]]);
    const { results, stats } = await fetchPrimaryPrices(assets, db, undefined, undefined, undefined, undefined, dlListPrices);

    expect(results.size).toBe(1);
    const result = results.get("usdt-tether")!;
    expect(result.confidence).toBe("single-source");
    expect(result.source).toBe("defillama-list");
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

  it("tracks cgOnly in stats for CG-only single-source assets", async () => {
    const assets: PeggedAsset[] = [
      { id: "a", name: "A", symbol: "A", geckoId: "a-id", pegType: "peggedUSD", circulating: {} },
      { id: "b", name: "B", symbol: "B", geckoId: "b-id", pegType: "peggedUSD", circulating: {} },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({
          "a-id": { usd: 1.0 },
          "b-id": { usd: 1.0 },
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));
    const db = makeTestDb();
    const { stats } = await fetchPrimaryPrices(assets, db);
    expect(stats.cgOnly).toBe(2);
    expect(stats.singleSource).toBe(2);
  });

  it("uses Pyth as a single source when Hermes returns an unprefixed feed id", async () => {
    const freshPublishTime = Math.floor(Date.now() / 1000) - 60;
    const assets: PeggedAsset[] = [
      { id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (typeof url === "string" && url.includes("hermes.pyth.network")) {
        return new Response(JSON.stringify({
          parsed: [
            {
              id: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
              price: { price: "100010000", expo: -8, conf: "5000", publish_time: freshPublishTime },
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
              timestamp: Date.now(),
            },
          }), { status: 200 });
        }
        if (url.includes("symbols=fxUSD")) {
          return new Response(JSON.stringify({
            fxUSD: {
              value: 0.9997,
              source: { curve: 0.9997 },
              timestamp: Date.now(),
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

describe("applyResolvedPrice", () => {
  it("sets consensusSources to single-element array with source name", () => {
    const asset: PeggedAsset = {
      id: "test",
      name: "Test",
      symbol: "TEST",
      price: 0,
      priceSource: "",
      circulating: {},
      chains: [],
    };

    applyResolvedPrice(asset, 0.9998, "cmc", "fallback", 1000);

    expect(asset.price).toBe(0.9998);
    expect(asset.priceSource).toBe("cmc");
    expect(asset.priceConfidence).toBe("fallback");
    expect(asset.priceUpdatedAt).toBe(1000);
    expect(asset.consensusSources).toEqual(["cmc"]);
  });

  it("agreeSources reflects consensus.agreeSources not candidateSources", async () => {
    const { computePriceConsensus } = await import("../../lib/price-consensus");
    const sources = [
      { source: "coingecko", price: 1.0001, weight: 2 },
      { source: "defillama", price: 1.0002, weight: 1 },
      { source: "outlier", price: 1.05, weight: 1 },  // diverges >50bps
    ];
    const result = computePriceConsensus(sources, 1.0, 50);
    expect(result).not.toBeNull();
    // coingecko and defillama agree; outlier disagrees
    expect(result!.agreeSources).toContain("coingecko");
    expect(result!.agreeSources).toContain("defillama");
    expect(result!.agreeSources).not.toContain("outlier");
    expect(result!.disagreeSources).toContain("outlier");
  });
});

describe("pool challenge — soft-only high confidence downgrade", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makePoolChallengeDb(poolSources: Array<{ stablecoin_id: string; price_sources_json: string; updated_at: number }>) {
    return mockD1([
      { match: "circuit", rows: [] },
      { match: "price_sources_json", rows: poolSources },
    ]);
  }

  it("downgrades soft-only high confidence when ANY large pool diverges >500bps", async () => {
    // CG = $0.995, DL-list = $0.994 → agree within 50bps → high confidence
    // But one large DEX pool shows $0.80 → >500bps divergence → downgrade to low
    // (even though another large pool shows $1.00 which is near-peg)
    const assets: PeggedAsset[] = [
      { id: "dusd-dtrinity", name: "dUSD", symbol: "dUSD", geckoId: "dtrinity-usd", pegType: "peggedUSD", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({ "dtrinity-usd": { usd: 0.995 } }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const nowSec = Math.floor(Date.now() / 1000);
    const db = makePoolChallengeDb([{
      stablecoin_id: "dusd-dtrinity",
      price_sources_json: JSON.stringify([
        { protocol: "uniswap-v3", chain: "ethereum", price: 1.00, tvl: 1_480_000 },
        { protocol: "curve", chain: "ethereum", price: 0.999, tvl: 967_000 },
        { protocol: "curve", chain: "ethereum", price: 0.80, tvl: 849_000 },
      ]),
      updated_at: nowSec - 60,
    }]);

    const dlListPrices = new Map([["dusd-dtrinity", 0.994]]);
    const { results, stats } = await fetchPrimaryPrices(assets, db, undefined, undefined, undefined, undefined, dlListPrices);

    expect(results.size).toBe(1);
    const result = results.get("dusd-dtrinity")!;
    expect(result.confidence).toBe("low");
    expect(stats.low).toBe(1);
    expect(stats.high).toBe(0);

    // Price should be TVL-weighted mean of individual pools, not soft consensus
    // (1.00*1480000 + 0.999*967000 + 0.80*849000) / (1480000 + 967000 + 849000) ≈ 0.9482
    expect(result.price).toBeCloseTo(0.9482, 3);
    expect(result.source).toBe("pool-tvl-weighted");
  });

  it("does NOT downgrade when consensus includes a hard source", async () => {
    // CG + Pyth agree → hard source present → no pool challenge
    const freshPublishTime = Math.floor(Date.now() / 1000) - 60;
    const assets: PeggedAsset[] = [
      { id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether", pegType: "peggedUSD", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({ tether: { usd: 1.0001 } }), { status: 200 });
      }
      if (typeof url === "string" && url.includes("hermes.pyth.network")) {
        return new Response(JSON.stringify({
          parsed: [{
            id: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
            price: { price: "100010000", expo: -8, conf: "5000", publish_time: freshPublishTime },
          }],
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const nowSec = Math.floor(Date.now() / 1000);
    const db = makePoolChallengeDb([{
      stablecoin_id: "usdt-tether",
      price_sources_json: JSON.stringify([
        { protocol: "uniswap-v3", chain: "ethereum", price: 0.80, tvl: 5_000_000 },
      ]),
      updated_at: nowSec - 60,
    }]);

    const { results } = await fetchPrimaryPrices(assets, db);

    expect(results.size).toBe(1);
    const result = results.get("usdt-tether")!;
    // Pyth is a hard source, so pool challenge doesn't apply
    expect(result.confidence).toBe("high");
  });

  it("does NOT downgrade via pool challenge when pool divergence is <500bps", async () => {
    const assets: PeggedAsset[] = [
      { id: "dusd-dtrinity", name: "dUSD", symbol: "dUSD", geckoId: "dtrinity-usd", pegType: "peggedUSD", circulating: {} },
    ];

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("coingecko.com")) {
        return new Response(JSON.stringify({ "dtrinity-usd": { usd: 0.995 } }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const nowSec = Math.floor(Date.now() / 1000);
    const db = makePoolChallengeDb([{
      stablecoin_id: "dusd-dtrinity",
      price_sources_json: JSON.stringify([
        { protocol: "curve", chain: "ethereum", price: 0.97, tvl: 500_000 }, // ~2.5% divergence = 254bps, below 500
      ]),
      updated_at: nowSec - 60,
    }]);

    const dlListPrices = new Map([["dusd-dtrinity", 0.994]]);
    const { results } = await fetchPrimaryPrices(assets, db, undefined, undefined, undefined, undefined, dlListPrices);

    expect(results.size).toBe(1);
    // Pool challenge doesn't fire (<500bps), but CG+DL-only downgrade applies
    expect(results.get("dusd-dtrinity")!.confidence).toBe("single-source");
    expect(results.get("dusd-dtrinity")!.source).not.toBe("pool-tvl-weighted");
  });
});

describe("applyPoolChallenge", () => {
  function makeStats(): PriceValidationStats {
    return { attempted: 1, high: 1, singleSource: 0, cgOnly: 0, low: 0 };
  }

  it("fires for non-USD peg at 300 bps divergence", () => {
    const results = new Map<string, PrimaryPriceResult>([
      ["jpyc-jpyc", {
        price: 0.00682, source: "coingecko+defillama-list+dex-promoted",
        confidence: "high", dlPrice: 0.00682, cgPrice: 0.00682,
        candidateSources: ["coingecko", "defillama-list", "dex-promoted"],
        agreeSources: ["coingecko", "defillama-list", "dex-promoted"],
      }],
    ]);
    const pools = new Map([
      ["jpyc-jpyc", [{ price: 0.00704, tvlUsd: 500_000, protocol: "uniswap", chain: "ethereum" }]],
    ]);
    const pegTypes = new Map<string, string | undefined>([["jpyc-jpyc", "peggedJPY"]]);
    const stats = makeStats();

    const downgrades = applyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(1);
    expect(results.get("jpyc-jpyc")!.confidence).toBe("low");
  });

  it("does NOT fire for USD peg at 300 bps divergence", () => {
    const results = new Map<string, PrimaryPriceResult>([
      ["usdt-tether", {
        price: 1.0, source: "coingecko+defillama-list+dex-promoted",
        confidence: "high", dlPrice: 1.0, cgPrice: 1.0,
        candidateSources: ["coingecko", "defillama-list", "dex-promoted"],
        agreeSources: ["coingecko", "defillama-list", "dex-promoted"],
      }],
    ]);
    const pools = new Map([
      ["usdt-tether", [{ price: 0.97, tvlUsd: 500_000, protocol: "uniswap", chain: "ethereum" }]],
    ]);
    const pegTypes = new Map<string, string | undefined>([["usdt-tether", "peggedUSD"]]);
    const stats = makeStats();

    const downgrades = applyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(0);
    expect(results.get("usdt-tether")!.confidence).toBe("high");
  });

  it("fires for USD peg at 500+ bps divergence", () => {
    const results = new Map<string, PrimaryPriceResult>([
      ["dusd-test", {
        price: 1.0, source: "coingecko+defillama-list",
        confidence: "high", dlPrice: 1.0, cgPrice: 1.0,
        candidateSources: ["coingecko", "defillama-list"],
        agreeSources: ["coingecko", "defillama-list"],
      }],
    ]);
    const pools = new Map([
      ["dusd-test", [{ price: 0.80, tvlUsd: 500_000, protocol: "curve", chain: "ethereum" }]],
    ]);
    const pegTypes = new Map<string, string | undefined>([["dusd-test", "peggedUSD"]]);
    const stats = makeStats();

    const downgrades = applyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(1);
    expect(results.get("dusd-test")!.confidence).toBe("low");
    expect(results.get("dusd-test")!.source).toBe("pool-tvl-weighted");
  });

  it("skips results with hard sources in agreeSources", () => {
    const results = new Map<string, PrimaryPriceResult>([
      ["usdt-tether", {
        price: 1.0, source: "coingecko+binance",
        confidence: "high", dlPrice: 1.0, cgPrice: 1.0,
        candidateSources: ["coingecko", "binance"],
        agreeSources: ["coingecko", "binance"],
      }],
    ]);
    const pools = new Map([
      ["usdt-tether", [{ price: 0.80, tvlUsd: 500_000, protocol: "curve", chain: "ethereum" }]],
    ]);
    const pegTypes = new Map<string, string | undefined>([["usdt-tether", "peggedUSD"]]);
    const stats = makeStats();

    const downgrades = applyPoolChallenge(results, pools, pegTypes, stats);

    expect(downgrades).toBe(0); // binance is a hard source
  });
});
