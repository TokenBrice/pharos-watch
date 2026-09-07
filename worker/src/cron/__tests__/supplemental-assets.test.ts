import { afterEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import {
  computeExcludedBalanceAdjustedSupplyRaw,
  getSupplementalDefiLlamaContractPriceKey,
  resolveLowVolumeCoinGeckoPrice,
  resolveSupplementalContractPrice,
  resolveSupplementalPrice,
} from "../sync-stablecoins/supplemental-assets";
import { fetchGoldTokens } from "../sync-stablecoins/supplemental-assets/gold";
import { fetchSupplementalPriceData } from "../sync-stablecoins/supplemental-assets/shared";
import { fillMissingSupplyHistory } from "../sync-stablecoins/phase-helpers";
import { createMockD1Preset } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { CIRCUIT_SOURCE } from "../../lib/constants";

const mockD1 = createMockD1Preset([
  { match: "INSERT OR REPLACE INTO cache", rows: [] },
]);

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeMeta(contracts: StablecoinMeta["contracts"], id = "test-stablecoin"): StablecoinMeta {
  return {
    id,
    name: "Test Stablecoin",
    symbol: "TEST",
    detailProvider: "coingecko",
    contracts,
    flags: {
      pegCurrency: "USD",
      backing: "rwa-backed",
      governance: "centralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
  } as StablecoinMeta;
}

function makeCircuitRow(source: string, state: "closed" | "open" | "half-open", openedAt: number | null = null) {
  return {
    key: `circuit:${source}`,
    value: JSON.stringify({
      state,
      consecutiveFailures: state === "closed" ? 0 : 3,
      lastFailureAt: openedAt,
      lastSuccessAt: state === "closed" ? Math.floor(Date.now() / 1000) : null,
      openedAt,
    }),
    updated_at: Math.floor(Date.now() / 1000),
  };
}

describe("computeExcludedBalanceAdjustedSupplyRaw", () => {
  it("subtracts configured non-circulating balances before decimal conversion", () => {
    expect(computeExcludedBalanceAdjustedSupplyRaw(
      40_020_000n * 10n ** 18n,
      [
        19_686_793n * 10n ** 18n,
        19_780_590n * 10n ** 18n,
      ],
    )).toBe(552_617n * 10n ** 18n);
  });

  it("fails closed when excluded balances exhaust supply", () => {
    expect(computeExcludedBalanceAdjustedSupplyRaw(1_000n, [1_000n])).toBeNull();
    expect(computeExcludedBalanceAdjustedSupplyRaw(1_000n, [1_001n])).toBeNull();
  });
});

describe("resolveSupplementalPrice", () => {
  it("rejects stale supplemental CoinGecko rows with upstream timestamps", () => {
    const nowSec = Math.floor(Date.now() / 1000);

    expect(resolveSupplementalPrice(
      { coins: {} },
      {
        vcred: {
          usd: 1,
          usd_market_cap: 1_000_000,
          last_updated_at: nowSec - 60 * 60,
        },
      },
      "vcred",
    )).toBeNull();
  });

  it("rejects future-skewed supplemental upstream timestamps", () => {
    const nowSec = Math.floor(Date.now() / 1000);

    expect(resolveSupplementalPrice(
      { coins: { "coingecko:vcred": { price: 1, timestamp: nowSec + 60 * 60 } } },
      {},
      "vcred",
    )).toBeNull();

    expect(resolveSupplementalPrice(
      { coins: {} },
      {
        vcred: {
          usd: 1,
          usd_market_cap: 1_000_000,
          last_updated_at: nowSec + 60 * 60,
        },
      },
      "vcred",
    )).toBeNull();
  });

  it("preserves fresh supplemental CoinGecko upstream timestamps", () => {
    const nowSec = Math.floor(Date.now() / 1000);

    expect(resolveSupplementalPrice(
      { coins: {} },
      {
        vcred: {
          usd: 1,
          usd_market_cap: 1_000_000,
          last_updated_at: nowSec - 60,
        },
      },
      "vcred",
    )).toEqual({
      price: 1,
      source: "coingecko",
      observedAt: nowSec - 60,
      observedAtMode: "upstream",
    });
  });

  it("resolves a fresh DefiLlama exact-contract quote for no-gecko supplemental assets", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const meta = makeMeta([
      {
        chain: "ethereum",
        address: "0xBEEfFF209270748ddd194831b3fa287a5386f5bC",
        decimals: 18,
      },
    ], "bbqusdc-steakhouse");

    expect(getSupplementalDefiLlamaContractPriceKey(meta)).toBe(
      "ethereum:0xbeefff209270748ddd194831b3fa287a5386f5bc",
    );
    expect(resolveSupplementalContractPrice(
      {
        coins: {
          "ethereum:0xbeefff209270748ddd194831b3fa287a5386f5bc": {
            price: 1.114859,
            symbol: "TEST",
            timestamp: nowSec - 60,
            confidence: 0.99,
          },
        },
      },
      meta,
    )).toEqual({
      price: 1.114859,
      source: "defillama-contract",
      observedAt: nowSec - 60,
      observedAtMode: "upstream",
    });
  });

  it("rejects DefiLlama exact-contract quotes without matching symbol and confidence", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const meta = makeMeta([
      {
        chain: "ethereum",
        address: "0xBEEfFF209270748ddd194831b3fa287a5386f5bC",
        decimals: 18,
      },
    ], "bbqusdc-steakhouse");
    const key = "ethereum:0xbeefff209270748ddd194831b3fa287a5386f5bc";

    expect(resolveSupplementalContractPrice(
      { coins: { [key]: { price: 1.01, timestamp: nowSec - 60, symbol: "WRONG", confidence: 0.99 } } },
      meta,
    )).toBeNull();
    expect(resolveSupplementalContractPrice(
      { coins: { [key]: { price: 1.01, timestamp: nowSec - 60, symbol: "TEST", confidence: 0.79 } } },
      meta,
    )).toBeNull();
  });

  it("rejects unreasonable DefiLlama exact-contract quotes", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const meta = makeMeta([
      {
        chain: "ethereum",
        address: "0xBEEfFF209270748ddd194831b3fa287a5386f5bC",
        decimals: 18,
      },
    ], "bbqusdc-steakhouse");

    expect(resolveSupplementalContractPrice(
      {
        coins: {
          "ethereum:0xbeefff209270748ddd194831b3fa287a5386f5bc": {
            price: 12345.67,
            symbol: "TEST",
            timestamp: nowSec - 60,
            confidence: 0.99,
          },
        },
      },
      meta,
    )).toBeNull();
  });

  it("does not request exact-contract supplemental prices for assets with CoinGecko IDs", () => {
    const meta = {
      ...makeMeta([
        {
          chain: "ethereum",
          address: "0x0000000000000000000000000000000000000001",
          decimals: 18,
        },
      ]),
      geckoId: "test",
    } as StablecoinMeta;

    expect(getSupplementalDefiLlamaContractPriceKey(meta)).toBeNull();
    expect(resolveSupplementalContractPrice({ coins: {} }, meta)).toBeNull();
  });

  it("accepts low-volume CoinGecko rows inside the relaxed freshness window", () => {
    const nowSec = Math.floor(Date.now() / 1000);

    expect(resolveLowVolumeCoinGeckoPrice(
      {
        vcred: {
          usd: 0.42,
          usd_market_cap: 1_000_000,
          last_updated_at: nowSec - 6 * 24 * 60 * 60,
        },
      },
      "vcred",
    )).toEqual({
      price: 0.42,
      source: "coingecko-low-volume",
      observedAt: nowSec - 6 * 24 * 60 * 60,
      observedAtMode: "upstream",
    });
  });

  it("rejects low-volume CoinGecko rows outside the relaxed freshness window", () => {
    const nowSec = Math.floor(Date.now() / 1000);

    expect(resolveLowVolumeCoinGeckoPrice(
      {
        vcred: {
          usd: 0.42,
          usd_market_cap: 1_000_000,
          last_updated_at: nowSec - 8 * 24 * 60 * 60,
        },
      },
      "vcred",
    )).toBeNull();
  });

  it("rejects low-volume CoinGecko rows without upstream timestamps", () => {
    expect(resolveLowVolumeCoinGeckoPrice(
      {
        vcred: {
          usd: 0.42,
          usd_market_cap: 1_000_000,
        },
      },
      "vcred",
    )).toBeNull();
  });
});

