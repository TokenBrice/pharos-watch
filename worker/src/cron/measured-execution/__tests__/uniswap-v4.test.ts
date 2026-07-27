import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
} from "viem/utils";

const rpcMocks = vi.hoisted(() => ({
  fetchEvmCodeAtBlock: vi.fn(),
  fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
}));

vi.mock("../../../lib/evm-rpc", () => ({
  fetchEvmCodeAtBlock: rpcMocks.fetchEvmCodeAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock:
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock,
}));

import { buildDexMeasuredExecutionTargetId } from "@shared/types/measured-execution";
import {
  buildUniswapV4MeasuredExecutionTarget,
  type UniswapV4ExecutionCandidate,
} from "../inventory";
import { buildDexMeasuredExecutionProfile } from "../profiles";
import {
  UNISWAP_V4_ADAPTER_PROFILE_ID,
  UNISWAP_V4_HOOK_FREE_ADDRESS,
  computeUniswapV4PoolId,
  getUniswapV4Deployment,
  quoteUniswapV4Requests,
  resolveUniswapV4PoolBindings,
  validateUniswapV4ProfileProof,
} from "../uniswap-v4";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const BLOCK = 25_618_353;
const POOL_ID = computeUniswapV4PoolId({
  currency0: USDC,
  currency1: USDT,
  feePips: 100,
  tickSpacing: 1,
  hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
});

function candidate(
  hookAddress: `0x${string}` = UNISWAP_V4_HOOK_FREE_ADDRESS,
): UniswapV4ExecutionCandidate {
  return {
    chain: "ethereum",
    poolId: POOL_ID,
    feePips: 100,
    tickSpacing: 1,
    hookAddress,
    tvlUsd: 20_000_000,
    token0Price: 1,
    token1Price: 1,
    tokens: [
      { address: USDC, symbol: "USDC", decimals: 6 },
      { address: USDT, symbol: "USDT", decimals: 6 },
    ],
  };
}

function target() {
  const result = buildUniswapV4MeasuredExecutionTarget({
    stablecoinId: "usdc-circle",
    candidate: candidate(),
    stablecoinPriceById: new Map([
      ["usdc-circle", 1],
      ["usdt-tether", 1],
    ]),
    chainAddressToId: new Map([
      [`ethereum:${USDC}`, "usdc-circle"],
      [`ethereum:${USDT}`, "usdt-tether"],
    ]),
    retainedTvlUsd: 20_000_000,
    capturedAt: 1_785_000_000,
  });
  if (!result) throw new Error("missing V4 target fixture");
  return result;
}

