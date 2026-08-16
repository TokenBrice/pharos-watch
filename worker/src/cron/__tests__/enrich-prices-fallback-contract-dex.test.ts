import { afterEach, describe, expect, it, vi } from "vitest";
import {
  maturePairCreatedAt,
  dlQuote,
  cmcUsdQuote,
  cmcCategory,
  cleanupEnrichMissingPricesTest,
  fixtureEnrichMissingPrices,
  fixtureRunDexScreenerPass,
  fixtureRunDlContractPasses,
  fixtureMockD1 as createFixtureMockD1,
  fixtureMockFetch,
  fixtureCIRCUIT_SOURCE,
  type PeggedAsset,
} from "./enrich-prices.test-support";

function installFetch(implementation: (url: string) => Response | Promise<Response>) {
  return fixtureMockFetch([{ match: () => true, respond: (request) => implementation(request.url) }]);
}

function fixtureMockD1(
  tables: Parameters<typeof createFixtureMockD1>[0] = [],
  options?: Parameters<typeof createFixtureMockD1>[1],
) {
  return createFixtureMockD1(
    [
      ...tables,
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
    ],
    options,
  );
}

describe("enrichMissingPrices", () => {
  afterEach(cleanupEnrichMissingPricesTest);
  it("returns zero counts when no assets are missing prices", async () => {
    const assets: PeggedAsset[] = [
      { id: "usdt-tether", name: "Tether", symbol: "USDT", price: 1.0, pegType: "peggedUSD", circulating: {} },
      { id: "usdc-circle", name: "USD Coin", symbol: "USDC", price: 0.999, pegType: "peggedUSD", circulating: {} },
    ];
    const progress: string[] = [];

    const stats = await fixtureEnrichMissingPrices(
      assets,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (snapshot) => {
        progress.push(snapshot.phase);
      },
    );

    expect(stats.totalMissing).toBe(0);
    expect(stats.pass1).toBe(0);
    expect(stats.passDex).toBe(0);
    expect(stats.finalMissing).toBe(0);
    expect(progress).toEqual(["start", "complete"]);
  });

  it("continues when the FX-rate cache cannot be read", async () => {
    fixtureMockFetch([]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const db = fixtureMockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        throwError: new Error("d1 unavailable"),
      },
    ]);
    const assets: PeggedAsset[] = [
      { id: "missing-usd", name: "Missing USD", symbol: "mUSD", price: 0, pegType: "peggedUSD", circulating: {} },
    ];

    const stats = await fixtureEnrichMissingPrices(assets, undefined, db);

    expect(stats.totalMissing).toBe(1);
    expect(stats.finalMissing).toBe(1);
    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toMatchObject({
      level: "warn",
      event: "stablecoin-price-enrichment.fx-rates-load-failed",
      job: "sync-stablecoins",
      errorMessage: "d1 unavailable",
    });
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("enriches via Pass 1 (contract address → DL coins API)", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "usdt-tether",
        name: "Tether",
        symbol: "USDT",
        price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    fixtureMockFetch([
      {
        match: "coins.llama.fi/prices",
        body: {
          coins: {
            "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7": dlQuote(1.0, "USDT"),
          },
        },
      },
    ]);

    const stats = await fixtureEnrichMissingPrices(assets);

    expect(stats.totalMissing).toBe(1);
    expect(stats.pass1).toBe(1);
    expect(assets[0].price).toBe(1.0);
    expect(stats.finalMissing).toBe(0);
  });

  it("enriches via curated tracked contract metadata when the upstream row is addressless", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "ctusd-citrea",
        name: "Citrea USD",
        symbol: "ctUSD",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    fixtureMockFetch([
      {
        match: "coins.llama.fi/prices/current/citrea:0x8d82c4e3c936c7b5724a382a9c5a4e6eb7ab6d5d",
        body: {
          coins: {
            "citrea:0x8d82c4e3c936c7b5724a382a9c5a4e6eb7ab6d5d": dlQuote(1.0015, "ctUSD", { confidence: 0.97 }),
          },
        },
      },
    ]);

    const stats = await fixtureEnrichMissingPrices(assets);

    expect(stats.pass1).toBe(1);
    expect(assets[0].price).toBe(1.0015);
    expect(assets[0].priceSource).toBe("defillama-contract");
    expect(stats.finalMissing).toBe(0);
  });

  it("normalizes EVM contract casing for DefiLlama contract fallback", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "usg-tangent",
        name: "Tangent USD",
        symbol: "USG",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    fixtureMockFetch([
      {
        match: "coins.llama.fi/prices/current/ethereum:0xb1c2db5d6ca03fce73dbd304d320bf76c55ae1b1",
        body: {
          coins: {
            "ethereum:0xb1c2db5d6ca03fce73dbd304d320bf76c55ae1b1": dlQuote(0.9994, "USG", { confidence: 0.95 }),
          },
        },
      },
    ]);

    const stats = await fixtureEnrichMissingPrices(assets);

    expect(stats.pass1).toBe(1);
    expect(assets[0].price).toBe(0.9994);
    expect(assets[0].priceSource).toBe("defillama-contract");
    expect(stats.finalMissing).toBe(0);
  });

  it("preserves case-sensitive Sui Move identifiers from tracked metadata", async () => {
    const suiAusdCoinId = "sui:0x2053d08c1e2bd02791056171aab0fd12bd7cd7efad2ab8f6b9c8902f14df2ff2::ausd::AUSD";
    const assets: PeggedAsset[] = [
      {
        id: "ausd-agora",
        name: "Agora Dollar",
        symbol: "AUSD",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    fixtureMockFetch([
      {
        match: suiAusdCoinId,
        body: {
          coins: {
            [suiAusdCoinId]: dlQuote(1.0002, "AUSD", { confidence: 0.95 }),
          },
        },
      },
    ]);

    const result = await fixtureRunDlContractPasses(assets, undefined);

    expect(result.pass1).toBe(1);
    expect(assets[0].price).toBe(1.0002);
    expect(assets[0].priceSource).toBe("defillama-contract");
  });

  it("preserves colon-rich Move identifiers in explicit chain-qualified addresses", async () => {
    const suiUsdtCoinId = "sui:0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT";
    const assets: PeggedAsset[] = [
      {
        id: "sui-usdt-test",
        name: "Sui USDT",
        symbol: "USDT",
        price: 0,
        address: suiUsdtCoinId,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    fixtureMockFetch([
      {
        match: suiUsdtCoinId,
        body: {
          coins: {
            [suiUsdtCoinId]: dlQuote(0.9998, "USDT", { confidence: 0.95 }),
          },
        },
      },
    ]);

    const result = await fixtureRunDlContractPasses(assets, undefined);

    expect(result.pass1).toBe(1);
    expect(assets[0].price).toBe(0.9998);
    expect(assets[0].priceSource).toBe("defillama-contract");
  });

  it("escapes slash-bearing DefiLlama IDs without breaking the rest of the batch", async () => {
    const mAddress = "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b";
    const usdxIbcId = "osmosis:ibc/C78F65E1648A3DFE0BAEB6C4CDA69CC2A75437F1793C0E6386DFDA26393790AE";
    const fetchSpy = fixtureMockFetch([
      {
        match: `coins.llama.fi/prices/current/ethereum:${mAddress},osmosis:ibc%2FC78F65E1648A3DFE0BAEB6C4CDA69CC2A75437F1793C0E6386DFDA26393790AE`,
        body: {
          coins: {
            [`ethereum:${mAddress}`]: dlQuote(0.9998, "M"),
            [usdxIbcId]: dlQuote(0.658, "USDX"),
          },
        },
      },
    ], { requireMatch: true });
    const assets: PeggedAsset[] = [
      {
        id: "m-m0",
        name: "M by M0",
        symbol: "M",
        price: 0,
        address: `ethereum:${mAddress}`,
        pegType: "peggedUSD",
        circulating: {},
      },
      {
        id: "usdx-kava",
        name: "Kava USDX",
        symbol: "USDX",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const result = await fixtureRunDlContractPasses(assets, undefined);

    expect(result).toMatchObject({ pass1: 2, failures: [] });
    expect(assets.map((asset) => asset.price)).toEqual([0.9998, 0.658]);
    expect(fetchSpy.getHistory()[0]?.url).toContain("osmosis:ibc%2FC78F65");
  });

  it("reports a non-OK DefiLlama contract batch as a failed pass", async () => {
    fixtureMockFetch([
      {
        match: "coins.llama.fi/prices/current/ethereum:0xfailed",
        status: 404,
        body: { error: "not found" },
      },
    ]);
    const assets: PeggedAsset[] = [
      {
        id: "failed-contract",
        name: "Failed Contract",
        symbol: "FAIL",
        price: 0,
        address: "ethereum:0xfailed",
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const result = await fixtureRunDlContractPasses(assets, undefined);

    expect(result.failures).toEqual(["dl-contracts"]);
    expect(result.resolved).toBe(0);
  });

  it("rejects unreasonable DefiLlama contract prices and allows later fallback passes to resolve", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "jpyc-jpyc",
        name: "JPYC",
        symbol: "JPYC",
        price: 0,
        address: "ethereum:0xjpyc",
        cmcSlug: "jpyc",
        pegType: "peggedJPY",
        circulating: {},
      },
    ];

    fixtureMockFetch([
      {
        match: "coins.llama.fi/prices",
        body: {
          coins: {
            "ethereum:0xjpyc": dlQuote(0.5, "JPYC"),
          },
        },
      },
      {
        match: "pro-api.coinmarketcap.com",
        body: cmcCategory([{ slug: "jpyc", symbol: "JPYC", quote: { USD: cmcUsdQuote(0.0068) } }]),
      },
    ]);

    const stats = await fixtureEnrichMissingPrices(assets, "test-cmc-key");

    expect(stats.pass1).toBe(0);
    expect(stats.passCmc).toBe(1);
    expect(stats.finalMissing).toBe(0);
    expect(assets[0].price).toBe(0.0068);
    expect(assets[0].priceSource).toBe("coinmarketcap");
  });

  it("does not enrich assets with 'wrong' geckoId via contract passes — falls through to CMC/DexScreener", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "usdt-tether",
        name: "SomeToken",
        symbol: "TOK",
        price: 0,
        geckoId: "sometoken-wrong",
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    // All APIs return empty — asset stays unpriced
    fixtureMockFetch([
      { match: "coins.llama.fi", body: { coins: {} } },
      { match: "dexscreener.com", body: { pairs: [] } },
    ]);

    const stats = await fixtureEnrichMissingPrices(assets);

    // "wrong" geckoIds have no contract address, so pass 1/1b skip them.
    // Without CMC key or DexScreener match, asset stays missing.
    expect(stats.pass1).toBe(0);
    expect(stats.pass1b).toBe(0);
    expect(stats.finalMissing).toBe(1);
  });

  it("leaves assets unpriced when all APIs return empty data", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "usdt-tether",
        name: "Tether",
        symbol: "USDT",
        price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        geckoId: "tether",
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    // All APIs return 200 but with no useful price data
    fixtureMockFetch([
      { match: "coins.llama.fi", body: { coins: {} } },
      { match: "dexscreener.com", body: { pairs: [] } },
    ]);

    const stats = await fixtureEnrichMissingPrices(assets);

    // Asset remains unpriced
    expect(stats.totalMissing).toBe(1);
    expect(stats.finalMissing).toBe(1);
    expect(stats.pass1).toBe(0);
    expect(stats.passDex).toBe(0);
  });

  it("fills selected DL-listed missing prices from the low-volume CoinGecko fallback lane", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const observedAt = nowSec - 3600;
    const assets: PeggedAsset[] = [
      {
        id: "dllr-sovryn",
        name: "DLLR",
        symbol: "DLLR",
        price: null,
        priceSource: "defillama",
        geckoId: "sovryn-dollar",
        pegType: "peggedUSD",
        circulating: { peggedUSD: 2_000_000 },
      },
    ];

    installFetch(async (url: string) => {
        if (url.includes("coins.llama.fi")) {
          return new Response(JSON.stringify({ coins: {} }), { status: 200 });
        }
        if (url.includes("dexscreener.com")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.includes("coingecko.com")) {
          return new Response(
            JSON.stringify({
            "sovryn-dollar": { usd: 0.998, last_updated_at: observedAt },
            }),
            { status: 200 },
          );
        }
        return new Response("Not found", { status: 404 });
      });

    const stats = await fixtureEnrichMissingPrices(assets);

    expect(stats.totalMissing).toBe(1);
    expect(stats.passCgLowVolume).toBe(1);
    expect(stats.finalMissing).toBe(0);
    expect(assets[0]).toMatchObject({
      price: 0.998,
      priceSource: "coingecko-low-volume",
      priceSelectedSource: "coingecko-low-volume",
      priceConfidence: "fallback",
      priceObservedAt: observedAt,
      priceObservedAtMode: "upstream",
      consensusSources: ["coingecko-low-volume"],
    });
  });

  it("does not apply low-volume CoinGecko fallback to unallowlisted stale rows", async () => {
    const observedAt = Math.floor(Date.now() / 1000) - 3600;
    const assets: PeggedAsset[] = [
      {
        id: "usx-dforce",
        name: "dForce USD",
        symbol: "USX",
        price: null,
        priceSource: "defillama",
        geckoId: "token-dforce-usd",
        pegType: "peggedUSD",
        circulating: { peggedUSD: 2_000_000 },
      },
    ];

    installFetch(async (url: string) => {
        if (url.includes("coins.llama.fi")) {
          return new Response(JSON.stringify({ coins: {} }), { status: 200 });
        }
        if (url.includes("dexscreener.com")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.includes("coingecko.com")) {
          return new Response(
            JSON.stringify({
              "token-dforce-usd": { usd: 0.414, last_updated_at: observedAt },
            }),
            { status: 200 },
          );
        }
        return new Response("Not found", { status: 404 });
      });

    const stats = await fixtureEnrichMissingPrices(assets);

    expect(stats.passCgLowVolume).toBe(0);
    expect(stats.finalMissing).toBe(1);
    expect(assets[0].price).toBeNull();
    expect(assets[0].priceSource).toBe("defillama");
  });

  it("still uses stale FX cache for DexScreener fallback in enrichment (characterization)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedJPY: 0.0067 }),
          updated_at: nowSec - 8 * 3600,
        },
      },
      { match: "circuit", rows: [] },
    ]);

    const assets: PeggedAsset[] = [
      {
        id: "cjpy-yamato",
        name: "CJPY",
        symbol: "CJPY",
        price: 0,
        pegType: "peggedJPY",
        chains: ["Ethereum"],
        circulating: {},
      },
    ];

    fixtureMockFetch([
      {
        match: "api.dexscreener.com/tokens/v1/ethereum/0x1cfa5641c01406ab8ac350ded7d735ec41298372",
        body: [
          {
            chainId: "ethereum",
            dexId: "uniswap",
            pairAddress: "0xpair",
            baseToken: {
              address: "0x1cfa5641c01406ab8ac350ded7d735ec41298372",
              name: "CJPY",
              symbol: "CJPY",
            },
            quoteToken: {
              address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
              name: "Tether USD",
              symbol: "USDT",
            },
            priceUsd: "0.0005",
            priceNative: "0.0005",
            liquidity: { usd: 100_000, base: 125_000, quote: 125_000 },
            volume: { h24: 25_000 },
            pairCreatedAt: maturePairCreatedAt(),
          },
        ],
      },
    ]);

    const stats = await fixtureEnrichMissingPrices(assets, undefined, db);

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

    const fetchSpy = installFetch(async (url: string) => {
      if (url.includes("coins.llama.fi")) {
        return new Response(JSON.stringify({ coins: {} }), { status: 200 });
      }
      if (url.includes("api.dexscreener.com/tokens/v1/base/0xabc")) {
        return new Response(
          JSON.stringify([
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
          ]),
          { status: 200 },
        );
      }
      if (url.includes("dexscreener.com/latest/dex/search")) {
        return new Response(JSON.stringify({ pairs: [] }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const stats = await fixtureEnrichMissingPrices(assets);

    expect(stats.passDex).toBe(1);
    expect(assets[0].price).toBe(1.0004);
    expect(assets[0].priceSource).toBe("dexscreener-exact");
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("latest/dex/search"))).toBe(false);
  });

  it("does not call retired DexScreener fallback search", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "mystery-usd",
        name: "Mystery USD",
        symbol: "USDT",
        price: 0,
        pegType: "peggedUSD",
        chains: ["Ethereum"],
        circulating: {},
      },
    ];

    const fetchSpy = installFetch(async (url: string) => {
      if (url.includes("dexscreener.com")) {
        return new Response("upstream error", { status: 500 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const stats = await fixtureEnrichMissingPrices(assets);

    expect(stats.passDex).toBe(0);
    expect(stats.finalMissing).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses tracked contract metadata for addressless DexScreener exact fallback targets", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "gusd-gate",
        name: "GUSD",
        symbol: "GUSD",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const fetchSpy = installFetch(async (url: string) => {
      if (url.includes("api.dexscreener.com/tokens/v1/ethereum/0xaf6186b3521b60e27396b5d23b48abc34bf585c5")) {
        return new Response(
          JSON.stringify([
            {
              chainId: "ethereum",
              dexId: "curve",
              pairAddress: "0xpair",
              baseToken: { address: "0xaf6186b3521b60e27396b5d23b48abc34bf585c5", name: "GUSD", symbol: "GUSD" },
              quoteToken: { address: "0xdef", name: "USD Coin", symbol: "USDC" },
              priceUsd: "0.999",
              priceNative: "0.999",
              liquidity: { usd: 250_000, base: 125_000, quote: 125_000 },
              volume: { h24: 1_000, h6: 500, h1: 100, m5: 10 },
              pairCreatedAt: Date.now(),
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await fixtureRunDexScreenerPass(assets, undefined, undefined);

    expect(result.resolved).toBe(1);
    expect(assets[0].price).toBe(0.999);
    expect(assets[0].priceSource).toBe("dexscreener-exact");
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("api.dexscreener.com/tokens/v1/ethereum/0xaf6186b3521b60e27396b5d23b48abc34bf585c5"),
      expect.anything(),
    );
  });

  it("rejects metadata-derived DexScreener exact prices when the tracked token symbol differs", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "usdo-openeden",
        name: "OpenDollar USDO",
        symbol: "USDO",
        price: 0,
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    installFetch(async (url: string) => {
        if (url.includes("api.dexscreener.com/tokens/v1/ethereum/0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe")) {
          return new Response(
            JSON.stringify([
              {
                chainId: "ethereum",
                dexId: "curve",
                pairAddress: "0xpair",
                baseToken: {
                  address: "0x8238884ec9668ef77b90c6dff4d1a9f4f4823bfe",
                  name: "OpenEden cUSDO",
                  symbol: "cUSDO",
                },
                quoteToken: { address: "0xdef", name: "USD Coin", symbol: "USDC" },
                priceUsd: "1.047",
                priceNative: "1.047",
                liquidity: { usd: 356_000, base: 178_000, quote: 178_000 },
                volume: { h24: 267, h6: 100, h1: 10, m5: 1 },
                pairCreatedAt: Date.now(),
              },
            ]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      });

    const result = await fixtureRunDexScreenerPass(assets, undefined, undefined);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
  });

  it("keeps retired DexScreener search independent from exact token lookups", async () => {
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${fixtureCIRCUIT_SOURCE.DEXSCREENER_PRICES}`],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${fixtureCIRCUIT_SOURCE.DEXSCREENER_SEARCH}`],
        rows: [],
        first: null,
      },
    ]);

    const assets: PeggedAsset[] = [
      {
        id: "exact-usd",
        name: "Exact USD",
        symbol: "EXACT",
        price: 0,
        address: "0xabc",
        chains: ["Base"],
        pegType: "peggedUSD",
        circulating: { total: 100 },
      },
      {
        id: "search-usd",
        name: "Search USD",
        symbol: "CHFAU",
        price: 0,
        pegType: "peggedUSD",
        chains: ["Ethereum"],
        circulating: { total: 90 },
      },
    ];

    const fetchSpy = installFetch(async (url: string) => {
      if (url.includes("api.dexscreener.com/tokens/v1/base/0xabc")) {
        return new Response(
          JSON.stringify([
            {
              chainId: "base",
              dexId: "aerodrome",
              pairAddress: "0xpair",
              baseToken: { address: "0xabc", name: "Exact USD", symbol: "EXACT" },
              quoteToken: { address: "0xdef", name: "USD Coin", symbol: "USDC" },
              priceUsd: "1.0004",
              priceNative: "1.0004",
              liquidity: { usd: 250_000, base: 125_000, quote: 125_000 },
              volume: { h24: 1_000, h6: 500, h1: 100, m5: 10 },
              pairCreatedAt: Date.now(),
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("dexscreener.com/latest/dex/search?q=CHFAU")) {
        return new Response("upstream error", { status: 500 });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await fixtureRunDexScreenerPass(assets, undefined, db);

    expect(result.resolved).toBe(1);
    expect(assets[0].price).toBe(1.0004);

    const circuitWrites = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"))
      .map((entry) => String(entry.binds[0]));

    expect(circuitWrites).toContain(`circuit:${fixtureCIRCUIT_SOURCE.DEXSCREENER_PRICES}`);
    expect(circuitWrites).not.toContain(`circuit:${fixtureCIRCUIT_SOURCE.DEXSCREENER_SEARCH}`);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("latest/dex/search"))).toBe(false);
  });

  it("does not probe or recover the retired DexScreener search breaker", async () => {
    const openedAt = Math.floor(Date.now() / 1000) - 3600;
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${fixtureCIRCUIT_SOURCE.DEXSCREENER_SEARCH}`],
        rows: [
          {
            key: `circuit:${fixtureCIRCUIT_SOURCE.DEXSCREENER_SEARCH}`,
            value: JSON.stringify({
              state: "open",
              consecutiveFailures: 3,
              lastFailureAt: openedAt,
              lastSuccessAt: null,
              openedAt,
            }),
            updated_at: openedAt,
          },
        ],
      },
    ]);

    const assets: PeggedAsset[] = [
      {
        id: "search-usd",
        name: "Search USD",
        symbol: "CHFAU",
        price: 0,
        pegType: "peggedUSD",
        chains: ["Ethereum"],
        circulating: { total: 90 },
      },
    ];

    const fetchSpy = fixtureMockFetch();

    const result = await fixtureRunDexScreenerPass(assets, undefined, db);

    expect(result.resolved).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    const searchHistory = db
      .getHistory()
      .filter((entry) => entry.binds.includes(`circuit:${fixtureCIRCUIT_SOURCE.DEXSCREENER_SEARCH}`));
    expect(searchHistory).toHaveLength(0);
  });

  it("can still run exact DexScreener lookups when the search breaker is open", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${fixtureCIRCUIT_SOURCE.DEXSCREENER_PRICES}`],
        rows: [],
        first: null,
      },
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${fixtureCIRCUIT_SOURCE.DEXSCREENER_SEARCH}`],
        rows: [],
        first: {
          value: JSON.stringify({
            state: "open",
            consecutiveFailures: 3,
            lastFailureAt: nowSec - 60,
            lastSuccessAt: null,
            openedAt: nowSec - 60,
          }),
          updated_at: nowSec - 60,
        },
      },
    ]);

    const assets: PeggedAsset[] = [
      {
        id: "exact-usd",
        name: "Exact USD",
        symbol: "EXACT",
        price: 0,
        address: "0xabc",
        chains: ["Base"],
        pegType: "peggedUSD",
        circulating: { total: 100 },
      },
      {
        id: "search-usd",
        name: "Search USD",
        symbol: "SUSD",
        price: 0,
        pegType: "peggedUSD",
        circulating: { total: 90 },
      },
    ];

    const fetchSpy = installFetch(async (url: string) => {
      if (url.includes("api.dexscreener.com/tokens/v1/base/0xabc")) {
        return new Response(
          JSON.stringify([
            {
              chainId: "base",
              dexId: "aerodrome",
              pairAddress: "0xpair",
              baseToken: { address: "0xabc", name: "Exact USD", symbol: "EXACT" },
              quoteToken: { address: "0xdef", name: "USD Coin", symbol: "USDC" },
              priceUsd: "1.0004",
              priceNative: "1.0004",
              liquidity: { usd: 250_000, base: 125_000, quote: 125_000 },
              volume: { h24: 1_000, h6: 500, h1: 100, m5: 10 },
              pairCreatedAt: Date.now(),
            },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("dexscreener.com/latest/dex/search")) {
        throw new Error("search path should have been skipped");
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await fixtureRunDexScreenerPass(assets, undefined, db);

    expect(result.resolved).toBe(1);
    expect(fetchSpy.mock.calls).toHaveLength(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("api.dexscreener.com/tokens/v1/base/0xabc");
  });

  it("does not fall back to DexScreener symbol search when an exact token target exists", async () => {
    const assets: PeggedAsset[] = [
      {
        id: "usdg-paxos",
        name: "USDG",
        symbol: "USDG",
        price: 0,
        address: "0xabc",
        chains: ["Base"],
        pegType: "peggedUSD",
        circulating: {},
      },
    ];

    const fetchSpy = installFetch(async (url: string) => {
      if (url.includes("api.dexscreener.com/tokens/v1/base/0xabc")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes("dexscreener.com/latest/dex/search")) {
        return new Response(
          JSON.stringify({
            pairs: [
              {
                baseToken: { symbol: "USDG" },
                quoteToken: { symbol: "USDC" },
                priceUsd: "1.0003",
                liquidity: { usd: 250_000 },
                chainId: "base",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await fixtureRunDexScreenerPass(assets, undefined, undefined);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("api.dexscreener.com/tokens/v1/base/0xabc");
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("latest/dex/search"))).toBe(false);
  });

  it("does not spend DexScreener request budget on retired symbol-search candidates", { timeout: 15_000 }, async () => {
    const assets: PeggedAsset[] = [
      { id: "deusd-1", name: "DEUSD 1", symbol: "DEUSD", price: 0, pegType: "peggedUSD", circulating: { total: 100 } },
      { id: "bean-1", name: "Bean 1", symbol: "BEAN", price: 0, pegType: "peggedUSD", circulating: { total: 90 } },
      {
        id: "usdn-1",
        name: "USDN 1",
        symbol: "USDN",
        price: 0,
        pegType: "peggedUSD",
        circulating: { total: 80 },
        chains: ["Ethereum"],
      },
      { id: "tor-1", name: "TOR 1", symbol: "TOR", price: 0, pegType: "peggedUSD", circulating: { total: 70 } },
      {
        id: "usdr-1",
        name: "USDR 1",
        symbol: "CTUSD",
        price: 0,
        pegType: "peggedUSD",
        circulating: { total: 60 },
        chains: ["Ethereum"],
      },
      { id: "pinto-1", name: "Pinto 1", symbol: "PINTO", price: 0, pegType: "peggedUSD", circulating: { total: 50 } },
      {
        id: "usbd-1",
        name: "USBD 1",
        symbol: "USBD",
        price: 0,
        pegType: "peggedUSD",
        circulating: { total: 40 },
        chains: ["Ethereum"],
      },
      {
        id: "usdx-1",
        name: "USDX 1",
        symbol: "TEST",
        price: 0,
        pegType: "peggedUSD",
        circulating: { total: 30 },
        chains: ["Ethereum"],
      },
      { id: "husd-1", name: "HUSD 1", symbol: "HUSD", price: 0, pegType: "peggedUSD", circulating: { total: 20 } },
      {
        id: "usx-1",
        name: "USX 1",
        symbol: "CASH",
        price: 0,
        pegType: "peggedUSD",
        circulating: { total: 10 },
        chains: ["Ethereum"],
      },
      {
        id: "chfau-1",
        name: "CHFAU 1",
        symbol: "CHFAU",
        price: 0,
        pegType: "peggedCHF",
        circulating: { total: 9 },
        chains: ["Ethereum"],
      },
    ];

    const fetchSpy = installFetch(async (url: string) => {
      if (
        url.includes("q=USDN") ||
        url.includes("q=CTUSD") ||
        url.includes("q=USBD") ||
        url.includes("q=TEST") ||
        url.includes("q=CASH")
      ) {
        return new Response("upstream error", { status: 500 });
      }
      if (url.includes("q=CHFAU")) {
        return new Response(
          JSON.stringify({
            pairs: [
              {
                baseToken: { symbol: "CHFAU" },
                quoteToken: { symbol: "USDC" },
                priceUsd: "1.126",
                liquidity: { usd: 250_000 },
                volume: { h24: 25_000 },
                pairCreatedAt: maturePairCreatedAt(),
                chainId: "ethereum",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await fixtureRunDexScreenerPass(assets, { peggedCHF: 1.12 }, undefined);

    expect(result.resolved).toBe(0);
    expect(assets[10].price).toBe(0);
    expect(assets[10].priceSource).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