describe("fetchSupplementalPriceData", () => {
  it("fails closed to an empty coin map on malformed DefiLlama price payloads", async () => {
    mockFetch([{ match: () => true, body: { coins: { "coingecko:test": { price: "1.00" } } } }]);
    const meta = { ...makeMeta([]), geckoId: "test" } as StablecoinMeta;

    await expect(fetchSupplementalPriceData([meta], "supplemental-test")).resolves.toEqual({ coins: {} });
  });

  it("skips supplemental DefiLlama price fetches while the DL coins circuit is open", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [makeCircuitRow(CIRCUIT_SOURCE.DL_COINS, "open", nowSec)],
      },
    ]);
    const fetchMock = mockFetch([], { requireMatch: true });
    const meta = { ...makeMeta([]), geckoId: "test" } as StablecoinMeta;

    await expect(fetchSupplementalPriceData([meta], "supplemental-test", undefined, db)).resolves.toEqual({ coins: {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows half-open supplemental DefiLlama price probes to recover the DL coins circuit", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [makeCircuitRow(CIRCUIT_SOURCE.DL_COINS, "open", nowSec - 31 * 60)],
      },
    ]);
    mockFetch([{ match: () => true, body: { coins: { "coingecko:test": { price: 1, timestamp: nowSec } } } }]);
    const meta = { ...makeMeta([]), geckoId: "test" } as StablecoinMeta;

    await expect(fetchSupplementalPriceData([meta], "supplemental-test", undefined, db)).resolves.toEqual({
      coins: { "coingecko:test": { price: 1, timestamp: nowSec } },
    });

    const circuitWrites = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === `circuit:${CIRCUIT_SOURCE.DL_COINS}`);
    expect(circuitWrites.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(String(circuitWrites[circuitWrites.length - 1]?.binds[1]))).toMatchObject({
      state: "closed",
      consecutiveFailures: 0,
    });
  });

  it("fetches supplemental DefiLlama prices by exact contract for no-gecko assets", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const fetchMock = mockFetch([{ match: () => true, body: {
        coins: {
          "ethereum:0xbeefff209270748ddd194831b3fa287a5386f5bc": {
            price: 1.114859,
            symbol: "TEST",
            timestamp: nowSec,
            confidence: 0.99,
          },
        },
      } }]);
    const meta = makeMeta([
      {
        chain: "ethereum",
        address: "0xBEEfFF209270748ddd194831b3fa287a5386f5bC",
        decimals: 18,
      },
    ], "bbqusdc-steakhouse");

    await expect(fetchSupplementalPriceData([meta], "supplemental-test")).resolves.toEqual({
      coins: {
        "ethereum:0xbeefff209270748ddd194831b3fa287a5386f5bc": {
          price: 1.114859,
          symbol: "TEST",
          timestamp: nowSec,
          confidence: 0.99,
        },
      },
    });

    const [requestedUrl] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestedUrl)).toContain(
      "/prices/current/ethereum:0xbeefff209270748ddd194831b3fa287a5386f5bc",
    );
  });

  it("records malformed supplemental DefiLlama price payloads as DL coins failures", async () => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [],
      },
    ]);
    mockFetch([{ match: () => true, body: { coins: { "coingecko:test": { price: "1.00" } } } }]);
    const meta = { ...makeMeta([]), geckoId: "test" } as StablecoinMeta;

    await expect(fetchSupplementalPriceData([meta], "supplemental-test", undefined, db)).resolves.toEqual({ coins: {} });

    const circuitWrite = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === `circuit:${CIRCUIT_SOURCE.DL_COINS}`);
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({
      state: "closed",
      consecutiveFailures: 1,
    });
  });
});

