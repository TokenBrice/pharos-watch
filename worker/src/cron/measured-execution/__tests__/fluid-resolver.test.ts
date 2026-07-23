import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDexMeasuredExecutionTargetId,
  validateDexMeasuredExecutionProfile,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";

const rpcMocks = vi.hoisted(() => ({
  fetchEvmCodeAtBlock: vi.fn(),
  fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
}));
const viemMocks = vi.hoisted(() => ({
  keccak256: vi.fn(),
}));

vi.mock("../../../lib/evm-rpc", () => rpcMocks);
vi.mock("viem/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem/utils")>()),
  keccak256: viemMocks.keccak256,
}));

import {
  buildDexMeasuredExecutionProfile,
  createDexMeasuredExecutionRpcBudget,
} from "../profiles";
import {
  FLUID_RESOLVER_ADAPTER_PROFILE_ID,
  FLUID_RESOLVER_DEPLOYMENTS,
  decodeFluidEstimateSwapIn,
  decodeFluidResolverQuotePoint,
  encodeFluidEstimateSwapIn,
  getFluidResolverDeployment,
  quoteFluidResolverRequests,
  resolveFluidPoolAddress,
  resolveFluidSwapDirection,
  validateFluidResolverProfileProof,
  verifyFluidResolverDeployment,
} from "../fluid-resolver";

const ETHEREUM_BLOCK = 25_536_857;
const FLUID_USDC_USDT_POOL = "0x667701e51b4d1ca244f17c78f7ab8744b4c99f9b";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f";
const ETHEREUM_CODE_HASH = "0x354034a96ded2ea80cab41cc6baac559a19a85f9f4054edd538b7e760c24a020";
const ZERO_CODE_HASH = `0x${"00".repeat(32)}` as `0x${string}`;

function uint256Return(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function makeTarget(overrides: Partial<DexMeasuredExecutionTarget> = {}): DexMeasuredExecutionTarget {
  const target: DexMeasuredExecutionTarget = {
    schemaVersion: "dex-measured-target-v1",
    targetId: "fluid-usdc-usdt-forward",
    stablecoinId: "usdc-circle",
    adapterProfileId: FLUID_RESOLVER_ADAPTER_PROFILE_ID,
    protocol: "fluid",
    chain: "ethereum",
    poolId: FLUID_USDC_USDT_POOL,
    poolTokenAddresses: [USDC, USDT],
    tokenIn: {
      address: USDC,
      symbol: "USDC",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdc-circle",
    },
    tokenOut: {
      address: USDT,
      symbol: "USDT",
      decimals: 6,
      referencePriceUsd: 1,
      trackedAssetId: "usdt-tether",
    },
    retainedTvlUsd: 100_000,
    retainedPoolPriceUsd: 1,
    capturedAt: 1_752_500_000,
    ...overrides,
  };
  if (overrides.targetId == null) {
    target.targetId = buildDexMeasuredExecutionTargetId({
      adapterProfileId: target.adapterProfileId,
      stablecoinId: target.stablecoinId,
      chain: target.chain,
      protocol: target.protocol,
      poolId: target.poolId,
      tokenInAddress: target.tokenIn.address,
      tokenOutAddress: target.tokenOut.address,
      ...(target.poolTokenAddresses ? { poolTokenAddresses: target.poolTokenAddresses } : {}),
      ...(target.feePips != null ? { feePips: target.feePips } : {}),
    });
  }
  return target;
}

function makeDecodeRequest(
  input: {
    target?: DexMeasuredExecutionTarget;
    amountInRaw?: bigint;
    swap0To1?: boolean;
    blockNumber?: number;
  } = {},
) {
  const deployment = getFluidResolverDeployment("ethereum");
  if (deployment == null) throw new Error("missing Ethereum deployment fixture");
  const target = input.target ?? makeTarget();
  const amountInRaw = input.amountInRaw ?? 1_000_000_000n;
  const swap0To1 = input.swap0To1 ?? true;
  return {
    target,
    amountInRaw,
    swap0To1,
    blockNumber: input.blockNumber ?? ETHEREUM_BLOCK,
    deployment,
    callData: encodeFluidEstimateSwapIn({
      poolAddress: FLUID_USDC_USDT_POOL,
      swap0To1,
      amountInRaw,
    }),
  };
}

describe("Fluid resolver deployment registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    viemMocks.keccak256.mockReturnValue(ETHEREUM_CODE_HASH);
  });

  it("pins four reviewed resolver deployments as shadow and score-ineligible", () => {
    expect(FLUID_RESOLVER_DEPLOYMENTS).toHaveLength(4);
    expect(FLUID_RESOLVER_DEPLOYMENTS.map((deployment) => deployment.chain)).toEqual([
      "ethereum",
      "arbitrum",
      "base",
      "polygon",
    ]);
    expect(
      FLUID_RESOLVER_DEPLOYMENTS.every(
        (deployment) => deployment.mode === "shadow" && deployment.scoreEligible === false,
      ),
    ).toBe(true);
  });

  it("fails closed when pinned-block resolver bytecode drifts", async () => {
    rpcMocks.fetchEvmCodeAtBlock.mockResolvedValue("0x6000");
    viemMocks.keccak256.mockReturnValue(ZERO_CODE_HASH);
    const deployment = getFluidResolverDeployment("ethereum");
    if (deployment == null) throw new Error("missing Ethereum deployment fixture");

    await expect(
      verifyFluidResolverDeployment({
        deployment,
        blockNumber: ETHEREUM_BLOCK,
        chainRpcs: new Map(),
      }),
    ).resolves.toEqual({ ok: false, reason: "resolver-code-hash-mismatch" });
    expect(rpcMocks.fetchEvmCodeAtBlock).toHaveBeenCalledWith(
      "ethereum",
      deployment.endpointAddress,
      ETHEREUM_BLOCK,
      expect.objectContaining({ timeoutMs: 15_000, maxRetries: 0 }),
    );
  });
});

