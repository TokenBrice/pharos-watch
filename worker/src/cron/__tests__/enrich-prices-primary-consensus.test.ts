import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fixtureFetchPrimaryPrices,
  fixtureApplyResolvedPrice,
  installPrimaryPriceRoutes,
  makePeggedAsset,
  makePrimaryPricingDb,
  type PeggedAsset,
} from "./enrich-prices.test-support";

const installFetch = installPrimaryPriceRoutes;

// --- fetchPrimaryPrices tests ---

describe("fetchPrimaryPrices", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeFreshDlListPrices(entries: Array<[string, number]>) {
    const observedAt = Math.floor(Date.now() / 1000) - 60;
    return new Map(entries.map(([id, price]) => [id, { price, observedAt, observedAtMode: "upstream" as const }]));
  }

  function makeTestDb() {
    return makePrimaryPricingDb();
  }

  function makeDexBridgeDb({
    dexRows,
    poolSources,
  }: {
    dexRows?: Array<{
      stablecoin_id: string;
      dex_price_usd: number;
      deviation_from_primary_bps: number | null;
      source_pool_count: number;
      source_total_tvl: number;
      updated_at: number;
    }>;
    poolSources?: Array<{ stablecoin_id: string; price_sources_json: string; updated_at: number }>;
  }) {
    return makePrimaryPricingDb({ dexRows: dexRows ?? [], poolSources: poolSources ?? [] });
  }

  it("withholds dex-promoted aggregate when an uncorroborated protocol source is rejected", async () => {
    const assets = [makePeggedAsset({
      id: "usr-resolv",
      name: "Resolv USD",
      symbol: "USR",
      geckoId: "resolv-usr",
    })];

    installFetch({ "coingecko.com": { body: { "resolv-usr": { usd: 0.145 } } } });

    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeDexBridgeDb({
      dexRows: [
        {
          stablecoin_id: "usr-resolv",
          dex_price_usd: 1.042315,
          deviation_from_primary_bps: null,
          source_pool_count: 2,
          source_total_tvl: 14_000_000,
          updated_at: nowSec - 60,
        },
      ],
      poolSources: [
        {
          stablecoin_id: "usr-resolv",
          price_sources_json: JSON.stringify([
            { protocol: "balancer", chain: "base", price: 1.042315, tvl: 14_000_000 },
          ]),
          updated_at: nowSec - 60,
        },
      ],
    });

    const dlListPrices = makeFreshDlListPrices([["usr-resolv", 0.549146]]);
    const { results } = await fixtureFetchPrimaryPrices(
      assets,
      db,
      undefined,
      undefined,
      undefined,
      undefined,
      dlListPrices,
    );

    const result = results.get("usr-resolv");
    expect(result).toBeDefined();
    expect(result!.candidateSources).toEqual(["coingecko", "defillama-list"]);
    expect(result!.confidence).toBe("low");
    expect(result!.source).toBe("defillama-list");
    expect(result!.price).toBe(0.549146);
    expect(result!.priceSourceConfidenceProfile).toBeNull();
  });

  it("suppresses promoted DEX protocol sources when only a soft aggregator corroborates and withholds aggregate DEX", async () => {
    const assets = [makePeggedAsset({
      id: "usdc-circle",
      name: "USD Coin",
      symbol: "USDC",
      geckoId: "usd-coin",
    })];

    installFetch({ "coingecko.com": { body: { "usd-coin": { usd: 1.0001 } } } });

    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeDexBridgeDb({
      dexRows: [
        {
          stablecoin_id: "usdc-circle",
          dex_price_usd: 1.0002,
          deviation_from_primary_bps: null,
          source_pool_count: 3,
          source_total_tvl: 25_000_000,
          updated_at: nowSec - 60,
        },
      ],
      poolSources: [
        {
          stablecoin_id: "usdc-circle",
          price_sources_json: JSON.stringify([{ protocol: "balancer", chain: "base", price: 1.0002, tvl: 25_000_000 }]),
          updated_at: nowSec - 60,
        },
      ],
    });

    const { results } = await fixtureFetchPrimaryPrices(assets, db);

    const result = results.get("usdc-circle");
    expect(result).toBeDefined();
    // CG alone is a soft aggregator, so it cannot corroborate the protocol lane.
    expect(result!.candidateSources).toEqual(["coingecko"]);
    expect(result!.agreeSources).toEqual(["coingecko"]);
    expect(result!.confidence).toBe("single-source");
    expect(result!.priceSourceConfidenceProfile).toBeNull();
  });

  it("withholds dex-promoted aggregate when a corroborated Uniswap protocol lane is accepted", async () => {
    const assets = [makePeggedAsset({ id: "usdt-tether", name: "Tether", symbol: "USDT" })];

    installFetch({ binance: { body: [{ symbol: "USDTUSD", price: "1.0000" }] } });

    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeDexBridgeDb({
      dexRows: [
        {
          stablecoin_id: "usdt-tether",
          dex_price_usd: 1.0001,
          deviation_from_primary_bps: null,
          source_pool_count: 2,
          source_total_tvl: 3_000_000,
          updated_at: nowSec - 60,
        },
      ],
      poolSources: [
        {
          stablecoin_id: "usdt-tether",
          price_sources_json: JSON.stringify([
            { protocol: "uniswap-v3", chain: "ethereum", price: 1.0001, tvl: 3_000_000 },
          ]),
          updated_at: nowSec - 60,
        },
      ],
    });

    const { results } = await fixtureFetchPrimaryPrices(assets, db);

    const result = results.get("usdt-tether");
    expect(result).toBeDefined();
    expect(result!.candidateSources).toEqual(["binance", "uniswap-v3-dex"]);
    expect(result!.candidateSources).not.toContain("dex-promoted");
    expect(result!.agreeSources).toEqual(["binance", "uniswap-v3-dex"]);
    expect(result!.priceSourceConfidenceProfile).toEqual({
      activeDexLanes: 1,
      freshestDexLaneAgeSec: expect.any(Number),
      aggregateLaneOnly: false,
    });
  });

  it("downgrades CG+DL-only consensus to single-source (DESIGN-4)", async () => {
    const assets = [makePeggedAsset({ id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether" })];

    installFetch({ coingecko: { body: { tether: { usd: 1.0001 } } } });

    const db = makeTestDb();
    const dlListPrices = makeFreshDlListPrices([["usdt-tether", 1.0002]]);
    const { results, stats, cgPrices } = await fixtureFetchPrimaryPrices(
      assets,
      db,
      undefined,
      undefined,
      undefined,
      undefined,
      dlListPrices,
    );

    expect(results.size).toBe(1);
    const result = results.get("usdt-tether")!;
    // CG+DL-only gets downgraded from high to single-source
    expect(result.confidence).toBe("single-source");
    expect(result.source).toBe("coingecko+defillama-list");
    expect(result.price).toBe(1.00015);
    expect(cgPrices.get("tether")).toBe(1.0001);
    expect(stats.high).toBe(0);
    expect(stats.singleSource).toBe(1);
    expect(stats.low).toBe(0);
  });

  it("returns single-source when CG is the only source (no DL list price)", async () => {
    const assets = [makePeggedAsset({ id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether" })];

    installFetch({ coingecko: { body: { tether: { usd: 1.0001 } } } });

    const db = makeTestDb();
    const { results, stats } = await fixtureFetchPrimaryPrices(assets, db);

    expect(results.size).toBe(1);
    const result = results.get("usdt-tether")!;
    expect(result.confidence).toBe("single-source");
    expect(result.source).toBe("coingecko");
    expect(stats.singleSource).toBe(1);
    expect(stats.cgOnly).toBe(1);
  });

  it("drops stale CoinGecko simple-price rows when upstream last_updated_at is old", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const assets = [makePeggedAsset({
      id: "gyd-gyroscope",
      name: "Gyroscope GYD",
      symbol: "GYD",
      geckoId: "gyroscope-gyd",
    })];

    const fetchMock = installFetch({
      coingecko: { body: { "gyroscope-gyd": { usd: 0.992463, last_updated_at: nowSec - 86_400 } } },
    });

    const db = makeTestDb();
    const dlListPrices = new Map([
      [
        "gyd-gyroscope",
        {
          price: 1.0001,
          observedAt: nowSec - 60,
          observedAtMode: "upstream" as const,
        },
      ],
    ]);
    const { results, cgPrices } = await fixtureFetchPrimaryPrices(
      assets,
      db,
      undefined,
      undefined,
      undefined,
      undefined,
      dlListPrices,
    );

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("include_last_updated_at=true"), expect.any(Object));
    expect(cgPrices.has("gyroscope-gyd")).toBe(false);
    expect(results.get("gyd-gyroscope")).toMatchObject({
      source: "defillama-list",
      confidence: "single-source",
      cgPrice: null,
    });
  });

  it("keeps fresh CoinGecko simple-price upstream observation timestamps", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const observedAt = nowSec - 60;
    const assets = [makePeggedAsset({ id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether" })];

    installFetch({ coingecko: { body: { tether: { usd: 1.0001, last_updated_at: observedAt } } } });

    const db = makeTestDb();
    const { results } = await fixtureFetchPrimaryPrices(assets, db);

    expect(results.get("usdt-tether")).toMatchObject({
      source: "coingecko",
      observedAt,
      observedAtMode: "upstream",
    });
  });

  it("includes Kraken and Bitstamp in the consensus cluster when they agree", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const assets = [makePeggedAsset({ id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether" })];

    installFetch({
      coingecko: { body: { tether: { usd: 1.0001 } } },
      "api.kraken.com": { body: { error: [], result: { USDTZUSD: { c: ["1.0000"] } } } },
      "bitstamp.net": { body: [{ pair: "USDT/USD", market: "USDT/USD", last: "1.0002", timestamp: String(nowSec - 60) }] },
    });

    const db = makeTestDb();
    const { results } = await fixtureFetchPrimaryPrices(assets, db);
    const result = results.get("usdt-tether");

    expect(result).toBeDefined();
    expect(result!.agreeSources).toEqual(expect.arrayContaining(["coingecko", "kraken", "bitstamp"]));
    expect(result!.confidence).toBe("high");
  });

  it("returns low confidence when CG and DL list prices diverge beyond 50bps", async () => {
    const assets = [makePeggedAsset({ id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether" })];

    installFetch({ coingecko: { body: { tether: { usd: 0.99 } } } });

    const db = makeTestDb();
    const dlListPrices = makeFreshDlListPrices([["usdt-tether", 1.05]]);
    const { results, stats } = await fixtureFetchPrimaryPrices(
      assets,
      db,
      undefined,
      undefined,
      undefined,
      undefined,
      dlListPrices,
    );

    expect(results.size).toBe(1);
    const result = results.get("usdt-tether")!;
    expect(result.confidence).toBe("low");
    expect(stats.low).toBe(1);
  });

  it("chooses the peg-closer candidate for non-USD divergences when references are available", async () => {
    const assets = [makePeggedAsset({
      id: "eurc-circle",
      name: "EURC",
      symbol: "EURC",
      geckoId: "euro-coin",
      pegType: "peggedEUR",
    })];

    installFetch({ coingecko: { body: { "euro-coin": { usd: 1.08 } } } });

    const db = makeTestDb();
    const dlListPrices = makeFreshDlListPrices([["eurc-circle", 1.8]]);
    const { results, stats } = await fixtureFetchPrimaryPrices(
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
    const assets = [makePeggedAsset({
      id: "ousg-ondo-finance",
      name: "OUSG",
      symbol: "OUSG",
      geckoId: "ousg",
      navToken: true,
    })];

    installFetch({ coingecko: { body: { ousg: { usd: 1.01 } } } });

    const db = makeTestDb();
    const dlListPrices = makeFreshDlListPrices([["ousg-ondo-finance", 110]]);
    const { results, stats } = await fixtureFetchPrimaryPrices(
      assets,
      db,
      undefined,
      undefined,
      undefined,
      undefined,
      dlListPrices,
    );

    expect(results.size).toBe(1);
    const result = results.get("ousg-ondo-finance")!;
    expect(result.confidence).toBe("low");
    expect(result.source).toBe("defillama-list");
    expect(result.price).toBe(110);
    expect(stats.low).toBe(1);
  });

  it("returns single-source when DL list is the only source", async () => {
    const assets = [makePeggedAsset({ id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether" })];

    installFetch({ coingecko: { body: {} } });

    const db = makeTestDb();
    const dlListPrices = makeFreshDlListPrices([["usdt-tether", 1.0]]);
    const { results, stats } = await fixtureFetchPrimaryPrices(
      assets,
      db,
      undefined,
      undefined,
      undefined,
      undefined,
      dlListPrices,
    );

    expect(results.size).toBe(1);
    const result = results.get("usdt-tether")!;
    expect(result.confidence).toBe("single-source");
    expect(result.source).toBe("defillama-list");
    expect(stats.singleSource).toBe(1);
  });

  it("can still evaluate assets without geckoId when other primary-source metadata exists", async () => {
    const assets = [makePeggedAsset({ id: "usdt-tether", name: "NoGecko", symbol: "NG" })];

    installFetch(async () => new Response(JSON.stringify({}), { status: 200 }));

    const db = makeTestDb();
    const { results, stats } = await fixtureFetchPrimaryPrices(assets, db);

    expect(results.size).toBe(0);
    expect(stats.attempted).toBe(1);
  });

  it("filters wrong geckoIds out of CoinGecko fetches while still allowing other primary sources", async () => {
    const assets = [makePeggedAsset({
      id: "usdt-tether",
      name: "BadGecko",
      symbol: "BG",
      geckoId: "something-wrong",
    })];

    installFetch(async () => new Response(JSON.stringify({}), { status: 200 }));

    const db = makeTestDb();
    const { results, stats } = await fixtureFetchPrimaryPrices(assets, db);

    expect(results.size).toBe(0);
    expect(stats.attempted).toBe(1);
  });

  it("tracks cgOnly in stats for CG-only single-source assets", async () => {
    const assets = [
      makePeggedAsset({ id: "a", name: "A", symbol: "A", geckoId: "a-id" }),
      makePeggedAsset({ id: "b", name: "B", symbol: "B", geckoId: "b-id" }),
    ];
    installFetch({
      coingecko: { body: { "a-id": { usd: 1.0 }, "b-id": { usd: 1.0 } } },
    });
    const db = makeTestDb();
    const { stats } = await fixtureFetchPrimaryPrices(assets, db);
    expect(stats.cgOnly).toBe(2);
    expect(stats.singleSource).toBe(2);
  });

  it("uses Pyth as a single source when Hermes returns an unprefixed feed id", async () => {
    const freshPublishTime = Math.floor(Date.now() / 1000) - 60;
    const assets = [makePeggedAsset({ id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether" })];

    installFetch({
      coingecko: { body: {} },
      "hermes.pyth.network": {
        body: {
          parsed: [{
            id: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
            price: { price: "100010000", expo: -8, conf: "5000", publish_time: freshPublishTime },
          }],
        },
      },
    });

    const db = makeTestDb();
    const { results, stats } = await fixtureFetchPrimaryPrices(assets, db);

    expect(results.size).toBe(1);
    const result = results.get("usdt-tether")!;
    expect(result.source).toBe("pyth");
    expect(result.confidence).toBe("single-source");
    expect(result.price).toBeCloseTo(1.0001, 4);
    expect(stats.singleSource).toBe(1);
  });

  it("can price tracked assets without a geckoId when another primary source exists", async () => {
    const freshPublishTime = Math.floor(Date.now() / 1000) - 60;
    const assets = [makePeggedAsset({ id: "usdt-tether", name: "Tether", symbol: "USDT" })];

    installFetch({
      "hermes.pyth.network": {
        body: {
          parsed: [{
            id: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
            price: { price: "100010000", expo: -8, conf: "5000", publish_time: freshPublishTime },
          }],
        },
      },
      "": { body: {} },
    });

    const db = makeTestDb();
    const { results, stats } = await fixtureFetchPrimaryPrices(assets, db);

    expect(results.get("usdt-tether")).toMatchObject({
      source: "pyth",
      confidence: "single-source",
    });
    expect(stats.singleSource).toBe(1);
  });

  it("uses exact-case RedStone symbols and recovers batch-dropped results with solo retry", async () => {
    const assets = [
      makePeggedAsset({ id: "usde-ethena", name: "Ethena USDe", symbol: "USDe", geckoId: "ethena-usde" }),
      makePeggedAsset({ id: "fxusd-f-x-protocol", name: "fxUSD", symbol: "fxUSD", geckoId: "fxusd" }),
    ];

    const fetchMock = installFetch({
      "coins.llama.fi": { body: { coins: {} } },
      coingecko: { body: {} },
      "hermes.pyth.network": { body: { parsed: [] } },
      "api.redstone.finance": (url) => url.includes("symbols=USDe%2CfxUSD")
        ? {
            body: {
              USDe: {
                value: 1.0003,
                source: { curve: 1.0003, uniswap: 1.0002 },
                timestamp: Date.now(),
              },
            },
          }
        : {
            body: {
              fxUSD: {
                value: 0.9997,
                source: { curve: 0.9997, chainlink: 0.9998 },
                timestamp: Date.now(),
              },
            },
          },
    });

    const db = makeTestDb();
    const { results, stats } = await fixtureFetchPrimaryPrices(assets, db);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("symbols=USDe%2CfxUSD"), expect.any(Object));
    expect(results.get("usde-ethena")?.source).toBe("redstone");
    expect(results.get("usde-ethena")?.confidence).toBe("single-source");
    expect(results.get("fxusd-f-x-protocol")?.source).toBe("redstone");
    expect(results.get("fxusd-f-x-protocol")?.price).toBeCloseTo(0.9997, 4);
    expect(stats.singleSource).toBe(2);
  });

  it("excludes single-venue RedStone prices from primary consensus", async () => {
    const assets = [makePeggedAsset({
      id: "usde-ethena",
      name: "Ethena USDe",
      symbol: "USDe",
      geckoId: "ethena-usde",
    })];

    installFetch({
      coingecko: { body: {} },
      "hermes.pyth.network": { body: { parsed: [] } },
      "api.redstone.finance": {
        body: { USDe: { value: 1.0003, source: { curve: 1.0003 }, timestamp: Date.now() } },
      },
    });

    const db = makeTestDb();
    const { results, stats } = await fixtureFetchPrimaryPrices(assets, db);

    expect(results.size).toBe(0);
    expect(stats.attempted).toBe(1);
    expect(stats.singleSource).toBe(0);
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

    fixtureApplyResolvedPrice(asset, 0.9998, "cmc", "fallback", 1000);

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
      { source: "outlier", price: 1.05, weight: 1 }, // diverges >50bps
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
