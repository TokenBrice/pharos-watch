import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodeFunctionResult,
  parseAbi,
  parseAbiParameters,
} from "viem/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { recordDwellirCredits } = vi.hoisted(() => ({ recordDwellirCredits: vi.fn() }));
vi.mock("../../../lib/rpc-provider-budget", () => ({ recordDwellirCredits }));

import {
  DEX_MEASURED_ADAPTER_PROFILE_IDS,
  type DexMeasuredExecutionRegistryBindingProof,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import {
  CURVE_3POOL_STABLESWAP_POLICY,
  CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
  createCurveStableSwapDeploymentVerifier,
  createCurveStableSwapQuoteExecutor,
  decodeCurveStableSwapGetDy,
  encodeCurveStableSwapGetDy,
  evaluateCurveStableSwapEligibility,
  resolveCurveStableSwapTokenIndices,
  validateCurveStableSwapProfileProof,
  type CurveStableSwapRuntimeEvidence,
} from "../curve-stableswap";
import { buildDexMeasuredExecutionProfile } from "../profiles";
import { buildChainRpcs } from "../../../lib/chain-registry";
import { executeCurveGetDyMulticall } from "../curve-stableswap-execution-pipeline";
import type { EvmMulticall3Call } from "../../../lib/evm-rpc";
import { makeMeasuredTarget } from "@shared/test-utils/measured-execution.test-support";
import { poolCoinProof, tokenDecimalsProof } from "./curve-proof.test-support";

const POOL_ABI = parseAbi([
  "function coins(uint256) view returns (address)",
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
const REGISTRY_ABI = parseAbi([
  "function get_lp_token(address pool) view returns (address)",
  "function get_coins(address pool) view returns (address[8])",
]);
const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);
const BLOCK_NUMBER = 25_601_051;
const BLOCK_TIMESTAMP = 1_784_877_491;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function registryProof(): DexMeasuredExecutionRegistryBindingProof {
  const policy = CURVE_3POOL_STABLESWAP_POLICY;
  const lpTokenCallData = encodeFunctionData({
    abi: REGISTRY_ABI,
    functionName: "get_lp_token",
    args: [policy.poolAddress],
  }).toLowerCase() as `0x${string}`;
  const registryCoinsCallData = encodeFunctionData({
    abi: REGISTRY_ABI,
    functionName: "get_coins",
    args: [policy.poolAddress],
  }).toLowerCase() as `0x${string}`;
  return {
    registryAddress: policy.registryAddress,
    registryCodeHash: policy.expectedRegistryCodeHash,
    registeredPoolAddress: policy.poolAddress,
    lpTokenAddress: policy.lpTokenAddress,
    poolTokenAddresses: policy.poolTokens.map((token) => token.address),
    lpTokenCallData,
    lpTokenReturnData: encodeFunctionResult({
      abi: REGISTRY_ABI,
      functionName: "get_lp_token",
      result: policy.lpTokenAddress,
    }).toLowerCase() as `0x${string}`,
    registryCoinsCallData,
    registryCoinsReturnData: encodeFunctionResult({
      abi: REGISTRY_ABI,
      functionName: "get_coins",
      result: [
        policy.poolTokens[0].address,
        policy.poolTokens[1].address,
        policy.poolTokens[2].address,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
      ],
    }).toLowerCase() as `0x${string}`,
    poolCoinsProof: policy.poolTokens.map((token, index) => ({
      index,
      ...poolCoinProof(index, token.address),
    })),
    tokenDecimalsProof: policy.poolTokens.map((token) => ({
      tokenAddress: token.address,
      decimals: token.decimals,
      ...tokenDecimalsProof(token.decimals),
    })),
  };
}

function runtimeEvidence(): CurveStableSwapRuntimeEvidence {
  return {
    blockTimestamp: BLOCK_TIMESTAMP,
    poolCodeHash: CURVE_3POOL_STABLESWAP_POLICY.expectedPoolCodeHash,
    registryBindingProof: registryProof(),
  };
}

function target(inputIndex: number, outputIndex: number): DexMeasuredExecutionTarget {
  const policy = CURVE_3POOL_STABLESWAP_POLICY;
  const tokenInPolicy = policy.poolTokens[inputIndex]!;
  const tokenOutPolicy = policy.poolTokens[outputIndex]!;
  const stablecoinIds = ["dai-makerdao", "usdc-circle", "usdt-tether"];
  const poolId = `${policy.chain}:${policy.poolAddress}`;
  const tokenIn = {
    address: tokenInPolicy.address,
    symbol: tokenInPolicy.symbol,
    decimals: tokenInPolicy.decimals,
    referencePriceUsd: tokenInPolicy.symbol === "USDT" ? 0.9992518040104241 : 1,
    trackedAssetId: stablecoinIds[inputIndex],
  };
  const tokenOut = {
    address: tokenOutPolicy.address,
    symbol: tokenOutPolicy.symbol,
    decimals: tokenOutPolicy.decimals,
    referencePriceUsd: tokenOutPolicy.symbol === "USDT" ? 0.9992518040104241 : 1,
    trackedAssetId: stablecoinIds[outputIndex],
  };
  const poolTokenAddresses = policy.poolTokens.map((token) => token.address);
  return makeMeasuredTarget({
    stablecoinId: stablecoinIds[inputIndex]!,
    adapterProfileId: CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
    protocol: "curve",
    chain: policy.chain,
    poolId,
    poolTokenAddresses,
    tokenIn,
    tokenOut,
    retainedTvlUsd: 160_047_206,
    retainedPoolPriceUsd: tokenIn.referencePriceUsd,
    capturedAt: BLOCK_TIMESTAMP - 60,
  });
}

describe("Curve legacy StableSwap 3pool policy", () => {
  it("is exact to the reviewed main-registry pool and distinct from CryptoSwap", () => {
    expect(CURVE_STABLESWAP_ADAPTER_PROFILE_ID).toBe(DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwap);
    expect(CURVE_3POOL_STABLESWAP_POLICY).toMatchObject({
      chain: "ethereum",
      poolAddress: "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7",
      registryAddress: "0x90e00ace148ca3b23ac1bc8c240c2a7dd9c2d7f5",
      lpTokenAddress: "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490",
      mode: "active",
      scoreEligible: true,
    });
    expect(CURVE_3POOL_STABLESWAP_POLICY.poolTokens).toEqual([
      expect.objectContaining({ symbol: "DAI", decimals: 18 }),
      expect.objectContaining({ symbol: "USDC", decimals: 6 }),
      expect.objectContaining({ symbol: "USDT", decimals: 6 }),
    ]);
  });

  it("preserves eligibility reason precedence and inclusive source-time boundaries", () => {
    for (const [blockNumber, timestamp, nowSec, reason] of [
      [-1, undefined, BLOCK_TIMESTAMP, "invalid-pinned-block"],
      [BLOCK_NUMBER, undefined, BLOCK_TIMESTAMP, "block-timestamp-unavailable"],
      [BLOCK_NUMBER, 0, BLOCK_TIMESTAMP, "block-timestamp-unavailable"],
      [BLOCK_NUMBER, BLOCK_TIMESTAMP, BLOCK_TIMESTAMP + 10_800, null],
      [BLOCK_NUMBER, BLOCK_TIMESTAMP, BLOCK_TIMESTAMP + 10_801, "stale-pinned-block"],
      [BLOCK_NUMBER, BLOCK_TIMESTAMP + 60, BLOCK_TIMESTAMP, null],
      [BLOCK_NUMBER, BLOCK_TIMESTAMP + 61, BLOCK_TIMESTAMP, "future-pinned-block"],
    ] as const) {
      expect(evaluateCurveStableSwapEligibility({
        chain: "ethereum", endpointAddress: CURVE_3POOL_STABLESWAP_POLICY.poolAddress, blockNumber, nowSec,
        evidence: timestamp === undefined ? undefined : { ...runtimeEvidence(), blockTimestamp: timestamp },
      })).toEqual(reason === null ? { ok: true } : { ok: false, reason });
    }
  });

  it("fails closed on registry, token-order, decimals, code, and stale-block drift", () => {
    const base = runtimeEvidence();
    const evaluate = (evidence: CurveStableSwapRuntimeEvidence, nowSec = BLOCK_TIMESTAMP + 60) =>
      evaluateCurveStableSwapEligibility({
        chain: "ethereum",
        endpointAddress: CURVE_3POOL_STABLESWAP_POLICY.poolAddress,
        blockNumber: BLOCK_NUMBER,
        nowSec,
        evidence,
      });

    expect(evaluate(base)).toEqual({ ok: true });
    expect(evaluate({
      ...base,
      poolCodeHash: `0x${"11".repeat(32)}`,
    })).toEqual({ ok: false, reason: "runtime-code-hash-mismatch" });
    expect(evaluate({
      ...base,
      registryBindingProof: {
        ...base.registryBindingProof,
        registryAddress: "0x1111111111111111111111111111111111111111",
      },
    })).toEqual({ ok: false, reason: "registry-membership-mismatch" });
    expect(evaluate({
      ...base,
      registryBindingProof: {
        ...base.registryBindingProof,
        poolTokenAddresses: [...base.registryBindingProof.poolTokenAddresses].reverse(),
      },
    })).toEqual({ ok: false, reason: "pool-token-order-mismatch" });
    expect(evaluate({
      ...base,
      registryBindingProof: {
        ...base.registryBindingProof,
        tokenDecimalsProof: base.registryBindingProof.tokenDecimalsProof.map((entry, index) =>
          index === 2 ? { ...entry, decimals: 18 } : entry
        ),
      },
    })).toEqual({ ok: false, reason: "token-decimals-mismatch" });
    expect(evaluate(base, BLOCK_TIMESTAMP + 10_801)).toEqual({
      ok: false,
      reason: "stale-pinned-block",
    });
  });

  it("rejects stale blocks and runtime code drift before quoting", async () => {
    const fetchCodeStatus = vi.fn(async () => ({
      status: "available" as const,
      code: "0x6000" as const,
    }));
    const verify = createCurveStableSwapDeploymentVerifier({
      fetchCodeStatus,
      fetchCall: vi.fn(async () => null),
      fetchBlockHeader: vi.fn(async () => ({ number: BLOCK_NUMBER, timestamp: BLOCK_TIMESTAMP, hash: `0x${"ab".repeat(32)}` as const })),
    });

    await expect(verify({
      blockNumber: BLOCK_NUMBER,
      nowSec: BLOCK_TIMESTAMP + 10_801,
      chainRpcs: new Map(),
    })).resolves.toEqual({ ok: false, reason: "stale-pinned-block" });
    expect(fetchCodeStatus).not.toHaveBeenCalled();

    await expect(verify({
      blockNumber: BLOCK_NUMBER,
      nowSec: BLOCK_TIMESTAMP + 60,
      chainRpcs: new Map(),
    })).resolves.toEqual({ ok: false, reason: "runtime-code-hash-mismatch" });
  });

  it("distinguishes absent runtime code from transport unavailability", async () => {
    const verify = (status: "absent" | "unavailable") =>
      createCurveStableSwapDeploymentVerifier({
        fetchCodeStatus: vi.fn(async () => ({ status })),
        fetchCall: vi.fn(async () => null),
        fetchBlockHeader: vi.fn(async () => ({ number: BLOCK_NUMBER, timestamp: BLOCK_TIMESTAMP, hash: `0x${"ab".repeat(32)}` as const })),
      })({
        blockNumber: BLOCK_NUMBER,
        nowSec: BLOCK_TIMESTAMP + 60,
        chainRpcs: new Map(),
      });

    await expect(verify("absent")).resolves.toEqual({
      ok: false,
      reason: "runtime-code-absent",
    });
    await expect(verify("unavailable")).resolves.toEqual({
      ok: false,
      reason: "runtime-code-unavailable",
    });
  });

  it("verifies one complete pinned pool and main-registry proof", async () => {
    const policy = CURVE_3POOL_STABLESWAP_POLICY;
    const fetchCall = vi.fn(async (_chain: string, address: string, callData: string) => {
      if (address === policy.registryAddress) {
        const decoded = decodeFunctionData({ abi: REGISTRY_ABI, data: callData as `0x${string}` });
        return decoded.functionName === "get_lp_token"
          ? encodeFunctionResult({
              abi: REGISTRY_ABI,
              functionName: "get_lp_token",
              result: policy.lpTokenAddress,
            })
          : encodeFunctionResult({
              abi: REGISTRY_ABI,
              functionName: "get_coins",
              result: [
                policy.poolTokens[0].address,
                policy.poolTokens[1].address,
                policy.poolTokens[2].address,
                ZERO_ADDRESS,
                ZERO_ADDRESS,
                ZERO_ADDRESS,
                ZERO_ADDRESS,
                ZERO_ADDRESS,
              ],
            });
      }
      if (address === policy.poolAddress) {
        const decoded = decodeFunctionData({ abi: POOL_ABI, data: callData as `0x${string}` });
        return encodeFunctionResult({
          abi: POOL_ABI,
          functionName: "coins",
          result: policy.poolTokens[Number(decoded.args[0])]!.address,
        });
      }
      const token = policy.poolTokens.find((candidate) => candidate.address === address);
      return token
        ? encodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", result: token.decimals })
        : null;
    });
    const verify = createCurveStableSwapDeploymentVerifier({
      fetchCodeStatus: vi.fn(async (_chain, address) => ({
        status: "available" as const,
        code: address === policy.poolAddress ? "0x6000" as const : "0x6001" as const,
      })),
      fetchCall,
      fetchBlockHeader: vi.fn(async () => ({ number: BLOCK_NUMBER, timestamp: BLOCK_TIMESTAMP, hash: `0x${"ab".repeat(32)}` as const })),
      hashCode: (code) =>
        code === "0x6000" ? policy.expectedPoolCodeHash : policy.expectedRegistryCodeHash,
    });

    const result = await verify({
      blockNumber: BLOCK_NUMBER,
      nowSec: BLOCK_TIMESTAMP + 60,
      chainRpcs: new Map(),
    });

    expect(result).toMatchObject({
      ok: true,
      codeHash: policy.expectedPoolCodeHash,
      blockTimestamp: BLOCK_TIMESTAMP,
      blockHash: `0x${"ab".repeat(32)}`,
      registryBindingProof: {
        registryAddress: policy.registryAddress,
        registryCodeHash: policy.expectedRegistryCodeHash,
        registeredPoolAddress: policy.poolAddress,
        lpTokenAddress: policy.lpTokenAddress,
        poolTokenAddresses: policy.poolTokens.map((token) => token.address),
      },
    });
    expect(fetchCall).toHaveBeenCalledTimes(8);
    expect(result.ok && result.registryBindingProof.poolCoinsProof[0]?.callData.slice(0, 10))
      .toBe("0xc6610657");
  });
});

describe("Curve legacy StableSwap 3pool quoting", () => {
  it("rejects DAI inputs and cross-wired tracked labels at the consumer token resolver", () => {
    for (const inputIndex of [1, 2]) {
      expect(resolveCurveStableSwapTokenIndices(target(inputIndex, 0)).ok).toBe(true);
    }
    const daiInput = target(0, 1);
    expect(resolveCurveStableSwapTokenIndices(daiInput).ok).toBe(false);
    daiInput.stablecoinId = "usdt-tether";
    daiInput.tokenIn.trackedAssetId = "usdt-tether";
    expect(resolveCurveStableSwapTokenIndices(daiInput).ok).toBe(false);
    const swappedLabel = target(2, 1);
    swappedLabel.tokenIn.trackedAssetId = "usdc-circle";
    expect(resolveCurveStableSwapTokenIndices(swappedLabel).ok).toBe(false);
    const wrongOutput = target(2, 0);
    wrongOutput.tokenOut.trackedAssetId = "usdc-circle";
    expect(resolveCurveStableSwapTokenIndices(wrongOutput).ok).toBe(false);
  });

  it("encodes the legacy int128 selector and decodes the pinned USDT output", () => {
    const callData = encodeCurveStableSwapGetDy({
      inputIndex: 2,
      outputIndex: 1,
      amountInRaw: 25_018_718_905_149n,
    });
    const decoded = decodeFunctionData({ abi: POOL_ABI, data: callData });
    expect(decoded).toMatchObject({
      functionName: "get_dy",
      args: [2n, 1n, 25_018_718_905_149n],
    });
    expect(decodeCurveStableSwapGetDy(
      encodeFunctionResult({
        abi: POOL_ABI,
        functionName: "get_dy",
        result: 24_884_311_382_815n,
      }),
    )).toBe(24_884_311_382_815n);
  });

  it("quotes USDT and USDC directions with independent token prices", async () => {
    const quote = createCurveStableSwapQuoteExecutor({
      executeMulticall: vi.fn(async ({ calls }: { calls: readonly EvmMulticall3Call[] }) =>
        calls.map((call) => {
          const decoded = decodeFunctionData({ abi: POOL_ABI, data: call.callData as `0x${string}` });
          const outputIndex = Number(decoded.args[1]);
          return {
            label: call.label,
            success: true,
            returnData: encodeFunctionResult({
              abi: POOL_ABI,
              functionName: "get_dy",
              result: outputIndex === 1 ? 24_884_311_382_815n : 24_900_000_000_000n,
            }),
          };
        })
      ),
    });
    const usdtToUsdc = target(2, 1);
    const usdcToUsdt = target(1, 2);
    const outcomes = await quote({
      requests: [
        {
          target: usdtToUsdc,
          inputUsd: 25_000_000,
          blockNumber: BLOCK_NUMBER,
          blockHash: `0x${"ab".repeat(32)}`,
          blockObservedAt: BLOCK_TIMESTAMP + 60,
          endpointAddress: CURVE_3POOL_STABLESWAP_POLICY.poolAddress,
          runtimeEvidence: runtimeEvidence(),
        },
        {
          target: usdcToUsdt,
          inputUsd: 25_000_000,
          blockNumber: BLOCK_NUMBER,
          blockHash: `0x${"ab".repeat(32)}`,
          blockObservedAt: BLOCK_TIMESTAMP + 60,
          endpointAddress: CURVE_3POOL_STABLESWAP_POLICY.poolAddress,
          runtimeEvidence: runtimeEvidence(),
        },
      ],
      chainRpcs: new Map(),
    });

    expect(resolveCurveStableSwapTokenIndices(usdtToUsdc)).toEqual({
      ok: true,
      inputIndex: 2,
      outputIndex: 1,
    });
    expect(resolveCurveStableSwapTokenIndices(usdcToUsdt)).toEqual({
      ok: true,
      inputIndex: 1,
      outputIndex: 2,
    });
    expect(outcomes).toEqual([
      expect.objectContaining({
        eligibility: { ok: true },
        point: expect.objectContaining({
          amountOutRaw: "24884311382815",
          passesCostBound: true,
        }),
      }),
      expect.objectContaining({
        eligibility: { ok: true },
        point: expect.objectContaining({
          amountOutRaw: "24900000000000",
          passesCostBound: true,
        }),
      }),
    ]);
    expect(outcomes[1]!.point?.outputUsd).toBeCloseTo(24_881_369.82, 2);
    expect(outcomes[1]!.point?.costBps).toBeGreaterThan(40);
  });

  it("fails the affected target on RPC failure and quote revert", async () => {
    const requests = [target(2, 1), target(1, 2)].map((quoteTarget) => ({
      target: quoteTarget,
      inputUsd: 100_000,
      blockNumber: BLOCK_NUMBER,
      blockHash: `0x${"ab".repeat(32)}` as const,
      blockObservedAt: BLOCK_TIMESTAMP + 60,
      endpointAddress: CURVE_3POOL_STABLESWAP_POLICY.poolAddress,
      runtimeEvidence: runtimeEvidence(),
    }));
    const rpcFailure = createCurveStableSwapQuoteExecutor({
      executeMulticall: vi.fn(async () => null),
    });
    await expect(rpcFailure({ requests, chainRpcs: new Map() })).resolves.toEqual([
      expect.objectContaining({ failureReason: "rpc-failure" }),
      expect.objectContaining({ failureReason: "rpc-failure" }),
    ]);

    const revert = createCurveStableSwapQuoteExecutor({
      executeMulticall: vi.fn(async ({ calls }: { calls: readonly EvmMulticall3Call[] }) =>
        calls.map((call) => ({ label: call.label, success: false, returnData: "0x" as const }))
      ),
    });
    await expect(revert({ requests, chainRpcs: new Map() })).resolves.toEqual([
      expect.objectContaining({ failureReason: "pool-revert" }),
      expect.objectContaining({ failureReason: "pool-revert" }),
    ]);
  });

  it("retains a realized cost breach as a failing capacity point", async () => {
    const quote = createCurveStableSwapQuoteExecutor({
      executeMulticall: vi.fn(async ({ calls }: { calls: readonly EvmMulticall3Call[] }) =>
        calls.map((call) => ({
          label: call.label,
          success: true,
          returnData: encodeFunctionResult({
            abi: POOL_ABI,
            functionName: "get_dy",
            result: 90_000_000_000n,
          }),
        }))
      ),
    });
    const measuredTarget = target(2, 1);
    const [outcome] = await quote({
      requests: [{
        target: measuredTarget,
        inputUsd: 100_000,
        blockNumber: BLOCK_NUMBER,
        blockHash: `0x${"ab".repeat(32)}`,
        blockObservedAt: BLOCK_TIMESTAMP + 60,
        endpointAddress: CURVE_3POOL_STABLESWAP_POLICY.poolAddress,
        runtimeEvidence: runtimeEvidence(),
      }],
      chainRpcs: new Map(),
    });

    expect(outcome?.point).toMatchObject({
      amountOutRaw: "90000000000",
      passesCostBound: false,
    });
    expect(outcome?.point?.costBps).toBeGreaterThan(999);
  });

  it("validates the quote ABI and the full registry proof", () => {
    const measuredTarget = target(2, 1);
    const callData = encodeCurveStableSwapGetDy({
      inputIndex: 2,
      outputIndex: 1,
      amountInRaw: 1_000_748_755n,
    });
    const returnData = encodeFunctionResult({
      abi: POOL_ABI,
      functionName: "get_dy",
      result: 999_500_000n,
    });
    const profile = buildDexMeasuredExecutionProfile({
      blockHash: `0x${"ab".repeat(32)}`,
      target: measuredTarget,
      targetGenerationId: "targets-1",
      quoteGenerationId: "quotes-1",
      quotedAt: BLOCK_TIMESTAMP,
      blockNumber: BLOCK_NUMBER,
      endpointAddress: CURVE_3POOL_STABLESWAP_POLICY.poolAddress,
      endpointCodeHash: CURVE_3POOL_STABLESWAP_POLICY.expectedPoolCodeHash,
      registryBindingProof: registryProof(),
      points: [{
        amountInRaw: "1000748755",
        amountOutRaw: "999500000",
        callData,
        returnData,
        inputUsd: 1_000,
        outputUsd: 999.5,
        costBps: 5,
        passesCostBound: true,
      }],
    });

    expect(validateCurveStableSwapProfileProof(profile)).toEqual([]);
    const mismatchedPool = { ...profile, poolId: "ethereum:0x1234567890123456789012345678901234567890" };
    expect(validateCurveStableSwapProfileProof(mismatchedPool)).toContain("execution-pool-identity-mismatch");
    const daiInput = { ...profile, tokenIn: { ...profile.tokenIn,
      address: CURVE_3POOL_STABLESWAP_POLICY.poolTokens[0].address, decimals: 18,
      trackedAssetId: "usdt-tether" } };
    expect(validateCurveStableSwapProfileProof(daiInput)).toContain("invalid-curve-stableswap-target");
    profile.registryBindingProof!.tokenDecimalsProof[2]!.decimals = 18;
    expect(validateCurveStableSwapProfileProof(profile)).toContain("token-decimals-proof-mismatch");
  });
});

const BLOCK_HASH = `0x${"ab".repeat(32)}` as const;
const POOL = "0x4444444444444444444444444444444444444444" as const;

function rpcResponse(body: { result?: string; error?: { code: number; message: string } }): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }), { status: 200 });
}

