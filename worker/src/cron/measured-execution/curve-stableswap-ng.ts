import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
} from "viem/utils";

import {
  DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC,
  DEX_MEASURED_ADAPTER_PROFILE_IDS,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionStableSwapNgFactoryBindingProof,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import {
  CURVE_STABLESWAP_NG_DEPLOYMENTS,
  CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT,
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
  type DexMeasuredRawQuotePoint,
} from "./profiles";
import {
  canonicalEvmAddress,
  canonicalEvmHash,
  decodeAddressResult as decodeEvmAddressResult,
} from "./evm-codecs";
import {
  CURVE_STABLESWAP_MULTICALL_BATCH_SIZE,
  CURVE_STABLESWAP_MULTICALL_GAS,
  createCurveStableSwapExecutionPipeline,
  createCurveStableSwapPinnedReaders,
  decodeCurveStableSwapGetDyResult,
  encodeCurveStableSwapGetDyCall,
  validateCurveStableSwapExecutionProfile,
  verifyCurveStableSwapPoolTokens,
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
  chain: "ethereum";
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
  mode: "active";
  scoreEligible: true;
}

/** Exact reviewed USDG/USDC StableSwap-NG deployment. This is not a generic Curve allowlist. */
export const CURVE_USDG_USDC_STABLESWAP_NG_POLICY: CurveStableSwapNgPoolPolicy = {
  chain: CURVE_STABLESWAP_NG_DEPLOYMENTS[0].chain,
  stablecoinId: CURVE_STABLESWAP_NG_DEPLOYMENTS[0].stablecoinId,
  poolAddress: CURVE_STABLESWAP_NG_DEPLOYMENTS[0].poolAddress,
  expectedPoolCodeHash: CURVE_STABLESWAP_NG_DEPLOYMENTS[0].poolCodeHash,
  factoryAddress: CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT.address,
  expectedFactoryCodeHash: CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT.codeHash,
  factoryPoolIndex: CURVE_STABLESWAP_NG_DEPLOYMENTS[0].factoryPoolIndex,
  poolTokens: CURVE_STABLESWAP_NG_DEPLOYMENTS[0].poolTokens,
  inputIndex: CURVE_STABLESWAP_NG_DEPLOYMENTS[0].inputIndex,
  outputIndex: CURVE_STABLESWAP_NG_DEPLOYMENTS[0].outputIndex,
  mode: "active",
  scoreEligible: true,
};

/** Exact reviewed DUSD/USDC StableSwap-NG deployment. DUSD is the rate-bearing input; direct get_dy is required. */
export const CURVE_DUSD_USDC_STABLESWAP_NG_POLICY: CurveStableSwapNgPoolPolicy = {
  chain: CURVE_STABLESWAP_NG_DEPLOYMENTS[1].chain,
  stablecoinId: CURVE_STABLESWAP_NG_DEPLOYMENTS[1].stablecoinId,
  poolAddress: CURVE_STABLESWAP_NG_DEPLOYMENTS[1].poolAddress,
  expectedPoolCodeHash: CURVE_STABLESWAP_NG_DEPLOYMENTS[1].poolCodeHash,
  factoryAddress: CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT.address,
  expectedFactoryCodeHash: CURVE_STABLESWAP_NG_FACTORY_DEPLOYMENT.codeHash,
  factoryPoolIndex: CURVE_STABLESWAP_NG_DEPLOYMENTS[1].factoryPoolIndex,
  poolTokens: CURVE_STABLESWAP_NG_DEPLOYMENTS[1].poolTokens,
  inputIndex: CURVE_STABLESWAP_NG_DEPLOYMENTS[1].inputIndex,
  outputIndex: CURVE_STABLESWAP_NG_DEPLOYMENTS[1].outputIndex,
  mode: "active",
  scoreEligible: true,
};

const CURVE_STABLESWAP_NG_POLICIES: readonly CurveStableSwapNgPoolPolicy[] = [
  CURVE_USDG_USDC_STABLESWAP_NG_POLICY,
  CURVE_DUSD_USDC_STABLESWAP_NG_POLICY,
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
    DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC
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
  return async function verifyCurveStableSwapNgDeployment(input: {
    policy?: CurveStableSwapNgPoolPolicy;
    nowSec: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<CurveStableSwapNgDeploymentVerification> {
    const policy = input.policy ?? CURVE_USDG_USDC_STABLESWAP_NG_POLICY;
    const requestOptions = {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
    };

    const blockHeader = await dependencies.fetchBlockHeader(
      policy.chain,
      "finalized",
      requestOptions,
    );
    input.rpcBudget?.recordChainResult(policy.chain, blockHeader != null);
    if (blockHeader == null) return { ok: false, reason: "block-header-unavailable" };
    if (!/^0x[0-9a-f]{64}$/.test(blockHeader.hash)) {
      return { ok: false, reason: "block-hash-invalid" };
    }
    const blockTimestamp = blockHeader.timestamp;
    if (blockTimestamp > input.nowSec + 60) return { ok: false, reason: "future-pinned-block" };
    if (
      input.nowSec - blockTimestamp >
      DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC
    ) {
      return { ok: false, reason: "stale-pinned-block" };
    }

    const { readCode, readCall } = createCurveStableSwapPinnedReaders(
      { policy, blockNumber: blockHeader.number, rpcBudget: input.rpcBudget },
      dependencies,
      requestOptions,
    );

    const poolCodeResult = await readCode(policy.poolAddress);
    if (poolCodeResult.status === "unavailable") {
      return { ok: false, reason: "runtime-code-unavailable" };
    }
    if (poolCodeResult.status === "absent") {
      return { ok: false, reason: "runtime-code-absent" };
    }
    const factoryCodeResult = await readCode(policy.factoryAddress);
    if (factoryCodeResult.status === "unavailable") {
      return { ok: false, reason: "factory-code-unavailable" };
    }
    if (factoryCodeResult.status === "absent") {
      return { ok: false, reason: "factory-code-absent" };
    }
    const hashCode = dependencies.hashCode ?? ((code: `0x${string}`) => keccak256(code));
    const poolCodeHash = hashCode(poolCodeResult.code).toLowerCase() as `0x${string}`;
    if (poolCodeHash !== policy.expectedPoolCodeHash) {
      return { ok: false, reason: "runtime-code-hash-mismatch" };
    }
    const factoryCodeHash = hashCode(factoryCodeResult.code).toLowerCase() as `0x${string}`;
    if (factoryCodeHash !== policy.expectedFactoryCodeHash) {
      return { ok: false, reason: "factory-code-hash-mismatch" };
    }

    const poolListCallData = encodeFunctionData({
      abi: CURVE_STABLESWAP_NG_FACTORY_ABI,
      functionName: "pool_list",
      args: [BigInt(policy.factoryPoolIndex)],
    }).toLowerCase() as `0x${string}`;
    const factoryCoinsCallData = encodeFunctionData({
      abi: CURVE_STABLESWAP_NG_FACTORY_ABI,
      functionName: "get_coins",
      args: [policy.poolAddress],
    }).toLowerCase() as `0x${string}`;
    const poolListReturnData = await readCall(policy.factoryAddress, poolListCallData);
    const factoryCoinsReturnData = await readCall(policy.factoryAddress, factoryCoinsCallData);
    if (poolListReturnData == null || factoryCoinsReturnData == null) {
      return { ok: false, reason: "factory-membership-unproven" };
    }

    let registeredPoolAddress: `0x${string}` | null;
    let factoryCoins: readonly (`0x${string}` | null)[];
    try {
      registeredPoolAddress = canonicalEvmAddress(decodeFunctionResult({
        abi: CURVE_STABLESWAP_NG_FACTORY_ABI,
        functionName: "pool_list",
        data: poolListReturnData,
      }));
      factoryCoins = (decodeFunctionResult({
        abi: CURVE_STABLESWAP_NG_FACTORY_ABI,
        functionName: "get_coins",
        data: factoryCoinsReturnData,
      }) as readonly string[]).map((coin) => canonicalEvmAddress(coin));
    } catch {
      return { ok: false, reason: "factory-membership-mismatch" };
    }
    const expectedAddresses = policy.poolTokens.map((token) => token.address);
    if (
      registeredPoolAddress !== policy.poolAddress ||
      factoryCoins.length !== expectedAddresses.length ||
      expectedAddresses.some((address, index) => factoryCoins[index] !== address)
    ) {
      return { ok: false, reason: "factory-membership-mismatch" };
    }

    const tokenProof = await verifyCurveStableSwapPoolTokens({
      policy,
      signal: input.signal,
      readCall,
      failures: {
        poolTokenUnavailable: "pool-token-order-unproven",
        poolTokenMismatch: "pool-token-order-mismatch",
        tokenDecimalsUnavailable: "token-decimals-unproven",
        tokenDecimalsMismatch: "token-decimals-mismatch",
      },
    });
    if (!tokenProof.ok) return tokenProof;

    const revalidatedBlockHeader = await dependencies.fetchBlockHeader(
      policy.chain,
      blockHeader.number,
      requestOptions,
    );
    input.rpcBudget?.recordChainResult(policy.chain, revalidatedBlockHeader != null);
    if (revalidatedBlockHeader == null) {
      return { ok: false, reason: "block-header-unavailable" };
    }
    if (
      revalidatedBlockHeader.number !== blockHeader.number ||
      revalidatedBlockHeader.timestamp !== blockHeader.timestamp ||
      revalidatedBlockHeader.hash !== blockHeader.hash
    ) {
      return { ok: false, reason: "block-header-mismatch" };
    }

    const factoryBindingProof: DexMeasuredExecutionStableSwapNgFactoryBindingProof = {
      blockNumber: blockHeader.number,
      blockHash: blockHeader.hash,
      blockCommitment: "finalized",
      factoryAddress: policy.factoryAddress,
      factoryCodeHash,
      poolIndex: policy.factoryPoolIndex,
      registeredPoolAddress: policy.poolAddress,
      poolTokenAddresses: expectedAddresses,
      poolListCallData,
      poolListReturnData: poolListReturnData.toLowerCase() as `0x${string}`,
      factoryCoinsCallData,
      factoryCoinsReturnData: factoryCoinsReturnData.toLowerCase() as `0x${string}`,
      poolCoinsProof: tokenProof.poolCoinsProof,
      tokenDecimalsProof: tokenProof.tokenDecimalsProof,
    };
    const runtimeEvidence: CurveStableSwapNgRuntimeEvidence = {
      blockTimestamp,
      poolCodeHash,
      factoryBindingProof,
    };
    const eligibility = evaluateCurveStableSwapNgEligibility({
      chain: policy.chain,
      endpointAddress: policy.poolAddress,
      blockNumber: blockHeader.number,
      nowSec: input.nowSec,
      evidence: runtimeEvidence,
    });
    return eligibility.ok
      ? {
          ok: true,
          codeHash: poolCodeHash,
          blockNumber: blockHeader.number,
          blockTimestamp,
          runtimeEvidence,
          factoryBindingProof,
        }
      : eligibility;
  };
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

export interface CurveStableSwapNgBatchOutcome {
  targetId: string;
  inputUsd: number;
  blockNumber: number;
  eligibility: CurveStableSwapNgEligibility;
  point?: DexMeasuredRawQuotePoint;
  failureReason?: CurveStableSwapNgQuoteFailure;
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
