import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockFetchRetry } from "../../test-helpers/cron";

// The DL /coins pass retries a 5xx through the real backoff; stub the retry
// helper so this suite asserts diagnostics and breaker writes, not wall clock.
vi.mock("../../lib/fetch-retry", () => mockFetchRetry({ notOkAsNull: true }));

import * as circuitBreaker from "../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  maturePairCreatedAt,
  staleObservedAtSec,
  dlQuote,
  cmcUsdQuote,
  cmcCategory,
  cleanupEnrichMissingPricesTest,
  makeEnrichPricesDb,
  installFetch,
} from "./enrich-prices.test-support";
import { enrichMissingPrices, type PeggedAsset } from "../sync-stablecoins/enrich-prices";
import { DEXSCREENER_ROTATION_INTERVAL_MS, runDexScreenerPass } from "../sync-stablecoins/enrich-prices-dexscreener-pass";
import { runDlContractPasses } from "../sync-stablecoins/enrich-prices-defillama-pass";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { makePeggedAsset } from "../sync-stablecoins/__tests__/_fixtures";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });
describe("enrichMissingPrices", () => {
  afterEach(cleanupEnrichMissingPricesTest);
  it("returns zero counts when no assets are missing prices", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({ price: 1.0 }),
      makePeggedAsset({ id: "usdc-circle", name: "USD Coin", symbol: "USDC", price: 0.999 }),
    ];
    const progress: string[] = [];

    const stats = await enrichMissingPrices(
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
    mockFetch([]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const db = makeEnrichPricesDb([
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

    const stats = await enrichMissingPrices(assets, undefined, db);

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

    mockFetch([
      {
        match: "coins.llama.fi/prices",
        body: {
          coins: {
            "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7": dlQuote(1.0, "USDT"),
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

  it("normalizes EVM contract casing for DefiLlama contract fallback", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "usg-tangent",
        name: "Tangent USD",
        symbol: "USG",
        price: 0,
      }),
    ];

    mockFetch([
      {
        match: "coins.llama.fi/prices/current/ethereum:0xb1c2db5d6ca03fce73dbd304d320bf76c55ae1b1",
        body: {
          coins: {
            "ethereum:0xb1c2db5d6ca03fce73dbd304d320bf76c55ae1b1": dlQuote(0.9994, "USG", { confidence: 0.95 }),
          },
        },
      },
    ]);

    const stats = await enrichMissingPrices(assets);

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

    mockFetch([
      {
        match: suiAusdCoinId,
        body: {
          coins: {
            [suiAusdCoinId]: dlQuote(1.0002, "AUSD", { confidence: 0.95 }),
          },
        },
      },
    ]);

    const result = await runDlContractPasses(assets, undefined);

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

    mockFetch([
      {
        match: suiUsdtCoinId,
        body: {
          coins: {
            [suiUsdtCoinId]: dlQuote(0.9998, "USDT", { confidence: 0.95 }),
          },
        },
      },
    ]);

    const result = await runDlContractPasses(assets, undefined);

    expect(result.pass1).toBe(1);
    expect(assets[0].price).toBe(0.9998);
    expect(assets[0].priceSource).toBe("defillama-contract");
  });

  it("escapes slash-bearing DefiLlama IDs without breaking the rest of the batch", async () => {
    const mAddress = "0x866a2bf4e572cbcf37d5071a7a58503bfb36be1b";
    const usdxIbcId = "osmosis:ibc/C78F65E1648A3DFE0BAEB6C4CDA69CC2A75437F1793C0E6386DFDA26393790AE";
    const fetchSpy = mockFetch([
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

    const result = await runDlContractPasses(assets, undefined);

    expect(result).toMatchObject({ pass1: 2, failures: [] });
    expect(assets.map((asset) => asset.price)).toEqual([0.9998, 0.658]);
    expect(fetchSpy.getHistory()[0]?.url).toContain("osmosis:ibc%2FC78F65");
    expect(fetchSpy.getHistory()[0]?.url).not.toContain("kava:usdx");
  });

  it.each(["usdx", "kava:usdx"])("does not use native bank identity %s as a contract price lookup", async address => {
    const ibcId = "osmosis:ibc/C78F65E1648A3DFE0BAEB6C4CDA69CC2A75437F1793C0E6386DFDA26393790AE";
    const fetchSpy = mockFetch([{
      match: "coins.llama.fi/prices/current/osmosis:ibc%2FC78F65E1648A3DFE0BAEB6C4CDA69CC2A75437F1793C0E6386DFDA26393790AE",
      body: { coins: { [ibcId]: dlQuote(0.658, "USDX") } },
    }], { requireMatch: true });
    const assets = [makePeggedAsset({ id: "usdx-kava", name: "Kava USDX", symbol: "USDX", price: 0, address, chains: ["Kava"] })];
    expect(await runDlContractPasses(assets, undefined)).toMatchObject({ pass1: 1, failures: [] });
    expect(assets[0].price).toBe(0.658);
    expect(fetchSpy.getHistory()).toHaveLength(1);
    expect(fetchSpy.getHistory()[0].url).not.toContain("kava:usdx");
    expect(fetchSpy.getHistory()[0].url).not.toContain("solana:usdx");
  });

  it("keeps a native-only asset unpriced without sending a synthetic contract request", async ({ onTestFinished }) => {
    const meta = ACTIVE_META_BY_ID.get("usdx-kava")!;
    // Guard the precondition the zero-request assertion needs: without a
    // native-denom deployment the fixture would be silently vacuous.
    expect(meta.contracts!.some(deployment => deployment.kind === "native-denom")).toBe(true);
    const lookup = vi.spyOn(ACTIVE_META_BY_ID, "get").mockReturnValue({
      ...meta, contracts: meta.contracts!.filter(deployment => deployment.kind === "native-denom"), tradedContracts: [],
    });
    onTestFinished(() => lookup.mockRestore());
    const fetchSpy = mockFetch([], { requireMatch: true });
    const assets = [makePeggedAsset({ id: "usdx-kava", name: "Kava USDX", symbol: "USDX", price: 0, address: "kava:usdx" })];
    expect(await runDlContractPasses(assets, undefined)).toMatchObject({ pass1: 0, pass1b: 0, failures: [] });
    expect(assets[0].price).toBe(0);
    expect(fetchSpy.getHistory()).toHaveLength(0);
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

    mockFetch([
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

    const stats = await enrichMissingPrices(assets, "test-cmc-key");

    expect(stats.pass1).toBe(0);
    expect(stats.passCmc).toBe(1);
    expect(stats.finalMissing).toBe(0);
    expect(assets[0].price).toBe(0.0068);
    expect(assets[0].priceSource).toBe("coinmarketcap");
  });

  it("resolves an asset with a wrong geckoId through independent CMC identity", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        symbol: "TOK",
        id: "test-token",
        cmcSlug: "test-token",
        price: 0,
        geckoId: "wrong",
      }),
    ];

    const fetchSpy = mockFetch([
      { match: "coins.llama.fi", body: { coins: {} } },
      { match: "dexscreener.com", body: { pairs: [] } },
      { match: "pro-api.coinmarketcap.com", body: cmcCategory([
        { slug: "test-token", symbol: "TOK", quote: { USD: cmcUsdQuote(1.0003) } },
      ]) },
    ]);

    const stats = await enrichMissingPrices(assets, "test-cmc-key");

    expect(stats.passCmc).toBe(1);
    expect(stats.finalMissing).toBe(0);
    expect(assets[0]).toMatchObject({ price: 1.0003, priceSource: "coinmarketcap" });
    expect(fetchSpy.getHistory().filter(({ url }) => new URL(url).searchParams.get("ids")?.split(",").includes("wrong"))).toEqual([]);
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

    const stats = await enrichMissingPrices(assets);

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

    const stats = await enrichMissingPrices(assets);

    expect(stats.passCgLowVolume).toBe(0);
    expect(stats.finalMissing).toBe(1);
    expect(assets[0].price).toBeNull();
    expect(assets[0].priceSource).toBe("defillama");
  });

  it("still uses stale FX cache for DexScreener fallback in enrichment (characterization)", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeEnrichPricesDb([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: ["fx-rates"],
        rows: [],
        first: {
          value: JSON.stringify({ peggedJPY: 0.0067 }),
          updated_at: nowSec - 8 * 3600,
        },
      },
      { match: "circuit", rows: [], allowUnused: true },
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

    mockFetch([
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

    const stats = await enrichMissingPrices(assets, undefined, db);

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

    const stats = await enrichMissingPrices(assets);

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

    const result = await runDexScreenerPass(assets, undefined, undefined);

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

    const result = await runDexScreenerPass(assets, undefined, undefined);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
  });

});

// The full hourly cohort previously produced a 46KB URL (upstream HTTP 414).
describe("bounded DefiLlama contract batches", () => {
  afterEach(cleanupEnrichMissingPricesTest);
  const cohort = (count: number) => Array.from({ length: count }, (_, index) => makePeggedAsset({
    id: `batch-${index}`, symbol: "USD", price: null,
    address: `ethereum:0x${index.toString(16).padStart(40, "0")}`,
  }));
  const quoteResponse = (url: string) => Response.json({ coins: Object.fromEntries(
    url.split("/prices/current/")[1].split(",").map((id) => [decodeURIComponent(id), dlQuote(1, "USD")]),
  ) });

  it("bounds encoded URLs, deduplicates identities and merges every successful chunk", async () => {
    const assets = cohort(1_000);
    assets.push({ ...assets[0], id: "duplicate-contract" });
    const urls: string[] = [];
    installFetch((url) => { urls.push(url); return quoteResponse(url); });
    const result = await runDlContractPasses(assets, undefined);
    expect(result).toMatchObject({ resolved: 1_001, failures: [] });
    expect(urls.length).toBeGreaterThan(1);
    expect(urls.every((url) => url.length <= 8_000)).toBe(true);
    const ids = urls.flatMap((url) => url.split("/prices/current/")[1].split(","));
    expect(ids).toHaveLength(1_000);
    expect(new Set(ids).size).toBe(1_000);
  });

  it.each(["http", "schema"])("retains earlier quotes but reports a later %s failure", async (failure) => {
    const assets = cohort(500);
    let calls = 0;
    installFetch((url) => ++calls === 1 ? quoteResponse(url)
      : failure === "http" ? Response.json({ error: "unavailable" }, { status: 404 }) : Response.json({ coins: [] }));
    const result = await runDlContractPasses(assets, undefined);
    expect(result.failures).toEqual(["dl-contracts"]);
    expect(result.resolved).toBeGreaterThan(0);
    expect(result.resolved).toBeLessThan(assets.length);
    expect(assets[0].price).toBe(1);
    expect(assets[assets.length - 1].price).toBeNull();
  });

  it("quarantines a malformed quote without losing siblings or later batches", async () => {
    const assets = cohort(500);
    let calls = 0;
    installFetch((url) => {
      calls += 1;
      if (calls > 1) return quoteResponse(url);
      const ids = url.split("/prices/current/")[1].split(",").map(decodeURIComponent);
      return Response.json({ coins: Object.fromEntries(ids.map((id, index) => [id,
        index === 0 ? { price: null, symbol: "USD" } : dlQuote(1, "USD")])) });
    });
    const result = await runDlContractPasses(assets, undefined);
    expect(calls).toBeGreaterThan(1);
    expect(result.failures).toEqual([]);
    expect(result.resolved).toBe(assets.length - 1);
    expect(assets[0].price).toBeNull();
    expect(assets[1].price).toBe(1);
    expect(assets[assets.length - 1].price).toBe(1);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      source: "defillama-contract", success: true, rejectionReasonCounts: { "invalid-shape": 1 },
    })]);
  });

  it("fails an all-invalid batch but still merges a later healthy batch", async () => {
    const allowed = vi.spyOn(circuitBreaker, "shouldAttemptFetch").mockResolvedValue(true);
    const outcome = vi.spyOn(circuitBreaker, "recordOutcome").mockResolvedValue({} as circuitBreaker.CircuitOutcomeRecord);
    try {
      const assets = cohort(500);
      let calls = 0;
      installFetch((url) => {
        calls += 1;
        if (calls > 1) return quoteResponse(url);
        const ids = url.split("/prices/current/")[1].split(",").map(decodeURIComponent);
        return Response.json({ coins: Object.fromEntries(ids.map((id) => [id, { price: "1" }])) });
      });
      const result = await runDlContractPasses(assets, undefined, undefined, makeEnrichPricesDb([]));
      expect(result.failures).toEqual(["dl-contracts"]);
      expect(assets[0].price).toBeNull();
      expect(assets[assets.length - 1].price).toBe(1);
      expect(result.diagnostics?.[0]).toMatchObject({ success: false, errorClass: "invalid-shape" });
      expect(outcome).toHaveBeenCalledTimes(1);
      expect(outcome.mock.calls[0][2]).toBe(true);
    } finally {
      allowed.mockRestore();
      outcome.mockRestore();
    }
  });

  it("keeps a valid empty batch healthy and without diagnostics", async () => {
    installFetch(() => Response.json({ coins: {} }));
    const result = await runDlContractPasses(cohort(1), undefined);
    expect(result).toMatchObject({ resolved: 0, failures: [] });
    expect(result.diagnostics).toBeUndefined();
  });

  it("fails the pass and the DL_COINS circuit for a 200 envelope without a coins member", async () => {
    const allowed = vi.spyOn(circuitBreaker, "shouldAttemptFetch").mockResolvedValue(true);
    const outcome = vi.spyOn(circuitBreaker, "recordOutcome").mockResolvedValue({} as circuitBreaker.CircuitOutcomeRecord);
    try {
      installFetch(() => Response.json({ error: "unavailable" }));
      const assets = cohort(1);
      const result = await runDlContractPasses(assets, undefined, undefined, makeEnrichPricesDb([]));

      // A malformed OK envelope is failure, not healthy empty coverage.
      expect(result).toMatchObject({ resolved: 0, failures: ["dl-contracts"] });
      expect(assets[0].price).toBeNull();
      expect(outcome).toHaveBeenCalledWith(expect.anything(), CIRCUIT_SOURCE.DL_COINS, false);
    } finally {
      allowed.mockRestore();
      outcome.mockRestore();
    }
  });

  it("does not count local budget exhaustion as a provider failure", async () => {
    const allowed = vi.spyOn(circuitBreaker, "shouldAttemptFetch").mockResolvedValue(true);
    const outcome = vi.spyOn(circuitBreaker, "recordOutcome");
    try {
      installFetch(quoteResponse);
      const result = await runDlContractPasses(cohort(2_000), undefined, undefined, makeEnrichPricesDb([]));
      expect(result.failures).toEqual(["dl-contracts"]);
      expect(outcome).toHaveBeenCalledTimes(1);
      expect(outcome.mock.calls[0][2]).toBe(true);
    } finally {
      allowed.mockRestore();
      outcome.mockRestore();
    }
  });

  it("withholds an individually oversized encoded identity without losing valid peers", async () => {
    const assets = cohort(1);
    assets.push(makePeggedAsset({ id: "oversized", symbol: "USD", price: null, address: `osmosis:${"/".repeat(3_000)}` }));
    const urls: string[] = [];
    installFetch((url) => { urls.push(url); return quoteResponse(url); });
    const result = await runDlContractPasses(assets, undefined);
    expect(urls).toHaveLength(1);
    expect(result).toMatchObject({ resolved: 1, failures: ["dl-contracts"] });
    expect(assets[1].price).toBeNull();
  });

  it("shares the eight-batch cap with alternate deployment lookups", async () => {
    const assets = cohort(1_100);
    assets.push(makePeggedAsset({ id: "usdt-tether", symbol: "USDT", price: null,
      address: "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7" }));
    const urls: string[] = [];
    installFetch((url) => { urls.push(url); return quoteResponse(url); });
    const result = await runDlContractPasses(assets, undefined);
    expect(urls).toHaveLength(8);
    expect(result).toMatchObject({ resolved: 1_100, pass1b: 0, failures: ["dl-contracts"] });
  });

  it("propagates the parent abort before another chunk is requested", async () => {
    const controller = new AbortController();
    let calls = 0;
    installFetch((url) => { calls++; controller.abort(); return quoteResponse(url); });
    await expect(runDlContractPasses(cohort(500), undefined, controller.signal)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("enrichMissingPrices", () => {
  afterEach(cleanupEnrichMissingPricesTest);
  it.each([
    { chainId: "ethereum", tokenAddress: "MintCase", resolves: false },
    { chainId: "solana", tokenAddress: "mintCase", resolves: false },
    { chainId: "solana", tokenAddress: "MintCase", resolves: true },
  ])("requires chain and native-case identity for DexScreener fallback: %j", async ({ chainId, tokenAddress, resolves }) => {
    const assets = [makePeggedAsset({ id: "test-usd", symbol: "TEST", price: null, address: "solana:MintCase" })];
    mockFetch([{
      match: "api.dexscreener.com/tokens/v1/solana/MintCase",
      body: [{
        chainId, dexId: "raydium", pairAddress: "PoolCase",
        baseToken: { address: "BaseCase", name: "Base", symbol: "BASE" },
        quoteToken: { address: tokenAddress, name: "Test", symbol: "TEST" },
        priceUsd: "4", priceNative: "4", liquidity: { usd: 100_000, base: 0, quote: 0 },
        volume: null, pairCreatedAt: null,
      }],
    }]);
    const result = await runDexScreenerPass(assets, undefined, undefined);
    expect(result.resolved).toBe(resolves ? 1 : 0);
    expect(assets[0].price).toBe(resolves ? 1 : null);
    if (!resolves && chainId === "ethereum") {
      // Provider failures live in attempt diagnostics, not the pass's legacy failure list.
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        source: "dexscreener-exact", stage: "fallback", status: 200, ok: false, success: false,
        errorMessage: expect.stringContaining("outside requested chain solana"),
      }));
    }
  });
  it.each([true, false])("prefers the freshest usable DL deployment (newer symbol valid: %s)", async (validSymbol) => {
    const now = Math.floor(Date.now() / 1000);
    const assets = [makePeggedAsset({
      id: "test-usd", symbol: "TEST", price: null,
      address: "0x1111111111111111111111111111111111111111", chains: ["Ethereum", "Base"],
    })];
    const fetchSpy = mockFetch([{
      match: "coins.llama.fi/prices",
      body: { coins: {
        "ethereum:0x1111111111111111111111111111111111111111": dlQuote(1, "TEST", { timestamp: now - 800 }),
        "base:0x1111111111111111111111111111111111111111": dlQuote(1.01, validSymbol ? "TEST" : "OTHER", { timestamp: now - 30 }),
      } },
    }]);
    const result = await runDlContractPasses(assets, undefined);
    expect(result.resolved).toBe(1);
    expect(assets[0]).toMatchObject({
      price: validSymbol ? 1.01 : 1,
      priceObservedAt: now - (validSymbol ? 30 : 800),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it("closes the stale DexScreener exact circuit when no exact candidates remain", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const { db, sqlite } = fixtures.open();
    const key = `circuit:${CIRCUIT_SOURCE.DEXSCREENER_PRICES}`;
    sqlite.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(key, JSON.stringify({
      state: "open", consecutiveFailures: 3, lastFailureAt: 1_799_996_400,
      lastSuccessAt: null, openedAt: 1_799_996_400,
    }), 1_799_996_400);
    const assets = [makePeggedAsset({ id: "search-usd", name: "Search USD", symbol: "CHFAU", price: 0 })];

    const fetchSpy = mockFetch();
    const result = await runDexScreenerPass(assets, undefined, db);

    expect(result.resolved).toBe(0);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "dexscreener-exact",
          stage: "no-candidates",
          status: null,
          ok: true,
          success: true,
          candidateCount: 0,
        }),
      ]),
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key)!;
    expect(JSON.parse(String(row.value))).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
  });

  it("spends the DexScreener batch on original missing chains and uses spare capacity for probes", async () => {
    const make = (id: string, chain: string, suffix: number) => makePeggedAsset({
      id, price: null, address: `${chain}:0x${suffix.toString(16).padStart(40, "0")}`,
      circulating: { peggedUSD: id.startsWith("probe") ? 1_000_000 : 1 },
    });
    const assets = [make("probe-base", "base", 1), make("probe-eth", "ethereum", 2),
      make("missing-eth", "ethereum", 3), make("missing-sol", "solana", 4)];
    const missing = new Set(["missing-eth", "missing-sol"]);
    const fetchSpy = mockFetch();
    await runDexScreenerPass(assets, undefined, undefined, undefined, undefined, 0, missing);
    await runDexScreenerPass(assets, undefined, undefined, undefined, undefined,
      DEXSCREENER_ROTATION_INTERVAL_MS, missing);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const first = String(fetchSpy.mock.calls[0]?.[0]);
    expect(first).toContain("/ethereum/");
    expect(first.indexOf("0003")).toBeLessThan(first.indexOf("0002"));
    expect(first).not.toContain("0001");
    expect(String(fetchSpy.mock.calls[1]?.[0])).toContain("/solana/");
  });

  it("rotates the leading chain group on the next cycle", async () => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        id: "gusd-gemini",
        name: "Gemini Dollar",
        symbol: "GUSD",
        price: 0,
      }),
    ];

    const db = makeEnrichPricesDb(
      [
        { match: "circuit", rows: [], allowUnused: true },
        { match: "cache", rows: [] },
      ],
    );

    const fetchSpy = mockFetch([], { requireMatch: true });

    // One rotation interval later the bridged NEAR deployment takes its turn.
    // The rotation is the point — a persistent gap on one network must not
    // starve the other — so this pins the behaviour rather than the accident.
    await runDexScreenerPass(assets, undefined, db, undefined, undefined, DEXSCREENER_ROTATION_INTERVAL_MS);

    expect(fetchSpy.mock.calls[0]?.[0]).toContain(
      "api.dexscreener.com/tokens/v1/near/056fd409e1d7a124bd7017459dfea2f387b6d5cd.factory.bridge.near",
    );
  });

  it.each([
    ["stale timestamp", dlQuote(1.0, "USDT", { timestamp: staleObservedAtSec() })],
    ["low confidence", dlQuote(1.0, "USDT", { confidence: 0.2 })],
    ["wrong symbol", dlQuote(1.0, "USDC")],
  ])("skips DefiLlama contract quotes with %s", async (_caseName, quote) => {
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      }),
    ];

    mockFetch([
      {
        match: "coins.llama.fi/prices",
        body: {
          coins: {
            "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7": quote,
          },
        },
      },
    ]);

    const result = await runDlContractPasses(assets, undefined);

    expect(result.resolved).toBe(0);
    expect(assets[0].price).toBe(0);
  });

  it("records a defillama-coins breaker failure when DL /coins OK response is malformed", async () => {
    const db = makeEnrichPricesDb([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.DL_COINS}`],
        rows: [],
        first: null,
      },
    ]);
    const assets: PeggedAsset[] = [
      makePeggedAsset({
        price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      }),
    ];

    mockFetch([
      {
        match: "coins.llama.fi/prices",
        body: {
          coins: {
            "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7": { price: "1.0" },
          },
        },
      },
    ]);

    const result = await runDlContractPasses(assets, undefined, undefined, db);

    expect(result.resolved).toBe(0);
    expect(result.failures).toEqual(["dl-contracts"]);
    const circuitWrite = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT INTO cache") &&
          entry.binds[0] === `circuit:${CIRCUIT_SOURCE.DL_COINS}`,
      );
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({
      consecutiveFailures: 1,
    });
  });

  it("records breaker success when a malformed DL /coins row has a healthy sibling", async () => {
    const db = makeEnrichPricesDb([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.DL_COINS}`],
        rows: [],
        first: null,
      },
    ]);
    const assets: PeggedAsset[] = [
      makePeggedAsset({ price: 0, address: "0xdac17f958d2ee523a2206206994597c13d831ec7" }),
    ];

    mockFetch([
      {
        match: "coins.llama.fi/prices",
        body: {
          coins: {
            "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7": dlQuote(1, "USDT"),
            "ethereum:0xbad": { price: "1.0" },
          },
        },
      },
    ]);

    const result = await runDlContractPasses(assets, undefined, undefined, db);

    expect(result.resolved).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.diagnostics?.[0]?.rejectionReasonCounts).toEqual({ "invalid-shape": 1 });
    const circuitWrite = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("INSERT INTO cache") &&
          entry.binds[0] === `circuit:${CIRCUIT_SOURCE.DL_COINS}`,
      );
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({ consecutiveFailures: 0 });
  });

  it("skips DL /coins fetch when the defillama-coins breaker is open", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeEnrichPricesDb([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.DL_COINS}`],
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
      makePeggedAsset({
        price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      }),
    ];

    const fetchSpy = mockFetch([], { requireMatch: true });

    const result = await runDlContractPasses(assets, undefined, undefined, db);

    expect(result.resolved).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records a defillama-coins breaker failure when DL /coins returns 500", async () => {
    const db = makeEnrichPricesDb([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.DL_COINS}`],
        rows: [],
        first: null,
      },
    ]);

    const assets: PeggedAsset[] = [
      makePeggedAsset({
        price: 0,
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      }),
    ];

    const fetchSpy = mockFetch([{ match: () => true, body: "upstream error", status: 500 }]);

    const result = await runDlContractPasses(assets, undefined, undefined, db);

    expect(result.resolved).toBe(0);
    expect(fetchSpy).toHaveBeenCalled();

    const circuitWrites = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT INTO cache"))
      .filter((entry) => String(entry.binds[0]) === `circuit:${CIRCUIT_SOURCE.DL_COINS}`);

    expect(circuitWrites.length).toBeGreaterThan(0);
    const lastWrite = circuitWrites[circuitWrites.length - 1];
    const record = JSON.parse(String(lastWrite.binds[1]));
    expect(record.consecutiveFailures).toBeGreaterThan(0);
    expect(record.lastFailureAt).not.toBeNull();
  });
});
