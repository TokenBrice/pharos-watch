import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installPrimaryPriceRoutes,
  makePrimaryPricingDb,
} from "./enrich-prices.test-support";
import {
  applyResolvedPrice,
  type PeggedAsset,
} from "../sync-stablecoins/enrich-prices";
import { fetchPrimaryPrices } from "../sync-stablecoins/enrich-prices-primary";
import { makePeggedAsset } from "../sync-stablecoins/__tests__/_fixtures";


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

    installPrimaryPriceRoutes({ "coingecko.com": { body: { "resolv-usr": { usd: 0.145 } } } });

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
            { protocol: "balancer", chain: "base", price: 1.042315, tvl: 14_000_000, observedAt: nowSec - 60, aggregateObservedAt: nowSec - 60 },
          ]),
          updated_at: nowSec - 60,
        },
      ],
    });

    const dlListPrices = makeFreshDlListPrices([["usr-resolv", 0.549146]]);
    const { results } = await fetchPrimaryPrices(
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

    installPrimaryPriceRoutes({ "coingecko.com": { body: { "usd-coin": { usd: 1.0001 } } } });

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
          price_sources_json: JSON.stringify([{ protocol: "balancer", chain: "base", price: 1.0002, tvl: 25_000_000, observedAt: nowSec - 60, aggregateObservedAt: nowSec - 60 }]),
          updated_at: nowSec - 60,
        },
      ],
    });

    const { results } = await fetchPrimaryPrices(assets, db);

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

    installPrimaryPriceRoutes({ binance: { body: [{ symbol: "USDTUSD", price: "1.0000" }] } });

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
            { protocol: "uniswap-v3", chain: "ethereum", price: 1.0001, tvl: 3_000_000, observedAt: nowSec - 60, aggregateObservedAt: nowSec - 60 },
          ]),
          updated_at: nowSec - 60,
        },
      ],
    });

    const { results } = await fetchPrimaryPrices(assets, db);

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

  it("admits only fresh retained VUSD aggregate liquidity at the UI floor", async () => {
    installPrimaryPriceRoutes({});
    const nowSec = Math.floor(Date.now() / 1000);
    const cases = [
      {
        asset: makePeggedAsset({ id: "vusd-virtue", name: "Virtue USD", symbol: "VUSD" }),
        tvl: 725_586,
        updatedAt: nowSec - 60,
        accepted: true,
      },
      {
        asset: makePeggedAsset({ id: "dusd-test", name: "Test USD", symbol: "DUSD" }),
        tvl: 725_586,
        updatedAt: nowSec - 60,
        accepted: false,
      },
      {
        asset: makePeggedAsset({ id: "vusd-virtue", name: "Virtue USD", symbol: "VUSD" }),
        tvl: 249_999,
        updatedAt: nowSec - 60,
        accepted: false,
      },
      {
        asset: makePeggedAsset({ id: "vusd-virtue", name: "Virtue USD", symbol: "VUSD" }),
        tvl: 725_586,
        updatedAt: nowSec - 3_601,
        accepted: false,
      },
    ];

    for (const testCase of cases) {
      const db = makeDexBridgeDb({
        dexRows: [
          {
            stablecoin_id: testCase.asset.id,
            dex_price_usd: 0.99093,
            deviation_from_primary_bps: null,
            source_pool_count: 3,
            source_total_tvl: testCase.tvl,
            updated_at: testCase.updatedAt,
          },
        ],
      });

      const { results } = await fetchPrimaryPrices([testCase.asset], db);
      const result = results.get(testCase.asset.id);
      if (testCase.accepted) {
        expect(result).toMatchObject({
          price: 0.99093,
          source: "dex-promoted",
          confidence: "single-source",
          agreeSources: ["dex-promoted"],
        });
      } else {
        expect(result).toBeUndefined();
      }
    }
  });

  it("downgrades CG+DL-only consensus to single-source (DESIGN-4)", async () => {
    const assets = [makePeggedAsset({ id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether" })];

    installPrimaryPriceRoutes({ coingecko: { body: { tether: { usd: 1.0001 } } } });

    const db = makeTestDb();
    const dlListPrices = makeFreshDlListPrices([["usdt-tether", 1.0002]]);
    const { results, stats } = await fetchPrimaryPrices(
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
    expect(stats.high).toBe(0);
    expect(stats.singleSource).toBe(1);
    expect(stats.low).toBe(0);
  });

  it("returns single-source when CG is the only source (no DL list price)", async () => {
    const assets = [makePeggedAsset({ id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether" })];

    installPrimaryPriceRoutes({ coingecko: { body: { tether: { usd: 1.0001 } } } });

    const db = makeTestDb();
    const { results, stats } = await fetchPrimaryPrices(assets, db);

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

    const fetchMock = installPrimaryPriceRoutes({
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
    const { results } = await fetchPrimaryPrices(
      assets,
      db,
      undefined,
      undefined,
      undefined,
      undefined,
      dlListPrices,
    );

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("include_last_updated_at=true"), expect.any(Object));
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

    installPrimaryPriceRoutes({ coingecko: { body: { tether: { usd: 1.0001, last_updated_at: observedAt } } } });

    const db = makeTestDb();
    const { results } = await fetchPrimaryPrices(assets, db);

    expect(results.get("usdt-tether")).toMatchObject({
      source: "coingecko",
      observedAt,
      observedAtMode: "upstream",
    });
  });

  it("includes Kraken and Bitstamp in the consensus cluster when they agree", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const assets = [makePeggedAsset({ id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether" })];

    installPrimaryPriceRoutes({
      coingecko: { body: { tether: { usd: 1.0001 } } },
      "api.kraken.com": { body: { error: [], result: { USDTZUSD: { c: ["1.0000"] } } } },
      "bitstamp.net": { body: [{ pair: "USDT/USD", market: "USDT/USD", last: "1.0002", timestamp: String(nowSec - 60) }] },
    });

    const db = makeTestDb();
    const { results } = await fetchPrimaryPrices(assets, db);
    const result = results.get("usdt-tether");

    expect(result).toBeDefined();
    expect(result!.agreeSources).toEqual(expect.arrayContaining(["coingecko", "kraken", "bitstamp"]));
    expect(result!.confidence).toBe("high");
  });

  it("returns low confidence when CG and DL list prices diverge beyond 50bps", async () => {
    const assets = [makePeggedAsset({ id: "usdt-tether", name: "Tether", symbol: "USDT", geckoId: "tether" })];

    installPrimaryPriceRoutes({ coingecko: { body: { tether: { usd: 0.99 } } } });

    const db = makeTestDb();
    const dlListPrices = makeFreshDlListPrices([["usdt-tether", 1.05]]);
    const { results, stats } = await fetchPrimaryPrices(
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

    installPrimaryPriceRoutes({ coingecko: { body: { "euro-coin": { usd: 1.08 } } } });

    const db = makeTestDb();
    const dlListPrices = makeFreshDlListPrices([["eurc-circle", 1.8]]);
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
    const assets = [makePeggedAsset({
      id: "ousg-ondo-finance",
      name: "OUSG",
      symbol: "OUSG",
      geckoId: "ousg",
      navToken: true,
    })];

    installPrimaryPriceRoutes({ coingecko: { body: { ousg: { usd: 1.01 } } } });

    const db = makeTestDb();
    const dlListPrices = makeFreshDlListPrices([["ousg-ondo-finance", 110]]);
    const { results, stats } = await fetchPrimaryPrices(
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

    installPrimaryPriceRoutes({ coingecko: { body: {} } });

    const db = makeTestDb();
    const dlListPrices = makeFreshDlListPrices([["usdt-tether", 1.0]]);
    const { results, stats } = await fetchPrimaryPrices(
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
    const assets = [makePeggedAsset({ id: "usdt-tether", name: "NoGecko", symbol: "USDT" })];

    const fetchSpy = installPrimaryPriceRoutes({ binance: { body: [{ symbol: "USDTUSD", price: "1.0004" }] } });

    const db = makeTestDb();
    const { results, stats } = await fetchPrimaryPrices(assets, db);

    expect(results.get("usdt-tether")).toMatchObject({ price: 1.0004, source: "binance" });
    expect(fetchSpy.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/simple/price"))).toEqual([]);
    expect(stats.attempted).toBe(1);
  });

  it("filters wrong geckoIds out of CoinGecko fetches while still allowing other primary sources", async () => {
    const assets = [makePeggedAsset({
      id: "usdt-tether",
      name: "BadGecko",
      symbol: "USDT",
      geckoId: "wrong",
    })];

    const fetchSpy = installPrimaryPriceRoutes({ binance: { body: [{ symbol: "USDTUSD", price: "1.0004" }] } });

    const db = makeTestDb();
    const { results, stats } = await fetchPrimaryPrices(assets, db);

    expect(results.get("usdt-tether")).toMatchObject({ price: 1.0004, source: "binance" });
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("ids"))
      .filter((ids) => ids?.split(",").includes("wrong"))).toEqual([]);
    expect(stats.attempted).toBe(1);
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
});
