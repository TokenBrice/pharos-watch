import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  parseAbi,
} from "viem/utils";
import { describe, expect, it, vi } from "vitest";

import {
  buildDexMeasuredExecutionTargetId,
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
import type { EvmMulticall3Call } from "../../../lib/evm-rpc";

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
      callData: encodeFunctionData({
        abi: POOL_ABI,
        functionName: "coins",
        args: [BigInt(index)],
      }).toLowerCase() as `0x${string}`,
      returnData: encodeFunctionResult({
        abi: POOL_ABI,
        functionName: "coins",
        result: token.address,
      }).toLowerCase() as `0x${string}`,
    })),
    tokenDecimalsProof: policy.poolTokens.map((token) => ({
      tokenAddress: token.address,
      decimals: token.decimals,
      callData: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "decimals",
      }).toLowerCase() as `0x${string}`,
      returnData: encodeFunctionResult({
        abi: ERC20_ABI,
        functionName: "decimals",
        result: token.decimals,
      }).toLowerCase() as `0x${string}`,
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
  return {
    schemaVersion: "dex-measured-target-v1",
    targetId: buildDexMeasuredExecutionTargetId({
      adapterProfileId: CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
      stablecoinId: stablecoinIds[inputIndex]!,
      chain: policy.chain,
      protocol: "curve",
      poolId,
      tokenInAddress: tokenIn.address,
      tokenOutAddress: tokenOut.address,
      poolTokenAddresses,
    }),
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
  };
}

describe("Curve legacy StableSwap 3pool policy", () => {
  it("is exact to the reviewed main-registry pool and distinct from CryptoSwap", () => {
    expect(CURVE_STABLESWAP_ADAPTER_PROFILE_ID).toBe("curve-stableswap-main-registry-get-dy-v1");
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
      fetchBlockTimestamp: vi.fn(async () => BLOCK_TIMESTAMP),
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
        fetchBlockTimestamp: vi.fn(async () => BLOCK_TIMESTAMP),
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
      fetchBlockTimestamp: vi.fn(async () => BLOCK_TIMESTAMP),
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
          blockObservedAt: BLOCK_TIMESTAMP + 60,
          endpointAddress: CURVE_3POOL_STABLESWAP_POLICY.poolAddress,
          runtimeEvidence: runtimeEvidence(),
        },
        {
          target: usdcToUsdt,
          inputUsd: 25_000_000,
          blockNumber: BLOCK_NUMBER,
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
    profile.registryBindingProof!.tokenDecimalsProof[2]!.decimals = 18;
    expect(validateCurveStableSwapProfileProof(profile)).toContain("token-decimals-proof-mismatch");
  });
});