describe("Fluid token order and ABI proof", () => {
  it("derives only directions that exactly match the reviewed pool token order", () => {
    expect(resolveFluidSwapDirection(makeTarget())).toEqual({ ok: true, swap0To1: true });
    expect(
      resolveFluidSwapDirection(
        makeTarget({
          targetId: "fluid-usdc-usdt-reverse",
          stablecoinId: "usdt-tether",
          tokenIn: makeTarget().tokenOut,
          tokenOut: makeTarget().tokenIn,
        }),
      ),
    ).toEqual({ ok: true, swap0To1: false });
    expect(resolveFluidSwapDirection(makeTarget({ poolTokenAddresses: undefined }))).toEqual({
      ok: false,
      reason: "missing-pool-token-order",
    });
    expect(resolveFluidSwapDirection(makeTarget({ tokenOut: { ...makeTarget().tokenOut, address: DAI } }))).toEqual({
      ok: false,
      reason: "token-order-mismatch",
    });

    const threeTokenOrder = makeTarget({
      poolTokenAddresses: [USDC, USDT],
    }) as DexMeasuredExecutionTarget & { poolTokenAddresses: readonly string[] };
    threeTokenOrder.poolTokenAddresses = [USDC, USDT, DAI];
    expect(resolveFluidSwapDirection(threeTokenOrder as DexMeasuredExecutionTarget)).toEqual({
      ok: false,
      reason: "invalid-pool-token-order",
    });
  });

  it("extracts only a raw pool address or an exactly matching chain-scoped pool identity", () => {
    expect(resolveFluidPoolAddress(makeTarget())).toBe(FLUID_USDC_USDT_POOL);
    expect(resolveFluidPoolAddress(makeTarget({ poolId: `ethereum:${FLUID_USDC_USDT_POOL}` }))).toBe(
      FLUID_USDC_USDT_POOL,
    );
    expect(resolveFluidPoolAddress(makeTarget({ poolId: `base:${FLUID_USDC_USDT_POOL}` }))).toBeNull();
    expect(resolveFluidPoolAddress(makeTarget({ poolId: `ethereum:pool:${FLUID_USDC_USDT_POOL}` }))).toBeNull();
  });

  it("reproduces the pinned Ethereum USDC to USDT canary calldata and return", () => {
    const callData = encodeFluidEstimateSwapIn({
      poolAddress: FLUID_USDC_USDT_POOL,
      swap0To1: true,
      amountInRaw: 1_000_000_000_000n,
    });
    expect(callData).toBe(
      "0xbb39e3a1000000000000000000000000667701e51b4d1ca244f17c78f7ab8744b4c99f9b" +
        "0000000000000000000000000000000000000000000000000000000000000001" +
        "000000000000000000000000000000000000000000000000000000e8d4a51000" +
        "0000000000000000000000000000000000000000000000000000000000000000",
    );
    const returnData = uint256Return(1_000_454_811_038n);
    expect(returnData).toBe("0x000000000000000000000000000000000000000000000000000000e8efc0ed9e");
    expect(decodeFluidEstimateSwapIn(returnData)).toBe(1_000_454_811_038n);

    const decoded = decodeFluidResolverQuotePoint(makeDecodeRequest({ amountInRaw: 1_000_000_000_000n }), {
      label: "canary",
      success: true,
      returnData,
    });
    expect(decoded.failureReason).toBeUndefined();
    expect(decoded.point).toMatchObject({
      amountInRaw: "1000000000000",
      amountOutRaw: "1000454811038",
      inputUsd: 1_000_000,
      outputUsd: 1_000_454.811038,
      costBps: 0,
      passesCostBound: true,
      callData,
      returnData,
    });
  });

  it("rejects a proof whose swap direction is reversed relative to token order", () => {
    const target = makeTarget();
    const point = decodeFluidResolverQuotePoint(makeDecodeRequest({ target, amountInRaw: 1_000_000_000n }), {
      label: "marginal",
      success: true,
      returnData: uint256Return(1_000_000_000n),
    }).point;
    if (point == null) throw new Error("missing quote point fixture");
    const deployment = getFluidResolverDeployment("ethereum");
    if (deployment == null) throw new Error("missing Ethereum deployment fixture");
    const profile = buildDexMeasuredExecutionProfile({
      target,
      targetGenerationId: "target-generation",
      quoteGenerationId: "quote-generation",
      quotedAt: target.capturedAt + 60,
      blockNumber: ETHEREUM_BLOCK,
      endpointAddress: deployment.endpointAddress,
      endpointCodeHash: deployment.expectedCodeHash,
      points: [
        {
          ...point,
          callData: encodeFluidEstimateSwapIn({
            poolAddress: FLUID_USDC_USDT_POOL,
            swap0To1: false,
            amountInRaw: 1_000_000_000n,
          }),
        },
      ],
    });

    expect(validateFluidResolverProfileProof(profile)).toContain("call-data-mismatch");
  });
});

