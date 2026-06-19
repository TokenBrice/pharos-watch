import { afterEach, describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import {
  computeExcludedBalanceAdjustedSupplyRaw,
  resolveLowVolumeCoinGeckoPrice,
  resolveSupplementalPrice,
  selectSingleOnChainSupplyContract,
  selectSupplementalOnChainSupplyContract,
} from "../sync-stablecoins/supplemental-assets";
import { fetchGoldTokens } from "../sync-stablecoins/supplemental-assets/gold";
import { fetchSupplementalPriceData } from "../sync-stablecoins/supplemental-assets/shared";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { CIRCUIT_SOURCE } from "../../lib/constants";

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

describe("selectSingleOnChainSupplyContract", () => {
  it("returns one supported EVM contract", () => {
    const contract = { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 6 };

    expect(selectSingleOnChainSupplyContract(makeMeta([contract]))).toBe(contract);
  });

  it("returns one supported Solana contract", () => {
    const contract = { chain: "solana", address: "So11111111111111111111111111111111111111112", decimals: 6 };

    expect(selectSingleOnChainSupplyContract(makeMeta([contract]))).toBe(contract);
  });

  it("ignores unsupported standalone contracts", () => {
    expect(selectSingleOnChainSupplyContract(makeMeta([
      { chain: "stellar", address: "TEST.STELLAR", decimals: 7 },
      { chain: "tron", address: "TEST.TRON", decimals: 6 },
    ]))).toBeNull();
  });

  it("rejects multiple supported contracts to avoid publishing partial global supply", () => {
    expect(selectSingleOnChainSupplyContract(makeMeta([
      { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 6 },
      { chain: "bsc", address: "0x0000000000000000000000000000000000000002", decimals: 6 },
    ]))).toBeNull();
  });

  it("rejects mixed supported and unsupported contracts to avoid partial global supply", () => {
    expect(selectSingleOnChainSupplyContract(makeMeta([
      { chain: "tron", address: "TEST.TRON", decimals: 6 },
      { chain: "ethereum", address: "0x0000000000000000000000000000000000000001", decimals: 6 },
    ]))).toBeNull();
  });

  it("allows curated multi-chain supplemental assets to use a configured supply chain", () => {
    const ethereumContract = { chain: "ethereum", address: "0x28b3a8fb53b741a8fd78c0fb9a6b2393d896a43d", decimals: 6 };
    const avalancheContract = { chain: "avalanche", address: "0x28b3a8fb53b741a8fd78c0fb9a6b2393d896a43d", decimals: 6 };

    expect(selectSingleOnChainSupplyContract(makeMeta([
      ethereumContract,
      avalancheContract,
    ], "susdc-spark"))).toBeNull();
    expect(selectSupplementalOnChainSupplyContract(makeMeta([
      ethereumContract,
      avalancheContract,
    ], "susdc-spark"))).toBe(ethereumContract);
  });
});

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
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ coins: { "coingecko:test": { price: "1.00" } } }), { status: 200 })
    ));
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
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
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
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ coins: { "coingecko:test": { price: 1, timestamp: nowSec } } }), { status: 200 })
    ));
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

  it("records malformed supplemental DefiLlama price payloads as DL coins failures", async () => {
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        rows: [],
      },
    ]);
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ coins: { "coingecko:test": { price: "1.00" } } }), { status: 200 })
    ));
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
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/protocol/")) {
        throw new Error(`unexpected protocol fetch: ${url}`);
      }
      return new Response(JSON.stringify({ coins: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGoldTokens({}, undefined, db)).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("/protocol/"))).toBe(true);
  });
});
