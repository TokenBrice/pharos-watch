import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { adaptFx } from "../fx";
import { runAdapter, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const FX_API_ENDPOINT = "https://fx.example/tvl";
const API_PRICE_ENDPOINT =
  "https://coins.llama.fi/prices/current/ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599,ethereum:0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0";
const ONCHAIN_PRICE_ENDPOINT =
  "https://coins.llama.fi/prices/current/ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599,ethereum:0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
const WSTETH_POOL = "0x6Ecfa38FeE8a5277B91eFdA204c235814F0122E8";
const WBTC_POOL = "0xAB709e26Fa6B0A30c119D8c55B887DeD24952473";
const WSTETH_POOL_LOWER = WSTETH_POOL.toLowerCase();
const WBTC_POOL_LOWER = WBTC_POOL.toLowerCase();
const COLLATERAL_SELECTOR = "0xee65a03c";
const DEBT_SELECTOR = "0xf9d45fd2";
const fxCoin = TRACKED_META_BY_ID.get("fxusd-f-x-protocol")!;
const apiConfig = {
  ...fxCoin.liveReservesConfig!,
  inputs: { primary: { kind: "http-json" as const, url: FX_API_ENDPOINT } },
};

function apiPayload(extra: Record<string, { collateralBalance: string }> = {}) {
  return {
    data: {
      poolInfo: {
        wstETH: { collateralBalance: "2000000000000000000" },
        wbtc: { collateralBalance: "100000000" },
        ...extra,
      },
    },
  };
}

function apiPrices(nowSec: number, includeWbtc = true) {
  return {
    coins: {
      "ethereum:0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": {
        price: 4_000,
        timestamp: nowSec,
        confidence: 1,
      },
      ...(includeWbtc
        ? {
            "ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": {
              price: 100_000,
              timestamp: nowSec,
              confidence: 1,
            },
          }
        : {}),
    },
  };
}

function onchainPrices(nowSec: number, stEthPrice = 2485.83, wbtcPrice = 78966.15) {
  return {
    coins: {
      "ethereum:0xae7ab96520de3a18e5e111b5eaab095312d7fe84": {
        price: stEthPrice,
        timestamp: nowSec,
        confidence: 1,
      },
      "ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": {
        price: wbtcPrice,
        timestamp: nowSec,
        confidence: 1,
      },
    },
  };
}

function onchainNetwork(options: {
  wstEthRaw?: bigint;
  wstEthDebt?: bigint;
  wbtcRaw?: bigint;
  wbtcDebt?: bigint;
  stEthPrice?: number;
  wbtcPrice?: number;
  missing?: { pool: string; selector: string };
} = {}): AdapterNetworkSpec {
  const rpc: Record<string, bigint | null> = {
    [`ethereum:eth_call:${WSTETH_POOL_LOWER}:${COLLATERAL_SELECTOR}`]: options.wstEthRaw ?? 2n * 10n ** 18n,
    [`ethereum:eth_call:${WSTETH_POOL_LOWER}:${DEBT_SELECTOR}`]: options.wstEthDebt ?? 1n * 10n ** 18n,
    [`ethereum:eth_call:${WBTC_POOL_LOWER}:${COLLATERAL_SELECTOR}`]: options.wbtcRaw ?? 1n * 10n ** 18n,
    [`ethereum:eth_call:${WBTC_POOL_LOWER}:${DEBT_SELECTOR}`]: options.wbtcDebt ?? 1n * 10n ** 18n,
  };
  if (options.missing) {
    rpc[`ethereum:eth_call:${options.missing.pool.toLowerCase()}:${options.missing.selector}`] = null;
  }
  return {
    rpc,
    json: {
      [ONCHAIN_PRICE_ENDPOINT]: onchainPrices(1_757_000_000, options.stEthPrice, options.wbtcPrice),
    },
  };
}

describe("adaptFx", () => {
  it("fails closed at the HTTP consumer for unknown positive collateral", async () => {
    await expect(runAdapter("fx", fxCoin, {
      config: apiConfig,
      network: {
        json: {
          [FX_API_ENDPOINT]: apiPayload({ unexpectedAsset: { collateralBalance: "1" } }),
        },
      },
      nowSec: 1_800_000_000,
      validate: false,
    })).rejects.toThrow("unmapped positive collateral keys with unquantified exposure: unexpectedAsset");
  });

  it("rejects a missing price instead of renormalizing the priced balance", async () => {
    await expect(runAdapter("fx", fxCoin, {
      config: apiConfig,
      network: {
        json: {
          [FX_API_ENDPOINT]: apiPayload(),
          [API_PRICE_ENDPOINT]: apiPrices(1_800_000_000, false),
        },
      },
      nowSec: 1_800_000_000,
      validate: false,
    })).rejects.toThrow("Missing DefiLlama price for wbtc");
  });

  it.each([
    ["0xee65a03c", "collateral"], ["0xf9d45fd2", "debt"],
  ])("rejects an independently unreadable on-chain %s read", async (selector, kind) => {
    await expect(runAdapter("fx", fxCoin, {
      network: onchainNetwork({ missing: { pool: WSTETH_POOL, selector } }),
      nowSec: 1_757_000_000,
      validate: false,
    })).rejects.toThrow(`fx on-chain ${kind} read failed for wstETH`);
  });

  it("values API WBTC at eight decimals rather than the on-chain eighteen", async () => {
    const { result } = await runAdapter("fx", fxCoin, {
      config: apiConfig,
      network: {
        json: {
          [FX_API_ENDPOINT]: apiPayload(),
          [API_PRICE_ENDPOINT]: apiPrices(1_800_000_000),
        },
      },
      nowSec: 1_800_000_000,
    });
    expect(result.slices).toEqual([
      { sourceKey: "fx:wbtc", name: "WBTC", pct: 92.6, risk: "medium" },
      { sourceKey: "fx:wsteth", name: "wstETH (Lido)", pct: 7.4, risk: "low" },
    ]);
  });

  it("extracts non-zero collateral balances from the official fx TVL payload", () => {
    const result = adaptFx({
      data: {
        poolInfo: {
          wstETH: { collateralBalance: "4420184046004807062590", debtBalance: "1000000000000000000000" },
          wbtc: { collateralBalance: "21713855211", debtBalance: "2000000000000000000000" },
        },
      },
    });

    expect(result).toEqual({
      balances: [
        { key: "wstETH", amountRaw: 4420184046004807062590n, debtRaw: 1000000000000000000000n },
        { key: "wbtc", amountRaw: 21713855211n, debtRaw: 2000000000000000000000n },
      ],
      unknownKeys: [],
    });
  });

  it("surfaces unknown positive collateral keys so the fetch path can fail closed", () => {
    const result = adaptFx({
      data: {
        poolInfo: {
          wstETH: { collateralBalance: "1000000000000000000" },
          unexpectedAsset: { collateralBalance: "250000000000000000" },
        },
      },
    });

    expect(result).toEqual({
      balances: [{ key: "wstETH", amountRaw: 1000000000000000000n, debtRaw: 0n }],
      unknownKeys: ["unexpectedAsset"],
    });
  });

  it("treats non-numeric collateralBalance strings as zero (parse-failure path)", () => {
    const result = adaptFx({
      data: {
        poolInfo: {
          wstETH: { collateralBalance: "not-a-number", debtBalance: "1000" },
          wbtc: { collateralBalance: "-250", debtBalance: "0" },
        },
      },
    });

    // Both wstETH and wbtc parse to 0 -> filtered out; neither counts as unknown.
    expect(result.balances).toEqual([]);
    expect(result.unknownKeys).toEqual([]);
  });

  it("returns an empty balance list and no unknowns when poolInfo is absent", () => {
    const result = adaptFx({});
    expect(result.balances).toEqual([]);
    expect(result.unknownKeys).toEqual([]);
  });

  it("skips unknown keys with zero collateralBalance (no false-positive unknown list)", () => {
    const result = adaptFx({
      data: {
        poolInfo: {
          wstETH: { collateralBalance: "1000000000000000000" },
          retiredAsset: { collateralBalance: "0" },
        },
      },
    });
    expect(result.unknownKeys).toEqual([]);
  });

  it("values on-chain pool raw collateral in each pool's raw unit (stETH for the wstETH pool)", async () => {
    const wstEthPoolRaw = 6498117380312973051552n;
    const wstEthPoolDebt = 8408069477417882708446823n;
    const wbtcPoolRaw = 1256573802172773285735n;
    const wbtcPoolDebt = 71492785220689011149058249n;
    const stEthPrice = 2485.83;
    const wbtcPrice = 78966.15;
    const { result, network } = await runAdapter("fx", "fxusd-f-x-protocol", {
      network: onchainNetwork({
        wstEthRaw: wstEthPoolRaw,
        wstEthDebt: wstEthPoolDebt,
        wbtcRaw: wbtcPoolRaw,
        wbtcDebt: wbtcPoolDebt,
        stEthPrice,
        wbtcPrice,
      }),
      nowSec: 1_757_000_000,
    });

    expect(network.requests.map((request) => request.url)).toContain(ONCHAIN_PRICE_ENDPOINT);
    expect(result.slices).toEqual([
      { sourceKey: "fx:wbtc", name: "WBTC", pct: 86.0, risk: "medium" },
      { sourceKey: "fx:wsteth", name: "wstETH (Lido)", pct: 14.0, risk: "low" },
    ]);

    const totalDebtUsd = (Number(wstEthPoolDebt) + Number(wbtcPoolDebt)) / 1e18;
    const totalReserveUsd = (Number(wstEthPoolRaw) / 1e18) * stEthPrice
      + (Number(wbtcPoolRaw) / 1e18) * wbtcPrice;
    expect(totalReserveUsd).toBeCloseTo(115_380_000, -3);
    expect(totalReserveUsd / totalDebtUsd).toBeCloseTo(1.444, 2);

    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      details: {
        proofKind: "fx-pool-direct-onchain",
        poolCount: 2,
      },
      redemption: {
        capacityKind: "live-proxy-validated",
        freshnessKind: "same-run-api",
      },
    });
    expect(result.metadata?.redemption?.capacityUsd).toBeCloseTo(totalDebtUsd, 6);
  });
});
