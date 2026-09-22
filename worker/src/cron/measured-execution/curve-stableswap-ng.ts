import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
} from "viem/utils";

import {
  DEX_MEASURED_FRESHNESS_MAX_SEC,
  DEX_MEASURED_ADAPTER_PROFILE_IDS,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionStableSwapNgFactoryBindingProof,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import {
  CURVE_STABLESWAP_NG_DEPLOYMENTS,
  CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT,
  CURVE_STABLESWAP_NG_SHADOW_DEPLOYMENTS,
  CURVE_STABLESWAP_NG_ETHERLINK_FACTORY,
} from "@shared/lib/measured-execution-deployment-policies";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmBlockHeader,
  fetchEvmCallHexAtBlock,
  fetchEvmCodeStatusAtBlock,
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmCodeAtBlockResult,
  type EvmBlockHeader,
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
  createCurveFamilyDeploymentVerifier,
  createCurveStableSwapExecutionPipeline,
  decodeCurveStableSwapGetDyResult,
  encodeCurveStableSwapGetDyCall,
  validateCurveStableSwapExecutionProfile,
} from "./curve-stableswap-execution-pipeline";

const CURVE_STABLESWAP_NG_FACTORY_ABI = parseAbi([
  "function pool_list(uint256) view returns (address)",
  "function get_coins(address pool) view returns (address[])",
]);

export const CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID =
  DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg;
export const CURVE_STABLESWAP_NG_MIN_COMPLETE_CYCLES = 3;
export const CURVE_STABLESWAP_NG_MIN_SUCCESSFUL_OBSERVATIONS = 3;

export interface CurveStableSwapNgPoolPolicy {
  chain: "ethereum" | "etherlink";
  stablecoinId: string;
  poolAddress: `0x${string}`;
  expectedPoolCodeHash: `0x${string}`;
  factoryAddress: `0x${string}`;
  expectedFactoryCodeHash: `0x${string}`;
  factoryPoolIndex: number;
  poolTokens: readonly [
    { address: `0x${string}`; symbol: string; decimals: number; trackedAssetId: string },
    { address: `0x${string}`; symbol: string; decimals: number; trackedAssetId: string },
  ];
  inputIndex: 0 | 1;
  outputIndex: 0 | 1;
  mode: "active" | "shadow";
  scoreEligible: boolean;
}

/** Projects one reviewed deployment identity, plus its factory binding, into the producer policy shape. */
function toCurveStableSwapNgPolicy(
  deployment: (typeof CURVE_STABLESWAP_NG_DEPLOYMENTS)[number],
): CurveStableSwapNgPoolPolicy {
  return {
    chain: deployment.chain,
    stablecoinId: deployment.stablecoinId,
    poolAddress: deployment.poolAddress,
    expectedPoolCodeHash: deployment.poolCodeHash,
    factoryAddress: CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT.address,
    expectedFactoryCodeHash: CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT.codeHash,
    factoryPoolIndex: deployment.factoryPoolIndex,
    poolTokens: deployment.poolTokens,
    inputIndex: deployment.inputIndex,
    outputIndex: deployment.outputIndex,
    mode: "active",
    scoreEligible: true,
  };
}

/** Exact reviewed USDG/USDC StableSwap-NG deployment. This is not a generic Curve allowlist. */
export const CURVE_USDG_USDC_STABLESWAP_NG_POLICY: CurveStableSwapNgPoolPolicy =
  toCurveStableSwapNgPolicy(CURVE_STABLESWAP_NG_DEPLOYMENTS[0]);

/** Exact reviewed DUSD/USDC StableSwap-NG deployment. DUSD is the rate-bearing input; direct get_dy is required. */
export const CURVE_DUSD_USDC_STABLESWAP_NG_POLICY: CurveStableSwapNgPoolPolicy =
  toCurveStableSwapNgPolicy(CURVE_STABLESWAP_NG_DEPLOYMENTS[1]);

