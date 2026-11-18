import { afterEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import {
  computeExcludedBalanceAdjustedSupplyRaw,
  getSupplementalDefiLlamaContractPriceKey,
  resolveLowVolumeCoinGeckoPrice,
  resolveSupplementalContractPrice,
  resolveSupplementalPrice,
} from "../sync-stablecoins/supplemental-assets";
import { fetchGoldTokens } from "../sync-stablecoins/supplemental-assets/gold";
import { fetchSilverTokens } from "../sync-stablecoins/supplemental-assets/silver";
import { resolveSupplementalCoinGeckoMcap, fetchSupplementalPriceData } from "../sync-stablecoins/supplemental-assets/shared";
import { fillMissingSupplyHistory } from "../sync-stablecoins/phase-helpers";
import { createMockD1Preset } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { buildChainRpcs } from "../../lib/chain-registry";
import * as evmRpc from "../../lib/evm-rpc";
import * as supplyPerimeter from "@shared/lib/supply-perimeter-changes";
import { DECIMALS_SELECTOR, TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";

const mockD1 = createMockD1Preset([
  { match: "INSERT INTO cache", rows: [] },
  { match: "FROM cache WHERE key = ?", matchBinds: ["snapshot-supply:last-write"], rows: [], first: null, allowUnused: true },
]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

  it("rejects the known replacement-mint alias before legacy supply valuation", () => {
    const address = "Ex5DaKYMCN6QWFA4n67TmMwsH8MJV68RX6YXTmVM532C";
    const meta = { ...makeMeta([{ chain: "solana", address, decimals: 9 }], "usdv-solomon"), symbol: "USDV" };
    expect(getSupplementalDefiLlamaContractPriceKey(meta)).toBeNull();
    expect(resolveSupplementalContractPrice({ coins: {
      [`solana:${address}`]: { price: 0.8, symbol: "USDV", confidence: 1, timestamp: Math.floor(Date.now() / 1000) },
    } }, meta)).toBeNull();
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
      .filter((entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === `circuit:${CIRCUIT_SOURCE.DL_COINS}`);
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
      .find((entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === `circuit:${CIRCUIT_SOURCE.DL_COINS}`);
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({
      state: "closed",
      consecutiveFailures: 1,
    });
  });

  it.each([
    ["a non-OK response", 404, {}],
    ["an unparseable body", 200, "{"],
  ])("records %s from supplemental DefiLlama prices as a DL coins failure", async (_case, status, body) => {
    const db = mockD1([{ match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [] }]);
    mockFetch([{ match: () => true, status, body }]);
    const meta = { ...makeMeta([]), geckoId: "test" } as StablecoinMeta;

    await expect(fetchSupplementalPriceData([meta], "supplemental-test", undefined, db)).resolves.toEqual({ coins: {} });

    const circuitWrite = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === `circuit:${CIRCUIT_SOURCE.DL_COINS}`);
    expect(JSON.parse(String(circuitWrite?.binds[1]))).toMatchObject({ consecutiveFailures: 1 });
  });
});

describe("fetchGoldTokens", () => {
  it.each([
    { reconciles: true, price: 4_020, scoped: true },
    { reconciles: false, price: 4_020, scoped: false },
    { reconciles: true, price: 9_999, scoped: false },
    { reconciles: true, price: 100_000, scoped: false },
  ])("admits clocked XAUT liability only with scope and price evidence ($reconciles, $price)", async ({ reconciles, price, scoped }) => {
    const now = Math.floor(Date.now() / 1000);
    const hash = `0x${"1".repeat(64)}` as const;
    const header = vi.spyOn(evmRpc, "fetchEvmBlockHeader").mockResolvedValue({ number: 50, hash, timestamp: now - 300 });
    const supply = vi.spyOn(evmRpc, "fetchEvmUint256AtBlock").mockImplementation(async (_chain, _address, call) =>
      call === DECIMALS_SELECTOR ? 6n : (call === TOTAL_SUPPLY_SELECTOR ? 110n : reconciles ? 10n : 11n) * 1_000_000n);
    mockFetch([
      { match: "/prices/current/", body: { coins: { "coingecko:tether-gold": { price, timestamp: now - 60 } } } },
      { match: "/protocol/", body: {} },
      { match: "app.tether.to/transparency.json", body: { data_formatted: [{ iso: "xaut", id: now - 900,
        blockChains: [{ name: "Ethereum", totalAuthorized: "110", notIssued: "10", quarantined: "0" }] }] } },
    ], { requireMatch: true });
    try {
      const capClock = now - 90;
      const asset = (await fetchGoldTokens({ "tether-gold": { usd_market_cap: 500_000, last_updated_at: capClock } },
        undefined, undefined, buildChainRpcs(), undefined,
        { validationReferences: { rates: { peggedGOLD: 4_020 }, type: "fresh", updatedAt: now - 60 } },
      )).find(({ id }) => id === "xaut-tether");
      expect(asset).toMatchObject(scoped ? { circulating: { peggedGOLD: 402_000 }, circulatingNative: 100,
        valuationPriceUsd: 4_020, valuationObservedAtSec: now - 60, supplyObservedAt: now - 300 }
        : { circulating: { peggedGOLD: 500_000 }, supplyObservedAt: capClock, circulatingNative: null });
      if (price === 4_020) expect(header.mock.calls.map(([, block]) => block)).toContain("finalized");
      expect(supply.mock.calls.filter(([chain, _address, _call, block, opts]) =>
        chain === "ethereum" && block === 50 && opts?.stateBlockHash === hash)).toHaveLength(price === 4_020 ? 3 : 0);
    } finally {
      header.mockRestore();
      supply.mockRestore();
    }
  });

  it("checks the pre-cutover KAG cap against program stock without publishing wrapper quantity", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockFetch([
      { match: "/prices/current/", body: { coins: { "coingecko:kinesis-silver": { price: 30, timestamp: now } } } },
      { match: "/coins/markets?", body: [{ id: "kinesis-silver", circulating_supply: 100, last_updated: new Date(now * 1000).toISOString() }] },
    ], { requireMatch: true });
    const assets = await fetchSilverTokens({ "kinesis-silver": { usd: 30, usd_market_cap: 1000, last_updated_at: now } });
    expect(assets.find(({ id }) => id === "kag-kinesis")).toMatchObject({
      circulating: { peggedSILVER: 3000 }, circulatingNative: null, supplySource: "coingecko-fallback",
    });
  });

  it.each([
    ["kau-kinesis", "kinesis-gold", fetchGoldTokens],
    ["kag-kinesis", "kinesis-silver", fetchSilverTokens],
  ] as const)("holds %s when valuation is outside its commodity price band", async (id, geckoId, fetchTokens) => {
    const now = Math.floor(Date.now() / 1000);
    mockFetch([
      { match: "/prices/current/", body: { coins: { [`coingecko:${geckoId}`]: { price: 8_000, timestamp: now } } } },
      { match: "/protocol/", body: {} },
      { match: "/coins/markets?", body: [] },
    ], { requireMatch: true });
    const rpc = vi.spyOn(evmRpc, "fetchEvmUint256AtBlock").mockResolvedValue(100n * 10n ** 18n);
    const cutover = vi.spyOn(supplyPerimeter, "isKinesisWrapperSupplyCutoverActive")
      .mockImplementation((assetId) => assetId === id);
    try {
      const cg = { [geckoId]: { usd_market_cap: 500_000, last_updated_at: now } };
      const chainRpcs = buildChainRpcs();
      const assets = fetchTokens === fetchGoldTokens
        ? await fetchGoldTokens(cg, undefined, undefined, chainRpcs)
        : await fetchSilverTokens(cg, undefined, null, undefined, chainRpcs);
      expect(assets.find((asset) => asset.id === id)).toMatchObject({ circulating: {}, supplySource: "onchain-supply-withheld" });
      expect(rpc).not.toHaveBeenCalled();
    } finally {
      rpc.mockRestore();
      cutover.mockRestore();
    }
  });

  it("keeps XAUT comparisons unavailable when the protocol cap has no paired quantity or clock", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const mcap = 2_460_797_595;
    const protocolTvl = 2_890_974_295;
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
        match: "FROM supply_history",
        rows: [{ stablecoin_id: "xaut-tether", snapshot_date: utcMidnight(7), circulating_usd: 2_496_955_497 }],
      },
    ]);

    await expect(fillMissingSupplyHistory(db, assets)).resolves.toBe(0);
    expect(xaut).toMatchObject({
      circulatingNative: null,
      circulatingPrevDay: null,
      circulatingPrevWeek: null,
      circulatingPrevMonth: null,
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

  it("fills empty historical buckets from exact daily observations without replacing observed zero", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 13, 12), toFake: ["Date"] });
    const snapshotDate = (daysAgo: number) => Date.UTC(2026, 10, 13 - daysAgo) / 1000;
    const db = mockD1([{
      match: "FROM supply_history",
      rows: ["empty", "observed-zero", "gho-aave", "out-of-bound"].flatMap((stablecoin_id) =>
        [1, 7, 30].map((days, i) => ({
          stablecoin_id, snapshot_date: snapshotDate(days), circulating_usd: 1.1 * (99 - i),
          circulating_native: stablecoin_id === "out-of-bound" ? 50 : 99 - i,
          supply_provenance: JSON.stringify({ supplySource: "defillama", supplyObservedAt: snapshotDate(days) + 12 * 3600, supplyChainGuard: null }),
        }))),
    }]);
    const assets = ["empty", "observed-zero", "out-of-bound", "no-history", "gho-aave"].map((id) => ({
      id,
      name: id,
      symbol: id,
      circulating: { peggedUSD: 100 },
      supplyObservedAt: snapshotDate(0) + 12 * 3600,
      circulatingNative: 100,
      valuationPriceUsd: 1,
      circulatingPrevDay: id === "observed-zero" ? { peggedUSD: 0 } : {},
      circulatingPrevWeek: id === "observed-zero" ? { peggedUSD: 0 } : {},
      circulatingPrevMonth: id === "observed-zero" ? { peggedUSD: 0 } : {},
    })) as Parameters<typeof fillMissingSupplyHistory>[1];

    await expect(fillMissingSupplyHistory(db, assets)).resolves.toBe(3);
    expect(assets[0]).toMatchObject({
      circulatingPrevDay: { peggedUSD: 99 },
      circulatingPrevWeek: { peggedUSD: 98 },
      circulatingPrevMonth: { peggedUSD: 97 },
    });
    expect(assets[1]).toMatchObject({
      circulatingPrevDay: { peggedUSD: 0 },
      circulatingPrevWeek: { peggedUSD: 0 },
      circulatingPrevMonth: { peggedUSD: 0 },
    });
    expect(assets[2].circulatingPrevWeek).toEqual({});
    expect(assets[3].circulatingPrevWeek).toEqual({});
    expect([assets[4].circulatingPrevDay, assets[4].circulatingPrevWeek, assets[4].circulatingPrevMonth]).toEqual([{}, {}, {}]);
  });

  it("does not mis-attribute total history to a multi-bucket asset", async () => {
    const now = new Date();
    const snapshotDate = (daysAgo: number) => {
      const date = new Date(now);
      date.setUTCDate(date.getUTCDate() - daysAgo);
      date.setUTCHours(0, 0, 0, 0);
      return Math.floor(date.getTime() / 1000);
    };
    const db = mockD1([{
      match: "FROM supply_history",
      rows: [{ stablecoin_id: "multi", snapshot_date: snapshotDate(1), circulating_usd: 100, circulating_native: 100,
        supply_provenance: JSON.stringify({ supplySource: "defillama", supplyObservedAt: Math.floor(now.getTime() / 1000) - 86_400, supplyChainGuard: null }) }],
    }]);
    const asset = {
      id: "multi",
      name: "Multi-bucket fixture",
      symbol: "MULTI",
      circulating: { peggedUSD: 60, peggedEUR: 40 },
      supplyObservedAt: Math.floor(now.getTime() / 1000),
      circulatingNative: 100,
      valuationPriceUsd: 1,
      circulatingPrevDay: null,
    } as Parameters<typeof fillMissingSupplyHistory>[1][number];

    await expect(fillMissingSupplyHistory(db, [asset])).resolves.toBe(0);
    expect(asset.circulatingPrevDay).toBeNull();
  });
});


it.each([undefined, 0, Number.NaN, 1_800_000_000 - 9 * 86400, 1_800_000_000 + 601])(
  "rejects commodity market cap with missing, invalid, stale or future timestamp %s", (last_updated_at) => {
    // Keep the future boundary fixed while other tests wait to execute.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000 * 1000);
    try {
      expect(resolveSupplementalCoinGeckoMcap({ gold: { usd_market_cap: 10_000_000, last_updated_at } }, "gold")).toBeNull();
    } finally {
      clock.mockRestore();
    }
  },
);

it("accepts current market cap even when the independent spot-price field is missing", () => {
  expect(resolveSupplementalCoinGeckoMcap({ gold: { usd_market_cap: 10_000_000, last_updated_at: Math.floor(Date.now() / 1000) } }, "gold")).toBe(10_000_000);
});
