import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
} from "viem/utils";

import {
  DEX_MEASURED_ADAPTER_PROFILE_IDS,
  DEX_MEASURED_FRESHNESS_MAX_SEC,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionRegistryBindingProof,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { CURVE_STABLESWAP_DEPLOYMENT } from "@shared/lib/measured-execution-deployment-policies";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmBlockTimestamp,
  fetchEvmCallHexAtBlock,
  fetchEvmCodeStatusAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmMulticall3Call,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import {
  DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
  type DexMeasuredExecutionBudgetStopReason,
  type DexMeasuredExecutionRpcBudget,
} from "./profiles";
import {
  canonicalEvmAddress,
  canonicalEvmHash,
  decodeAddressResult as decodeEvmAddressResult,
} from "./evm-codecs";
import {
  CURVE_STABLESWAP_MULTICALL_BATCH_SIZE,
  CURVE_STABLESWAP_MULTICALL_GAS,
  createCurveStableSwapDeploymentVerifier as createCurveStableSwapDeploymentVerifierPipeline,
  createCurveStableSwapExecutionPipeline,
  decodeCurveStableSwapGetDyResult,
  encodeCurveStableSwapGetDyCall,
  evaluateCurveStableSwapBaseEligibility,
  validateCurveStableSwapExecutionProfile,
  verifyCurveStableSwapPoolTokens,
  type CurveStableSwapDeploymentDependencies,
} from "./curve-stableswap-execution-pipeline";

const CURVE_MAIN_REGISTRY_ABI = parseAbi([
  "function get_lp_token(address pool) view returns (address)",
  "function get_coins(address pool) view returns (address[8])",
]);

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
  chain: CURVE_STABLESWAP_DEPLOYMENT.chain,
  poolAddress: CURVE_STABLESWAP_DEPLOYMENT.poolAddress,
  expectedPoolCodeHash: CURVE_STABLESWAP_DEPLOYMENT.poolCodeHash,
  registryAddress: CURVE_STABLESWAP_DEPLOYMENT.registryAddress,
  expectedRegistryCodeHash: CURVE_STABLESWAP_DEPLOYMENT.registryCodeHash,
  lpTokenAddress: CURVE_STABLESWAP_DEPLOYMENT.lpTokenAddress,
  poolTokens: CURVE_STABLESWAP_DEPLOYMENT.poolTokens,
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
  const base = evaluateCurveStableSwapBaseEligibility(
    input,
    getCurveStableSwapPolicy,
    DEX_MEASURED_FRESHNESS_MAX_SEC,
    "block-timestamp-unavailable",
  );
  if (!base.ok) return base;
  const { policy, evidence } = base;
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

interface CurveStableSwapVerificationDependencies extends CurveStableSwapDeploymentDependencies {
  fetchBlockTimestamp(
    chain: string,
    blockNumber: number,
    options: Parameters<typeof fetchEvmBlockTimestamp>[2],
  ): Promise<number | null>;
}

interface CurveStableSwapVerificationInput {
  policy?: CurveStableSwapPoolPolicy;
  blockNumber: number;
  nowSec: number;
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
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
  const verifyBase = createCurveStableSwapDeploymentVerifierPipeline<
    CurveStableSwapPoolPolicy,
    CurveStableSwapVerificationInput,
    DexMeasuredExecutionRegistryBindingProof,
    CurveStableSwapEligibilityFailure
  >(dependencies, {
    defaultPolicy: CURVE_3POOL_STABLESWAP_POLICY,
    freshnessMaxSec: DEX_MEASURED_FRESHNESS_MAX_SEC,
    precheck: (input) =>
      Number.isSafeInteger(input.blockNumber) && input.blockNumber >= 0
        ? null
        : "invalid-pinned-block",
    acquireBlock: async (input, policy, requestOptions) => {
      const blockTimestamp = await dependencies.fetchBlockTimestamp(
        policy.chain,
        input.blockNumber,
        requestOptions,
      );
      input.rpcBudget?.recordChainResult(policy.chain, blockTimestamp != null);
      return blockTimestamp == null
        ? { ok: false, reason: "block-timestamp-unavailable" }
        : { ok: true, value: { blockNumber: input.blockNumber, blockTimestamp } };
    },
    bindingCode: {
      address: (policy) => policy.registryAddress,
      expectedHash: (policy) => policy.expectedRegistryCodeHash,
      beforePoolHash: false,
      unavailable: "registry-code-unavailable",
      absent: "registry-code-absent",
      mismatch: "registry-code-hash-mismatch",
    },
    verifyBinding: async ({
      input,
      policy,
      readCall,
      bindingCodeHash: registryCodeHash,
    }) => {
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
        }) as readonly string[]).map((coin) =>
          canonicalEvmAddress(coin) ?? "0x0000000000000000000000000000000000000000"
        );
      } catch {
        return { ok: false, reason: "registry-membership-mismatch" };
      }
      if (lpTokenAddress !== policy.lpTokenAddress) {
        return { ok: false, reason: "lp-token-mismatch" };
      }
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

      const tokenProof = await verifyCurveStableSwapPoolTokens({
        policy,
        signal: input.signal,
        readCall,
        failures: {
          poolTokenUnavailable: "rpc-failure",
          poolTokenMismatch: "pool-token-order-mismatch",
          tokenDecimalsUnavailable: "rpc-failure",
          tokenDecimalsMismatch: "token-decimals-mismatch",
        },
      });
      if (!tokenProof.ok) return tokenProof;
      return {
        ok: true,
        value: {
          registryAddress: policy.registryAddress,
          registryCodeHash,
          registeredPoolAddress: policy.poolAddress,
          lpTokenAddress,
          poolTokenAddresses: expectedAddresses,
          lpTokenCallData,
          lpTokenReturnData: lpTokenReturnData.toLowerCase() as `0x${string}`,
          registryCoinsCallData,
          registryCoinsReturnData: registryCoinsReturnData.toLowerCase() as `0x${string}`,
          poolCoinsProof: tokenProof.poolCoinsProof,
          tokenDecimalsProof: tokenProof.tokenDecimalsProof,
        },
      };
    },
  });
  return async (input: CurveStableSwapVerificationInput): Promise<CurveStableSwapDeploymentVerification> => {
    const result = await verifyBase(input);
    if (!result.ok) return result;
    const runtimeEvidence: CurveStableSwapRuntimeEvidence = {
      blockTimestamp: result.blockTimestamp,
      poolCodeHash: result.codeHash,
      registryBindingProof: result.bindingProof,
    };
    const policy = input.policy ?? CURVE_3POOL_STABLESWAP_POLICY;
    const eligibility = evaluateCurveStableSwapEligibility({
      chain: policy.chain,
      endpointAddress: policy.poolAddress,
      blockNumber: result.blockNumber,
      nowSec: input.nowSec,
      evidence: runtimeEvidence,
    });
    return eligibility.ok
      ? {
          ok: true,
          codeHash: result.codeHash,
          blockTimestamp: result.blockTimestamp,
          runtimeEvidence,
          registryBindingProof: result.bindingProof,
        }
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
  return encodeCurveStableSwapGetDyCall(
    input,
    (inputIndex, outputIndex) =>
      Number.isInteger(inputIndex) &&
      inputIndex >= 0 &&
      inputIndex <= 7 &&
      Number.isInteger(outputIndex) &&
      outputIndex >= 0 &&
      outputIndex <= 7 &&
      inputIndex !== outputIndex,
    "Curve StableSwap quote indices or amount are invalid",
  );
}