const CURVE_STABLESWAP_NG_POLICIES: readonly CurveStableSwapNgPoolPolicy[] = [
  CURVE_USDG_USDC_STABLESWAP_NG_POLICY,
  CURVE_DUSD_USDC_STABLESWAP_NG_POLICY,
  ...CURVE_STABLESWAP_NG_SHADOW_DEPLOYMENTS.map((deployment): CurveStableSwapNgPoolPolicy => ({
    chain: deployment.chain,
    stablecoinId: deployment.stablecoinId,
    poolAddress: deployment.poolAddress,
    expectedPoolCodeHash: deployment.poolCodeHash,
    factoryAddress: CURVE_STABLESWAP_NG_ETHERLINK_FACTORY.address,
    expectedFactoryCodeHash: CURVE_STABLESWAP_NG_ETHERLINK_FACTORY.codeHash,
    factoryPoolIndex: deployment.factoryPoolIndex,
    poolTokens: deployment.poolTokens,
    inputIndex: deployment.inputIndex,
    outputIndex: deployment.outputIndex,
    mode: "shadow",
    scoreEligible: false,
  })),
];

export interface CurveStableSwapNgRuntimeEvidence {
  blockTimestamp: number;
  poolCodeHash: `0x${string}`;
  factoryBindingProof: DexMeasuredExecutionStableSwapNgFactoryBindingProof;
}

export type CurveStableSwapNgEligibilityFailure =
  | "pool-not-reviewed"
  | "execution-endpoint-mismatch"
  | "invalid-pinned-block"
  | "block-header-unavailable"
  | "block-header-mismatch"
  | "block-hash-invalid"
  | "block-commitment-mismatch"
  | "stale-pinned-block"
  | "future-pinned-block"
  | "runtime-code-unavailable"
  | "runtime-code-absent"
  | "runtime-code-hash-mismatch"
  | "factory-code-unavailable"
  | "factory-code-absent"
  | "factory-code-hash-mismatch"
  | "factory-membership-mismatch"
  | "factory-membership-unproven"
  | "pool-token-order-mismatch"
  | "pool-token-order-unproven"
  | "token-decimals-mismatch"
  | "token-decimals-unproven"
  | "rpc-failure";

export type CurveStableSwapNgEligibility =
  | { ok: true }
  | { ok: false; reason: CurveStableSwapNgEligibilityFailure };

export function getCurveStableSwapNgPolicy(
  chain: string,
  poolAddress: string,
): CurveStableSwapNgPoolPolicy | null {
  const normalizedChain = chain.trim().toLowerCase();
  const normalizedAddress = canonicalEvmAddress(poolAddress);
  return CURVE_STABLESWAP_NG_POLICIES.find(
    (policy) => policy.chain === normalizedChain && policy.poolAddress === normalizedAddress,
  ) ?? null;
}

