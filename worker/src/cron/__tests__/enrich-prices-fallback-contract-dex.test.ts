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
  makeFixtureMockD1 as fixtureMockD1,
  fixtureMockFetch,
  installFetch,
  type PeggedAsset,
} from "./enrich-prices.test-support";
import { makePeggedAsset } from "../sync-stablecoins/__tests__/_fixtures";

describe("enrichMissingPrices", () => {
  afterEach(cleanupEnrichMissingPricesTest);
  it("returns zero counts when no assets are missing prices", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({ price: 1.0 }),
      makePeggedAsset({ id: "usdc-circle", name: "USD Coin", symbol: "USDC", price: 0.999 }),
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
      makePeggedAsset({ id: "missing-usd", name: "Missing USD", symbol: "mUSD", price: 0 }),
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
      makePeggedAsset({
        price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      }),
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
      makePeggedAsset({
        id: "ctusd-citrea",
        name: "Citrea USD",
        symbol: "ctUSD",
        price: 0,
      }),
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
      makePeggedAsset({
        id: "usg-tangent",
        name: "Tangent USD",
        symbol: "USG",
        price: 0,
      }),
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
      makePeggedAsset({
        id: "ausd-agora",
        name: "Agora Dollar",
        symbol: "AUSD",
        price: 0,
      }),
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
      makePeggedAsset({
        id: "sui-usdt-test",
        name: "Sui USDT",
        price: 0,
        address: suiUsdtCoinId,
      }),
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
      makePeggedAsset({
        id: "m-m0",
        name: "M by M0",
        symbol: "M",
        price: 0,
        address: `ethereum:${mAddress}`,
      }),
      makePeggedAsset({
        id: "usdx-kava",
        name: "Kava USDX",
        symbol: "USDX",
        price: 0,
      }),
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
      makePeggedAsset({
        id: "failed-contract",
        name: "Failed Contract",
        symbol: "FAIL",
        price: 0,
        address: "ethereum:0xfailed",
      }),
    ];

    const result = await fixtureRunDlContractPasses(assets, undefined);

    expect(result.failures).toEqual(["dl-contracts"]);
    expect(result.resolved).toBe(0);
  });

  it("rejects unreasonable DefiLlama contract prices and allows later fallback passes to resolve", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "jpyc-jpyc",
        name: "JPYC",
        symbol: "JPYC",
        price: 0,
        address: "ethereum:0xjpyc",
        cmcSlug: "jpyc",
        pegType: "peggedJPY",
      }),
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
      makePeggedAsset({
        symbol: "TOK",
        price: 0,
        geckoId: "sometoken-wrong",
      }),
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
      makePeggedAsset({
        price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        geckoId: "tether",
      }),
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
      makePeggedAsset({
        id: "dllr-sovryn",
        name: "DLLR",
        symbol: "DLLR",
        price: null,
        priceSource: "defillama",
        geckoId: "sovryn-dollar",
        circulating: { peggedUSD: 2_000_000 },
      }),
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
      makePeggedAsset({
        id: "usx-dforce",
        name: "dForce USD",
        symbol: "USX",
        price: null,
        priceSource: "defillama",
        geckoId: "token-dforce-usd",
        circulating: { peggedUSD: 2_000_000 },
      }),
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
      makePeggedAsset({
        id: "cjpy-yamato",
        name: "CJPY",
        symbol: "CJPY",
        price: 0,
        pegType: "peggedJPY",
        chains: ["Ethereum"],
      }),
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

  it("enriches via an exact DexScreener token-address lookup", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "mystery-usd",
        name: "Mystery USD",
        symbol: "MUSD",
        price: 0,
        address: "0xabc",
        chains: ["Base"],
      }),
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
      return new Response("Not found", { status: 404 });
    });

    const stats = await fixtureEnrichMissingPrices(assets);

    expect(stats.passDex).toBe(1);
    expect(assets[0].price).toBe(1.0004);
    expect(assets[0].priceSource).toBe("dexscreener-exact");
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("api.dexscreener.com/tokens/v1/base/0xabc"))).toBe(true);
  });

  it("uses tracked contract metadata for addressless DexScreener exact fallback targets", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "gusd-gate",
        name: "GUSD",
        symbol: "GUSD",
        price: 0,
      }),
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
      makePeggedAsset({
        id: "usdo-openeden",
        name: "OpenDollar USDO",
        symbol: "USDO",
        price: 0,
      }),
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

});
