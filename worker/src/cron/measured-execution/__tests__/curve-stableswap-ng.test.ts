import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  parseAbi,
} from "viem/utils";
import { describe, expect, it, vi } from "vitest";

import {
  buildDexMeasuredExecutionTargetId,
  getDexMeasuredExecutionFreshnessMaxSec,
  type DexMeasuredExecutionStableSwapNgFactoryBindingProof,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import type { EvmBlockHeader, EvmMulticall3Call } from "../../../lib/evm-rpc";
import {
  CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
  CURVE_USDG_USDC_STABLESWAP_NG_POLICY,
  createCurveStableSwapNgDeploymentVerifier,
  createCurveStableSwapNgQuoteExecutor,
  decodeCurveStableSwapNgGetDy,
  encodeCurveStableSwapNgGetDy,
  evaluateCurveStableSwapNgEligibility,
  resolveCurveStableSwapNgTokenIndices,
  validateCurveStableSwapNgProfileProof,
  type CurveStableSwapNgRuntimeEvidence,
} from "../curve-stableswap-ng";
import { isOperationalDexMeasuredFailure } from "../persistence";
import { buildDexMeasuredExecutionProfile } from "../profiles";

const POOL_ABI = parseAbi([
  "function coins(uint256) view returns (address)",
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
const FACTORY_ABI = parseAbi([
  "function pool_list(uint256) view returns (address)",
  "function get_coins(address pool) view returns (address[])",
]);
const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);
const BLOCK_NUMBER = 25_601_359;
const BLOCK_TIMESTAMP = 1_784_881_199;
const BLOCK_HASH =
  "0xc59c64d548022d7bc442b9f64136b161ea031d3f1fb54a43d433653e5d1c24de" as const;

function factoryProof(): DexMeasuredExecutionStableSwapNgFactoryBindingProof {
  const policy = CURVE_USDG_USDC_STABLESWAP_NG_POLICY;
  const poolListCallData = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "pool_list",
    args: [BigInt(policy.factoryPoolIndex)],
  }).toLowerCase() as `0x${string}`;
  const factoryCoinsCallData = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: "get_coins",
    args: [policy.poolAddress],
  }).toLowerCase() as `0x${string}`;
  return {
    blockNumber: BLOCK_NUMBER,
    blockHash: BLOCK_HASH,
    blockCommitment: "finalized",
    factoryAddress: policy.factoryAddress,
    factoryCodeHash: policy.expectedFactoryCodeHash,
    poolIndex: policy.factoryPoolIndex,
    registeredPoolAddress: policy.poolAddress,
    poolTokenAddresses: policy.poolTokens.map((token) => token.address),
    poolListCallData,
    poolListReturnData: encodeFunctionResult({
      abi: FACTORY_ABI,
      functionName: "pool_list",
      result: policy.poolAddress,
    }).toLowerCase() as `0x${string}`,
    factoryCoinsCallData,
    factoryCoinsReturnData: encodeFunctionResult({
      abi: FACTORY_ABI,
      functionName: "get_coins",
      result: [
        policy.poolTokens[0].address,
        policy.poolTokens[1].address,
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

function runtimeEvidence(): CurveStableSwapNgRuntimeEvidence {
  return {
    blockTimestamp: BLOCK_TIMESTAMP,
    poolCodeHash: CURVE_USDG_USDC_STABLESWAP_NG_POLICY.expectedPoolCodeHash,
    factoryBindingProof: factoryProof(),
  };
}

async function validDeploymentCall(
  _chain: string,
  address: string,
  callData: string,
  _blockNumber?: number,
  _options?: unknown,
): Promise<`0x${string}` | null> {
  const policy = CURVE_USDG_USDC_STABLESWAP_NG_POLICY;
  if (address === policy.factoryAddress) {
    const decoded = decodeFunctionData({ abi: FACTORY_ABI, data: callData as `0x${string}` });
    return decoded.functionName === "pool_list"
      ? encodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "pool_list",
          result: policy.poolAddress,
        })
      : encodeFunctionResult({
          abi: FACTORY_ABI,
          functionName: "get_coins",
          result: policy.poolTokens.map((token) => token.address),
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
}

async function validDeploymentCode(
  _chain: string,
  address: string,
  _blockNumber?: number,
  _options?: unknown,
): Promise<{ status: "available"; code: `0x${string}` }> {
  return {
    status: "available",
    code: address === CURVE_USDG_USDC_STABLESWAP_NG_POLICY.poolAddress ? "0x6000" : "0x6001",
  };
}

function target(): DexMeasuredExecutionTarget {
  const policy = CURVE_USDG_USDC_STABLESWAP_NG_POLICY;
  const poolId = `${policy.chain}:${policy.poolAddress}`;
  const poolTokenAddresses = policy.poolTokens.map((token) => token.address);
  const tokenIn = {
    ...policy.poolTokens[policy.inputIndex],
    referencePriceUsd: 1,
  };
  const tokenOut = {
    ...policy.poolTokens[policy.outputIndex],
    referencePriceUsd: 1,
  };
  return {
    schemaVersion: "dex-measured-target-v1",
    targetId: buildDexMeasuredExecutionTargetId({
      adapterProfileId: CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
      stablecoinId: policy.stablecoinId,
      chain: policy.chain,
      protocol: "curve",
      poolId,
      tokenInAddress: tokenIn.address,
      tokenOutAddress: tokenOut.address,
      poolTokenAddresses,
    }),
    stablecoinId: policy.stablecoinId,
    adapterProfileId: CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
    protocol: "curve",
    chain: policy.chain,
    poolId,
    poolTokenAddresses,
    tokenIn,
    tokenOut,
    retainedTvlUsd: 20_501_133,
    retainedPoolPriceUsd: 1,
    capturedAt: BLOCK_TIMESTAMP - 60,
  };
}

describe("reviewed Curve StableSwap-NG policy", () => {
  it("admits only the exact USDG/USDC factory deployment and direction", () => {
    expect(CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID).toBe(
      "curve-stableswap-ng-factory-get-dy-v2",
    );
    expect(CURVE_USDG_USDC_STABLESWAP_NG_POLICY).toMatchObject({
      chain: "ethereum",
      stablecoinId: "usdg-paxos",
      poolAddress: "0xc061caa073f3d95f80f8e5428d32d2d76f5e1622",
      factoryAddress: "0x6a8cbed756804b16e05e741edabd5cb544ae21bf",
      factoryPoolIndex: 563,
      inputIndex: 0,
      outputIndex: 1,
      mode: "active",
      scoreEligible: true,
    });
    expect(resolveCurveStableSwapNgTokenIndices(target())).toEqual({
      ok: true,
      inputIndex: 0,
      outputIndex: 1,
    });
    expect(resolveCurveStableSwapNgTokenIndices({
      ...target(),
      tokenIn: target().tokenOut,
      tokenOut: target().tokenIn,
    })).toEqual({ ok: false, reason: "invalid-curve-stableswap-ng-target" });
    expect(resolveCurveStableSwapNgTokenIndices({
      ...target(),
      adapterProfileId: "curve-stableswap-ng-factory-get-dy-v1",
    })).toEqual({ ok: false, reason: "invalid-curve-stableswap-ng-target" });
  });

  it("fails closed on pool, factory, membership, token-order, and decimal drift", () => {
    const base = runtimeEvidence();
    const evaluate = (evidence: CurveStableSwapNgRuntimeEvidence) =>
      evaluateCurveStableSwapNgEligibility({
        chain: "ethereum",
        endpointAddress: CURVE_USDG_USDC_STABLESWAP_NG_POLICY.poolAddress,
        blockNumber: BLOCK_NUMBER,
        nowSec: BLOCK_TIMESTAMP + 60,
        evidence,
      });

    expect(evaluate(base)).toEqual({ ok: true });
    expect(evaluate({
      ...base,
      poolCodeHash: `0x${"34".repeat(32)}`,
    })).toEqual({ ok: false, reason: "runtime-code-hash-mismatch" });
    expect(evaluate({
      ...base,
      factoryBindingProof: {
        ...base.factoryBindingProof,
        factoryCodeHash: `0x${"56".repeat(32)}`,
      },
    })).toEqual({ ok: false, reason: "factory-code-hash-mismatch" });
    expect(evaluate({
      ...base,
      factoryBindingProof: {
        ...base.factoryBindingProof,
        registeredPoolAddress: "0x1111111111111111111111111111111111111111",
      },
    })).toEqual({ ok: false, reason: "factory-membership-mismatch" });
    expect(evaluate({
      ...base,
      factoryBindingProof: {
        ...base.factoryBindingProof,
        poolTokenAddresses: [...base.factoryBindingProof.poolTokenAddresses].reverse(),
      },
    })).toEqual({ ok: false, reason: "pool-token-order-mismatch" });
    expect(evaluate({
      ...base,
      factoryBindingProof: {
        ...base.factoryBindingProof,
        tokenDecimalsProof: base.factoryBindingProof.tokenDecimalsProof.map((entry, index) =>
          index === 0 ? { ...entry, decimals: 18 } : entry
        ),
      },
    })).toEqual({ ok: false, reason: "token-decimals-mismatch" });
  });

  it("selects an explicitly finalized header with a canonical block hash", async () => {
    const verifier = async (header: {
      number: number;
      timestamp: number;
      hash: `0x${string}`;
    } | null) => {
      const fetchBlockHeader = vi.fn(async () => header);
      const result = await createCurveStableSwapNgDeploymentVerifier({
        fetchCodeStatus: vi.fn(async () => ({ status: "unavailable" as const })),
        fetchCall: vi.fn(async () => null),
        fetchBlockHeader,
      })({
        nowSec: BLOCK_TIMESTAMP + 60,
        chainRpcs: new Map(),
      });
      expect(fetchBlockHeader).toHaveBeenCalledWith(
        "ethereum",
        "finalized",
        expect.any(Object),
      );
      return result;
    };

    await expect(verifier(null)).resolves.toEqual({
      ok: false,
      reason: "block-header-unavailable",
    });
    await expect(verifier({
      number: BLOCK_NUMBER,
      timestamp: BLOCK_TIMESTAMP,
      hash: "0x1234",
    })).resolves.toEqual({ ok: false, reason: "block-hash-invalid" });

    const mismatchedEvidence = runtimeEvidence();
    mismatchedEvidence.factoryBindingProof.blockNumber = BLOCK_NUMBER - 1;
    expect(evaluateCurveStableSwapNgEligibility({
      chain: "ethereum",
      endpointAddress: CURVE_USDG_USDC_STABLESWAP_NG_POLICY.poolAddress,
      blockNumber: BLOCK_NUMBER,
      nowSec: BLOCK_TIMESTAMP + 60,
      evidence: mismatchedEvidence,
    })).toEqual({ ok: false, reason: "block-header-mismatch" });
  });

  it("uses the shared two-hour Curve freshness boundary in producer eligibility", async () => {
    const freshnessMaxSec = getDexMeasuredExecutionFreshnessMaxSec(
      CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
    );
    expect(freshnessMaxSec).toBe(7_200);
    expect(evaluateCurveStableSwapNgEligibility({
      chain: "ethereum",
      endpointAddress: CURVE_USDG_USDC_STABLESWAP_NG_POLICY.poolAddress,
      blockNumber: BLOCK_NUMBER,
      nowSec: BLOCK_TIMESTAMP + freshnessMaxSec,
      evidence: runtimeEvidence(),
    })).toEqual({ ok: true });
    expect(evaluateCurveStableSwapNgEligibility({
      chain: "ethereum",
      endpointAddress: CURVE_USDG_USDC_STABLESWAP_NG_POLICY.poolAddress,
      blockNumber: BLOCK_NUMBER,
      nowSec: BLOCK_TIMESTAMP + freshnessMaxSec + 1,
      evidence: runtimeEvidence(),
    })).toEqual({ ok: false, reason: "stale-pinned-block" });

    const verify = createCurveStableSwapNgDeploymentVerifier({
      fetchCodeStatus: vi.fn(async () => ({ status: "unavailable" as const })),
      fetchCall: vi.fn(async () => null),
      fetchBlockHeader: vi.fn(async () => ({
        number: BLOCK_NUMBER,
        timestamp: BLOCK_TIMESTAMP,
        hash: BLOCK_HASH,
      })),
    });
    await expect(verify({
      nowSec: BLOCK_TIMESTAMP + freshnessMaxSec + 1,
      chainRpcs: new Map(),
    })).resolves.toEqual({ ok: false, reason: "stale-pinned-block" });
  });

  it("verifies one complete finalized pool and factory membership proof", async () => {
    const policy = CURVE_USDG_USDC_STABLESWAP_NG_POLICY;
    const fetchCall = vi.fn(validDeploymentCall);
    const fetchCodeStatus = vi.fn(validDeploymentCode);
    const fetchBlockHeader = vi.fn(async (
      _chain: string,
      _blockNumber: number | "finalized",
    ) => ({
      number: BLOCK_NUMBER,
      timestamp: BLOCK_TIMESTAMP,
      hash: BLOCK_HASH,
    }));
    const verify = createCurveStableSwapNgDeploymentVerifier({
      fetchCodeStatus,
      fetchCall,
      fetchBlockHeader,
      hashCode: (code) =>
        code === "0x6000" ? policy.expectedPoolCodeHash : policy.expectedFactoryCodeHash,
    });

    const result = await verify({
      nowSec: BLOCK_TIMESTAMP + 60,
      chainRpcs: new Map(),
    });

    expect(result).toMatchObject({
      ok: true,
      codeHash: policy.expectedPoolCodeHash,
      blockNumber: BLOCK_NUMBER,
      blockTimestamp: BLOCK_TIMESTAMP,
      factoryBindingProof: {
        blockNumber: BLOCK_NUMBER,
        blockHash: BLOCK_HASH,
        blockCommitment: "finalized",
        factoryAddress: policy.factoryAddress,
        factoryCodeHash: policy.expectedFactoryCodeHash,
        poolIndex: policy.factoryPoolIndex,
        registeredPoolAddress: policy.poolAddress,
        poolTokenAddresses: policy.poolTokens.map((token) => token.address),
      },
    });
    expect(fetchCall).toHaveBeenCalledTimes(6);
    expect(fetchCodeStatus.mock.calls.every((call) => call[2] === BLOCK_NUMBER)).toBe(true);
    expect(fetchCall.mock.calls.every((call) => call[3] === BLOCK_NUMBER)).toBe(true);
    expect(fetchBlockHeader.mock.calls.map((call) => call[1])).toEqual([
      "finalized",
      BLOCK_NUMBER,
    ]);
  });

  it("rejects a finalized header that changes or disappears during identity reads", async () => {
    const policy = CURVE_USDG_USDC_STABLESWAP_NG_POLICY;
    const header = {
      number: BLOCK_NUMBER,
      timestamp: BLOCK_TIMESTAMP,
      hash: BLOCK_HASH,
    } as const;
    const run = async (secondHeader: EvmBlockHeader | null) => {
      const fetchBlockHeader = vi.fn()
        .mockResolvedValueOnce(header)
        .mockResolvedValueOnce(secondHeader);
      return createCurveStableSwapNgDeploymentVerifier({
        fetchCodeStatus: vi.fn(validDeploymentCode),
        fetchCall: vi.fn(validDeploymentCall),
        fetchBlockHeader,
        hashCode: (code) =>
          code === "0x6000" ? policy.expectedPoolCodeHash : policy.expectedFactoryCodeHash,
      })({
        nowSec: BLOCK_TIMESTAMP + 60,
        chainRpcs: new Map(),
      });
    };

    await expect(run({
      ...header,
      hash: `0x${"34".repeat(32)}`,
    })).resolves.toEqual({ ok: false, reason: "block-header-mismatch" });
    await expect(run(null)).resolves.toEqual({
      ok: false,
      reason: "block-header-unavailable",
    });
  });

  it("treats unavailable identity reads as semantic proof failures", async () => {
    const policy = CURVE_USDG_USDC_STABLESWAP_NG_POLICY;
    const run = (fetchCall: typeof validDeploymentCall) =>
      createCurveStableSwapNgDeploymentVerifier({
        fetchCodeStatus: vi.fn(validDeploymentCode),
        fetchCall: vi.fn(fetchCall),
        fetchBlockHeader: vi.fn(async () => ({
          number: BLOCK_NUMBER,
          timestamp: BLOCK_TIMESTAMP,
          hash: BLOCK_HASH,
        })),
        hashCode: (code) =>
          code === "0x6000" ? policy.expectedPoolCodeHash : policy.expectedFactoryCodeHash,
      })({
        nowSec: BLOCK_TIMESTAMP + 60,
        chainRpcs: new Map(),
      });

    const factoryFailure = await run(async (chain, address, callData) =>
      address === policy.factoryAddress
        ? null
        : validDeploymentCall(chain, address, callData)
    );
    const poolTokenFailure = await run(async (chain, address, callData) =>
      address === policy.poolAddress
        ? null
        : validDeploymentCall(chain, address, callData)
    );
    const decimalsFailure = await run(async (chain, address, callData) =>
      policy.poolTokens.some((token) => token.address === address)
        ? null
        : validDeploymentCall(chain, address, callData)
    );

    expect(factoryFailure).toEqual({ ok: false, reason: "factory-membership-unproven" });
    expect(poolTokenFailure).toEqual({ ok: false, reason: "pool-token-order-unproven" });
    expect(decimalsFailure).toEqual({ ok: false, reason: "token-decimals-unproven" });
    for (const reason of [
      "factory-membership-unproven",
      "pool-token-order-unproven",
      "token-decimals-unproven",
    ]) {
      expect(isOperationalDexMeasuredFailure(reason)).toBe(false);
    }
    expect(isOperationalDexMeasuredFailure("rpc-failure")).toBe(true);
  });
});

describe("reviewed Curve StableSwap-NG quoting", () => {
  it("encodes the exact get_dy direction and decodes the pinned USDG output", () => {
    const callData = encodeCurveStableSwapNgGetDy({
      inputIndex: 0,
      outputIndex: 1,
      amountInRaw: 10_000_000_000_000n,
    });
    expect(callData.slice(0, 10)).toBe("0x5e0d443f");
    expect(decodeFunctionData({ abi: POOL_ABI, data: callData })).toMatchObject({
      functionName: "get_dy",
      args: [0n, 1n, 10_000_000_000_000n],
    });
    expect(decodeCurveStableSwapNgGetDy(
      encodeFunctionResult({
        abi: POOL_ABI,
        functionName: "get_dy",
        result: 9_935_746_449_346n,
      }),
    )).toBe(9_935_746_449_346n);
    expect(() => encodeCurveStableSwapNgGetDy({
      inputIndex: 1,
      outputIndex: 0,
      amountInRaw: 1_000_000n,
    })).toThrow("indices or amount are invalid");
  });

  it("retains realized all-in costs across exact notional quotes", async () => {
    const outputs = new Map([
      [100_000_000_000n, 99_989_367_299n],
      [1_000_000_000_000n, 999_863_796_907n],
      [5_000_000_000_000n, 4_998_378_242_057n],
      [10_000_000_000_000n, 9_935_746_449_346n],
    ]);
    const quote = createCurveStableSwapNgQuoteExecutor({
      executeMulticall: vi.fn(async ({ calls }: { calls: readonly EvmMulticall3Call[] }) =>
        calls.map((call) => {
          const decoded = decodeFunctionData({ abi: POOL_ABI, data: call.callData as `0x${string}` });
          const rawInput = decoded.args[2];
          if (rawInput === undefined) {
            throw new Error("Missing quote input");
          }
          const output = outputs.get(BigInt(rawInput));
          if (output === undefined) {
            throw new Error(`Unexpected quote input: ${rawInput}`);
          }
          return {
            label: call.label,
            success: true,
            returnData: encodeFunctionResult({
              abi: POOL_ABI,
              functionName: "get_dy",
              result: output,
            }),
          };
        })
      ),
    });
    const measuredTarget = target();
    const outcomes = await quote({
      requests: [100_000, 1_000_000, 5_000_000, 10_000_000].map((inputUsd) => ({
        target: measuredTarget,
        inputUsd,
        blockNumber: BLOCK_NUMBER,
        blockObservedAt: BLOCK_TIMESTAMP + 60,
        endpointAddress: CURVE_USDG_USDC_STABLESWAP_NG_POLICY.poolAddress,
        runtimeEvidence: runtimeEvidence(),
      })),
      chainRpcs: new Map(),
    });

    expect(outcomes.map((outcome) => outcome.point?.costBps)).toEqual([
      expect.closeTo(1.0632701, 6),
      expect.closeTo(1.36203093, 6),
      expect.closeTo(3.243515886, 6),
      expect.closeTo(64.253550654, 6),
    ]);
    expect(outcomes.every((outcome) => outcome.point?.passesCostBound)).toBe(true);
  });

  it("fails the exact route on RPC failure and inner quote revert", async () => {
    const request = {
      target: target(),
      inputUsd: 100_000,
      blockNumber: BLOCK_NUMBER,
      blockObservedAt: BLOCK_TIMESTAMP + 60,
      endpointAddress: CURVE_USDG_USDC_STABLESWAP_NG_POLICY.poolAddress,
      runtimeEvidence: runtimeEvidence(),
    };
    const rpcFailure = createCurveStableSwapNgQuoteExecutor({
      executeMulticall: vi.fn(async () => null),
    });
    await expect(rpcFailure({ requests: [request], chainRpcs: new Map() })).resolves.toEqual([
      expect.objectContaining({ failureReason: "rpc-failure" }),
    ]);
    const revert = createCurveStableSwapNgQuoteExecutor({
      executeMulticall: vi.fn(async ({ calls }: { calls: readonly EvmMulticall3Call[] }) =>
        calls.map((call) => ({ label: call.label, success: false, returnData: "0x" as const }))
      ),
    });
    await expect(revert({ requests: [request], chainRpcs: new Map() })).resolves.toEqual([
      expect.objectContaining({ failureReason: "pool-revert" }),
    ]);
  });

  it("validates quote calldata and the full same-block factory proof", () => {
    const measuredTarget = target();
    const callData = encodeCurveStableSwapNgGetDy({
      inputIndex: 0,
      outputIndex: 1,
      amountInRaw: 1_000_000_000n,
    });
    const returnData = encodeFunctionResult({
      abi: POOL_ABI,
      functionName: "get_dy",
      result: 999_900_000n,
    });
    const profile = buildDexMeasuredExecutionProfile({
      target: measuredTarget,
      targetGenerationId: "targets-1",
      quoteGenerationId: "quotes-1",
      quotedAt: BLOCK_TIMESTAMP,
      blockNumber: BLOCK_NUMBER,
      endpointAddress: CURVE_USDG_USDC_STABLESWAP_NG_POLICY.poolAddress,
      endpointCodeHash: CURVE_USDG_USDC_STABLESWAP_NG_POLICY.expectedPoolCodeHash,
      stableSwapNgFactoryBindingProof: factoryProof(),
      points: [{
        amountInRaw: "1000000000",
        amountOutRaw: "999900000",
        callData,
        returnData,
        inputUsd: 1_000,
        outputUsd: 999.9,
        costBps: 1,
        passesCostBound: true,
      }],
    });

    expect(validateCurveStableSwapNgProfileProof(profile)).toEqual([]);
    profile.stableSwapNgFactoryBindingProof!.blockNumber = BLOCK_NUMBER - 1;
    expect(validateCurveStableSwapNgProfileProof(profile)).toContain("block-binding-mismatch");
    profile.stableSwapNgFactoryBindingProof!.blockNumber = BLOCK_NUMBER;
    profile.stableSwapNgFactoryBindingProof!.poolIndex = 562;
    expect(validateCurveStableSwapNgProfileProof(profile)).toContain("factory-binding-mismatch");
    profile.stableSwapNgFactoryBindingProof!.poolIndex = 563;
    profile.stableSwapNgFactoryBindingProof!.factoryCoinsReturnData = encodeFunctionResult({
      abi: FACTORY_ABI,
      functionName: "get_coins",
      result: [
        CURVE_USDG_USDC_STABLESWAP_NG_POLICY.poolTokens[0].address,
        CURVE_USDG_USDC_STABLESWAP_NG_POLICY.poolTokens[1].address,
        "0x1111111111111111111111111111111111111111",
      ],
    });
    expect(validateCurveStableSwapNgProfileProof(profile)).toContain(
      "factory-coins-proof-mismatch",
    );
  });
});