export function evaluateCurveStableSwapNgEligibility(input: {
  chain: string;
  endpointAddress: string;
  blockNumber: number;
  nowSec: number;
  evidence?: CurveStableSwapNgRuntimeEvidence;
}): CurveStableSwapNgEligibility {
  const policy = getCurveStableSwapNgPolicy(input.chain, input.endpointAddress);
  if (!policy) return { ok: false, reason: "pool-not-reviewed" };
  if (canonicalEvmAddress(input.endpointAddress) !== policy.poolAddress) {
    return { ok: false, reason: "execution-endpoint-mismatch" };
  }
  if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0) {
    return { ok: false, reason: "invalid-pinned-block" };
  }
  const evidence = input.evidence;
  if (!evidence || !Number.isSafeInteger(evidence.blockTimestamp) || evidence.blockTimestamp <= 0) {
    return { ok: false, reason: "block-header-unavailable" };
  }
  if (evidence.blockTimestamp > input.nowSec + 60) {
    return { ok: false, reason: "future-pinned-block" };
  }
  if (
    input.nowSec - evidence.blockTimestamp >
    DEX_MEASURED_FRESHNESS_MAX_SEC
  ) {
    return { ok: false, reason: "stale-pinned-block" };
  }
  if (canonicalEvmHash(evidence.poolCodeHash) == null) {
    return { ok: false, reason: "runtime-code-unavailable" };
  }
  if (evidence.poolCodeHash !== policy.expectedPoolCodeHash) {
    return { ok: false, reason: "runtime-code-hash-mismatch" };
  }
  const proof = evidence.factoryBindingProof;
  if (proof.blockNumber !== input.blockNumber) {
    return { ok: false, reason: "block-header-mismatch" };
  }
  if (!/^0x[0-9a-f]{64}$/.test(proof.blockHash)) {
    return { ok: false, reason: "block-hash-invalid" };
  }
  if (proof.blockCommitment !== "finalized") {
    return { ok: false, reason: "block-commitment-mismatch" };
  }
  if (canonicalEvmHash(proof.factoryCodeHash) == null) {
    return { ok: false, reason: "factory-code-unavailable" };
  }
  if (proof.factoryCodeHash !== policy.expectedFactoryCodeHash) {
    return { ok: false, reason: "factory-code-hash-mismatch" };
  }
  if (
    proof.factoryAddress !== policy.factoryAddress ||
    proof.poolIndex !== policy.factoryPoolIndex ||
    proof.registeredPoolAddress !== policy.poolAddress
  ) {
    return { ok: false, reason: "factory-membership-mismatch" };
  }
  const expectedAddresses = policy.poolTokens.map((token) => token.address);
  if (
    proof.poolTokenAddresses.length !== expectedAddresses.length ||
    proof.poolTokenAddresses.some((address, index) => address !== expectedAddresses[index]) ||
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

interface CurveStableSwapNgVerificationDependencies {
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
  fetchBlockHeader(
    chain: string,
    blockNumber: number | "finalized",
    options: Parameters<typeof fetchEvmBlockHeader>[2],
  ): Promise<EvmBlockHeader | null>;
  hashCode?(code: `0x${string}`): `0x${string}`;
}

export type CurveStableSwapNgDeploymentVerification =
  | {
      ok: true;
      codeHash: `0x${string}`;
      blockNumber: number;
      blockTimestamp: number;
      runtimeEvidence: CurveStableSwapNgRuntimeEvidence;
      factoryBindingProof: DexMeasuredExecutionStableSwapNgFactoryBindingProof;
    }
  | { ok: false; reason: CurveStableSwapNgEligibilityFailure };

export function createCurveStableSwapNgDeploymentVerifier(
  dependencies: CurveStableSwapNgVerificationDependencies,
) {
  return createCurveFamilyDeploymentVerifier<
    CurveStableSwapNgPoolPolicy,
    CurveStableSwapNgEligibilityFailure,
    CurveStableSwapNgDeploymentVerification
  >({
    defaultPolicy: CURVE_USDG_USDC_STABLESWAP_NG_POLICY,
    dependencies,
    async resolveBlock(input, policy, requestOptions) {
      const blockHeader = await dependencies.fetchBlockHeader(policy.chain, "finalized", requestOptions);
      input.rpcBudget?.recordChainResult(policy.chain, blockHeader != null);
      if (blockHeader == null) return { ok: false, reason: "block-header-unavailable" };
      if (!/^0x[0-9a-f]{64}$/.test(blockHeader.hash)) {
        return { ok: false, reason: "block-hash-invalid" };
      }
      if (blockHeader.timestamp > input.nowSec + 60) {
        return { ok: false, reason: "future-pinned-block" };
      }
      if (input.nowSec - blockHeader.timestamp > DEX_MEASURED_FRESHNESS_MAX_SEC) {
        return { ok: false, reason: "stale-pinned-block" };
      }
      return {
        number: blockHeader.number,
        timestamp: blockHeader.timestamp,
        hash: blockHeader.hash,
      };
    },
    codeBindings: [
      {
        key: "pool",
        address: (policy) => policy.poolAddress,
        expectedHash: (policy) => policy.expectedPoolCodeHash,
        unavailable: "runtime-code-unavailable",
        absent: "runtime-code-absent",
        mismatch: "runtime-code-hash-mismatch",
      },
      {
        key: "factory",
        address: (policy) => policy.factoryAddress,
        expectedHash: (policy) => policy.expectedFactoryCodeHash,
        unavailable: "factory-code-unavailable",
        absent: "factory-code-absent",
        mismatch: "factory-code-hash-mismatch",
      },
    ],
    binding: {
      kind: "ng-factory",
      address: (policy) => policy.factoryAddress,
      poolIndex: (policy) => policy.factoryPoolIndex,
      unavailable: "factory-membership-unproven",
      mismatch: "factory-membership-mismatch",
    },
    tokenFailures: {
      poolTokenUnavailable: "pool-token-order-unproven",
      poolTokenMismatch: "pool-token-order-mismatch",
      tokenDecimalsUnavailable: "token-decimals-unproven",
      tokenDecimalsMismatch: "token-decimals-mismatch",
    },
    async confirmBlock({ input, policy, block, requestOptions, fail }) {
      const revalidated = await dependencies.fetchBlockHeader(policy.chain, block.number, requestOptions);
      input.rpcBudget?.recordChainResult(policy.chain, revalidated != null);
      if (revalidated == null) return fail("block-header-unavailable");
      if (
        revalidated.number !== block.number ||
        revalidated.timestamp !== block.timestamp ||
        revalidated.hash !== block.hash
      ) return fail("block-header-mismatch");
      return { ok: true };
    },
    makeResult({ input, policy, block, codeHashes }, binding, tokenProof) {
      const poolCodeHash = codeHashes.get("pool")!;
      const factoryBindingProof: DexMeasuredExecutionStableSwapNgFactoryBindingProof = {
        blockNumber: block.number,
        blockHash: block.hash!,
        blockCommitment: "finalized",
        factoryAddress: policy.factoryAddress,
        factoryCodeHash: codeHashes.get("factory")!,
        poolIndex: policy.factoryPoolIndex,
        registeredPoolAddress: binding.registeredPoolAddress,
        poolTokenAddresses: binding.poolTokenAddresses,
        poolListCallData: binding.identityCallData,
        poolListReturnData: binding.identityReturnData,
        factoryCoinsCallData: binding.coinsCallData,
        factoryCoinsReturnData: binding.coinsReturnData,
        poolCoinsProof: tokenProof.poolCoinsProof,
        tokenDecimalsProof: tokenProof.tokenDecimalsProof,
      };
      const runtimeEvidence: CurveStableSwapNgRuntimeEvidence = {
        blockTimestamp: block.timestamp,
        poolCodeHash,
        factoryBindingProof,
      };
      const eligibility = evaluateCurveStableSwapNgEligibility({
        chain: policy.chain,
        endpointAddress: policy.poolAddress,
        blockNumber: block.number,
        nowSec: input.nowSec,
        evidence: runtimeEvidence,
      });
      return eligibility.ok
        ? {
            ok: true,
            codeHash: poolCodeHash,
            blockNumber: block.number,
            blockTimestamp: block.timestamp,
            runtimeEvidence,
            factoryBindingProof,
          }
        : eligibility;
    },
  });
}

export const verifyCurveStableSwapNgDeployment = createCurveStableSwapNgDeploymentVerifier({
  fetchCodeStatus: fetchEvmCodeStatusAtBlock,
  fetchCall: fetchEvmCallHexAtBlock,
  fetchBlockHeader: fetchEvmBlockHeader,
});

export type CurveStableSwapNgQuoteFailure =
  | DexMeasuredExecutionBudgetStopReason
  | "unsupported-chain-or-pool"
  | "invalid-pinned-block"
  | "invalid-quote-input"
  | "invalid-curve-stableswap-ng-target"
  | "pool-token-order-mismatch"
  | "runtime-evidence-missing"
  | "rpc-failure"
  | "pool-revert"
  | "malformed-pool-return";

export interface CurveStableSwapNgRequest {
  target: DexMeasuredExecutionTarget;
  inputUsd: number;
  blockNumber: number;
  blockObservedAt: number;
  endpointAddress: `0x${string}`;
  runtimeEvidence?: CurveStableSwapNgRuntimeEvidence;
}

export function resolveCurveStableSwapNgTokenIndices(
  target: DexMeasuredExecutionTarget | DexMeasuredExecutionProfile,
): { ok: true; inputIndex: 0 | 1; outputIndex: 0 | 1 } | { ok: false; reason: CurveStableSwapNgQuoteFailure } {
  const endpointAddress =
    "executionEndpoint" in target
      ? target.executionEndpoint.address
      : target.poolId.slice(target.poolId.lastIndexOf(":") + 1);
  const policy = getCurveStableSwapNgPolicy(target.chain, endpointAddress);
  if (
    target.adapterProfileId !== CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID ||
    target.protocol.trim().toLowerCase() !== "curve" ||
    !policy ||
    target.poolTokenAddresses == null ||
    target.poolTokenAddresses.length !== policy.poolTokens.length ||
    target.poolTokenAddresses.some((address, index) => address !== policy.poolTokens[index]!.address) ||
    target.tokenIn.address !== policy.poolTokens[policy.inputIndex].address ||
    target.tokenOut.address !== policy.poolTokens[policy.outputIndex].address ||
    target.tokenIn.decimals !== policy.poolTokens[policy.inputIndex].decimals ||
    target.tokenOut.decimals !== policy.poolTokens[policy.outputIndex].decimals ||
    target.tokenIn.trackedAssetId !== policy.poolTokens[policy.inputIndex].trackedAssetId ||
    target.tokenOut.trackedAssetId !== policy.poolTokens[policy.outputIndex].trackedAssetId
  ) {
    return { ok: false, reason: "invalid-curve-stableswap-ng-target" };
  }
  return { ok: true, inputIndex: policy.inputIndex, outputIndex: policy.outputIndex };
}

export function encodeCurveStableSwapNgGetDy(input: {
  inputIndex: number;
  outputIndex: number;
  amountInRaw: bigint;
}): `0x${string}` {
  return encodeCurveStableSwapGetDyCall(
    input,
    (inputIndex, outputIndex) =>
      (inputIndex === 0 || inputIndex === 1) &&
      (outputIndex === 0 || outputIndex === 1) &&
      inputIndex !== outputIndex,
    "Curve StableSwap-NG quote indices or amount are invalid",
  );
}

export function decodeCurveStableSwapNgGetDy(returnData: `0x${string}`): bigint | null {
  return decodeCurveStableSwapGetDyResult(returnData);
}

interface CurveStableSwapNgQuoteDependencies {
  executeMulticall(input: {
    chain: string;
    calls: readonly EvmMulticall3Call[];
    blockNumber: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<EvmMulticall3Result[] | null>;
}

export function createCurveStableSwapNgQuoteExecutor(
  dependencies: CurveStableSwapNgQuoteDependencies,
) {
  return createCurveStableSwapExecutionPipeline<
    CurveStableSwapNgPoolPolicy,
    CurveStableSwapNgRuntimeEvidence,
    CurveStableSwapNgEligibility,
    CurveStableSwapNgQuoteFailure
  >({
    invalidTargetFailure: "invalid-curve-stableswap-ng-target",
    runtimeEvidenceUnavailableReason: "block-header-unavailable",
    getPolicy: getCurveStableSwapNgPolicy,
    evaluateEligibility: evaluateCurveStableSwapNgEligibility,
    resolveTokenIndices: resolveCurveStableSwapNgTokenIndices,
    encodeGetDy: encodeCurveStableSwapNgGetDy,
    quoteMetadata: (request) => ({
      executionPool: request.endpointAddress,
      blockNumber: request.blockNumber,
      inputIndex: request.inputIndex,
      outputIndex: request.outputIndex,
      factory: request.policy.factoryAddress,
      factoryPoolIndex: request.policy.factoryPoolIndex,
    }),
  }, dependencies);
}

export const quoteCurveStableSwapNgRequests = createCurveStableSwapNgQuoteExecutor({
  executeMulticall: async (input) =>
    fetchEvmMulticall3Aggregate3AtBlock(input.chain, input.calls, input.blockNumber, {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      maxRetries: 1,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
      gas: CURVE_STABLESWAP_MULTICALL_GAS,
      multicallBatchSize: Math.min(
        CURVE_STABLESWAP_MULTICALL_BATCH_SIZE,
        input.calls.length,
      ),
    }),
});

/** Exact ABI and reviewed StableSwap-NG factory-binding validation at the consumer boundary. */
export function validateCurveStableSwapNgProfileProof(
  profile: DexMeasuredExecutionProfile,
): string[] {
  return validateCurveStableSwapExecutionProfile<
    CurveStableSwapNgPoolPolicy,
    CurveStableSwapNgQuoteFailure,
    DexMeasuredExecutionStableSwapNgFactoryBindingProof
  >({
    profile,
    adapterProfileId: CURVE_STABLESWAP_NG_ADAPTER_PROFILE_ID,
    getPolicy: getCurveStableSwapNgPolicy,
    resolveTokenIndices: resolveCurveStableSwapNgTokenIndices,
    getProof: (candidate) => candidate.stableSwapNgFactoryBindingProof,
    missingProofIssue: "factory-binding-proof-missing",
    validateDeploymentProof: (issues, proof, policy) => {
      if (
        proof.blockCommitment !== "finalized" ||
        proof.blockNumber !== profile.blockNumber
      ) issues.add("block-binding-mismatch");
      if (
        proof.factoryAddress !== policy.factoryAddress ||
        proof.factoryCodeHash !== policy.expectedFactoryCodeHash ||
        proof.poolIndex !== policy.factoryPoolIndex ||
        proof.registeredPoolAddress !== policy.poolAddress
      ) issues.add("factory-binding-mismatch");
      if (
        proof.poolTokenAddresses.length !== policy.poolTokens.length ||
        proof.poolTokenAddresses.some((address, index) => address !== policy.poolTokens[index]!.address)
      ) issues.add("pool-token-order-mismatch");

      try {
        const decodedCall = decodeFunctionData({
          abi: CURVE_STABLESWAP_NG_FACTORY_ABI,
          data: proof.poolListCallData as `0x${string}`,
        });
        if (
          decodedCall.functionName !== "pool_list" ||
          decodedCall.args[0] !== BigInt(policy.factoryPoolIndex) ||
          decodeEvmAddressResult({
            decode: () => decodeFunctionResult({
              abi: CURVE_STABLESWAP_NG_FACTORY_ABI,
              functionName: "pool_list",
              data: proof.poolListReturnData as `0x${string}`,
            } as never),
          }) !== policy.poolAddress
        ) issues.add("factory-pool-list-proof-mismatch");
      } catch {
        issues.add("factory-pool-list-proof-mismatch");
      }
      try {
        const decodedCall = decodeFunctionData({
          abi: CURVE_STABLESWAP_NG_FACTORY_ABI,
          data: proof.factoryCoinsCallData as `0x${string}`,
        });
        const decodedCoins = decodeFunctionResult({
          abi: CURVE_STABLESWAP_NG_FACTORY_ABI,
          functionName: "get_coins",
          data: proof.factoryCoinsReturnData as `0x${string}`,
        }) as readonly string[];
        if (
          decodedCall.functionName !== "get_coins" ||
          canonicalEvmAddress(decodedCall.args[0]) !== policy.poolAddress ||
          decodedCoins.length !== policy.poolTokens.length ||
          policy.poolTokens.some((token, index) => canonicalEvmAddress(decodedCoins[index]) !== token.address)
        ) issues.add("factory-coins-proof-mismatch");
      } catch {
        issues.add("factory-coins-proof-mismatch");
      }
    },
  });
}