describe("Fluid quote outcomes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    viemMocks.keccak256.mockReturnValue(ETHEREUM_CODE_HASH);
    rpcMocks.fetchEvmCodeAtBlock.mockResolvedValue("0x6000");
  });

  it("keeps a zero resolver return as a measured failing point and valid zero-capacity profile", () => {
    const target = makeTarget();
    const point = decodeFluidResolverQuotePoint(makeDecodeRequest({ target, amountInRaw: 1_000_000_000n }), {
      label: "zero-limit",
      success: true,
      returnData: uint256Return(0n),
    }).point;
    expect(point).toMatchObject({
      amountOutRaw: "0",
      outputUsd: 0,
      costBps: 10_000,
      passesCostBound: false,
      adapterMetadata: { zeroLimitReturn: true },
    });
    if (point == null) throw new Error("missing zero-limit quote point fixture");
    const deployment = getFluidResolverDeployment("ethereum");
    if (deployment == null) throw new Error("missing Ethereum deployment fixture");
    const profile = buildDexMeasuredExecutionProfile({
      target,
      targetGenerationId: "target-generation",
      quoteGenerationId: "quote-generation",
      quotedAt: target.capturedAt + 60,
      blockNumber: ETHEREUM_BLOCK,
      endpointAddress: deployment.endpointAddress,
      endpointCodeHash: deployment.expectedCodeHash,
      points: [point],
    });

    expect(profile.marginalOutputRatio).toBe(0);
    expect(profile.capacityCurve.every((capacityPoint) => capacityPoint.executableUsd === 0)).toBe(true);
    expect(
      validateDexMeasuredExecutionProfile({
        profile,
        quotedTarget: target,
        currentTarget: target,
        expectedTargetGenerationId: "target-generation",
        expectedQuoteGenerationId: "quote-generation",
        nowSec: target.capturedAt + 120,
      }),
    ).toEqual([]);
    expect(validateFluidResolverProfileProof(profile)).toEqual([]);
  });

  it("fails quote transport on revert and malformed single-word return data", () => {
    const request = makeDecodeRequest();
    expect(decodeFluidResolverQuotePoint(request, { label: "revert", success: false, returnData: "0x" })).toEqual({
      failureReason: "resolver-revert",
    });
    expect(decodeFluidResolverQuotePoint(request, { label: "malformed", success: true, returnData: "0x01" })).toEqual({
      failureReason: "malformed-resolver-return",
    });
    expect(decodeFluidEstimateSwapIn(`${uint256Return(1n)}00`)).toBeNull();
  });

  it("rejects an unpinned resolver address before any RPC call", async () => {
    const outcomes = await quoteFluidResolverRequests({
      requests: [
        {
          target: makeTarget(),
          inputUsd: 1_000,
          blockNumber: ETHEREUM_BLOCK,
          endpointAddress: "0x0000000000000000000000000000000000000001",
        },
      ],
      chainRpcs: new Map(),
    });

    expect(outcomes[0]?.failureReason).toBe("resolver-address-mismatch");
    expect(rpcMocks.fetchEvmCodeAtBlock).not.toHaveBeenCalled();
    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();
  });

  it("fails an oversized schema-valid input per target without aborting the batch", async () => {
    const deployment = getFluidResolverDeployment("ethereum");
    if (deployment == null) throw new Error("missing Ethereum deployment fixture");
    const target = makeTarget();
    target.tokenIn.decimals = 255;

    const outcomes = await quoteFluidResolverRequests({
      requests: [
        {
          target,
          inputUsd: 1_000,
          blockNumber: ETHEREUM_BLOCK,
          endpointAddress: deployment.endpointAddress,
        },
      ],
      chainRpcs: new Map(),
    });

    expect(outcomes[0]?.failureReason).toBe("invalid-quote-input");
    expect(rpcMocks.fetchEvmCodeAtBlock).not.toHaveBeenCalled();
    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();
  });

  it("attributes only the request rejected by the hard RPC budget to that budget", async () => {
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
    const deployment = getFluidResolverDeployment("ethereum");
    if (deployment == null) throw new Error("missing Ethereum deployment fixture");
    const budget = createDexMeasuredExecutionRpcBudget({
      maxRequests: 0,
      deadlineMs: Date.now() + 60_000,
    });

    const outcomes = await quoteFluidResolverRequests({
      requests: [{
        target: makeTarget(),
        inputUsd: 1_000,
        blockNumber: ETHEREUM_BLOCK,
        endpointAddress: deployment.endpointAddress,
      }],
      chainRpcs: new Map(),
      rpcBudget: budget,
      deploymentVerified: true,
    });

    expect(outcomes[0]?.failureReason).toBe("request-budget-exhausted");
  });

  it("does not relabel a genuine resolver revert from an already stopped budget", async () => {
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(
      async (_chain: string, calls: Array<{ label: string }>) =>
        calls.map((call) => ({ label: call.label, success: false, returnData: "0x" })),
    );
    const deployment = getFluidResolverDeployment("ethereum");
    if (deployment == null) throw new Error("missing Ethereum deployment fixture");
    const budget = createDexMeasuredExecutionRpcBudget({
      maxRequests: 0,
      deadlineMs: Date.now() + 60_000,
    });
    expect(budget.tryConsume()).toBe(false);

    const outcomes = await quoteFluidResolverRequests({
      requests: [{
        target: makeTarget(),
        inputUsd: 1_000,
        blockNumber: ETHEREUM_BLOCK,
        endpointAddress: deployment.endpointAddress,
      }],
      chainRpcs: new Map(),
      rpcBudget: budget,
      deploymentVerified: true,
    });

    expect(outcomes[0]?.failureReason).toBe("resolver-revert");
  });

  it("fails every block cohort before quoting when its resolver code hash drifts", async () => {
    viemMocks.keccak256.mockReturnValue(ZERO_CODE_HASH);
    const deployment = getFluidResolverDeployment("ethereum");
    if (deployment == null) throw new Error("missing Ethereum deployment fixture");
    const outcomes = await quoteFluidResolverRequests({
      requests: [
        {
          target: makeTarget(),
          inputUsd: 1_000,
          blockNumber: ETHEREUM_BLOCK,
          endpointAddress: deployment.endpointAddress,
        },
      ],
      chainRpcs: new Map(),
    });

    expect(outcomes[0]?.failureReason).toBe("resolver-code-hash-mismatch");
    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock).not.toHaveBeenCalled();
  });

  it("caps Multicall3 batches at eight calls and records zero-limit points", async () => {
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(
      async (_chain: string, calls: Array<{ label: string }>) =>
        calls.map((call) => ({ label: call.label, success: true, returnData: uint256Return(0n) })),
    );
    const deployment = getFluidResolverDeployment("ethereum");
    if (deployment == null) throw new Error("missing Ethereum deployment fixture");
    const target = makeTarget();
    const requests = Array.from({ length: 9 }, (_, index) => ({
      target,
      inputUsd: 1_000 + index,
      blockNumber: ETHEREUM_BLOCK,
      endpointAddress: deployment.endpointAddress,
    }));

    const outcomes = await quoteFluidResolverRequests({ requests, chainRpcs: new Map() });

    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock).toHaveBeenCalledTimes(2);
    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mock.calls.map((call) => call[1])).toEqual([
      expect.arrayContaining(
        Array.from({ length: 8 }, (_, index) =>
          expect.objectContaining({
            label: `${index}:${target.targetId}`,
            allowFailure: true,
          }),
        ),
      ),
      [expect.objectContaining({ label: `8:${target.targetId}`, allowFailure: true })],
    ]);
    expect(outcomes).toHaveLength(9);
    expect(outcomes.every((outcome) => outcome.point?.passesCostBound === false)).toBe(true);
    expect(outcomes.every((outcome) => outcome.failureReason == null)).toBe(true);
  });

  it("processes different pinned blocks on the same chain sequentially", async () => {
    let activeCodeChecks = 0;
    let maxActiveCodeChecks = 0;
    rpcMocks.fetchEvmCodeAtBlock.mockImplementation(async () => {
      activeCodeChecks += 1;
      maxActiveCodeChecks = Math.max(maxActiveCodeChecks, activeCodeChecks);
      await Promise.resolve();
      activeCodeChecks -= 1;
      return "0x6000";
    });
    rpcMocks.fetchEvmMulticall3Aggregate3AtBlock.mockImplementation(
      async (_chain: string, calls: Array<{ label: string }>) =>
        calls.map((call) => ({ label: call.label, success: true, returnData: uint256Return(0n) })),
    );
    const deployment = getFluidResolverDeployment("ethereum");
    if (deployment == null) throw new Error("missing Ethereum deployment fixture");

    await quoteFluidResolverRequests({
      requests: [ETHEREUM_BLOCK, ETHEREUM_BLOCK + 1].map((blockNumber) => ({
        target: makeTarget(),
        inputUsd: 1_000,
        blockNumber,
        endpointAddress: deployment.endpointAddress,
      })),
      chainRpcs: new Map(),
    });

    expect(maxActiveCodeChecks).toBe(1);
    expect(rpcMocks.fetchEvmCodeAtBlock).toHaveBeenCalledTimes(2);
    expect(rpcMocks.fetchEvmMulticall3Aggregate3AtBlock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when stored endpoint identity no longer matches a pin", () => {
    const target = makeTarget();
    const point = decodeFluidResolverQuotePoint(makeDecodeRequest({ target, amountInRaw: 1_000_000_000n }), {
      label: "marginal",
      success: true,
      returnData: uint256Return(1_000_000_000n),
    }).point;
    if (point == null) throw new Error("missing quote point fixture");
    const deployment = getFluidResolverDeployment("ethereum");
    if (deployment == null) throw new Error("missing Ethereum deployment fixture");
    const profile = buildDexMeasuredExecutionProfile({
      target,
      targetGenerationId: "target-generation",
      quoteGenerationId: "quote-generation",
      quotedAt: target.capturedAt + 60,
      blockNumber: ETHEREUM_BLOCK,
      endpointAddress: deployment.endpointAddress,
      endpointCodeHash: deployment.expectedCodeHash,
      points: [point],
    });
    const drifted = {
      ...profile,
      executionEndpoint: { ...profile.executionEndpoint, codeHash: ZERO_CODE_HASH },
    } as DexMeasuredExecutionProfile;

    expect(validateFluidResolverProfileProof(drifted)).toContain("resolver-identity-mismatch");
  });
});
