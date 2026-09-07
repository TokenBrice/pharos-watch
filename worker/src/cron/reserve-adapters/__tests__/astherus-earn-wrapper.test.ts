import { beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi } from "viem/utils";
import { jsonResponse } from "@shared/test-utils/mock-fetch";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { fetchWithRetryMock, resetRpcMocks, testChainRpcs } from "./helpers/rpc-mock";
import { mockErc4626Rpc } from "./erc4626-single-asset.test-support";

const MULTICALL3_ABI = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

const EARN_ADDRESS = "0xdb57a53c428a9fafcbfeffb6dd80d0f427543695";
const UNDERLYING_ADDRESS = "0x5a110fc00474038f6c02e89c707d638602ea44b5";
const SHARE_ADDRESS = "0x917af46b3c3c6e1bb7286b9f59637fb7c65851fb";
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const EARN_BALANCE_CALL_DATA = `0x70a08231${EARN_ADDRESS.slice(2).padStart(64, "0")}`;
const UNDERLYING_BALANCE = 3_006_484_174_203_159_992_078_097n;
const UNVESTED_AMOUNT = 55_099_977_083_333_333_333n;
const TOTAL_SUPPLY = 2_820_142_388_657_760_830_716_610n;
const EXCHANGE_PRICE = 1_066_055_773_040_941_551n;
const NET_BACKING = UNDERLYING_BALANCE - UNVESTED_AMOUNT;

function uint256Result(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function addressResult(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

const config = {
  adapter: "astherus-earn-wrapper",
  version: 1,
  semantics: "single-asset",
  inputs: {
    primary: { kind: "onchain-evm", chain: "bsc", rpcMode: "public-rpc" },
  },
  params: {
    earnAddress: EARN_ADDRESS,
    expectedUnderlyingAddress: UNDERLYING_ADDRESS,
    expectedShareAddress: SHARE_ADDRESS,
    underlyingDecimals: 18,
    shareDecimals: 18,
    slice: {
      name: "USDF staking wrapper shares",
      risk: "medium",
      coinId: "usdf-astherus",
      depType: "wrapper",
    },
  },
} as unknown as LiveReservesConfig;

const coin = { id: "asusdf-astherus", symbol: "asUSDF" } as StablecoinMeta;

function mockEarnState(overrides: { underlyingAddress?: string } = {}): void {
  mockErc4626Rpc({
    extraHandlers: [({ call }) => {
      if (!call?.data) return undefined;
      const to = call.to?.toLowerCase();
      const data = call.data.toLowerCase();

      if (to === EARN_ADDRESS && data === "0xb249b35d") {
        return jsonResponse({ result: addressResult(overrides.underlyingAddress ?? UNDERLYING_ADDRESS) });
      }
      if (to === EARN_ADDRESS && data === "0x1d30e266") {
        return jsonResponse({ result: addressResult(SHARE_ADDRESS) });
      }
      if (to === UNDERLYING_ADDRESS && data === EARN_BALANCE_CALL_DATA) {
        return jsonResponse({ result: uint256Result(UNDERLYING_BALANCE) });
      }
      if (to === SHARE_ADDRESS && data === "0x18160ddd") {
        return jsonResponse({ result: uint256Result(TOTAL_SUPPLY) });
      }
      if (to === EARN_ADDRESS && data === "0x9e65741e") {
        return jsonResponse({ result: uint256Result(EXCHANGE_PRICE) });
      }
      if (to === EARN_ADDRESS && data === "0xe7c2a608") {
        return jsonResponse({ result: uint256Result(UNVESTED_AMOUNT) });
      }
      if (to === EARN_ADDRESS && data === "0x5c975abb") {
        return jsonResponse({ result: uint256Result(0n) });
      }
      return undefined;
    }],
  });
}

async function runTracked() {
  // Load after rpc-mock registers the fetch-retry seam; a static import evaluates the transport too early.
  const { fetchAstherusEarnWrapperReserves } = await import("../astherus-earn-wrapper");
  return fetchAstherusEarnWrapperReserves(
    coin,
    config,
    new AbortController().signal,
    { chainRpcs: testChainRpcs },
  );
}

function assertSingleAggregate3Batch(): void {
  expect(fetchWithRetryMock).toHaveBeenCalledTimes(1);
  const init = fetchWithRetryMock.mock.calls[0]?.[1] as RequestInit | undefined;
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    params?: Array<{ to?: string; data?: string }>;
  };
  const call = body.params?.[0];
  expect(call?.to?.toLowerCase()).toBe(MULTICALL3);
  expect(call?.data).toBeDefined();
  expect(decodeFunctionData({
    abi: MULTICALL3_ABI,
    data: call!.data as `0x${string}`,
  }).args[0]).toHaveLength(7);
}

describe("fetchAstherusEarnWrapperReserves", () => {
  beforeEach(() => {
    resetRpcMocks();
    testChainRpcs.set("bsc", {
      chainId: "bsc",
      chainName: "BNB Smart Chain",
      type: "evm",
      rpcUrl: "https://rpc.example",
      explorerUrl: "https://bscscan.com",
    });
  });

  it("returns one 100% USDF slice from net asUSDFEarn backing", async () => {
    mockEarnState();

    const result = await runTracked();

    expect(result.slices).toEqual([
      {
        name: "USDF staking wrapper shares",
        pct: 100,
        risk: "medium",
        coinId: "usdf-astherus",
        depType: "wrapper",
      },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      chain: "bsc",
      contractAddress: EARN_ADDRESS,
      underlyingAmount: 3_006_429.0742260767,
      supplyTokens: 2_820_142.388657761,
      collateralizationRatio: 1.0660557730409417,
      details: {
        proofKind: "astherus-earn-wrapper-net-usdf-balance",
        underlyingBalanceRaw: UNDERLYING_BALANCE.toString(),
        unvestedAmountRaw: UNVESTED_AMOUNT.toString(),
        netBackingRaw: NET_BACKING.toString(),
        totalSupplyRaw: TOTAL_SUPPLY.toString(),
        exchangePriceRaw: EXCHANGE_PRICE.toString(),
      },
      redemption: {
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        routeStatusSource: "onchain",
      },
    });
    assertSingleAggregate3Batch();
  });

  it("throws and withholds the slice when USDF identity drifts", async () => {
    mockEarnState({ underlyingAddress: "0x1111111111111111111111111111111111111111" });

    await expect(runTracked()).rejects.toThrow(/underlying-address identity drifted/);
    assertSingleAggregate3Batch();
  });
});
