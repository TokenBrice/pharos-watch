import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetchRetry } from "../../test-helpers/cron";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import type { ChainRpcConfig } from "../../lib/chain-registry";

vi.mock("../../lib/fetch-retry", () => mockFetchRetry());

import { fetchCurveScrvusdCurrentRateSource } from "../yield-sync/sources";

const TEST_CHAIN_RPCS = new Map<string, ChainRpcConfig>([
  [
    "ethereum",
    {
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/eth",
      explorerUrl: "https://etherscan.io",
    },
  ],
]);

function uint256Hex(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function stubScrvusdRpc(values: Record<string, bigint>) {
  mockFetch([{
    match: "rpc.example/eth",
    respond: async (request) => {
      const body = await request.clone().json() as {
        params?: Array<{ data?: string } | string>;
      };
      const callData = typeof body.params?.[0] === "object" ? body.params[0]?.data : null;
      const result = callData ? values[callData] : null;
      if (result == null) {
        return new Response(JSON.stringify({ result: "0x" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ result: uint256Hex(result) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  }], { requireMatch: true });
}

describe("fetchCurveScrvusdCurrentRateSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("computes current APY from the Yearn V3 profit-unlock rate", async () => {
    stubScrvusdRpc({
      // totalAssets()
      "0x01e1d114": 30158843267975775812534801n,
      // totalSupply()
      "0x18160ddd": 27472111994438379962910025n,
      // profitUnlockingRate()
      "0x5141eebb": 36466621655966695427862704847n,
      // fullProfitUnlockDate()
      "0x2d632692": 1776150466n,
    });

    const result = await fetchCurveScrvusdCurrentRateSource(1775891171, undefined, TEST_CHAIN_RPCS);

    expect(result).toEqual(
      expect.objectContaining({
        apyReward: null,
        sourcePool: "5fd328af-4203-471b-bd16-1705c726d926",
        dataSource: "onchain",
        exchangeRate: null,
        sourceKey: "onchain:scrvusd-curve:scrvusd-current-rate",
        sourceObservedAt: 1775891171,
        comparisonAnchorObservedAt: null,
        yieldSource: "Curve Savings (scrvUSD)",
        yieldType: "governance-set",
      }),
    );
    expect(result?.currentApy).toBeCloseTo(4.2747, 4);
    expect(result?.apyBase).toBeCloseTo(4.2747, 4);
    expect(result?.sourceTvlUsd).toBeCloseTo(30_158_843.2679, 3);
  });

  it("returns a zero current rate when the profit-unlock window has ended", async () => {
    stubScrvusdRpc({
      "0x01e1d114": 30158843267975775812534801n,
      "0x18160ddd": 27472111994438379962910025n,
      "0x5141eebb": 36466621655966695427862704847n,
      "0x2d632692": 1775891170n,
    });

    const result = await fetchCurveScrvusdCurrentRateSource(1775891171, undefined, TEST_CHAIN_RPCS);

    expect(result?.currentApy).toBe(0);
    expect(result?.apyBase).toBe(0);
  });
});