export function decodeCurveStableSwapGetDy(returnData: `0x${string}`): bigint | null {
  return decodeCurveStableSwapGetDyResult(returnData);
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
  return createCurveStableSwapExecutionPipeline<
    CurveStableSwapPoolPolicy,
    CurveStableSwapRuntimeEvidence,
    CurveStableSwapEligibility,
    CurveStableSwapQuoteFailure
  >({
    invalidTargetFailure: "invalid-curve-stableswap-target",
    runtimeEvidenceUnavailableReason: "block-timestamp-unavailable",
    getPolicy: getCurveStableSwapPolicy,
    evaluateEligibility: evaluateCurveStableSwapEligibility,
    resolveTokenIndices: resolveCurveStableSwapTokenIndices,
    encodeGetDy: encodeCurveStableSwapGetDy,
    quoteMetadata: (request) => ({
      executionPool: request.endpointAddress,
      blockNumber: request.blockNumber,
      inputIndex: request.inputIndex,
      outputIndex: request.outputIndex,
      registry: CURVE_3POOL_STABLESWAP_POLICY.registryAddress,
    }),
  }, dependencies);
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
      gas: CURVE_STABLESWAP_MULTICALL_GAS,
      multicallBatchSize: Math.min(CURVE_STABLESWAP_MULTICALL_BATCH_SIZE, input.calls.length),
    }),
});

/** Exact ABI and reviewed registry-binding validation at the consumer boundary. */
export function validateCurveStableSwapProfileProof(profile: DexMeasuredExecutionProfile): string[] {
  return validateCurveStableSwapExecutionProfile<
    CurveStableSwapPoolPolicy,
    CurveStableSwapQuoteFailure,
    DexMeasuredExecutionRegistryBindingProof
  >({
    profile,
    adapterProfileId: CURVE_STABLESWAP_ADAPTER_PROFILE_ID,
    getPolicy: getCurveStableSwapPolicy,
    resolveTokenIndices: resolveCurveStableSwapTokenIndices,
    getProof: (candidate) => candidate.registryBindingProof,
    missingProofIssue: "registry-binding-proof-missing",
    validateDeploymentProof: (issues, proof, policy) => {
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
    },
  });
}