describe("fetchGoldTokens", () => {
  it("ignores protocol TVL history and defers XAUT comparisons to supply_history", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const mcap = 2_460_797_595;
    const protocolTvl = 2_890_974_295;
    const d1History = {
      day: 2_499_088_910,
      week: 2_496_955_497,
      month: 2_482_779_944,
    };
    const utcMidnight = (daysAgo: number) => {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - daysAgo);
      date.setUTCHours(0, 0, 0, 0);
      return Math.floor(date.getTime() / 1000);
    };
    mockFetch([
      {
        match: "/prices/current/",
        body: {
          coins: {
            "coingecko:tether-gold": {
              price: 4_020,
              timestamp: nowSec,
            },
          },
        },
      },
      {
        match: "/protocol/tether-gold",
        body: {
          mcap,
          tvl: [
            { date: nowSec - 30 * 86_400, totalLiquidityUSD: protocolTvl },
            { date: nowSec - 7 * 86_400, totalLiquidityUSD: protocolTvl },
            { date: nowSec - 86_400, totalLiquidityUSD: protocolTvl },
          ],
        },
      },
      { match: "/protocol/", body: {} },
    ], { requireMatch: true });

    const assets = await fetchGoldTokens({
      "tether-gold": {
        usd: 4_020,
        usd_market_cap: mcap,
        last_updated_at: nowSec,
      },
    });
    const xaut = assets.find((asset) => asset.id === "xaut-tether");

    expect(xaut).toMatchObject({
      supplySource: "defillama",
      circulating: { peggedGOLD: mcap },
      circulatingPrevDay: null,
      circulatingPrevWeek: null,
      circulatingPrevMonth: null,
    });

    const db = mockD1([
      {
        match: "SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history",
        rows: [
          { stablecoin_id: "xaut-tether", snapshot_date: utcMidnight(1), circulating_usd: d1History.day },
          { stablecoin_id: "xaut-tether", snapshot_date: utcMidnight(7), circulating_usd: d1History.week },
          { stablecoin_id: "xaut-tether", snapshot_date: utcMidnight(30), circulating_usd: d1History.month },
        ],
      },
    ]);

    await expect(fillMissingSupplyHistory(db, assets)).resolves.toBe(3);
    expect(xaut).toMatchObject({
      circulatingPrevDay: { peggedGOLD: d1History.day },
      circulatingPrevWeek: { peggedGOLD: d1History.week },
      circulatingPrevMonth: { peggedGOLD: d1History.month },
    });
  });

  it("skips DefiLlama protocol fanout while the DL protocols circuit is open", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [
          makeCircuitRow(CIRCUIT_SOURCE.DL_COINS, "closed"),
          makeCircuitRow(CIRCUIT_SOURCE.DL_PROTOCOLS, "open", nowSec),
        ],
      },
    ]);
    const fetchMock = mockFetch([{ match: "/prices/current/", body: { coins: {} } }], { requireMatch: true });

    await expect(fetchGoldTokens({}, undefined, db)).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("/protocol/"))).toBe(true);
  });
});
