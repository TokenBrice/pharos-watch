import { describe, expect, it } from "vitest";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import { resolveAdapterCoin, runAdapter, expectWarnings, type AdapterNetworkSpec } from "./reserve-adapter.test-support";

const NOW = 1_788_991_200;
const { config } = resolveAdapterCoin("liquity-v2-branches", "usdaf-asymmetry");
const params = parseLiveReserveAdapterParams("liquity-v2-branches", config.params);
const assets = [
  "0x9f4330700a36b29952869fac9b33f45eedd8a3d8",
  "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e",
  "0xdc035d45d973e3ec169d2276ddab16f1e407384f",
  "0xcacd6fd266af91b8aed52accc382b4e165586e29",
  null,
  null,
];

// Contract identities are the September 9 live six-branch census. Quantities
// are scaled deterministic observations so each branch contributes $100.
function network(options: { shutdown?: boolean; missingDebt?: boolean } = {}): AdapterNetworkSpec {
  const rpc: NonNullable<AdapterNetworkSpec["rpc"]> = {
    "decimals()": 18n,
    "totalAssets()": 100n * 10n ** 18n,
    "totalSupply()": 100n * 10n ** 18n,
    "getRedemptionRateWithDecay()": 5n * 10n ** 15n,
  };
  const prices: Record<string, { price: number; timestamp: number; confidence: number }> = {};
  params.branches.forEach((branch, index) => {
    rpc[`${branch.token.address}:balanceOf(address)`] = index < 4 ? 100n * 10n ** 18n : 10n ** 16n;
    rpc[`${branch.token.address}:asset()`] = assets[index];
    rpc[`${branch.holder}:getBoldDebt()`] = options.missingDebt && index === 0 ? null : 50n * 10n ** 18n;
    rpc[`${branch.holder}:hasBeenShutDown()`] = options.shutdown === true && index === 0;
    const pricedToken = branch.priceToken?.address ?? assets[index] ?? branch.token.address;
    prices[`ethereum:${pricedToken}`] = { price: index < 4 ? 1 : 10_000, timestamp: NOW, confidence: 1 };
  });
  return {
    rpc,
    block: { number: 25_942_241, timestamp: NOW },
    json: { [`https://coins.llama.fi/prices/current/${Object.keys(prices).sort().join(",")}`]: { coins: prices } },
  };
}

describe("USDaf on-chain rebinding", () => {
  it("values all six live branches including 18-decimal wrapped WBTC", async () => {
    const { result } = await runAdapter("liquity-v2-branches", "usdaf-asymmetry", { network: network(), nowSec: NOW });
    expect(result.slices.map((slice) => slice.name).sort()).toEqual(["sUSDS", "scrvUSD", "sfrxUSD", "tBTC", "wBTC", "ysyBOLD"].sort());
    for (const slice of result.slices) expect(slice.pct).toBeCloseTo(100 / 6, 0);
    expect(result.slices.find((slice) => slice.name === "wBTC")?.sourceKey).toBe("liquity-v2-branches:ethereum:0xe065bc161b90c9c4bba2de7f1e194b70a3267c47");
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 300, routeStatus: "open", routeStatusSource: "onchain", freshnessKind: "same-run-onchain", feeBps: 50 });
    expectWarnings(result, []);
  });

  it("retains measured collateral while a branch shutdown degrades the route", async () => {
    const { result } = await runAdapter("liquity-v2-branches", "usdaf-asymmetry", { network: network({ shutdown: true }), nowSec: NOW });
    expect(result.metadata?.redemption?.routeStatus).toBe("degraded");
    expect(result.slices.find((slice) => slice.name === "ysyBOLD")?.pct).toBeCloseTo(100 / 6, 0);
  });

  it("rejects shape drift when the required branch debt getter disappears", async () => {
    await expect(runAdapter("liquity-v2-branches", "usdaf-asymmetry", { network: network({ missingDebt: true }), nowSec: NOW })).rejects.toThrow(/active-pool debt/);
  });
});
