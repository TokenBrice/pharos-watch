import { describe, expect, it } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { runAdapter, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const ONCHAIN_PRICE_ENDPOINT =
  "https://coins.llama.fi/prices/current/ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599,ethereum:0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
const WSTETH_POOL = "0x6Ecfa38FeE8a5277B91eFdA204c235814F0122E8";
const WBTC_POOL = "0xAB709e26Fa6B0A30c119D8c55B887DeD24952473";
const WSTETH_POOL_LOWER = WSTETH_POOL.toLowerCase();
const WBTC_POOL_LOWER = WBTC_POOL.toLowerCase();
const COLLATERAL_SELECTOR = "0xee65a03c";
const DEBT_SELECTOR = "0xf9d45fd2";
const fxCoin = TRACKED_META_BY_ID.get("fxusd-f-x-protocol")!;

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

describe("fx", () => {
  it.each([
    ["0xee65a03c", "collateral"], ["0xf9d45fd2", "debt"],
  ])("rejects an independently unreadable on-chain %s read", async (selector, kind) => {
    await expect(runAdapter("fx", fxCoin, {
      network: onchainNetwork({ missing: { pool: WSTETH_POOL, selector } }),
      nowSec: 1_757_000_000,
      validate: false,
    })).rejects.toThrow(`fx on-chain ${kind} read failed for wstETH`);
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
