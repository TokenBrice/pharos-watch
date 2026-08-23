import { readJsonResponse } from "./api-request-response.test-support";
import { describe, it, expect, vi } from "vitest";
import { PEG_CURRENCY_VALUES, type PegCurrency } from "@shared/types/core";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { __pegSummaryTestHooks, handlePegSummary } from "../peg-summary";

const nowSec = Math.floor(Date.now() / 1000);

function makePegSummaryDb(
  assets: ReturnType<typeof makeAsset>[] = [],
  fxFallbackRates?: Record<string, number>,
  depegRows: ReturnType<typeof makeDepegEventRow>[] = [],
) {
  const cacheValue = JSON.stringify({ peggedAssets: assets, ...(fxFallbackRates ? { fxFallbackRates } : {}) });
  return mockD1([
    {
      match: "cache",
      rows: [{ key: "stablecoins", value: cacheValue, updated_at: nowSec }],
      first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
    },
    { match: "depeg_events", rows: depegRows },
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

function makeDepegEventRow(overrides: Partial<{
  id: number;
  stablecoin_id: string;
  symbol: string;
  peg_type: string;
  direction: "above" | "below";
  peak_deviation_bps: number;
  started_at: number;
  ended_at: number | null;
  start_price: number;
  peak_price: number | null;
  recovery_price: number | null;
  peg_reference: number;
  source: "live" | "backfill";
  confirmation_sources: string | null;
  pending_reason: string | null;
}> = {}) {
  return {
    id: 1,
    stablecoin_id: "usdt-tether",
    symbol: "USDT",
    peg_type: "peggedUSD",
    direction: "below" as const,
    peak_deviation_bps: 120,
    started_at: nowSec,
    ended_at: null,
    start_price: 0.99,
    peak_price: 0.988,
    recovery_price: null,
    peg_reference: 1,
    source: "live" as const,
    confirmation_sources: null,
    pending_reason: null,
    ...overrides,
  };
}

describe("handlePegSummary", () => {
  it("uses the exhaustive canonical currency-to-peg-type vocabulary", () => {
    const expected: Record<PegCurrency, string | undefined> = {
      USD: "peggedUSD",
      EUR: "peggedEUR",
      GBP: "peggedGBP",
      CHF: "peggedCHF",
      BRL: "peggedREAL",
      RUB: "peggedRUB",
      JPY: "peggedJPY",
      KRW: "peggedKRW",
      IDR: "peggedIDR",
      INR: "peggedINR",
      MYR: "peggedMYR",
      SGD: "peggedSGD",
      HKD: "peggedHKD",
      TRY: "peggedTRY",
      AUD: "peggedAUD",
      ZAR: "peggedZAR",
      CAD: "peggedCAD",
      CNY: "peggedCNY",
      CNH: "peggedCNH",
      PHP: "peggedPHP",
      MXN: "peggedMXN",
      VND: "peggedVND",
      UAH: "peggedUAH",
      ARS: "peggedARS",
      KGS: "peggedKGS",
      NGN: "peggedNGN",
      XOF: "peggedXOF",
      COP: "peggedCOP",
      CLP: "peggedCLP",
      GHS: "peggedGHS",
      KES: "peggedKES",
      PEN: "peggedPEN",
      GOLD: "peggedGOLD",
      SILVER: "peggedSILVER",
      VAR: undefined,
      OTHER: undefined,
    };

    expect(Object.fromEntries(
      PEG_CURRENCY_VALUES.map((currency) => [
        currency,
        __pegSummaryTestHooks.normalizePegTypeFromCurrency(currency),
      ]),
    )).toEqual(expected);
  });

  it("returns 503 when stablecoins cache is missing", async () => {
    const db = mockD1([
      { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: [], first: null },
    ]);
    const res = await handlePegSummary(db);
    expect(res.status).toBe(503);
  });

  it("returns 503 when stablecoins cache payload is corrupt", async () => {
    const db = mockD1([
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: JSON.stringify({ nope: true }), updated_at: nowSec }],
        first: { key: "stablecoins", value: JSON.stringify({ nope: true }), updated_at: nowSec },
      },
    ]);

    const res = await handlePegSummary(db);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: "Cached stablecoins data is corrupt",
    });
  });

  it("derives DEX deviation from primary deviation when no peg reference is usable", () => {
    expect(__pegSummaryTestHooks.deriveDexDeviationBps(
      1.02,
      null,
      {},
      undefined,
      -100,
      200,
    )).toBe(98);
    expect(__pegSummaryTestHooks.deriveDexDeviationBps(
      1.02,
      null,
      {},
      undefined,
      null,
      200,
    )).toBeNull();
  });

  it("returns 200 with coins and summary", async () => {
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const db = makePegSummaryDb([asset]);
    const res = await handlePegSummary(db);
    const body = (await readJsonResponse(res, 200)) as {
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

  it("falls back to empty DEX prices when the optional DEX table query fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
      const cacheValue = JSON.stringify({ peggedAssets: [asset] });
      const db = mockD1([
        {
          match: "cache",
          rows: [{ key: "stablecoins", value: cacheValue, updated_at: nowSec }],
          first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
        },
        { match: "depeg_events", rows: [] },
        { match: "dex_prices", rows: [], throwError: new Error("no such table: dex_prices") },
        { match: "supply_history", rows: [] },
      ]);

      const res = await handlePegSummary(db);
      const body = (await readJsonResponse(res, 200)) as {
        coins: Array<{ id: string; dexPriceCheck?: { agrees: boolean } | null }>;
      };
      expect(body.coins.find((c) => c.id === "usdt-tether")?.dexPriceCheck).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[peg-summary] DEX price query failed, falling back to empty:"),
      );
    } finally {
      warnSpy.mockRestore();
    }
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
    const body = (await readJsonResponse(res, 200)) as {
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

  it("includes navToken coins with peg signals withheld", async () => {
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
    const data = (await res.json()) as {
      coins: Array<{
        id: string;
        currentDeviationBps: number | null;
        pegScore: number | null;
        pegPct: number;
        severityScore: number;
        spreadPenalty: number;
        activeDepeg: boolean;
        eventCount: number;
        worstDeviationBps: number | null;
        lastEventAt: number | null;
        trackingSpanDays: number;
      }>;
    };
    const fpi = data.coins.find((c) => c.id === "fpi-frax");
    expect(fpi).toMatchObject({
      currentDeviationBps: null,
      pegScore: null,
      pegPct: 100,
      severityScore: 100,
      spreadPenalty: 0,
      activeDepeg: false,
      eventCount: 0,
      worstDeviationBps: null,
      lastEventAt: null,
      trackingSpanDays: 0,
    });
  });

  it("excludes navToken depeg rows from summary event counters", async () => {
    const db = makePegSummaryDb(
      [
        makeAsset({ id: "usdt-tether", symbol: "USDT" }),
        makeAsset({
          id: "fpi-frax",
          name: "Frax Price Index",
          symbol: "FPI",
          pegType: "peggedVAR",
          price: 1.12,
        }),
      ],
      undefined,
      [
        makeDepegEventRow({
          stablecoin_id: "fpi-frax",
          symbol: "FPI",
          peg_type: "peggedVAR",
          direction: "above",
          peak_deviation_bps: 1200,
          started_at: nowSec,
          source: "live",
        }),
      ],
    );

    const res = await handlePegSummary(db);
    const data = (await res.json()) as {
      summary: { activeDepegCount: number; depegEventsToday: number; depegEventsYesterday: number };
    };

    expect(data.summary).toMatchObject({
      activeDepegCount: 0,
      depegEventsToday: 0,
      depegEventsYesterday: 0,
    });
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
    // v6.08: a lone non-USD coin needs a live FX fallback for an
    // authoritative reference; without one, deviation is withheld and the
    // coin cannot count as at peg off its own self-referential median.
    const db = makePegSummaryDb([asset], { peggedEUR: 1.07 });
    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      summary: {
        coinsAtPeg: number;
        totalTracked: number;
      };
    };
    expect(body.summary.coinsAtPeg).toBeGreaterThanOrEqual(1);
  });

  it("withholds deviation for a thin non-USD peer group without an FX fallback", async () => {
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
    const cacheValue = JSON.stringify({ peggedAssets: [asset] });
    const db = mockD1([
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: cacheValue, updated_at: nowSec }],
        first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
      },
      { match: "depeg_events", rows: [] },
      {
        // A trusted DEX row must not leak a cross-check against the same
        // untrusted self-referential median the gate just withheld.
        match: "dex_prices",
        rows: [
          {
            stablecoin_id: "eurc-circle",
            dex_price_usd: 1.065,
            deviation_from_primary_bps: 0,
            source_pool_count: 4,
            source_total_tvl: 10_000_000,
            updated_at: nowSec - 60,
          },
        ],
      },
      { match: "supply_history", rows: [] },
    ]);
    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      coins: Array<{
        id: string;
        currentDeviationBps: number | null;
        pegReferenceUnavailable?: boolean;
        dexPriceCheck?: { agrees: boolean } | null;
      }>;
      summary: { coinsAtPeg: number };
    };
    const coin = body.coins.find((entry) => entry.id === "eurc-circle");
    expect(coin?.currentDeviationBps).toBeNull();
    expect(coin?.pegReferenceUnavailable).toBe(true);
    expect(coin?.dexPriceCheck).toBeUndefined();
    expect(body.summary.coinsAtPeg).toBe(0);
  });

  it("counts depeg events that started today and yesterday", async () => {
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const cacheValue = JSON.stringify({ peggedAssets: [asset] });
    const todayStart = Math.floor(nowSec / 86_400) * 86_400;
    const db = mockD1([
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: cacheValue, updated_at: nowSec }],
        first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
      },
      {
        match: "depeg_events",
        rows: [
          makeDepegEventRow({ id: 1, started_at: Math.max(todayStart, nowSec - 60) }),
          makeDepegEventRow({ id: 2, started_at: todayStart - 60 }),
          makeDepegEventRow({ id: 3, started_at: todayStart - 86_460 }),
        ],
      },
      { match: "dex_prices", rows: [] },
      { match: "supply_history", rows: [] },
    ]);

    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      summary: {
        depegEventsToday: number;
        depegEventsYesterday: number;
      };
    };
    expect(body.summary.depegEventsToday).toBe(1);
    expect(body.summary.depegEventsYesterday).toBe(1);
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

  it("serves peg data and event counters from the peg-analytics cache when fresh", async () => {
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const stablecoinsValue = JSON.stringify({ peggedAssets: [asset] });
    const pegAnalyticsValue = JSON.stringify({
      computedAtSec: nowSec - 1200,
      depegEventsToday: 2,
      depegEventsYesterday: 5,
      pegData: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          pegType: "peggedUSD",
          pegCurrency: "USD",
          governance: "centralized",
          currentDeviationBps: 12,
          pegScore: 99,
          pegPct: 99.9,
          severityScore: 0,
          spreadPenalty: 0,
          eventCount: 1,
          worstDeviationBps: -120,
          activeDepeg: false,
          lastEventAt: null,
          trackingSpanDays: 400,
          methodologyVersion: "6.08",
        },
      ],
    });
    const db = mockD1([
      {
        match: "cache",
        matchBinds: ["stablecoins"],
        rows: [{ key: "stablecoins", value: stablecoinsValue, updated_at: nowSec }],
        first: { key: "stablecoins", value: stablecoinsValue, updated_at: nowSec },
      },
      {
        match: "cache",
        matchBinds: ["peg-analytics"],
        rows: [{ key: "peg-analytics", value: pegAnalyticsValue, updated_at: nowSec }],
        first: { key: "peg-analytics", value: pegAnalyticsValue, updated_at: nowSec },
      },
      { match: "depeg_events", rows: [] },
      { match: "dex_prices", rows: [] },
      { match: "supply_history", rows: [] },
    ]);

    const res = await handlePegSummary(db);
    const body = (await res.json()) as {
      coins: Array<{ id: string; pegScore: number | null; currentDeviationBps: number | null }>;
      summary: { depegEventsToday: number; depegEventsYesterday: number };
      methodology: { asOf: number };
    };

    // Counters can only come from the cache (the fallback compute path would
    // count zero events from the empty depeg_events table).
    expect(body.summary.depegEventsToday).toBe(2);
    expect(body.summary.depegEventsYesterday).toBe(5);
    const usdt = body.coins.find((coin) => coin.id === "usdt-tether");
    expect(usdt?.pegScore).toBe(99);
    // Freshness keys to the older snapshot compute time, not the newer live
    // stablecoins cache the deviations no longer reflect.
    expect(body.methodology.asOf).toBe(nowSec - 1200);
    expect(Number(res.headers.get("X-Data-Age"))).toBeGreaterThanOrEqual(1200);
  });

  it("falls back to direct compute when the peg-analytics cache read throws", async () => {
    const asset = makeAsset({ id: "usdt-tether", symbol: "USDT" });
    const stablecoinsValue = JSON.stringify({ peggedAssets: [asset] });
    const db = mockD1([
      {
        match: "cache",
        matchBinds: ["stablecoins"],
        rows: [{ key: "stablecoins", value: stablecoinsValue, updated_at: nowSec }],
        first: { key: "stablecoins", value: stablecoinsValue, updated_at: nowSec },
      },
      {
        match: "cache",
        matchBinds: ["peg-analytics"],
        rows: [],
        // Non-retriable message: an overload-style error would run getCache's
        // real 3-attempt backoff (~1s of sleeps) before falling back.
        throwError: new Error("cache read failed"),
      },
      { match: "FROM cache WHERE key = ?", rows: [], first: null },
      { match: "INSERT OR REPLACE INTO cache", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_prices", rows: [] },
      { match: "supply_history", rows: [] },
    ]);

    const res = await handlePegSummary(db);
    const body = (await readJsonResponse(res, 200)) as { coins: Array<{ id: string }> };
    expect(body.coins.some((coin) => coin.id === "usdt-tether")).toBe(true);
  });
});
