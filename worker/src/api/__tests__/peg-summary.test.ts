import { describe, it, expect } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { handlePegSummary } from "../peg-summary";

const nowSec = Math.floor(Date.now() / 1000);

function makePegSummaryDb(assets: ReturnType<typeof makeAsset>[] = []) {
  const cacheValue = JSON.stringify({ peggedAssets: assets });
  return mockD1([
    {
      match: "cache",
      rows: [{ key: "stablecoins", value: cacheValue, updated_at: nowSec }],
      first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
    },
    { match: "depeg_events", rows: [] },
    { match: "dex_prices", rows: [] },
    { match: "supply_history", rows: [] },
  ]);
}

function makePegSummaryDbWithDexPrice(
  assets: ReturnType<typeof makeAsset>[],
  updatedAt: number,
  sourceTotalTvl = 10_000_000,
) {
  const cacheValue = JSON.stringify({ peggedAssets: assets });
  return mockD1([
    {
      match: "cache",
      rows: [{ key: "stablecoins", value: cacheValue, updated_at: nowSec }],
      first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
    },
    { match: "depeg_events", rows: [] },
    {
      match: "dex_prices",
      rows: [
        {
          stablecoin_id: "usdt-tether",
          dex_price_usd: 1.0002,
          deviation_from_primary_bps: 2,
          source_pool_count: 4,
          source_total_tvl: sourceTotalTvl,
          updated_at: updatedAt,
        },
      ],
    },
    { match: "supply_history", rows: [] },
  ]);
}

