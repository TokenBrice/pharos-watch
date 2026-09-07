import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, parseAbiParameters } from "viem/utils";

const rpcMocks = vi.hoisted(() => ({
  fetchEvmCodeAtBlock: vi.fn(),
  fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
}));

vi.mock("../../../lib/evm-rpc", () => ({
  fetchEvmCodeAtBlock: rpcMocks.fetchEvmCodeAtBlock,
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
  encodeQuoterV2ExactInputSingle,
  encodeV3FactoryGetPool,
  quoteQuoterV2Requests,
  resolveQuoterV2PoolBindings,
  validateQuoterV2ProfileProof,
} from "../quoter-v2";
import {
  getDexMeasuredExecutionDeployment,
  isDexMeasuredExecutionDeploymentScoreEligible,
  verifyDexMeasuredExecutionDeployment,
} from "../registry";
import {
  buildDexMeasuredExecutionProfile,
  createDexMeasuredExecutionRpcBudget,
  DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
  projectProfileForAdapter,
} from "../profiles";
import { buildP4DexExitRouteObservations } from "@shared/lib/p4-exit-route-observation-assembly";
import { toMaturePublicProfile } from "./profile.test-support";

const DEMANDED_GRID_USD = [
  1_000,
  ...DEX_MEASURED_CAPACITY_NOTIONALS_USD,
] as const;

interface ReplayFixture {
  name: string;
  adapterProfileId:
    | "uniswap-v3-quoter-v2"
    | "pancakeswap-v3-quoter-v2"
    | "aerodrome-slipstream-quoter-v2";
  protocol: "uniswap-v3" | "pancakeswap" | "aerodrome-slipstream";
  chain: "ethereum" | "bsc" | "base";
  blockNumber: number;
  pool: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  decimals: number;
  amountInRaw: string;
  amountOutRaw: string;
  factoryReturnData: `0x${string}`;
  quoteReturnData: `0x${string}`;
  tickSpacing?: number;
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
  {
    name: "BSC Uniswap V3 USDT to USD1",
    adapterProfileId: "uniswap-v3-quoter-v2",
    protocol: "uniswap-v3",
    chain: "bsc",
    blockNumber: 115_749_297,
    pool: "0xf150d29d92e7460a1531cbc9d1abeab33d6998e4",
    tokenIn: "0x55d398326f99059ff775485246999027b3197955",
    tokenOut: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
    decimals: 18,
    amountInRaw: "1000000000000000000000000",
    amountOutRaw: "56598749951243456661011",
    factoryReturnData: "0x000000000000000000000000f150d29d92e7460a1531cbc9d1abeab33d6998e4",
    quoteReturnData:
      "0x000000000000000000000000000000000000000000000bfc397127a06fb0c61300000000000000000000000000000000000000000006e092997bb0bfc1ca9dd5000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000005a31d9",
  },
  {
    name: "Base Aerodrome Slipstream USDC to USDbC",
    adapterProfileId: "aerodrome-slipstream-quoter-v2",
    protocol: "aerodrome-slipstream",
    chain: "base",
    blockNumber: 33_000_000,
    pool: "0x3333333333333333333333333333333333333333",
    tokenIn: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    tokenOut: "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca",
    decimals: 6,
    amountInRaw: "1000000000000",
    amountOutRaw: "1000428895951",
    factoryReturnData: "0x0000000000000000000000003333333333333333333333333333333333333333",
    quoteReturnData:
      "0x000000000000000000000000000000000000000000000000000000e8ee357ecf00000000000000000000000000000000000000010010b1148c71c129f534eb6500000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000017bbd",
    tickSpacing: 50,
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
    ...(fixture.tickSpacing != null ? { tickSpacing: fixture.tickSpacing } : { feePips: 100 }),
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
    ...(fixture.tickSpacing != null ? { tickSpacing: fixture.tickSpacing } : { feePips: 100 }),
    retainedTvlUsd: 20_000_000,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_752_560_000,
  };
}

describe("QuoterV2 pinned-block replay proofs", () => {
  beforeEach(() => {
    rpcMocks.fetchEvmCodeAtBlock.mockReset();
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockReset();
  });

  it("rejects a reviewed Quoter deployment when pinned runtime code differs", async () => {
    const deployment = getDexMeasuredExecutionDeployment(
      "uniswap-v3-quoter-v2",
      "ethereum",
    )!;
    rpcMocks.fetchEvmCodeAtBlock.mockResolvedValue("0x00");

    await expect(verifyDexMeasuredExecutionDeployment({
      deployment,
      blockNumber: REPLAYS[0]!.blockNumber,
      chainRpcs: new Map(),
    })).resolves.toEqual({ ok: false, reason: "code-hash-mismatch" });
    expect(rpcMocks.fetchEvmCodeAtBlock).toHaveBeenCalledTimes(1);
  });

  for (const fixture of REPLAYS) {
    it(`replays ${fixture.name} and binds the exact factory pool`, async () => {
      const target = makeTarget(fixture);
      const deployment = getDexMeasuredExecutionDeployment(fixture.adapterProfileId, fixture.chain);
      if (!deployment) throw new Error(`missing ${fixture.name} deployment`);
      rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(
        async (_chain: string, calls: Array<{ label: string; target: string; callData: `0x${string}` }>) =>
          calls.map((call) => ({
            label: call.label,
            success: true,
            returnData:
              call.target.toLowerCase() === deployment.factoryAddress
                ? fixture.factoryReturnData
                : encodeAbiParameters(
                    parseAbiParameters(
                      "uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate",
                    ),
                    [
                      BigInt(fixture.amountOutRaw) *
                        BigInt(`0x${call.callData.slice(2 + 8 + 128, 2 + 8 + 192)}`) /
                        BigInt(fixture.amountInRaw),
                      2n ** 96n,
                      1,
                      100_000n,
                    ],
                  ),
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
        requests: DEMANDED_GRID_USD.map((inputUsd) => ({
          target,
          inputUsd,
          endpointAddress: deployment.endpointAddress,
        })),
        blockNumber: fixture.blockNumber,
        chainRpcs: new Map(),
      });
      const points = quotes.flatMap((quote) => quote.point ? [quote.point] : []);
      const point = points.find((quote) => quote.inputUsd === 1_000_000);
      if (!point || points.length !== DEMANDED_GRID_USD.length || !binding[0]?.proof) {
        throw new Error(`missing ${fixture.name} proof fixture`);
      }

      expect(point.amountInRaw).toBe(fixture.amountInRaw);
      expect(point.amountOutRaw).toBe(fixture.amountOutRaw);
      expect(binding[0].proof).toMatchObject({
        factoryAddress: deployment.factoryAddress,
        factoryCodeHash: deployment.expectedFactoryCodeHash,
        resolvedPoolAddress: fixture.pool,
        callData: encodeV3FactoryGetPool(target),
        returnData: fixture.factoryReturnData,
      });

      const profile = buildDexMeasuredExecutionProfile({
        target,
        targetGenerationId: "target-generation",
        quoteGenerationId: "quote-generation",
        quotedAt: target.capturedAt + 60,
        blockNumber: fixture.blockNumber,
        endpointAddress: deployment.endpointAddress,
        endpointCodeHash: deployment.expectedCodeHash,
        poolBindingProof: binding[0].proof,
        points,
      });

      expect(validateQuoterV2ProfileProof(profile)).toEqual([]);
      const v2Profile = projectProfileForAdapter(profile, "evm-quoter-v2");
      expect(v2Profile).toMatchObject({
        adapterId: "evm-quoter-v2",
        demandedInputAmountsUsd: DEMANDED_GRID_USD,
        payload: { platform: "evm", blockNumber: fixture.blockNumber },
      });
      expect(v2Profile?.payload.platform === "evm" && v2Profile.payload.callProof).toHaveLength(5);
      if (
        isDexMeasuredExecutionDeploymentScoreEligible(
          fixture.adapterProfileId,
          fixture.chain,
        )
      ) {
        const measuredExecution = toMaturePublicProfile(profile);
        const p4 = buildP4DexExitRouteObservations({
          stablecoinId: target.stablecoinId,
          observedAt: profile.quotedAt + 60,
          retainedPools: [{
            poolId: target.poolId,
            project: target.protocol,
            chain: target.chain,
            tvlUsd: target.retainedTvlUsd,
            symbol: `${target.tokenIn.symbol}-${target.tokenOut.symbol}`,
            poolType: "cg-concentrated",
            source: "dl",
            extra: {
              measuredExecution,
              measuredExecutionPhysicalPoolId: target.poolId,
            },
          }],
        });
        expect(p4.coverage).toMatchObject({
          retainedPoolCount: 1,
          scoreEligibleObservationCount: 1,
          scoreEligiblePoolCount: 1,
          scoreEligibleCapabilityPoolCount: 1,
          unsupportedPoolCount: 0,
        });
      }
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

  it("preserves the Quoter adaptive multicall golden split", async () => {
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
    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mock.calls.every(
      (call) => call[3]?.timeoutMs === DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
    )).toBe(true);
  });

  it("preserves the Quoter adaptive multicall golden budget-exhaustion result", async () => {
    const fixture = REPLAYS[0]!;
    const target = makeTarget(fixture);
    const deployment = getDexMeasuredExecutionDeployment(fixture.adapterProfileId, fixture.chain)!;
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(
      async (
        _chain: string,
        _calls: unknown,
        _blockNumber: number,
        options: { beforeRequest?: () => boolean },
      ) => {
        options.beforeRequest?.();
        return null;
      },
    );
    const budget = createDexMeasuredExecutionRpcBudget({
      maxRequests: 0,
      deadlineMs: Date.now() + 60_000,
    });

    const outcomes = await quoteQuoterV2Requests({
      requests: [{ target, inputUsd: 1_000, endpointAddress: deployment.endpointAddress }],
      blockNumber: fixture.blockNumber,
      chainRpcs: new Map(),
      rpcBudget: budget,
    });

    expect(outcomes[0]?.failureReason).toBe("request-budget-exhausted");
  });

  it("preserves the Quoter adaptive multicall golden deadline result", async () => {
    const fixture = REPLAYS[0]!;
    const target = makeTarget(fixture);
    const deployment = getDexMeasuredExecutionDeployment(fixture.adapterProfileId, fixture.chain)!;
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockResolvedValue(null);
    const budget = createDexMeasuredExecutionRpcBudget({
      maxRequests: 100,
      deadlineMs: Date.now() - 1,
    });

    const outcomes = await quoteQuoterV2Requests({
      requests: [{ target, inputUsd: 1_000, endpointAddress: deployment.endpointAddress }],
      blockNumber: fixture.blockNumber,
      chainRpcs: new Map(),
      rpcBudget: budget,
    });

    expect(outcomes[0]?.failureReason).toBe("runtime-deadline-exceeded");
  });

  it("preserves the Quoter adaptive multicall golden unattempted result", async () => {
    const fixture = REPLAYS[0]!;
    const target = makeTarget(fixture);
    const deployment = getDexMeasuredExecutionDeployment(fixture.adapterProfileId, fixture.chain)!;
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockResolvedValue(null);
    const budget = createDexMeasuredExecutionRpcBudget({
      maxRequests: 100,
      deadlineMs: Date.now() + 60_000,
    });

    const outcomes = await quoteQuoterV2Requests({
      requests: Array.from({ length: 4 }, () => ({
        target,
        inputUsd: 1_000,
        endpointAddress: deployment.endpointAddress,
      })),
      blockNumber: fixture.blockNumber,
      chainRpcs: new Map(),
      rpcBudget: budget,
    });

    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mock.calls.map((call) => call[1].length)).toEqual([
      4, 2, 1, 1,
    ]);
    expect(budget.openChains).toEqual([fixture.chain]);
    expect(outcomes.map((outcome) => outcome.failureReason)).toEqual([
      "quoter-rpc-unavailable",
      "quoter-rpc-unavailable",
      "quoter-rpc-unavailable",
      "quoter-rpc-unavailable",
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

  it("retains a decoded singleton revert as a non-passing capacity proof", async () => {
    const fixture = REPLAYS[0]!;
    const target = makeTarget(fixture);
    const deployment = getDexMeasuredExecutionDeployment(fixture.adapterProfileId, fixture.chain)!;
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(
      async (_chain: string, calls: Array<{ label: string }>) =>
        calls.map((call) => ({ label: call.label, success: false, returnData: "0x" })),
    );

    const [outcome] = await quoteQuoterV2Requests({
      requests: [{ target, inputUsd: 100_000, endpointAddress: deployment.endpointAddress }],
      blockNumber: fixture.blockNumber,
      chainRpcs: new Map(),
    });

    expect(outcome?.failureReason).toBeUndefined();
    expect(outcome?.point).toMatchObject({
      amountOutRaw: "0",
      returnData: "0x",
      inputUsd: 100_000,
      outputUsd: 0,
      costBps: 10_000,
      passesCostBound: false,
      reverted: true,
    });
    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock).toHaveBeenCalledTimes(2);
  });

  it("keeps RPC transport failures operationally degraded", async () => {
    const fixture = REPLAYS[0]!;
    const target = makeTarget(fixture);
    const deployment = getDexMeasuredExecutionDeployment(fixture.adapterProfileId, fixture.chain)!;
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockResolvedValue(null);

    const [outcome] = await quoteQuoterV2Requests({
      requests: [{ target, inputUsd: 100_000, endpointAddress: deployment.endpointAddress }],
      blockNumber: fixture.blockNumber,
      chainRpcs: new Map(),
    });

    expect(outcome).toEqual({
      targetId: target.targetId,
      inputUsd: 100_000,
      failureReason: "quoter-rpc-unavailable",
    });
  });

  it("keeps malformed successful returndata operationally degraded", async () => {
    const fixture = REPLAYS[0]!;
    const target = makeTarget(fixture);
    const deployment = getDexMeasuredExecutionDeployment(fixture.adapterProfileId, fixture.chain)!;
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(
      async (_chain: string, calls: Array<{ label: string }>) =>
        calls.map((call) => ({ label: call.label, success: true, returnData: "0x1234" })),
    );

    const [outcome] = await quoteQuoterV2Requests({
      requests: [{ target, inputUsd: 100_000, endpointAddress: deployment.endpointAddress }],
      blockNumber: fixture.blockNumber,
      chainRpcs: new Map(),
    });

    expect(outcome).toEqual({
      targetId: target.targetId,
      inputUsd: 100_000,
      failureReason: "quoter-invalid-result",
    });
  });

  it("rejects a reverted proof carrying ABI-decodable success data", () => {
    const fixture = REPLAYS[0]!;
    const target = makeTarget(fixture);
    const deployment = getDexMeasuredExecutionDeployment(fixture.adapterProfileId, fixture.chain)!;
    const profile: DexMeasuredExecutionProfile = {
      schemaVersion: DEX_MEASURED_EXECUTION_SCHEMA_VERSION,
      kind: "measured-executable-depth",
      targetId: target.targetId,
      targetGenerationId: "targets-1",
      quoteGenerationId: "quotes-1",
      adapterProfileId: target.adapterProfileId,
      protocol: target.protocol,
      chain: target.chain,
      poolId: target.poolId,
      tokenIn: target.tokenIn,
      tokenOut: target.tokenOut,
      feePips: target.feePips,
      retainedTvlUsdAtQuote: target.retainedTvlUsd,
      retainedPoolPriceUsdAtQuote: target.retainedPoolPriceUsd,
      quotedAt: target.capturedAt,
      blockNumber: fixture.blockNumber,
      executionEndpoint: {
        address: deployment.endpointAddress,
        codeHash: deployment.expectedCodeHash,
      },
      maxCostBps: DEX_MEASURED_MAX_COST_BPS,
      marginalOutputRatio: 0,
      capacityCurve: DEX_MEASURED_CAPACITY_NOTIONALS_USD.map((requestedNotionalUsd) => ({
        requestedNotionalUsd,
        maxCostBps: DEX_MEASURED_MAX_COST_BPS,
        executableUsd: 0,
        completionRatio: 0,
      })),
      quoteProof: [{
        amountInRaw: "1000000000",
        amountOutRaw: "0",
        callData: encodeQuoterV2ExactInputSingle(target, 1_000_000_000n),
        returnData: fixture.quoteReturnData,
        inputUsd: 1_000,
        outputUsd: 0,
        costBps: 10_000,
        passesCostBound: false,
        reverted: true as const,
      }],
    };

    expect(validateQuoterV2ProfileProof(profile)).toContain("revert-data-decodes-as-success");
  });
});