function aggregateResponse(count: number): Response {
  return rpcResponse({ result: encodeAbiParameters(
    parseAbiParameters("(bool success,bytes returnData)[]"),
    [Array.from({ length: count }, () => ({ success: true, returnData: `0x${"00".repeat(31)}01` as const }))],
  ) });
}

function setup() {
  const chainRpcs = buildChainRpcs("alchemy-test-key", undefined, { dwellirApiKey: "dwellir-test-key" });
  const config = chainRpcs.get("ethereum")!;
  const primary = config.endpoints.find((endpoint) => endpoint.operator === "dwellir")!;
  const fallback = config.endpoints.find((endpoint) => endpoint.operator === "alchemy")!;
  config.endpoints = [primary, fallback].map((endpoint) => ({ ...endpoint, position: "registry" as const }));
  return {
    primary: primary.url,
    fallback: fallback.url,
    execute: (count: number, splitOnExecutionBudgetError = true) => executeCurveGetDyMulticall({
      chain: "ethereum",
      calls: Array.from({ length: count }, (_, index) => ({
        label: `get_dy-${index}`, target: POOL, callData: "0x5e0d443f", allowFailure: true,
      })),
      blockNumber: 21_000_000,
      blockHash: BLOCK_HASH,
      chainRpcs,
      splitOnExecutionBudgetError,
    }),
  };
}