describe("handlePegSummary", () => {
  it("returns 503 when stablecoins cache is missing", async () => {
    const db = mockD1();
    const res = await handlePegSummary(db);
    expect(res.status).toBe(503);
  });

  it("returns 200 with coins and summary", async () => {
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const db = makePegSummaryDb([asset]);
    const res = await handlePegSummary(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      coins: Array<{ id: string; methodologyVersion: string; currentDeviationBps: number | null }>;
      summary: {
        activeDepegCount: number;
        medianDeviationBps: number;
        totalTracked: number;
        worstCurrent: { id: string; symbol: string; bps: number } | null;
        fallbackPegRates?: string[];
      };
      methodology: {
        version: string;
        versionLabel: string;
        changelogPath: string;
      };
    };
    expect(Array.isArray(body.coins)).toBe(true);
    expect(body.summary.activeDepegCount).toBe(0);
    expect(body.summary.medianDeviationBps).toBe(0);
    expect(body.summary.totalTracked).toBe(body.coins.filter((coin) => coin.currentDeviationBps !== null).length);
    expect(body.summary.worstCurrent).toEqual({ id: "usdt-tether", symbol: "USDT", bps: 0 });
    expect(body.coins.some((coin) => coin.id === "usdt-tether")).toBe(true);
    expect(body.coins[0].methodologyVersion).toBe(body.methodology.version);
    expect(body.methodology.versionLabel.length).toBeGreaterThan(0);
    expect(body.methodology.changelogPath).toBe("/methodology/depeg-changelog/");
  });

  it("returns price provenance and trust fields for each coin", async () => {
    const asset = makeAsset({
      id: "usdt-tether",
      symbol: "USDT",
      priceSource: "cached",
      priceConfidence: "fallback",
      priceObservedAt: nowSec - 3600,
      priceObservedAtMode: "local_fetch",
      priceSyncedAt: nowSec - 1200,
      priceUpdatedAt: nowSec - 1800,
    });
    const db = makePegSummaryDb([asset]);
    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      coins: Array<{
        id: string;
        priceSource?: string;
        priceConfidence?: string | null;
        priceObservedAt?: number | null;
        priceObservedAtMode?: string | null;
        priceSyncedAt?: number | null;
        priceUpdatedAt?: number | null;
        primaryTrust?: string;
      }>;
    };
    const coin = body.coins.find((c) => c.id === "usdt-tether");
    expect(coin).toMatchObject({
      priceSource: "cached",
      priceConfidence: "fallback",
      priceObservedAt: nowSec - 3600,
      priceObservedAtMode: "local_fetch",
      priceSyncedAt: nowSec - 1200,
      priceUpdatedAt: nowSec - 1800,
      primaryTrust: "confirm_required",
    });
  });

  it("includes X-Data-Age header", async () => {
    const asset = makeAsset();
    const db = makePegSummaryDb([asset]);
    const res = await handlePegSummary(db);
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });

  it("keeps dexPriceCheck for data fresh enough for UI display", async () => {
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const db = makePegSummaryDbWithDexPrice([asset], nowSec - 1800);
    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      coins: Array<{
        id: string;
        dexPriceCheck?: {
          dexPrice: number;
          dexDeviationBps: number;
          agrees: boolean;
          sourcePools: number;
          sourceTvl: number;
        } | null;
      }>;
    };
    const coin = body.coins.find((c) => c.id === "usdt-tether");
    expect(coin?.dexPriceCheck).toEqual({
      dexPrice: 1.0002,
      dexDeviationBps: 2,
      agrees: true,
      sourcePools: 4,
      sourceTvl: 10_000_000,
    });
  });

  it("hides dexPriceCheck when data is too stale for UI display", async () => {
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const db = makePegSummaryDbWithDexPrice([asset], nowSec - 7200);
    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      coins: Array<{ id: string; dexPriceCheck?: { agrees: boolean } | null }>;
    };
    const coin = body.coins.find((c) => c.id === "usdt-tether");
    expect(coin?.dexPriceCheck).toBeUndefined();
  });

  it("hides dexPriceCheck when DEX source TVL is below the UI trust floor", async () => {
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const db = makePegSummaryDbWithDexPrice([asset], nowSec - 1800, 200_000);
    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      coins: Array<{ id: string; dexPriceCheck?: { agrees: boolean } | null }>;
    };
    const coin = body.coins.find((c) => c.id === "usdt-tether");
    expect(coin?.dexPriceCheck).toBeUndefined();
  });

  it("keeps dexPriceCheck even when the primary price is temporarily missing", async () => {
    const asset = makeAsset({
      id: "usdt-tether",
      symbol: "USDT",
      price: null,
    });
    const db = makePegSummaryDbWithDexPrice([asset], nowSec - 1800);
    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      coins: Array<{
        id: string;
        dexPriceCheck?: {
          dexPrice: number;
          dexDeviationBps: number;
          agrees: boolean;
          sourcePools: number;
          sourceTvl: number;
        } | null;
      }>;
    };
    const coin = body.coins.find((c) => c.id === "usdt-tether");
    expect(coin?.dexPriceCheck).toEqual({
      dexPrice: 1.0002,
      dexDeviationBps: 2,
      agrees: true,
      sourcePools: 4,
      sourceTvl: 10_000_000,
    });
  });

  it("derives secondary FX DEX deviation from tracked peg metadata when cache pegType is empty", async () => {
    const assets = [
      makeAsset({
        id: "kgst-kyrgyz-som",
        name: "Kyrgyz Som Stablecoin",
        symbol: "KGST",
        geckoId: "kyrgyz-som-stablecoin",
        pegType: "",
        price: null,
        circulating: { peggedKGS: 2_000_000 },
      }),
      makeAsset({
        id: "cngn-compliant-naira",
        name: "Compliant Naira",
        symbol: "cNGN",
        geckoId: "compliant-naira",
        pegType: "",
        price: null,
        circulating: { peggedNGN: 2_000_000 },
      }),
      makeAsset({
        id: "xofm-mento",
        name: "Mento West African CFA Franc",
        symbol: "XOFm",
        geckoId: "celo-west-african-cfa-franc",
        pegType: "",
        price: null,
        circulating: { peggedXOF: 2_000_000 },
      }),
    ];
    const cacheValue = JSON.stringify({
      peggedAssets: assets,
      fxFallbackRates: {
        peggedKGS: 1 / 87,
        peggedNGN: 1 / 1370,
        peggedXOF: 1 / 600,
      },
    });
    const db = mockD1([
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: cacheValue, updated_at: nowSec }],
        first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
      },
      { match: "depeg_events", rows: [] },
      {
        match: "dex_prices",
        rows: [
          {
            stablecoin_id: "kgst-kyrgyz-som",
            dex_price_usd: 1 / 87,
            deviation_from_primary_bps: null,
            source_pool_count: 2,
            source_total_tvl: 2_000_000,
            updated_at: nowSec - 60,
          },
          {
            stablecoin_id: "cngn-compliant-naira",
            dex_price_usd: 1 / 1370,
            deviation_from_primary_bps: null,
            source_pool_count: 2,
            source_total_tvl: 2_000_000,
            updated_at: nowSec - 60,
          },
          {
            stablecoin_id: "xofm-mento",
            dex_price_usd: 1 / 600,
            deviation_from_primary_bps: null,
            source_pool_count: 2,
            source_total_tvl: 2_000_000,
            updated_at: nowSec - 60,
          },
        ],
      },
      { match: "supply_history", rows: [] },
    ]);

    const res = await handlePegSummary(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      coins: Array<{
        id: string;
        dexPriceCheck?: { dexDeviationBps: number; agrees: boolean } | null;
      }>;
    };

    expect(body.coins.find((coin) => coin.id === "kgst-kyrgyz-som")?.dexPriceCheck).toMatchObject({
      dexDeviationBps: 0,
      agrees: true,
    });
    expect(body.coins.find((coin) => coin.id === "cngn-compliant-naira")?.dexPriceCheck).toMatchObject({
      dexDeviationBps: 0,
      agrees: true,
    });
    expect(body.coins.find((coin) => coin.id === "xofm-mento")?.dexPriceCheck).toMatchObject({
      dexDeviationBps: 0,
      agrees: true,
    });
  });

  it("includes navToken coins with null deviation fields", async () => {
    const db = makePegSummaryDb([
      makeAsset({
        id: "fpi-frax",
        name: "Frax Price Index",
        symbol: "FPI",
        pegType: "peggedVAR",
        price: 1.12,
      }),
    ]);
    const res = await handlePegSummary(db);
    const data = (await res.json()) as { coins: Array<{ id: string; currentDeviationBps: number | null }> };
    const fpi = data.coins.find((c) => c.id === "fpi-frax");
    expect(fpi).toBeDefined();
    expect(fpi!.currentDeviationBps).toBeNull();
  });

  it("counts only coins with a live deviation in the summary denominator", async () => {
    const db = makePegSummaryDb([
      makeAsset({ id: "usdt-tether", symbol: "USDT" }),
      makeAsset({
        id: "fpi-frax",
        name: "Frax Price Index",
        symbol: "FPI",
        pegType: "peggedVAR",
        price: 1.12,
      }),
      makeAsset({
        id: "cjpy-yamato",
        symbol: "CJPY",
        name: "Convertible JPY Token",
        pegType: "peggedJPY",
        price: 0.005,
        priceSource: "coingecko",
        priceConfidence: "single-source",
        priceUpdatedAt: nowSec,
        circulating: { peggedJPY: 500_000 },
      }),
    ]);
    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      coins: Array<{ id: string; currentDeviationBps: number | null }>;
      summary: {
        totalTracked: number;
      };
    };

    expect(body.coins.length).toBeGreaterThanOrEqual(3);
    expect(body.coins.find((coin) => coin.id === "usdt-tether")?.currentDeviationBps).not.toBeNull();
    expect(body.coins.find((coin) => coin.id === "fpi-frax")?.currentDeviationBps).toBeNull();
    expect(body.coins.find((coin) => coin.id === "cjpy-yamato")?.currentDeviationBps).toBeNull();
    expect(body.summary.totalTracked).toBe(1);
  });

  it("counts non-USD coins within the non-USD threshold as at peg", async () => {
    const asset = makeAsset({
      id: "eurc-circle",
      symbol: "EUROC",
      name: "Euro Coin",
      geckoId: "euro-coin",
      pegType: "peggedEUR",
      price: 1.065,
      priceSource: "defillama",
      priceConfidence: "single-source",
      priceUpdatedAt: nowSec,
    });
    const db = makePegSummaryDb([asset]);
    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      summary: {
        coinsAtPeg: number;
        totalTracked: number;
      };
    };
    expect(body.summary.coinsAtPeg).toBeGreaterThanOrEqual(1);
  });

  it("marks low-cap coins as depeg-event coverage limited", async () => {
    const asset = makeAsset({
      id: "cjpy-yamato",
      symbol: "CJPY",
      name: "Convertible JPY Token",
      pegType: "peggedJPY",
      price: 0.005,
      priceSource: "coingecko",
      priceConfidence: "single-source",
      priceUpdatedAt: nowSec,
      circulating: { peggedJPY: 500_000 },
    });
    const db = makePegSummaryDb([asset]);
    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      coins: Array<{
        id: string;
        currentDeviationBps: number | null;
        depegEventCoverageLimited?: boolean;
      }>;
    };
    const coin = body.coins.find((c) => c.id === "cjpy-yamato");
    expect(coin).toMatchObject({
      currentDeviationBps: null,
      depegEventCoverageLimited: true,
    });
  });
});
