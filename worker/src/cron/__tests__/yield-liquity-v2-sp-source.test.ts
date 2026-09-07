import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { cleanupYieldSourceTest, mockYieldSourceFetchRetryModule } from "./yield-source.test-support";

vi.mock("../../lib/fetch-retry", () => mockYieldSourceFetchRetryModule());

import {
  BASEDOLLAR_SP_CONFIG,
  LIQUITY_V2_SP_CONFIG,
  fetchLiquityV2StabilityPoolSource,
  type LiquityV2SpSourceConfig,
} from "../yield-sync/sources";

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
  [
    "ethereum",
    {
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/ethereum",
      fallbackRpcUrl: "https://rpc-fallback.example/ethereum",
      explorerUrl: "https://etherscan.io",
    },
  ],
]);

const E18 = 10n ** 18n;
const E36 = 10n ** 36n;
const AGG_WEIGHTED_DEBT_SUM_SELECTOR = "0x42635a95";
const SHUTDOWN_TIME_SELECTOR = "0x58569081";
const TOTAL_COLLATERALS_SELECTOR = "0x30504b6f";
const TOTAL_BOLD_DEPOSITS_SELECTOR = "0xf71c6940";

interface BranchValues {
  yearlyInterest: bigint;
  shutdownTime: bigint;
  deposits: bigint;
}

function uint256Hex(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function stubBranchRpc(
  config: LiquityV2SpSourceConfig,
  values: readonly BranchValues[],
  options?: { failRead?: { branchIndex: number; selector: string }; registryCount?: bigint },
) {
  function resolveCall(to: string | undefined, data: string | undefined): string {
    if (to === config.collateralRegistry && data === TOTAL_COLLATERALS_SELECTOR) {
      return uint256Hex(options?.registryCount ?? BigInt(config.branches.length));
    }
    for (const [index, branch] of config.branches.entries()) {
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
    throw new Error(`Unexpected eth_call: ${to ?? "missing-to"} ${data ?? "missing-data"}`);
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

/** Branch interest/deposit pairs sized so the aggregate APR lands on 7.5%. */
function buildBranchValues(config: LiquityV2SpSourceConfig): BranchValues[] {
  return config.branches.map((_branch, index) => ({
    yearlyInterest: BigInt(100 * (index + 1)),
    shutdownTime: 0n,
    deposits: BigInt(1_000 * (index + 1)),
  }));
}

describe.each([
  { name: "Base Dollar", config: BASEDOLLAR_SP_CONFIG, expectedBranchCount: 5 },
  { name: "Liquity V2", config: LIQUITY_V2_SP_CONFIG, expectedBranchCount: 3 },
])("fetchLiquityV2StabilityPoolSource ($name)", ({ config, expectedBranchCount }) => {
  afterEach(cleanupYieldSourceTest);

  it("aggregates every configured branch", () => {
    expect(config.branches).toHaveLength(expectedBranchCount);
  });

  it("computes the deposit-weighted interest-only APR across all branches", async () => {
    const values = buildBranchValues(config);
    stubBranchRpc(config, values);

    const totalDeposits = values.reduce((total, branch) => total + Number(branch.deposits), 0);
    const result = await fetchLiquityV2StabilityPoolSource(config, undefined, TEST_CHAIN_RPCS);

    expect(result).toEqual(
      expect.objectContaining({
        currentApy: expect.closeTo(7.5, 10),
        apyBase: expect.closeTo(7.5, 10),
        apyReward: null,
        sourcePool: null,
        sourceTvlUsd: totalDeposits,
        dataSource: "onchain",
        exchangeRate: null,
        sourceKey: `onchain:${config.stablecoinId}`,
        yieldSource: config.sourceLabel,
        yieldType: "lending-vault",
      }),
    );
  });

  it("excludes a shutdown branch's interest but retains its deposits", async () => {
    const values = buildBranchValues(config);
    const shutdownIndex = config.branches.length - 1;
    stubBranchRpc(config, values.map((branch, index) => (
      index === shutdownIndex ? { ...branch, shutdownTime: 1n } : branch
    )));

    const totalDeposits = values.reduce((total, branch) => total + Number(branch.deposits), 0);
    const activeInterest = values
      .filter((_branch, index) => index !== shutdownIndex)
      .reduce((total, branch) => total + Number(branch.yearlyInterest), 0);
    const result = await fetchLiquityV2StabilityPoolSource(config, undefined, TEST_CHAIN_RPCS);

    expect(result?.currentApy).toBeCloseTo(75 * activeInterest / totalDeposits, 10);
    expect(result?.sourceTvlUsd).toBe(totalDeposits);
  });

  it("fails closed when any branch read in the batch is unreadable", async () => {
    stubBranchRpc(config, buildBranchValues(config), {
      failRead: { branchIndex: config.branches.length - 1, selector: SHUTDOWN_TIME_SELECTOR },
    });

    await expect(fetchLiquityV2StabilityPoolSource(config, undefined, TEST_CHAIN_RPCS)).resolves.toBeNull();
  });

  it("fails closed when the CollateralRegistry reports more branches than configured", async () => {
    stubBranchRpc(config, buildBranchValues(config), {
      registryCount: BigInt(config.branches.length + 1),
    });

    await expect(fetchLiquityV2StabilityPoolSource(config, undefined, TEST_CHAIN_RPCS)).resolves.toBeNull();
  });

  it("returns null when total Stability Pool deposits are zero", async () => {
    stubBranchRpc(config, buildBranchValues(config).map((branch) => ({ ...branch, deposits: 0n })));

    await expect(fetchLiquityV2StabilityPoolSource(config, undefined, TEST_CHAIN_RPCS)).resolves.toBeNull();
  });

  it("returns null without a chain RPC for its deployment", async () => {
    stubBranchRpc(config, buildBranchValues(config));

    await expect(fetchLiquityV2StabilityPoolSource(config, undefined, new Map())).resolves.toBeNull();
  });
});
