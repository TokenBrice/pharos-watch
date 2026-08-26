import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
} from "viem/utils";

import {
  DEX_MEASURED_ADAPTER_PROFILE_IDS,
  DEX_MEASURED_FRESHNESS_MAX_SEC,
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionRegistryBindingProof,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { throwIfAborted } from "../../lib/abort";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmBlockTimestamp,
  fetchEvmCallHexAtBlock,
  fetchEvmCodeStatusAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmCodeAtBlockResult,
  type EvmMulticall3Call,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import {
  DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
  type DexMeasuredExecutionBudgetStopReason,
  type DexMeasuredExecutionRpcBudget,
  type DexMeasuredRawQuotePoint,
} from "./profiles";
import { usdToRawAmount } from "./fixed-point";
import { decodeCurveMeasuredRawQuotePoint } from "./curve-quote-point";
import {
  canonicalEvmAddress,
  canonicalEvmHash,
  decodeAddressResult as decodeEvmAddressResult,
} from "./evm-codecs";
import {
  createCurveGetDyQuoteAdapter,
  makeCurveGetDyPlan,
  type CurveGetDyPlan,
} from "./curve-get-dy-quote-engine";

const CURVE_STABLESWAP_ABI = parseAbi([
  "function coins(uint256) view returns (address)",
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
const CURVE_MAIN_REGISTRY_ABI = parseAbi([
  "function get_lp_token(address pool) view returns (address)",
  "function get_coins(address pool) view returns (address[8])",
]);
const ERC20_METADATA_ABI = parseAbi(["function decimals() view returns (uint8)"]);
const CURVE_MULTICALL_BATCH_SIZE = 8;
const CURVE_MULTICALL_GAS = "0x1c9c380";

export const CURVE_STABLESWAP_ADAPTER_PROFILE_ID =
  DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwap;
export const CURVE_STABLESWAP_MIN_COMPLETE_CYCLES = 3;
export const CURVE_STABLESWAP_MIN_SUCCESSFUL_OBSERVATIONS = 3;

export interface CurveStableSwapPoolPolicy {
  chain: "ethereum";
  poolAddress: `0x${string}`;
  expectedPoolCodeHash: `0x${string}`;
  registryAddress: `0x${string}`;
  expectedRegistryCodeHash: `0x${string}`;
  lpTokenAddress: `0x${string}`;
  poolTokens: readonly [
    { address: `0x${string}`; symbol: "DAI"; decimals: 18 },
    { address: `0x${string}`; symbol: "USDC"; decimals: 6 },
    { address: `0x${string}`; symbol: "USDT"; decimals: 6 },
  ];
  mode: "active";
  scoreEligible: true;
}

/** Exact reviewed legacy main-registry deployment. This is not a generic Curve allowlist. */
export const CURVE_3POOL_STABLESWAP_POLICY: CurveStableSwapPoolPolicy = {
  chain: "ethereum",
  poolAddress: "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7",
  expectedPoolCodeHash: "0x954a1e212c557c85043985931498ffa3e2fcbe7dfe9cd61513f36eb47d6f4dfc",
  registryAddress: "0x90e00ace148ca3b23ac1bc8c240c2a7dd9c2d7f5",
  expectedRegistryCodeHash: "0x13d7cfcf1cef4bf310fa544567a427771c9be2c16bbf2c6be845d3d5f4cc5f22",
  lpTokenAddress: "0x6c3f90f043a72fa612cbac8115ee7e52bde6e490",
  poolTokens: [
    { address: "0x6b175474e89094c44da98b954eedeac495271d0f", symbol: "DAI", decimals: 18 },
    { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 },
    { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6 },
  ],
  mode: "active",
  scoreEligible: true,
};

export interface CurveStableSwapRuntimeEvidence {
  blockTimestamp: number;
  poolCodeHash: `0x${string}`;
  registryBindingProof: DexMeasuredExecutionRegistryBindingProof;
}

export type CurveStableSwapEligibilityFailure =
  | "pool-not-reviewed"
  | "execution-endpoint-mismatch"
  | "invalid-pinned-block"
  | "block-timestamp-unavailable"
  | "stale-pinned-block"
  | "future-pinned-block"
  | "runtime-code-unavailable"
  | "runtime-code-absent"
  | "runtime-code-hash-mismatch"
  | "registry-code-unavailable"
  | "registry-code-absent"
  | "registry-code-hash-mismatch"
  | "registry-membership-mismatch"
  | "lp-token-mismatch"
  | "pool-token-order-mismatch"
  | "token-decimals-mismatch"
  | "rpc-failure";

export type CurveStableSwapEligibility =
  | { ok: true }
  | { ok: false; reason: CurveStableSwapEligibilityFailure };

export function getCurveStableSwapPolicy(chain: string, poolAddress: string): CurveStableSwapPoolPolicy | null {
  return chain.trim().toLowerCase() === CURVE_3POOL_STABLESWAP_POLICY.chain &&
    canonicalEvmAddress(poolAddress) === CURVE_3POOL_STABLESWAP_POLICY.poolAddress
    ? CURVE_3POOL_STABLESWAP_POLICY
    : null;
}

export function evaluateCurveStableSwapEligibility(input: {
  chain: string;
  endpointAddress: string;
  blockNumber: number;
  nowSec: number;
  evidence?: CurveStableSwapRuntimeEvidence;
}): CurveStableSwapEligibility {
  const policy = getCurveStableSwapPolicy(input.chain, input.endpointAddress);
  if (!policy) return { ok: false, reason: "pool-not-reviewed" };
  if (canonicalEvmAddress(input.endpointAddress) !== policy.poolAddress) {
    return { ok: false, reason: "execution-endpoint-mismatch" };
  }
  if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0) {
    return { ok: false, reason: "invalid-pinned-block" };
  }
  const evidence = input.evidence;
  if (!evidence || !Number.isSafeInteger(evidence.blockTimestamp) || evidence.blockTimestamp <= 0) {
    return { ok: false, reason: "block-timestamp-unavailable" };
  }
  if (evidence.blockTimestamp > input.nowSec + 60) {
    return { ok: false, reason: "future-pinned-block" };
  }
  if (input.nowSec - evidence.blockTimestamp > DEX_MEASURED_FRESHNESS_MAX_SEC) {
    return { ok: false, reason: "stale-pinned-block" };
  }
  if (canonicalEvmHash(evidence.poolCodeHash) == null) {
    return { ok: false, reason: "runtime-code-unavailable" };
  }
  if (evidence.poolCodeHash !== policy.expectedPoolCodeHash) {
    return { ok: false, reason: "runtime-code-hash-mismatch" };
  }
  const proof = evidence.registryBindingProof;
  if (canonicalEvmHash(proof.registryCodeHash) == null) {
    return { ok: false, reason: "registry-code-unavailable" };
  }
  if (proof.registryCodeHash !== policy.expectedRegistryCodeHash) {
    return { ok: false, reason: "registry-code-hash-mismatch" };
  }
  if (
    proof.registryAddress !== policy.registryAddress ||
    proof.registeredPoolAddress !== policy.poolAddress
  ) {
    return { ok: false, reason: "registry-membership-mismatch" };
  }
  if (proof.lpTokenAddress !== policy.lpTokenAddress) {
    return { ok: false, reason: "lp-token-mismatch" };
  }
  const expectedAddresses = policy.poolTokens.map((token) => token.address);
  if (
    proof.poolTokenAddresses.length !== expectedAddresses.length ||
    proof.poolTokenAddresses.some((address, index) => address !== expectedAddresses[index])
  ) {
    return { ok: false, reason: "pool-token-order-mismatch" };
  }
  if (
    proof.poolCoinsProof.length !== policy.poolTokens.length ||
    proof.poolCoinsProof.some((entry, index) => entry.index !== index)
  ) {
    return { ok: false, reason: "pool-token-order-mismatch" };
  }
  if (
    proof.tokenDecimalsProof.length !== policy.poolTokens.length ||
    proof.tokenDecimalsProof.some((entry, index) =>
      entry.tokenAddress !== policy.poolTokens[index]!.address ||
      entry.decimals !== policy.poolTokens[index]!.decimals
    )
  ) {
    return { ok: false, reason: "token-decimals-mismatch" };
  }
  return { ok: true };
}

interface CurveStableSwapVerificationDependencies {
  fetchCodeStatus(
    chain: string,
    address: string,
    blockNumber: number,
    options: Parameters<typeof fetchEvmCodeStatusAtBlock>[3],
  ): Promise<EvmCodeAtBlockResult>;
  fetchCall(
    chain: string,
    address: string,
    callData: string,
    blockNumber: number,
    options: Parameters<typeof fetchEvmCallHexAtBlock>[4],
  ): Promise<`0x${string}` | null>;
  fetchBlockTimestamp(
    chain: string,
    blockNumber: number,
    options: Parameters<typeof fetchEvmBlockTimestamp>[2],
  ): Promise<number | null>;
  hashCode?(code: `0x${string}`): `0x${string}`;
}

export type CurveStableSwapDeploymentVerification =
  | {
      ok: true;
      codeHash: `0x${string}`;
      blockTimestamp: number;
      runtimeEvidence: CurveStableSwapRuntimeEvidence;
      registryBindingProof: DexMeasuredExecutionRegistryBindingProof;
    }
  | { ok: false; reason: CurveStableSwapEligibilityFailure };

export function createCurveStableSwapDeploymentVerifier(
  dependencies: CurveStableSwapVerificationDependencies,
) {
  return async function verifyCurveStableSwapDeployment(input: {
    policy?: CurveStableSwapPoolPolicy;
    blockNumber: number;
    nowSec: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<CurveStableSwapDeploymentVerification> {
    const policy = input.policy ?? CURVE_3POOL_STABLESWAP_POLICY;
    if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0) {
      return { ok: false, reason: "invalid-pinned-block" };
    }
    const requestOptions = {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
    };
    const readCode = async (address: `0x${string}`): Promise<EvmCodeAtBlockResult> => {
      if (input.rpcBudget && !input.rpcBudget.canRequestChain(policy.chain)) {
        return { status: "unavailable" };
      }
      const result = await dependencies.fetchCodeStatus(
        policy.chain,
        address,
        input.blockNumber,
        requestOptions,
      );
      input.rpcBudget?.recordChainResult(policy.chain, result.status !== "unavailable");
      return result;
    };
    const readCall = async (
      address: `0x${string}`,
      callData: `0x${string}`,
    ): Promise<`0x${string}` | null> => {
      if (input.rpcBudget && !input.rpcBudget.canRequestChain(policy.chain)) return null;
      const result = await dependencies.fetchCall(
        policy.chain,
        address,
        callData,
        input.blockNumber,
        requestOptions,
      );
      input.rpcBudget?.recordChainResult(policy.chain, result != null);
      return result;
    };

    const blockTimestamp = await dependencies.fetchBlockTimestamp(
      policy.chain,
      input.blockNumber,
      requestOptions,
    );
    input.rpcBudget?.recordChainResult(policy.chain, blockTimestamp != null);
    if (blockTimestamp == null) return { ok: false, reason: "block-timestamp-unavailable" };
    if (blockTimestamp > input.nowSec + 60) return { ok: false, reason: "future-pinned-block" };
    if (input.nowSec - blockTimestamp > DEX_MEASURED_FRESHNESS_MAX_SEC) {
      return { ok: false, reason: "stale-pinned-block" };
    }

    const poolCodeResult = await readCode(policy.poolAddress);
    if (poolCodeResult.status === "unavailable") {
      return { ok: false, reason: "runtime-code-unavailable" };
    }
    if (poolCodeResult.status === "absent") {
      return { ok: false, reason: "runtime-code-absent" };
    }
    const poolCode = poolCodeResult.code;
    const hashCode = dependencies.hashCode ?? ((code: `0x${string}`) => keccak256(code));
    const poolCodeHash = hashCode(poolCode).toLowerCase() as `0x${string}`;
    if (poolCodeHash !== policy.expectedPoolCodeHash) {
      return { ok: false, reason: "runtime-code-hash-mismatch" };
    }
    const registryCodeResult = await readCode(policy.registryAddress);
    if (registryCodeResult.status === "unavailable") {
      return { ok: false, reason: "registry-code-unavailable" };
    }
    if (registryCodeResult.status === "absent") {
      return { ok: false, reason: "registry-code-absent" };
    }
    const registryCode = registryCodeResult.code;
    const registryCodeHash = hashCode(registryCode).toLowerCase() as `0x${string}`;
    if (registryCodeHash !== policy.expectedRegistryCodeHash) {
      return { ok: false, reason: "registry-code-hash-mismatch" };
    }

    const lpTokenCallData = encodeFunctionData({
      abi: CURVE_MAIN_REGISTRY_ABI,
      functionName: "get_lp_token",
      args: [policy.poolAddress],
    }).toLowerCase() as `0x${string}`;
    const registryCoinsCallData = encodeFunctionData({
      abi: CURVE_MAIN_REGISTRY_ABI,
      functionName: "get_coins",
      args: [policy.poolAddress],
    }).toLowerCase() as `0x${string}`;
    const lpTokenReturnData = await readCall(policy.registryAddress, lpTokenCallData);
    const registryCoinsReturnData = await readCall(policy.registryAddress, registryCoinsCallData);
    if (lpTokenReturnData == null || registryCoinsReturnData == null) {
      return { ok: false, reason: "rpc-failure" };
    }

    let lpTokenAddress: `0x${string}`;
    let registryCoins: readonly `0x${string}`[];
    try {
      lpTokenAddress = canonicalEvmAddress(decodeFunctionResult({
        abi: CURVE_MAIN_REGISTRY_ABI,
        functionName: "get_lp_token",
        data: lpTokenReturnData,
      }))!;
      registryCoins = (decodeFunctionResult({
        abi: CURVE_MAIN_REGISTRY_ABI,
        functionName: "get_coins",
        data: registryCoinsReturnData,
      }) as readonly string[]).map((coin) => canonicalEvmAddress(coin) ?? "0x0000000000000000000000000000000000000000");
    } catch {
      return { ok: false, reason: "registry-membership-mismatch" };
    }
    if (lpTokenAddress !== policy.lpTokenAddress) return { ok: false, reason: "lp-token-mismatch" };
    const expectedAddresses = policy.poolTokens.map((token) => token.address);
    if (
      registryCoins.length !== 8 ||
      expectedAddresses.some((address, index) => registryCoins[index] !== address) ||
      registryCoins.slice(expectedAddresses.length).some((address) =>
        address !== "0x0000000000000000000000000000000000000000"
      )
    ) {
      return { ok: false, reason: "registry-membership-mismatch" };
    }

    const poolCoinsProof: DexMeasuredExecutionRegistryBindingProof["poolCoinsProof"] = [];
    const tokenDecimalsProof: DexMeasuredExecutionRegistryBindingProof["tokenDecimalsProof"] = [];
    for (let index = 0; index < policy.poolTokens.length; index += 1) {
      throwIfAborted(input.signal);
      const token = policy.poolTokens[index]!;
      const coinCallData = encodeFunctionData({
        abi: CURVE_STABLESWAP_ABI,
        functionName: "coins",
        args: [BigInt(index)],
      }).toLowerCase() as `0x${string}`;
      const coinReturnData = await readCall(policy.poolAddress, coinCallData);
      if (coinReturnData == null) return { ok: false, reason: "rpc-failure" };
      let poolCoinAddress: `0x${string}` | null = null;
      try {
        poolCoinAddress = canonicalEvmAddress(decodeFunctionResult({
          abi: CURVE_STABLESWAP_ABI,
          functionName: "coins",
          data: coinReturnData,
        }));
      } catch {
        return { ok: false, reason: "pool-token-order-mismatch" };
      }
      if (poolCoinAddress !== token.address) return { ok: false, reason: "pool-token-order-mismatch" };
      poolCoinsProof.push({ index, callData: coinCallData, returnData: coinReturnData.toLowerCase() as `0x${string}` });

      const decimalsCallData = encodeFunctionData({
        abi: ERC20_METADATA_ABI,
        functionName: "decimals",
      }).toLowerCase() as `0x${string}`;
      const decimalsReturnData = await readCall(token.address, decimalsCallData);
      if (decimalsReturnData == null) return { ok: false, reason: "rpc-failure" };
      let decimals: number;
      try {
        decimals = Number(decodeFunctionResult({
          abi: ERC20_METADATA_ABI,
          functionName: "decimals",
          data: decimalsReturnData,
        }));
      } catch {
        return { ok: false, reason: "token-decimals-mismatch" };
      }
      if (decimals !== token.decimals) return { ok: false, reason: "token-decimals-mismatch" };
      tokenDecimalsProof.push({
        tokenAddress: token.address,
        decimals,
        callData: decimalsCallData,
        returnData: decimalsReturnData.toLowerCase() as `0x${string}`,
      });
    }

    const registryBindingProof: DexMeasuredExecutionRegistryBindingProof = {
      registryAddress: policy.registryAddress,
      registryCodeHash,
      registeredPoolAddress: policy.poolAddress,
      lpTokenAddress,
      poolTokenAddresses: expectedAddresses,
      lpTokenCallData,
      lpTokenReturnData: lpTokenReturnData.toLowerCase() as `0x${string}`,
      registryCoinsCallData,
      registryCoinsReturnData: registryCoinsReturnData.toLowerCase() as `0x${string}`,
      poolCoinsProof,
      tokenDecimalsProof,
    };
    const runtimeEvidence: CurveStableSwapRuntimeEvidence = {
      blockTimestamp,
      poolCodeHash,
      registryBindingProof,
    };
    const eligibility = evaluateCurveStableSwapEligibility({
      chain: policy.chain,
      endpointAddress: policy.poolAddress,
      blockNumber: input.blockNumber,
      nowSec: input.nowSec,
      evidence: runtimeEvidence,
    });
    return eligibility.ok
      ? { ok: true, codeHash: poolCodeHash, blockTimestamp, runtimeEvidence, registryBindingProof }
      : eligibility;
  };
}

export const verifyCurveStableSwapDeployment = createCurveStableSwapDeploymentVerifier({
  fetchCodeStatus: fetchEvmCodeStatusAtBlock,
  fetchCall: fetchEvmCallHexAtBlock,
  fetchBlockTimestamp: fetchEvmBlockTimestamp,
});

export type CurveStableSwapQuoteFailure =
  | DexMeasuredExecutionBudgetStopReason
  | "unsupported-chain-or-pool"
  | "invalid-pinned-block"
  | "invalid-quote-input"
  | "invalid-curve-stableswap-target"
  | "pool-token-order-mismatch"
  | "runtime-evidence-missing"
  | "rpc-failure"
  | "pool-revert"
  | "malformed-pool-return";

export interface CurveStableSwapRequest {
  target: DexMeasuredExecutionTarget;
  inputUsd: number;
  blockNumber: number;
  blockObservedAt: number;
  endpointAddress: `0x${string}`;
  runtimeEvidence?: CurveStableSwapRuntimeEvidence;
}

interface EncodedCurveStableSwapRequest extends CurveStableSwapRequest {
  index: number;
  label: string;
  amountInRaw: bigint;
  inputIndex: number;
  outputIndex: number;
  callData: `0x${string}`;
  policy: CurveStableSwapPoolPolicy;
  eligibility: CurveStableSwapEligibility;
}

export interface CurveStableSwapBatchOutcome {
  targetId: string;
  inputUsd: number;
  blockNumber: number;
  eligibility: CurveStableSwapEligibility;
  point?: DexMeasuredRawQuotePoint;
  failureReason?: CurveStableSwapQuoteFailure;
}

export function resolveCurveStableSwapTokenIndices(
  target: DexMeasuredExecutionTarget | DexMeasuredExecutionProfile,
): { ok: true; inputIndex: number; outputIndex: number } | { ok: false; reason: CurveStableSwapQuoteFailure } {
  const endpointAddress =
    "executionEndpoint" in target
      ? target.executionEndpoint.address
      : target.poolId.slice(target.poolId.lastIndexOf(":") + 1);
  const policy = getCurveStableSwapPolicy(target.chain, endpointAddress);
  if (
    target.adapterProfileId !== CURVE_STABLESWAP_ADAPTER_PROFILE_ID ||
    target.protocol.trim().toLowerCase() !== "curve" ||
    !policy ||
    target.poolTokenAddresses == null ||
    target.poolTokenAddresses.length !== policy.poolTokens.length ||
    target.poolTokenAddresses.some((address, index) => address !== policy.poolTokens[index]!.address)
  ) {
    return { ok: false, reason: "invalid-curve-stableswap-target" };
  }
  const inputIndex = policy.poolTokens.findIndex((token) => token.address === target.tokenIn.address);
  const outputIndex = policy.poolTokens.findIndex((token) => token.address === target.tokenOut.address);
  if (inputIndex < 0 || outputIndex < 0 || inputIndex === outputIndex) {
    return { ok: false, reason: "invalid-curve-stableswap-target" };
  }
  if (
    target.tokenIn.decimals !== policy.poolTokens[inputIndex]!.decimals ||
    target.tokenOut.decimals !== policy.poolTokens[outputIndex]!.decimals
  ) {
    return { ok: false, reason: "pool-token-order-mismatch" };
  }
  return { ok: true, inputIndex, outputIndex };
}

export function encodeCurveStableSwapGetDy(input: {
  inputIndex: number;
  outputIndex: number;
  amountInRaw: bigint;
}): `0x${string}` {
  if (
    !Number.isInteger(input.inputIndex) ||
    input.inputIndex < 0 ||
    input.inputIndex > 7 ||
    !Number.isInteger(input.outputIndex) ||
    input.outputIndex < 0 ||
    input.outputIndex > 7 ||
    input.inputIndex === input.outputIndex ||
    input.amountInRaw <= 0n
  ) throw new Error("Curve StableSwap quote indices or amount are invalid");
  return encodeFunctionData({
    abi: CURVE_STABLESWAP_ABI,
    functionName: "get_dy",
    args: [BigInt(input.inputIndex), BigInt(input.outputIndex), input.amountInRaw],
  }).toLowerCase() as `0x${string}`;
}

export function decodeCurveStableSwapGetDy(returnData: `0x${string}`): bigint | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(returnData)) return null;
  try {
    return decodeFunctionResult({
      abi: CURVE_STABLESWAP_ABI,
      functionName: "get_dy",
      data: returnData,
    }) as bigint;
  } catch {
    return null;
  }
}

function prepareRequest(
  request: CurveStableSwapRequest,
  index: number,
): {
  encoded?: EncodedCurveStableSwapRequest;
  failureReason?: CurveStableSwapQuoteFailure;
  eligibility: CurveStableSwapEligibility;
} {
  const policy = getCurveStableSwapPolicy(request.target.chain, request.endpointAddress);
  const eligibility = evaluateCurveStableSwapEligibility({
    chain: request.target.chain,
    endpointAddress: request.endpointAddress,
    blockNumber: request.blockNumber,
    nowSec: request.blockObservedAt,
    evidence: request.runtimeEvidence,
  });
  if (!policy) return { failureReason: "unsupported-chain-or-pool", eligibility };
  if (!Number.isSafeInteger(request.blockNumber) || request.blockNumber < 0) {
    return { failureReason: "invalid-pinned-block", eligibility };
  }
  if (!eligibility.ok) return { failureReason: eligibility.reason === "block-timestamp-unavailable" ? "runtime-evidence-missing" : "invalid-curve-stableswap-target", eligibility };
  const indices = resolveCurveStableSwapTokenIndices(request.target);
  if (!indices.ok) return { failureReason: indices.reason, eligibility };
  const expectedTargetId = buildDexMeasuredExecutionTargetId({
    adapterProfileId: request.target.adapterProfileId,
    stablecoinId: request.target.stablecoinId,
    chain: request.target.chain,
    protocol: request.target.protocol,
    poolId: request.target.poolId,
    tokenInAddress: request.target.tokenIn.address,
    tokenOutAddress: request.target.tokenOut.address,
    poolTokenAddresses: request.target.poolTokenAddresses,
  });
  if (request.target.targetId !== expectedTargetId) {
    return { failureReason: "invalid-curve-stableswap-target", eligibility };
  }
  const amountInRaw = usdToRawAmount(
    request.inputUsd,
    request.target.tokenIn.decimals,
    request.target.tokenIn.referencePriceUsd,
  );
  if (amountInRaw == null) return { failureReason: "invalid-quote-input", eligibility };
  return {
    eligibility,
    encoded: {
      ...request,
      index,
      label: `${index}:${request.target.targetId}`,
      amountInRaw,
      inputIndex: indices.inputIndex,
      outputIndex: indices.outputIndex,
      callData: encodeCurveStableSwapGetDy({
        inputIndex: indices.inputIndex,
        outputIndex: indices.outputIndex,
        amountInRaw,
      }),
      policy,
      eligibility,
    },
  };
}

function decodeCurveStableSwapQuotePoint(
  request: Pick<
    EncodedCurveStableSwapRequest,
    "amountInRaw" | "callData" | "inputIndex" | "outputIndex" | "blockNumber" | "endpointAddress" | "target"
  >,
  result: EvmMulticall3Result,
): { point?: DexMeasuredRawQuotePoint; failureReason?: CurveStableSwapQuoteFailure } {
  return decodeCurveMeasuredRawQuotePoint({
    request,
    result,
    decodeAmountOutRaw: decodeCurveStableSwapGetDy,
    adapterMetadata: {
      executionPool: request.endpointAddress,
      blockNumber: request.blockNumber,
      inputIndex: request.inputIndex,
      outputIndex: request.outputIndex,
      registry: CURVE_3POOL_STABLESWAP_POLICY.registryAddress,
    },
    failureReasons: {
      poolRevert: "pool-revert",
      malformedPoolReturn: "malformed-pool-return",
    },
  });
}

interface CurveStableSwapQuoteDependencies {
  executeMulticall(input: {
    chain: string;
    calls: readonly EvmMulticall3Call[];
    blockNumber: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<EvmMulticall3Result[] | null>;
}

export function createCurveStableSwapQuoteExecutor(dependencies: CurveStableSwapQuoteDependencies) {
  return createCurveGetDyQuoteAdapter<
    CurveStableSwapRequest,
    CurveGetDyPlan<EncodedCurveStableSwapRequest>,
    CurveStableSwapEligibility,
    CurveStableSwapBatchOutcome,
    CurveStableSwapQuoteFailure
  >({
    batchSize: CURVE_MULTICALL_BATCH_SIZE,
    prepare: (request, index) => {
      const prepared = prepareRequest(request, index);
      return {
        eligibility: prepared.eligibility,
        ...(prepared.failureReason ? { failureReason: prepared.failureReason } : {}),
        ...(prepared.encoded
          ? {
              plan: makeCurveGetDyPlan(prepared.encoded),
            }
          : {}),
      };
    },
    makeOutcome: (request, eligibility, failureReason) => ({
      targetId: request.target.targetId,
      inputUsd: request.inputUsd,
      blockNumber: request.blockNumber,
      eligibility,
      ...(failureReason ? { failureReason } : {}),
    }),
    executeMulticall: dependencies.executeMulticall,
    resolveResult: (request, result) => ({
      targetId: request.target.targetId,
      inputUsd: request.inputUsd,
      blockNumber: request.blockNumber,
      eligibility: request.eligibility,
      ...decodeCurveStableSwapQuotePoint(request, result),
    }),
    materializeTransportFailure: (request, reason) => ({
      targetId: request.target.targetId,
      inputUsd: request.inputUsd,
      blockNumber: request.blockNumber,
      eligibility: request.eligibility,
      failureReason: reason ?? "rpc-failure",
    }),
  });
}

export const quoteCurveStableSwapRequests = createCurveStableSwapQuoteExecutor({
  executeMulticall: async (input) =>
    fetchEvmMulticall3Aggregate3AtBlock(input.chain, input.calls, input.blockNumber, {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      maxRetries: 1,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
      gas: CURVE_MULTICALL_GAS,
      multicallBatchSize: Math.min(CURVE_MULTICALL_BATCH_SIZE, input.calls.length),
    }),
});

/** Exact ABI and reviewed registry-binding validation at the consumer boundary. */
export function validateCurveStableSwapProfileProof(profile: DexMeasuredExecutionProfile): string[] {
  const issues = new Set<string>();
  if (profile.adapterProfileId !== CURVE_STABLESWAP_ADAPTER_PROFILE_ID) issues.add("wrong-adapter-profile");
  const policy = getCurveStableSwapPolicy(profile.chain, profile.executionEndpoint.address);
  if (!policy) issues.add("execution-pool-not-reviewed");
  if (profile.executionEndpoint.codeHash !== policy?.expectedPoolCodeHash) issues.add("endpoint-code-hash-mismatch");
  const indices = resolveCurveStableSwapTokenIndices(profile);
  if (!indices.ok) issues.add(indices.reason);

  const proof = profile.registryBindingProof;
  if (!proof) {
    issues.add("registry-binding-proof-missing");
  } else if (policy) {
    if (
      proof.registryAddress !== policy.registryAddress ||
      proof.registryCodeHash !== policy.expectedRegistryCodeHash ||
      proof.registeredPoolAddress !== policy.poolAddress
    ) issues.add("registry-binding-mismatch");
    if (proof.lpTokenAddress !== policy.lpTokenAddress) issues.add("lp-token-mismatch");
    if (
      proof.poolTokenAddresses.length !== policy.poolTokens.length ||
      proof.poolTokenAddresses.some((address, index) => address !== policy.poolTokens[index]!.address)
    ) issues.add("pool-token-order-mismatch");

    try {
      const decodedCall = decodeFunctionData({
        abi: CURVE_MAIN_REGISTRY_ABI,
        data: proof.lpTokenCallData as `0x${string}`,
      });
      if (
        decodedCall.functionName !== "get_lp_token" ||
        canonicalEvmAddress(decodedCall.args[0]) !== policy.poolAddress ||
        decodeEvmAddressResult({
          decode: () => decodeFunctionResult({
            abi: CURVE_MAIN_REGISTRY_ABI,
            functionName: "get_lp_token",
            data: proof.lpTokenReturnData as `0x${string}`,
          } as never),
        }) !== policy.lpTokenAddress
      ) issues.add("lp-token-proof-mismatch");
    } catch {
      issues.add("lp-token-proof-mismatch");
    }
    try {
      const decodedCall = decodeFunctionData({
        abi: CURVE_MAIN_REGISTRY_ABI,
        data: proof.registryCoinsCallData as `0x${string}`,
      });
      const decodedCoins = decodeFunctionResult({
        abi: CURVE_MAIN_REGISTRY_ABI,
        functionName: "get_coins",
        data: proof.registryCoinsReturnData as `0x${string}`,
      }) as readonly string[];
      if (
        decodedCall.functionName !== "get_coins" ||
        canonicalEvmAddress(decodedCall.args[0]) !== policy.poolAddress ||
        policy.poolTokens.some((token, index) => canonicalEvmAddress(decodedCoins[index]) !== token.address) ||
        decodedCoins.slice(policy.poolTokens.length).some((coin) =>
          canonicalEvmAddress(coin) !== "0x0000000000000000000000000000000000000000"
        )
      ) issues.add("registry-coins-proof-mismatch");
    } catch {
      issues.add("registry-coins-proof-mismatch");
    }
    if (
      proof.poolCoinsProof.length !== policy.poolTokens.length ||
      proof.poolCoinsProof.some((entry, index) => {
        try {
          const call = decodeFunctionData({
            abi: CURVE_STABLESWAP_ABI,
            data: entry.callData as `0x${string}`,
          });
          return (
            entry.index !== index ||
            call.functionName !== "coins" ||
            call.args[0] !== BigInt(index) ||
            decodeEvmAddressResult({
              decode: () => decodeFunctionResult({
                abi: CURVE_STABLESWAP_ABI,
                functionName: "coins",
                data: entry.returnData as `0x${string}`,
              } as never),
            }) !== policy.poolTokens[index]!.address
          );
        } catch {
          return true;
        }
      })
    ) issues.add("pool-coins-proof-mismatch");
    if (
      proof.tokenDecimalsProof.length !== policy.poolTokens.length ||
      proof.tokenDecimalsProof.some((entry, index) => {
        try {
          const call = decodeFunctionData({
            abi: ERC20_METADATA_ABI,
            data: entry.callData as `0x${string}`,
          });
          const decimals = Number(decodeFunctionResult({
            abi: ERC20_METADATA_ABI,
            functionName: "decimals",
            data: entry.returnData as `0x${string}`,
          }));
          return (
            call.functionName !== "decimals" ||
            entry.tokenAddress !== policy.poolTokens[index]!.address ||
            entry.decimals !== policy.poolTokens[index]!.decimals ||
            decimals !== policy.poolTokens[index]!.decimals
          );
        } catch {
          return true;
        }
      })
    ) issues.add("token-decimals-proof-mismatch");
  }

  for (const point of profile.quoteProof) {
    if (point.reverted) {
      issues.add("quote-revert-not-publishable");
      continue;
    }
    try {
      const call = decodeFunctionData({
        abi: CURVE_STABLESWAP_ABI,
        data: point.callData as `0x${string}`,
      });
      if (
        !indices.ok ||
        call.functionName !== "get_dy" ||
        call.args[0] !== BigInt(indices.inputIndex) ||
        call.args[1] !== BigInt(indices.outputIndex) ||
        call.args[2].toString() !== point.amountInRaw
      ) issues.add("call-data-mismatch");
      const amountOutRaw = decodeCurveStableSwapGetDy(point.returnData as `0x${string}`);
      if (amountOutRaw == null) issues.add("abi-decode-failed");
      else if (amountOutRaw.toString() !== point.amountOutRaw) issues.add("return-data-mismatch");
    } catch {
      issues.add("abi-decode-failed");
    }
  }
  return [...issues];
}