describe("Curve get_dy execution-budget failover", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    recordDwellirCredits.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    { code: -32000, message: "out of gas" },
    { code: -32003, message: "out of gas: gas required exceeds: 30000000" },
  ])("returns a multi-call OOG ($code) for splitting without replaying it on the next provider", async (error) => {
    const run = setup();
    fetchMock.mockImplementation(async () => rpcResponse({ error }));

    expect(await run.execute(8)).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([run.primary]);
  });

  it("keeps provider failover for non-adaptive callers that cannot split an OOG", async () => {
    const run = setup();
    fetchMock.mockImplementation(async (url) => url === run.primary
      ? rpcResponse({ error: { code: -32003, message: "out of gas: gas required exceeds: 30000000" } })
      : aggregateResponse(8));

    expect(await run.execute(8, false)).toHaveLength(8);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([run.primary, run.fallback]);
  });

  it("keeps provider failover for a singleton OOG", async () => {
    const run = setup();
    fetchMock.mockImplementation(async (url) => url === run.primary
      ? rpcResponse({ error: { code: -32003, message: "out of gas: gas required exceeds: 30000000" } })
      : aggregateResponse(1));

    expect(await run.execute(1)).toEqual([{ label: "get_dy-0", success: true, returnData: `0x${"00".repeat(31)}01` }]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([run.primary, run.fallback]);
  });

  it("keeps provider failover for non-execution-budget errors", async () => {
    const run = setup();
    fetchMock.mockImplementation(async (url) => url === run.primary
      ? rpcResponse({ error: { code: -32000, message: "header not found" } })
      : aggregateResponse(2));

    expect(await run.execute(2)).toHaveLength(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([run.primary, run.fallback]);
  });
});