describe("hook-free Uniswap V4 measured execution", () => {
  beforeEach(() => {
    rpcMocks.fetchEvmCodeAtBlock.mockReset();
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockReset();
  });

  it("builds only a reviewed exact hook-free PoolKey target", () => {
    const measuredTarget = target();
    expect(measuredTarget).toMatchObject({
      adapterProfileId: UNISWAP_V4_ADAPTER_PROFILE_ID,
      protocol: "uniswap-v4",
      chain: "ethereum",
      poolId: `ethereum:${POOL_ID}`,
      poolTokenAddresses: [USDC, USDT],
      feePips: 100,
      tickSpacing: 1,
      hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
    });
    expect(measuredTarget.targetId).toBe(
      buildDexMeasuredExecutionTargetId({
        adapterProfileId: UNISWAP_V4_ADAPTER_PROFILE_ID,
        stablecoinId: "usdc-circle",
        chain: "ethereum",
        protocol: "uniswap-v4",
        poolId: `ethereum:${POOL_ID}`,
        tokenInAddress: USDC,
        tokenOutAddress: USDT,
        poolTokenAddresses: [USDC, USDT],
        feePips: 100,
        tickSpacing: 1,
        hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
      }),
    );

    expect(
      buildUniswapV4MeasuredExecutionTarget({
        stablecoinId: "usdc-circle",
        candidate: candidate("0x0000000000000000000000000000000000000001"),
        stablecoinPriceById: new Map([["usdc-circle", 1]]),
        chainAddressToId: new Map([[`ethereum:${USDC}`, "usdc-circle"]]),
        retainedTvlUsd: 20_000_000,
        capturedAt: 1_785_000_000,
      }),
    ).toBeNull();
  });

  it("decode-binds pinned StateView state and exact Quoter calldata", async () => {
    const measuredTarget = target();
    const deployment = getUniswapV4Deployment("ethereum");
    if (!deployment) throw new Error("missing V4 deployment");
    const poolManagerAbi = parseAbi([
      "function poolManager() view returns (address)",
    ]);
    const poolManagerCallData = encodeFunctionData({
      abi: poolManagerAbi,
      functionName: "poolManager",
    });
    const poolManagerReturnData = encodeAbiParameters(
      parseAbiParameters("address"),
      [deployment.poolManagerAddress],
    );
    const slot0ReturnData = encodeAbiParameters(
      parseAbiParameters(
        "uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee",
      ),
      [2n ** 96n, 0, 0, 100],
    );
    const liquidityReturnData = encodeAbiParameters(
      parseAbiParameters("uint128 liquidity"),
      [9_000_000_000_000n],
    );
    const quoteReturnData = encodeAbiParameters(
      parseAbiParameters("uint256 amountOut,uint256 gasEstimate"),
      [999_500_000n, 130_000n],
    );
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(
      async (_chain: string, calls: Array<{ label: string }>) =>
        calls.map((call) => ({
          label: call.label,
          success: true,
          returnData: call.label.endsWith(":slot0")
            ? slot0ReturnData
            : call.label.endsWith(":liquidity")
              ? liquidityReturnData
              : quoteReturnData,
        })),
    );

    const runtimeEvidence = {
      poolManagerCodeHash: deployment.expectedPoolManagerCodeHash,
      stateViewCodeHash: deployment.expectedStateViewCodeHash,
      quoterCodeHash: deployment.expectedCodeHash,
      quoterPoolManagerCallData: poolManagerCallData,
      quoterPoolManagerReturnData: poolManagerReturnData,
      stateViewPoolManagerCallData: poolManagerCallData,
      stateViewPoolManagerReturnData: poolManagerReturnData,
    };
    const bindings = await resolveUniswapV4PoolBindings({
      requests: [{ target: measuredTarget, deployment, runtimeEvidence }],
      blockNumber: BLOCK,
      chainRpcs: new Map(),
    });
    const quotes = await quoteUniswapV4Requests({
      requests: [
        {
          target: measuredTarget,
          inputUsd: 1_000,
          endpointAddress: deployment.endpointAddress,
        },
      ],
      blockNumber: BLOCK,
      chainRpcs: new Map(),
    });
    if (!bindings[0]?.proof || !quotes[0]?.point) {
      throw new Error("missing V4 proof fixture");
    }
    const profile = buildDexMeasuredExecutionProfile({
      target: measuredTarget,
      targetGenerationId: "targets",
      quoteGenerationId: "quotes",
      quotedAt: measuredTarget.capturedAt + 60,
      blockNumber: BLOCK,
      endpointAddress: deployment.endpointAddress,
      endpointCodeHash: deployment.expectedCodeHash,
      uniswapV4PoolProof: bindings[0].proof,
      points: [quotes[0].point],
    });

    expect(quotes[0].point).toMatchObject({
      amountInRaw: "1000000000",
      amountOutRaw: "999500000",
      passesCostBound: true,
    });
    expect(quotes[0].point.costBps).toBeCloseTo(5, 8);
    expect(validateUniswapV4ProfileProof(profile)).toEqual([]);

    profile.uniswapV4PoolProof!.poolId = `0x${"0".repeat(64)}`;
    expect(validateUniswapV4ProfileProof(profile)).toContain(
      "v4-runtime-or-pool-identity-mismatch",
    );
  });

  it("accepts V4 quote-shaped revert payloads as zero-execution proof points", async () => {
    const measuredTarget = target();
    const deployment = getUniswapV4Deployment("ethereum");
    if (!deployment) throw new Error("missing V4 deployment");
    const poolManagerAbi = parseAbi([
      "function poolManager() view returns (address)",
    ]);
    const poolManagerCallData = encodeFunctionData({
      abi: poolManagerAbi,
      functionName: "poolManager",
    });
    const poolManagerReturnData = encodeAbiParameters(
      parseAbiParameters("address"),
      [deployment.poolManagerAddress],
    );
    const slot0ReturnData = encodeAbiParameters(
      parseAbiParameters(
        "uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee",
      ),
      [2n ** 96n, 0, 0, 100],
    );
    const liquidityReturnData = encodeAbiParameters(
      parseAbiParameters("uint128 liquidity"),
      [9_000_000_000_000n],
    );
    const quoteReturnData = encodeAbiParameters(
      parseAbiParameters("uint256 amountOut,uint256 gasEstimate"),
      [999_500_000n, 130_000n],
    );
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(
      async (_chain: string, calls: Array<{ label: string }>) =>
        calls.map((call) => ({
          label: call.label,
          success: !call.label.includes(measuredTarget.targetId),
          returnData: call.label.endsWith(":slot0")
            ? slot0ReturnData
            : call.label.endsWith(":liquidity")
              ? liquidityReturnData
              : quoteReturnData,
        })),
    );

    const runtimeEvidence = {
      poolManagerCodeHash: deployment.expectedPoolManagerCodeHash,
      stateViewCodeHash: deployment.expectedStateViewCodeHash,
      quoterCodeHash: deployment.expectedCodeHash,
      quoterPoolManagerCallData: poolManagerCallData,
      quoterPoolManagerReturnData: poolManagerReturnData,
      stateViewPoolManagerCallData: poolManagerCallData,
      stateViewPoolManagerReturnData: poolManagerReturnData,
    };
    const bindings = await resolveUniswapV4PoolBindings({
      requests: [{ target: measuredTarget, deployment, runtimeEvidence }],
      blockNumber: BLOCK,
      chainRpcs: new Map(),
    });
    const quotes = await quoteUniswapV4Requests({
      requests: [
        {
          target: measuredTarget,
          inputUsd: 1_000,
          endpointAddress: deployment.endpointAddress,
        },
      ],
      blockNumber: BLOCK,
      chainRpcs: new Map(),
    });
    if (!bindings[0]?.proof || !quotes[0]?.point) {
      throw new Error("missing V4 proof fixture");
    }
    const profile = buildDexMeasuredExecutionProfile({
      target: measuredTarget,
      targetGenerationId: "targets",
      quoteGenerationId: "quotes",
      quotedAt: measuredTarget.capturedAt + 60,
      blockNumber: BLOCK,
      endpointAddress: deployment.endpointAddress,
      endpointCodeHash: deployment.expectedCodeHash,
      uniswapV4PoolProof: bindings[0].proof,
      points: [quotes[0].point],
    });

    expect(quotes[0].point).toMatchObject({
      amountOutRaw: "0",
      outputUsd: 0,
      passesCostBound: false,
      reverted: true,
    });
    expect(validateUniswapV4ProfileProof(profile)).toEqual([]);
  });
});
