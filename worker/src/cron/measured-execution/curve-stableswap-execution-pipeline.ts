import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
} from "viem/utils";

import {
  buildDexMeasuredExecutionTargetId,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import { throwIfAborted } from "../../lib/abort";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type {
  EvmCodeAtBlockResult,
  EvmMulticall3Call,
  EvmMulticall3Result,
  EvmRpcOptions,
} from "../../lib/evm-rpc";
import { DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS } from "./profiles";
import { decodeCurveMeasuredRawQuotePoint } from "./curve-quote-point";
import {
  createCurveGetDyQuoteAdapter,
  makeCurveGetDyPlan,
  type CurveGetDyPlan,
} from "./curve-get-dy-quote-engine";
import {
  canonicalEvmAddress,
  canonicalEvmHash,
  decodeAddressResult as decodeEvmAddressResult,
} from "./evm-codecs";
import { usdToRawAmount } from "./fixed-point";
import type {
  DexMeasuredExecutionBudgetStopReason,
  DexMeasuredExecutionRpcBudget,
  DexMeasuredRawQuotePoint,
} from "./profiles";

const CURVE_STABLESWAP_POOL_ABI = parseAbi([
  "function coins(uint256) view returns (address)",
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
const CURVE_STABLESWAP_ERC20_METADATA_ABI = parseAbi([
  "function decimals() view returns (uint8)",
]);
export const CURVE_STABLESWAP_MULTICALL_BATCH_SIZE = 8;
export const CURVE_STABLESWAP_MULTICALL_GAS = "0x1c9c380";

interface CurveStableSwapTokenPolicy {
  address: `0x${string}`;
  decimals: number;
}

export interface CurveStableSwapExecutionPolicy {
  chain: string;
  poolAddress: `0x${string}`;
  expectedPoolCodeHash: `0x${string}`;
  poolTokens: readonly CurveStableSwapTokenPolicy[];
}

interface CurveStableSwapPinnedReaderInput<P extends CurveStableSwapExecutionPolicy> {
  policy: P;
  blockNumber: number;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
}

interface CurveStableSwapPinnedReaderDependencies {
  fetchCodeStatus(
    chain: string,
    address: string,
    blockNumber: number,
    options: EvmRpcOptions,
  ): Promise<EvmCodeAtBlockResult>;
  fetchCall(
    chain: string,
    address: string,
    callData: string,
    blockNumber: number,
    options: EvmRpcOptions,
  ): Promise<`0x${string}` | null>;
}

export interface CurveStableSwapDeploymentDependencies
  extends CurveStableSwapPinnedReaderDependencies {
  hashCode?(code: `0x${string}`): `0x${string}`;
}

interface CurveStableSwapDeploymentInput<Policy extends CurveStableSwapExecutionPolicy> {
  policy?: Policy;
  nowSec: number;
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
}

interface CurveStableSwapPinnedBlock {
  blockNumber: number;
  blockTimestamp: number;
  blockHash?: `0x${string}`;
}

type CurveStableSwapVerificationStep<Value, Failure extends string> =
  | { ok: true; value: Value }
  | { ok: false; reason: Failure };

type CurveStableSwapDeploymentFailure =
  | "future-pinned-block"
  | "stale-pinned-block"
  | "runtime-code-unavailable"
  | "runtime-code-absent"
  | "runtime-code-hash-mismatch";

export interface CurveStableSwapDeploymentContext<
  Policy extends CurveStableSwapExecutionPolicy,
  Input extends CurveStableSwapDeploymentInput<Policy>,
> extends CurveStableSwapPinnedBlock {
  input: Input;
  policy: Policy;
  requestOptions: EvmRpcOptions;
  readCode(address: `0x${string}`): Promise<EvmCodeAtBlockResult>;
  readCall(address: `0x${string}`, callData: `0x${string}`): Promise<`0x${string}` | null>;
  hashCode(code: `0x${string}`): `0x${string}`;
}

export function createCurveStableSwapDeploymentVerifier<
  Policy extends CurveStableSwapExecutionPolicy,
  Input extends CurveStableSwapDeploymentInput<Policy>,
  BindingProof,
  Failure extends string,
>(
  dependencies: CurveStableSwapDeploymentDependencies,
  strategy: {
    defaultPolicy: Policy;
    freshnessMaxSec: number;
    precheck?(input: Input, policy: Policy): Failure | null;
    acquireBlock(input: Input, policy: Policy, options: EvmRpcOptions): Promise<
      CurveStableSwapVerificationStep<CurveStableSwapPinnedBlock, Failure>
    >;
    bindingCode: {
      address(policy: Policy): `0x${string}`;
      expectedHash(policy: Policy): `0x${string}`;
      beforePoolHash: boolean;
      unavailable: Failure;
      absent: Failure;
      mismatch: Failure;
    };
    verifyBinding(context: CurveStableSwapDeploymentContext<Policy, Input> & {
      bindingCodeHash: `0x${string}`;
    }): Promise<CurveStableSwapVerificationStep<BindingProof, Failure>>;
  },
) {
  return async function verifyCurveStableSwapDeployment(input: Input): Promise<
    | {
        ok: true;
        codeHash: `0x${string}`;
        blockNumber: number;
        blockTimestamp: number;
        bindingProof: BindingProof;
      }
    | { ok: false; reason: Failure | CurveStableSwapDeploymentFailure }
  > {
    const policy = input.policy ?? strategy.defaultPolicy;
    const precheckFailure = strategy.precheck?.(input, policy);
    if (precheckFailure) return { ok: false, reason: precheckFailure };

    const requestOptions: EvmRpcOptions = {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
    };
    const pinnedBlock = await strategy.acquireBlock(input, policy, requestOptions);
    if (!pinnedBlock.ok) return pinnedBlock;
    const { blockNumber, blockTimestamp } = pinnedBlock.value;
    if (blockTimestamp > input.nowSec + 60) {
      return { ok: false, reason: "future-pinned-block" };
    }
    if (input.nowSec - blockTimestamp > strategy.freshnessMaxSec) {
      return { ok: false, reason: "stale-pinned-block" };
    }

    const { readCode, readCall } = createCurveStableSwapPinnedReaders(
      { policy, blockNumber, rpcBudget: input.rpcBudget },
      dependencies,
      requestOptions,
    );
    const hashCode = dependencies.hashCode ?? ((code: `0x${string}`) => keccak256(code));
    const context: CurveStableSwapDeploymentContext<Policy, Input> = {
      input,
      policy,
      requestOptions,
      blockNumber,
      blockTimestamp,
      ...(pinnedBlock.value.blockHash ? { blockHash: pinnedBlock.value.blockHash } : {}),
      readCode,
      readCall,
      hashCode,
    };

    const poolCodeResult = await readCode(policy.poolAddress);
    if (poolCodeResult.status === "unavailable") {
      return { ok: false, reason: "runtime-code-unavailable" };
    }
    if (poolCodeResult.status === "absent") {
      return { ok: false, reason: "runtime-code-absent" };
    }
    const readBindingCode = async () => {
      const result = await readCode(strategy.bindingCode.address(policy));
      if (result.status === "unavailable") {
        return { ok: false, reason: strategy.bindingCode.unavailable } as const;
      }
      if (result.status === "absent") {
        return { ok: false, reason: strategy.bindingCode.absent } as const;
      }
      return { ok: true, value: result.code } as const;
    };
    let bindingCode = strategy.bindingCode.beforePoolHash ? await readBindingCode() : null;
    if (bindingCode && !bindingCode.ok) return bindingCode;
    const poolCodeHash = hashCode(poolCodeResult.code).toLowerCase() as `0x${string}`;
    if (poolCodeHash !== policy.expectedPoolCodeHash) {
      return { ok: false, reason: "runtime-code-hash-mismatch" };
    }
    bindingCode ??= await readBindingCode();
    if (!bindingCode.ok) return bindingCode;
    const bindingCodeHash = hashCode(bindingCode.value).toLowerCase() as `0x${string}`;
    if (bindingCodeHash !== strategy.bindingCode.expectedHash(policy)) {
      return { ok: false, reason: strategy.bindingCode.mismatch };
    }

    const binding = await strategy.verifyBinding({ ...context, bindingCodeHash });
    if (!binding.ok) return binding;
    return {
      ok: true,
      codeHash: poolCodeHash,
      blockNumber,
      blockTimestamp,
      bindingProof: binding.value,
    };
  };
}

export function createCurveStableSwapPinnedReaders<P extends CurveStableSwapExecutionPolicy>(
  input: CurveStableSwapPinnedReaderInput<P>,
  dependencies: CurveStableSwapPinnedReaderDependencies,
  requestOptions: EvmRpcOptions,
) {
  return {
    readCode: async (address: `0x${string}`): Promise<EvmCodeAtBlockResult> => {
      if (input.rpcBudget && !input.rpcBudget.canRequestChain(input.policy.chain)) {
        return { status: "unavailable" };
      }
      const result = await dependencies.fetchCodeStatus(
        input.policy.chain,
        address,
        input.blockNumber,
        requestOptions,
      );
      input.rpcBudget?.recordChainResult(input.policy.chain, result.status !== "unavailable");
      return result;
    },
    readCall: async (
      address: `0x${string}`,
      callData: `0x${string}`,
    ): Promise<`0x${string}` | null> => {
      if (input.rpcBudget && !input.rpcBudget.canRequestChain(input.policy.chain)) return null;
      const result = await dependencies.fetchCall(
        input.policy.chain,
        address,
        callData,
        input.blockNumber,
        requestOptions,
      );
      input.rpcBudget?.recordChainResult(input.policy.chain, result != null);
      return result;
    },
  };
}

interface CurveStableSwapBaseRuntimeEvidence {
  blockTimestamp: number;
  poolCodeHash: `0x${string}`;
}

type CurveStableSwapBaseEligibilityFailure =
  | "pool-not-reviewed"
  | "execution-endpoint-mismatch"
  | "invalid-pinned-block"
  | "future-pinned-block"
  | "stale-pinned-block"
  | "runtime-code-unavailable"
  | "runtime-code-hash-mismatch";

export function evaluateCurveStableSwapBaseEligibility<
  Policy extends CurveStableSwapExecutionPolicy,
  Evidence extends CurveStableSwapBaseRuntimeEvidence,
  Failure extends string,
>(input: {
  chain: string;
  endpointAddress: string;
  blockNumber: number;
  nowSec: number;
  evidence?: Evidence;
}, getPolicy: (chain: string, poolAddress: string) => Policy | null, freshnessMaxSec: number,
blockTimestampUnavailable: Failure):
  | { ok: true; policy: Policy; evidence: Evidence }
  | { ok: false; reason: Failure | CurveStableSwapBaseEligibilityFailure } {
  const policy = getPolicy(input.chain, input.endpointAddress);
  if (!policy) return { ok: false, reason: "pool-not-reviewed" };
  if (canonicalEvmAddress(input.endpointAddress) !== policy.poolAddress) {
    return { ok: false, reason: "execution-endpoint-mismatch" };
  }
  if (!Number.isSafeInteger(input.blockNumber) || input.blockNumber < 0) {
    return { ok: false, reason: "invalid-pinned-block" };
  }
  const evidence = input.evidence;
  if (!evidence || !Number.isSafeInteger(evidence.blockTimestamp) || evidence.blockTimestamp <= 0) {
    return { ok: false, reason: blockTimestampUnavailable };
  }
  if (evidence.blockTimestamp > input.nowSec + 60) {
    return { ok: false, reason: "future-pinned-block" };
  }
  if (input.nowSec - evidence.blockTimestamp > freshnessMaxSec) {
    return { ok: false, reason: "stale-pinned-block" };
  }
  if (canonicalEvmHash(evidence.poolCodeHash) == null) {
    return { ok: false, reason: "runtime-code-unavailable" };
  }
  if (evidence.poolCodeHash !== policy.expectedPoolCodeHash) {
    return { ok: false, reason: "runtime-code-hash-mismatch" };
  }
  return { ok: true, policy, evidence };
}

interface CurveStableSwapIndexedProof {
  index: number;
  callData: `0x${string}`;
  returnData: `0x${string}`;
}

interface CurveStableSwapDecimalsProof {
  tokenAddress: `0x${string}`;
  decimals: number;
  callData: `0x${string}`;
  returnData: `0x${string}`;
}

export async function verifyCurveStableSwapPoolTokens<Failure extends string>(input: {
  policy: CurveStableSwapExecutionPolicy;
  signal?: AbortSignal;
  readCall(address: `0x${string}`, callData: `0x${string}`): Promise<`0x${string}` | null>;
  failures: {
    poolTokenUnavailable: Failure;
    poolTokenMismatch: Failure;
    tokenDecimalsUnavailable: Failure;
    tokenDecimalsMismatch: Failure;
  };
}): Promise<
  | { ok: true; poolCoinsProof: CurveStableSwapIndexedProof[]; tokenDecimalsProof: CurveStableSwapDecimalsProof[] }
  | { ok: false; reason: Failure }
> {
  const poolCoinsProof: CurveStableSwapIndexedProof[] = [];
  const tokenDecimalsProof: CurveStableSwapDecimalsProof[] = [];
  for (let index = 0; index < input.policy.poolTokens.length; index += 1) {
    throwIfAborted(input.signal);
    const token = input.policy.poolTokens[index]!;
    const coinCallData = encodeFunctionData({
      abi: CURVE_STABLESWAP_POOL_ABI,
      functionName: "coins",
      args: [BigInt(index)],
    }).toLowerCase() as `0x${string}`;
    const coinReturnData = await input.readCall(input.policy.poolAddress, coinCallData);
    if (coinReturnData == null) {
      return { ok: false, reason: input.failures.poolTokenUnavailable };
    }
    let poolCoinAddress: `0x${string}` | null = null;
    try {
      poolCoinAddress = canonicalEvmAddress(decodeFunctionResult({
        abi: CURVE_STABLESWAP_POOL_ABI,
        functionName: "coins",
        data: coinReturnData,
      }));
    } catch {
      return { ok: false, reason: input.failures.poolTokenMismatch };
    }
    if (poolCoinAddress !== token.address) {
      return { ok: false, reason: input.failures.poolTokenMismatch };
    }
    poolCoinsProof.push({
      index,
      callData: coinCallData,
      returnData: coinReturnData.toLowerCase() as `0x${string}`,
    });

    const decimalsCallData = encodeFunctionData({
      abi: CURVE_STABLESWAP_ERC20_METADATA_ABI,
      functionName: "decimals",
    }).toLowerCase() as `0x${string}`;
    const decimalsReturnData = await input.readCall(token.address, decimalsCallData);
    if (decimalsReturnData == null) {
      return { ok: false, reason: input.failures.tokenDecimalsUnavailable };
    }
    let decimals: number;
    try {
      decimals = Number(decodeFunctionResult({
        abi: CURVE_STABLESWAP_ERC20_METADATA_ABI,
        functionName: "decimals",
        data: decimalsReturnData,
      }));
    } catch {
      return { ok: false, reason: input.failures.tokenDecimalsMismatch };
    }
    if (decimals !== token.decimals) {
      return { ok: false, reason: input.failures.tokenDecimalsMismatch };
    }
    tokenDecimalsProof.push({
      tokenAddress: token.address,
      decimals,
      callData: decimalsCallData,
      returnData: decimalsReturnData.toLowerCase() as `0x${string}`,
    });
  }
  return { ok: true, poolCoinsProof, tokenDecimalsProof };
}

export function encodeCurveStableSwapGetDyCall(input: {
  inputIndex: number;
  outputIndex: number;
  amountInRaw: bigint;
}, validateIndices: (inputIndex: number, outputIndex: number) => boolean, errorMessage: string): `0x${string}` {
  if (!validateIndices(input.inputIndex, input.outputIndex) || input.amountInRaw <= 0n) {
    throw new Error(errorMessage);
  }
  return encodeFunctionData({
    abi: CURVE_STABLESWAP_POOL_ABI,
    functionName: "get_dy",
    args: [BigInt(input.inputIndex), BigInt(input.outputIndex), input.amountInRaw],
  }).toLowerCase() as `0x${string}`;
}

export function decodeCurveStableSwapGetDyResult(returnData: `0x${string}`): bigint | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(returnData)) return null;
  try {
    return decodeFunctionResult({
      abi: CURVE_STABLESWAP_POOL_ABI,
      functionName: "get_dy",
      data: returnData,
    }) as bigint;
  } catch {
    return null;
  }
}

interface CurveStableSwapExecutionRequest<Evidence> {
  target: DexMeasuredExecutionTarget;
  inputUsd: number;
  blockNumber: number;
  blockObservedAt: number;
  endpointAddress: `0x${string}`;
  runtimeEvidence?: Evidence;
}

interface CurveStableSwapExecutionEligibility<Failure extends string> {
  ok: boolean;
  reason?: Failure;
}

interface CurveStableSwapExecutionOutcome<Eligibility, Failure extends string> {
  targetId: string;
  inputUsd: number;
  blockNumber: number;
  eligibility: Eligibility;
  point?: DexMeasuredRawQuotePoint;
  failureReason?: Failure | DexMeasuredExecutionBudgetStopReason;
}

interface CurveStableSwapExecutionStrategy<
  Policy extends CurveStableSwapExecutionPolicy,
  Evidence,
  Eligibility extends CurveStableSwapExecutionEligibility<string>,
  Failure extends string,
> {
  invalidTargetFailure: Failure;
  runtimeEvidenceUnavailableReason: string;
  getPolicy(chain: string, poolAddress: string): Policy | null;
  evaluateEligibility(input: {
    chain: string;
    endpointAddress: string;
    blockNumber: number;
    nowSec: number;
    evidence?: Evidence;
  }): Eligibility;
  resolveTokenIndices(
    target: DexMeasuredExecutionTarget | DexMeasuredExecutionProfile,
  ): { ok: true; inputIndex: number; outputIndex: number } | { ok: false; reason: Failure };
  encodeGetDy(input: { inputIndex: number; outputIndex: number; amountInRaw: bigint }): `0x${string}`;
  quoteMetadata(input: {
    policy: Policy;
    endpointAddress: `0x${string}`;
    blockNumber: number;
    inputIndex: number;
    outputIndex: number;
  }): Record<string, string | number | boolean>;
}

interface EncodedCurveStableSwapExecutionRequest<
  Policy extends CurveStableSwapExecutionPolicy,
  Evidence,
  Eligibility,
> extends CurveStableSwapExecutionRequest<Evidence> {
  index: number;
  label: string;
  amountInRaw: bigint;
  inputIndex: number;
  outputIndex: number;
  callData: `0x${string}`;
  policy: Policy;
  eligibility: Eligibility;
}

interface CurveStableSwapQuoteDependencies {
  executeMulticall(input: {
    chain: string;
    calls: readonly EvmMulticall3Call[];
    blockNumber: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<readonly EvmMulticall3Result[] | null>;
}

function hasCanonicalCurveStableSwapTargetId(target: DexMeasuredExecutionTarget): boolean {
  return target.targetId === buildDexMeasuredExecutionTargetId({
    adapterProfileId: target.adapterProfileId,
    stablecoinId: target.stablecoinId,
    chain: target.chain,
    protocol: target.protocol,
    poolId: target.poolId,
    tokenInAddress: target.tokenIn.address,
    tokenOutAddress: target.tokenOut.address,
    poolTokenAddresses: target.poolTokenAddresses,
  });
}

function makeCurveStableSwapOutcome<Eligibility>(
  request: Pick<CurveStableSwapExecutionRequest<unknown>, "target" | "inputUsd" | "blockNumber">,
  eligibility: Eligibility,
) {
  return {
    targetId: request.target.targetId,
    inputUsd: request.inputUsd,
    blockNumber: request.blockNumber,
    eligibility,
  };
}

export function createCurveStableSwapExecutionPipeline<
  Policy extends CurveStableSwapExecutionPolicy,
  Evidence,
  Eligibility extends CurveStableSwapExecutionEligibility<string>,
  Failure extends string,
>(
  strategy: CurveStableSwapExecutionStrategy<Policy, Evidence, Eligibility, Failure>,
  dependencies: CurveStableSwapQuoteDependencies,
) {
  type Request = CurveStableSwapExecutionRequest<Evidence>;
  type Encoded = EncodedCurveStableSwapExecutionRequest<Policy, Evidence, Eligibility>;
  type Outcome = CurveStableSwapExecutionOutcome<Eligibility, Failure>;

  return createCurveGetDyQuoteAdapter<
    Request,
    CurveGetDyPlan<Encoded>,
    Eligibility,
    Outcome,
    Failure | DexMeasuredExecutionBudgetStopReason
  >({
    batchSize: CURVE_STABLESWAP_MULTICALL_BATCH_SIZE,
    prepare: (request, index) => {
      const policy = strategy.getPolicy(request.target.chain, request.endpointAddress);
      const eligibility = strategy.evaluateEligibility({
        chain: request.target.chain,
        endpointAddress: request.endpointAddress,
        blockNumber: request.blockNumber,
        nowSec: request.blockObservedAt,
        evidence: request.runtimeEvidence,
      });
      if (!policy) return { failureReason: "unsupported-chain-or-pool" as Failure, eligibility };
      if (!Number.isSafeInteger(request.blockNumber) || request.blockNumber < 0) {
        return { failureReason: "invalid-pinned-block" as Failure, eligibility };
      }
      if (!eligibility.ok) {
        return {
          failureReason: (
            eligibility.reason === strategy.runtimeEvidenceUnavailableReason
              ? "runtime-evidence-missing"
              : strategy.invalidTargetFailure
          ) as Failure,
          eligibility,
        };
      }
      const indices = strategy.resolveTokenIndices(request.target);
      if (!indices.ok) return { failureReason: indices.reason, eligibility };
      if (!hasCanonicalCurveStableSwapTargetId(request.target)) {
        return { failureReason: strategy.invalidTargetFailure, eligibility };
      }
      const amountInRaw = usdToRawAmount(
        request.inputUsd,
        request.target.tokenIn.decimals,
        request.target.tokenIn.referencePriceUsd,
      );
      if (amountInRaw == null) {
        return { failureReason: "invalid-quote-input" as Failure, eligibility };
      }
      const encoded: Encoded = {
        ...request,
        index,
        label: `${index}:${request.target.targetId}`,
        amountInRaw,
        inputIndex: indices.inputIndex,
        outputIndex: indices.outputIndex,
        callData: strategy.encodeGetDy({
          inputIndex: indices.inputIndex,
          outputIndex: indices.outputIndex,
          amountInRaw,
        }),
        policy,
        eligibility,
      };
      return { eligibility, plan: makeCurveGetDyPlan(encoded) };
    },
    makeOutcome: (request, eligibility, failureReason) => ({
      ...makeCurveStableSwapOutcome(request, eligibility),
      ...(failureReason ? { failureReason } : {}),
    }),
    executeMulticall: dependencies.executeMulticall,
    resolveResult: (request, result) => ({
      ...makeCurveStableSwapOutcome(request, request.eligibility),
      ...decodeCurveMeasuredRawQuotePoint({
        request,
        result,
        decodeAmountOutRaw: decodeCurveStableSwapGetDyResult,
        adapterMetadata: strategy.quoteMetadata(request),
        failureReasons: {
          poolRevert: "pool-revert" as Failure,
          malformedPoolReturn: "malformed-pool-return" as Failure,
        },
      }),
    }),
    materializeTransportFailure: (request, reason) => ({
      ...makeCurveStableSwapOutcome(request, request.eligibility),
      failureReason: reason ?? ("rpc-failure" as Failure),
    }),
  });
}

interface CurveStableSwapProofShape {
  poolCoinsProof: readonly { index: number; callData: string; returnData: string }[];
  tokenDecimalsProof: readonly {
    tokenAddress: string;
    decimals: number;
    callData: string;
    returnData: string;
  }[];
}

export function validateCurveStableSwapExecutionProfile<
  Policy extends CurveStableSwapExecutionPolicy,
  Failure extends string,
  Proof extends CurveStableSwapProofShape,
>(input: {
  profile: DexMeasuredExecutionProfile;
  adapterProfileId: string;
  getPolicy(chain: string, poolAddress: string): Policy | null;
  resolveTokenIndices(
    profile: DexMeasuredExecutionProfile,
  ): { ok: true; inputIndex: number; outputIndex: number } | { ok: false; reason: Failure };
  getProof(profile: DexMeasuredExecutionProfile): Proof | undefined;
  missingProofIssue: string;
  validateDeploymentProof(issues: Set<string>, proof: Proof, policy: Policy): void;
}): string[] {
  const { profile } = input;
  const issues = new Set<string>();
  if (profile.adapterProfileId !== input.adapterProfileId) issues.add("wrong-adapter-profile");
  const policy = input.getPolicy(profile.chain, profile.executionEndpoint.address);
  if (!policy) issues.add("execution-pool-not-reviewed");
  if (profile.executionEndpoint.codeHash !== policy?.expectedPoolCodeHash) {
    issues.add("endpoint-code-hash-mismatch");
  }
  const indices = input.resolveTokenIndices(profile);
  if (!indices.ok) issues.add(indices.reason);

  const proof = input.getProof(profile);
  if (!proof) {
    issues.add(input.missingProofIssue);
  } else if (policy) {
    input.validateDeploymentProof(issues, proof, policy);
    if (
      proof.poolCoinsProof.length !== policy.poolTokens.length ||
      proof.poolCoinsProof.some((entry, index) => {
        try {
          const call = decodeFunctionData({
            abi: CURVE_STABLESWAP_POOL_ABI,
            data: entry.callData as `0x${string}`,
          });
          return (
            entry.index !== index ||
            call.functionName !== "coins" ||
            call.args[0] !== BigInt(index) ||
            decodeEvmAddressResult({
              decode: () => decodeFunctionResult({
                abi: CURVE_STABLESWAP_POOL_ABI,
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
            abi: CURVE_STABLESWAP_ERC20_METADATA_ABI,
            data: entry.callData as `0x${string}`,
          });
          const decimals = Number(decodeFunctionResult({
            abi: CURVE_STABLESWAP_ERC20_METADATA_ABI,
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
        abi: CURVE_STABLESWAP_POOL_ABI,
        data: point.callData as `0x${string}`,
      });
      if (
        !indices.ok ||
        call.functionName !== "get_dy" ||
        call.args[0] !== BigInt(indices.inputIndex) ||
        call.args[1] !== BigInt(indices.outputIndex) ||
        call.args[2].toString() !== point.amountInRaw
      ) issues.add("call-data-mismatch");
      const amountOutRaw = decodeCurveStableSwapGetDyResult(point.returnData as `0x${string}`);
      if (amountOutRaw == null) issues.add("abi-decode-failed");
      else if (amountOutRaw.toString() !== point.amountOutRaw) issues.add("return-data-mismatch");
    } catch {
      issues.add("abi-decode-failed");
    }
  }
  return [...issues];
}
