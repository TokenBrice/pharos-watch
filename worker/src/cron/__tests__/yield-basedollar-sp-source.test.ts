import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { cleanupYieldSourceTest, mockYieldSourceFetchRetryModule } from "./yield-source.test-support";

vi.mock("../../lib/fetch-retry", () => mockYieldSourceFetchRetryModule());

import { fetchBasedollarSpSource } from "../yield-sync/sources";

const TEST_CHAIN_RPCS = new Map<string, ChainRpcConfig>([
  [
    "base",
    {
      chainId: "base",
      chainName: "Base",
      type: "evm",
      rpcUrl: "https://rpc.example/base",
      fallbackRpcUrl: "https://rpc-fallback.example/base",
      explorerUrl: "https://basescan.org",
    },
  ],
]);

const E18 = 10n ** 18n;
const E36 = 10n ** 36n;
const TOTAL_COLLATERALS_SELECTOR = "0x30504b6f";
const AGG_WEIGHTED_DEBT_SUM_SELECTOR = "0x42635a95";
const SHUTDOWN_TIME_SELECTOR = "0x58569081";
const TOTAL_BOLD_DEPOSITS_SELECTOR = "0xf71c6940";
const COLLATERAL_REGISTRY = "0x7551ebfc8340b7f91874942be9c653733d4fb04f";
const BRANCHES = [
  {
    activePool: "0x254a8267d4e12a8c0f283274632a18a33e49f7c0",
    stabilityPool: "0x7d837bf114785642d225d1101145ddb8af4ba438",
  },
  {
    activePool: "0x1021fefc406c9573ab3579fc55be13e3300ef6b1",
    stabilityPool: "0xc65a05737d31e0f42c0806c739f3c88dd009c05f",
  },
  {
    activePool: "0x1b9a62798e8bae0cea4eb21b4b3775359beb819f",
    stabilityPool: "0x4eb3b6970fd358d34195b5d40e4eb64e0e3c0b6a",
  },
  {
    activePool: "0xcaa72df531554087318eaf24646958500668b230",
    stabilityPool: "0x6bd55dd953507641c84a03956760f83d29d65726",
  },
  {
    activePool: "0xddac84ab417677f553cced8ababf497226112218",
    stabilityPool: "0x25afbb09d9804482ed8e24295be4a12704fe93ea",
  },
] as const;

interface BranchValues {
  yearlyInterest: bigint;
  shutdownTime: bigint;
  deposits: bigint;
}

function uint256Hex(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function stubBasedollarRpc(
  values: readonly BranchValues[],
  options?: { failRead?: { branchIndex: number; selector: string }; registryCount?: bigint },
) {
  function resolveCall(to: string | undefined, data: string | undefined): string {
    if (to === COLLATERAL_REGISTRY && data === TOTAL_COLLATERALS_SELECTOR) {
      return uint256Hex(options?.registryCount ?? BigInt(BRANCHES.length));
    }
    for (const [index, branch] of BRANCHES.entries()) {
      if (options?.failRead?.branchIndex === index && options.failRead.selector === data) {
        // An empty eth_call result is not a valid uint256 word; the adapter
        // must reject the whole batch rather than publish a partial sum.
        return "0x";
      }
      if (to === branch.activePool && data === AGG_WEIGHTED_DEBT_SUM_SELECTOR) {
        return uint256Hex(values[index]!.yearlyInterest * E36);
      }
      if (to === branch.activePool && data === SHUTDOWN_TIME_SELECTOR) {
        return uint256Hex(values[index]!.shutdownTime);
      }
      if (to === branch.stabilityPool && data === TOTAL_BOLD_DEPOSITS_SELECTOR) {
        return uint256Hex(values[index]!.deposits * E18);
      }
    }
    throw new Error(`Unexpected Base Dollar eth_call: ${to ?? "missing-to"} ${data ?? "missing-data"}`);
  }

  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Array<{
      id?: number;
      params?: Array<{ to?: string; data?: string } | string>;
    }>;
    if (!Array.isArray(body)) {
      throw new Error("Expected a JSON-RPC batch request from fetchEvmRpcBatch");
    }
    const envelopes = body.map((call) => {
      const params = typeof call.params?.[0] === "object" ? call.params[0] : null;
      return {
        jsonrpc: "2.0",
        id: call.id,
        result: resolveCall(params?.to?.toLowerCase(), params?.data),
      };
    });
    return new Response(JSON.stringify(envelopes), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));
}

const DEFAULT_BRANCH_VALUES: readonly BranchValues[] = [
  { yearlyInterest: 100n, shutdownTime: 0n, deposits: 1_000n },
  { yearlyInterest: 200n, shutdownTime: 0n, deposits: 2_000n },
  { yearlyInterest: 300n, shutdownTime: 0n, deposits: 3_000n },
  { yearlyInterest: 400n, shutdownTime: 0n, deposits: 4_000n },
  { yearlyInterest: 500n, shutdownTime: 0n, deposits: 5_000n },
];

describe("fetchBasedollarSpSource", () => {
  afterEach(cleanupYieldSourceTest);

  it("computes the deposit-weighted interest-only APR across all branches", async () => {
    stubBasedollarRpc(DEFAULT_BRANCH_VALUES);

    const result = await fetchBasedollarSpSource(undefined, TEST_CHAIN_RPCS);

    expect(result).toEqual(
      expect.objectContaining({
        currentApy: 7.5,
        apyBase: 7.5,
        apyReward: null,
        sourcePool: null,
        sourceTvlUsd: 15_000,
        dataSource: "onchain",
        exchangeRate: null,
        sourceKey: "onchain:bd-basedollar",
        yieldSource: "Base Dollar Stability Pools (interest-only)",
        yieldType: "lending-vault",
      }),
    );
  });

  it("excludes a shutdown branch's interest but retains its deposits", async () => {
    stubBasedollarRpc(DEFAULT_BRANCH_VALUES.map((branch, index) => (
      index === 2 ? { ...branch, shutdownTime: 1n } : branch
    )));

    const result = await fetchBasedollarSpSource(undefined, TEST_CHAIN_RPCS);

    expect(result?.currentApy).toBeCloseTo(6, 10);
    expect(result?.apyBase).toBeCloseTo(6, 10);
    expect(result?.sourceTvlUsd).toBe(15_000);
  });

  it("fails closed when any branch read in the batch is unreadable", async () => {
    stubBasedollarRpc(DEFAULT_BRANCH_VALUES, {
      failRead: { branchIndex: 3, selector: SHUTDOWN_TIME_SELECTOR },
    });

    await expect(fetchBasedollarSpSource(undefined, TEST_CHAIN_RPCS)).resolves.toBeNull();
  });

  it("fails closed when the CollateralRegistry reports more branches than configured", async () => {
    stubBasedollarRpc(DEFAULT_BRANCH_VALUES, { registryCount: 6n });

    await expect(fetchBasedollarSpSource(undefined, TEST_CHAIN_RPCS)).resolves.toBeNull();
  });

  it("returns null when total Stability Pool deposits are zero", async () => {
    stubBasedollarRpc(DEFAULT_BRANCH_VALUES.map((branch) => ({ ...branch, deposits: 0n })));

    await expect(fetchBasedollarSpSource(undefined, TEST_CHAIN_RPCS)).resolves.toBeNull();
  });
});
