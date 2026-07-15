import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMocks = vi.hoisted(() => ({
  fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
}));

vi.mock("../../../lib/evm-rpc", () => ({
  fetchEvmMulticall3Aggregate3AtBlock: rpcMocks.fetchEvmMulticall3Aggregate3AtBlock,
}));

import {
  DEX_MEASURED_CAPACITY_NOTIONALS_USD,
  DEX_MEASURED_EXECUTION_SCHEMA_VERSION,
  DEX_MEASURED_MAX_COST_BPS,
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import {
  encodeV3FactoryGetPool,
  quoteQuoterV2Requests,
  resolveQuoterV2PoolBindings,
  validateQuoterV2ProfileProof,
} from "../quoter-v2";
import { getDexMeasuredExecutionDeployment } from "../registry";
import { createDexMeasuredExecutionRpcBudget } from "../profiles";

interface ReplayFixture {
  name: string;
  adapterProfileId: "uniswap-v3-quoter-v2" | "pancakeswap-v3-quoter-v2";
  protocol: "uniswap-v3" | "pancakeswap";
  chain: "ethereum" | "bsc";
  blockNumber: number;
  pool: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  decimals: number;
  amountInRaw: string;
  amountOutRaw: string;
  factoryReturnData: `0x${string}`;
  quoteReturnData: `0x${string}`;
}

const REPLAYS: readonly ReplayFixture[] = [
  {
    name: "Ethereum Uniswap USDC to USDT",
    adapterProfileId: "uniswap-v3-quoter-v2",
    protocol: "uniswap-v3",
    chain: "ethereum",
    blockNumber: 25_536_894,
    pool: "0x3416cf6c708da44db2624d63ea0aaef7113527c6",
    tokenIn: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    tokenOut: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    decimals: 6,
    amountInRaw: "1000000000000",
    amountOutRaw: "1000428895951",
    factoryReturnData: "0x0000000000000000000000003416cf6c708da44db2624d63ea0aaef7113527c6",
    quoteReturnData:
      "0x000000000000000000000000000000000000000000000000000000e8ee357ecf00000000000000000000000000000000000000010010b1148c71c129f534eb6500000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000017bbd",
  },
  {
    name: "BSC Pancake USDT to USDC",
    adapterProfileId: "pancakeswap-v3-quoter-v2",
    protocol: "pancakeswap",
    chain: "bsc",
    blockNumber: 110_108_702,
    pool: "0x92b7807bf19b7dddf89b706143896d05228f3121",
    tokenIn: "0x55d398326f99059ff775485246999027b3197955",
    tokenOut: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
    decimals: 18,
    amountInRaw: "1000000000000000000000000",
    amountOutRaw: "999279947580803659188350",
    factoryReturnData: "0x00000000000000000000000092b7807bf19b7dddf89b706143896d05228f3121",
    quoteReturnData:
      "0x00000000000000000000000000000000000000000000d39b1312b8ab9e71c87e0000000000000000000000000000000000000000ffe9569bc667ee7d5aa6bbfa0000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000002a803",
  },
] as const;

function makeTarget(fixture: ReplayFixture): DexMeasuredExecutionTarget {
  const poolId = `${fixture.chain}:${fixture.pool}`;
  const stablecoinId = `${fixture.chain}-input`;
  const targetId = buildDexMeasuredExecutionTargetId({
    adapterProfileId: fixture.adapterProfileId,
    stablecoinId,
    chain: fixture.chain,
    protocol: fixture.protocol,
    poolId,
    tokenInAddress: fixture.tokenIn,
    tokenOutAddress: fixture.tokenOut,
    poolTokenAddresses: [fixture.tokenIn, fixture.tokenOut],
    feePips: 100,
  });
  return {
    schemaVersion: "dex-measured-target-v1",
    targetId,
    stablecoinId,
    adapterProfileId: fixture.adapterProfileId,
    protocol: fixture.protocol,
    chain: fixture.chain,
    poolId,
    poolTokenAddresses: [fixture.tokenIn, fixture.tokenOut],
    tokenIn: {
      address: fixture.tokenIn,
      symbol: "TOKEN_IN",
      decimals: fixture.decimals,
      referencePriceUsd: 1,
      trackedAssetId: stablecoinId,
    },
    tokenOut: {
      address: fixture.tokenOut,
      symbol: "TOKEN_OUT",
      decimals: fixture.decimals,
      referencePriceUsd: 1,
      trackedAssetId: `${fixture.chain}-output`,
    },
    feePips: 100,
    retainedTvlUsd: 20_000_000,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_752_560_000,
  };
}

describe("QuoterV2 pinned-block replay proofs", () => {
  beforeEach(() => {
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockReset();
  });

  for (const fixture of REPLAYS) {
    it(`replays ${fixture.name} and binds the exact factory pool`, async () => {
      const target = makeTarget(fixture);
      const deployment = getDexMeasuredExecutionDeployment(fixture.adapterProfileId, fixture.chain);
      if (!deployment) throw new Error(`missing ${fixture.name} deployment`);
      rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(
        async (_chain: string, calls: Array<{ label: string; target: string }>) =>
          calls.map((call) => ({
            label: call.label,
            success: true,
            returnData:
              call.target.toLowerCase() === deployment.factoryAddress
                ? fixture.factoryReturnData
                : fixture.quoteReturnData,
          })),
      );

      const binding = await resolveQuoterV2PoolBindings({
        requests: [
          {
            target,
            factoryAddress: deployment.factoryAddress,
            factoryCodeHash: deployment.expectedFactoryCodeHash,
          },
        ],
        blockNumber: fixture.blockNumber,
        chainRpcs: new Map(),
      });
      const quotes = await quoteQuoterV2Requests({
        requests: [{ target, inputUsd: 1_000_000, endpointAddress: deployment.endpointAddress }],
        blockNumber: fixture.blockNumber,
        chainRpcs: new Map(),
      });
      const point = quotes[0]?.point;
      if (!point || !binding[0]?.proof) throw new Error(`missing ${fixture.name} proof fixture`);

      expect(point.amountInRaw).toBe(fixture.amountInRaw);
      expect(point.amountOutRaw).toBe(fixture.amountOutRaw);
      expect(binding[0].proof).toMatchObject({
        factoryAddress: deployment.factoryAddress,
        factoryCodeHash: deployment.expectedFactoryCodeHash,
        resolvedPoolAddress: fixture.pool,
        callData: encodeV3FactoryGetPool(target),
        returnData: fixture.factoryReturnData,
      });

      const profile: DexMeasuredExecutionProfile = {
        schemaVersion: DEX_MEASURED_EXECUTION_SCHEMA_VERSION,
        kind: "measured-executable-depth",
        targetId: target.targetId,
        targetGenerationId: "target-generation",
        quoteGenerationId: "quote-generation",
        adapterProfileId: target.adapterProfileId,
        protocol: target.protocol,
        chain: target.chain,
        poolId: target.poolId,
        poolTokenAddresses: target.poolTokenAddresses,
        tokenIn: target.tokenIn,
        tokenOut: target.tokenOut,
        feePips: target.feePips,
        retainedTvlUsdAtQuote: target.retainedTvlUsd,
        retainedPoolPriceUsdAtQuote: target.retainedPoolPriceUsd,
        quotedAt: target.capturedAt + 60,
        blockNumber: fixture.blockNumber,
        executionEndpoint: {
          address: deployment.endpointAddress,
          codeHash: deployment.expectedCodeHash,
        },
        poolBindingProof: binding[0].proof,
        maxCostBps: DEX_MEASURED_MAX_COST_BPS,
        marginalOutputRatio: point.outputUsd / point.inputUsd,
        capacityCurve: DEX_MEASURED_CAPACITY_NOTIONALS_USD.map((requestedNotionalUsd) => ({
          requestedNotionalUsd,
          maxCostBps: DEX_MEASURED_MAX_COST_BPS,
          executableUsd: 0,
          completionRatio: 0,
        })),
        quoteProof: [point],
      };

      expect(validateQuoterV2ProfileProof(profile)).toEqual([]);
      profile.executionEndpoint.address = "0x0000000000000000000000000000000000000001";
      expect(validateQuoterV2ProfileProof(profile)).toContain("execution-endpoint-identity-mismatch");
    });
  }

  it("rejects a factory return that resolves to a different physical pool", async () => {
    const fixture = REPLAYS[0]!;
    const target = makeTarget(fixture);
    const deployment = getDexMeasuredExecutionDeployment(fixture.adapterProfileId, fixture.chain)!;
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(
      async (_chain: string, calls: Array<{ label: string }>) =>
        calls.map((call) => ({
          label: call.label,
          success: true,
          returnData: "0x0000000000000000000000000000000000000000000000000000000000000001",
        })),
    );

    const result = await resolveQuoterV2PoolBindings({
      requests: [
        {
          target,
          factoryAddress: deployment.factoryAddress,
          factoryCodeHash: deployment.expectedFactoryCodeHash,
        },
      ],
      blockNumber: fixture.blockNumber,
      chainRpcs: new Map(),
    });

    expect(result).toEqual([{ targetId: target.targetId, failureReason: "factory-pool-mismatch" }]);
  });

  it("fails an oversized schema-valid input per target without aborting the batch", async () => {
    const fixture = REPLAYS[0]!;
    const target = makeTarget(fixture);
    target.tokenIn.decimals = 255;
    const deployment = getDexMeasuredExecutionDeployment(fixture.adapterProfileId, fixture.chain)!;

    const result = await quoteQuoterV2Requests({
      requests: [{ target, inputUsd: 1_000_000, endpointAddress: deployment.endpointAddress }],
      blockNumber: fixture.blockNumber,
      chainRpcs: new Map(),
    });

    expect(result).toEqual([
      {
        targetId: target.targetId,
        inputUsd: 1_000_000,
        failureReason: "invalid-quote-input",
      },
    ]);
    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();
  });

  it("does not trip the chain circuit while an oversized batch succeeds after halving", async () => {
    const fixture = REPLAYS[0]!;
    const target = makeTarget(fixture);
    const deployment = getDexMeasuredExecutionDeployment(fixture.adapterProfileId, fixture.chain)!;
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(
      async (_chain: string, calls: Array<{ label: string }>) =>
        calls.length > 2
          ? null
          : calls.map((call) => ({ label: call.label, success: true, returnData: fixture.quoteReturnData })),
    );
    const budget = createDexMeasuredExecutionRpcBudget({
      maxRequests: 100,
      deadlineMs: Date.now() + 60_000,
    });

    const outcomes = await quoteQuoterV2Requests({
      requests: Array.from({ length: 8 }, () => ({
        target,
        inputUsd: 1_000_000,
        endpointAddress: deployment.endpointAddress,
      })),
      blockNumber: fixture.blockNumber,
      chainRpcs: new Map(),
      rpcBudget: budget,
    });

    expect(outcomes.every((outcome) => outcome.point != null)).toBe(true);
    expect(budget.openChains).toEqual([]);
    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mock.calls.map((call) => call[1].length)).toEqual([
      8, 4, 2, 2, 4, 2, 2,
    ]);
  });

  it("retries failed inner quotes as serialized singletons", async () => {
    const fixture = REPLAYS[0]!;
    const target = makeTarget(fixture);
    const deployment = getDexMeasuredExecutionDeployment(fixture.adapterProfileId, fixture.chain)!;
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(
      async (_chain: string, calls: Array<{ label: string }>) =>
        calls.map((call, index) => ({
          label: call.label,
          success: calls.length === 1 || index === 0,
          returnData: calls.length === 1 || index === 0 ? fixture.quoteReturnData : "0x",
        })),
    );

    const outcomes = await quoteQuoterV2Requests({
      requests: Array.from({ length: 3 }, () => ({
        target,
        inputUsd: 1_000_000,
        endpointAddress: deployment.endpointAddress,
      })),
      blockNumber: fixture.blockNumber,
      chainRpcs: new Map(),
    });

    expect(outcomes.every((outcome) => outcome.point != null)).toBe(true);
    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mock.calls.map((call) => call[1].length)).toEqual([3, 1, 1]);
  });
});
