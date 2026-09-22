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
import { decodeCurveMeasuredRawQuotePoint } from "./curve-quote-point";
import {
  createCurveGetDyQuoteAdapter,
  makeCurveGetDyPlan,
  type CurveGetDyPlan,
} from "./curve-get-dy-quote-engine";
import { canonicalEvmAddress, decodeAddressResult as decodeEvmAddressResult } from "./evm-codecs";
import { usdToRawAmount } from "./fixed-point";
import {
  DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
  type DexMeasuredExecutionBudgetStopReason,
  type DexMeasuredExecutionRpcBudget,
  type DexMeasuredRawQuotePoint,
} from "./profiles";

const CURVE_STABLESWAP_POOL_ABI = parseAbi([
  "function coins(uint256) view returns (address)",
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
const CURVE_FAMILY_LEGACY_REGISTRY_ABI = parseAbi([
  "function get_lp_token(address pool) view returns (address)",
  "function get_coins(address pool) view returns (address[8])",
]);
const CURVE_FAMILY_NG_FACTORY_ABI = parseAbi([
  "function pool_list(uint256) view returns (address)",
  "function get_coins(address pool) view returns (address[])",
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
    options: unknown,
  ): Promise<EvmCodeAtBlockResult>;
  fetchCall(
    chain: string,
    address: string,
    callData: string,
    blockNumber: number,
    options: unknown,
  ): Promise<`0x${string}` | null>;
}

function createCurveStableSwapPinnedReaders<P extends CurveStableSwapExecutionPolicy>(
  input: CurveStableSwapPinnedReaderInput<P>,
  dependencies: CurveStableSwapPinnedReaderDependencies,
  requestOptions: unknown,
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

async function verifyCurveStableSwapPoolTokens<Failure extends string>(input: {
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

interface CurveFamilyVerificationDependencies {
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
  hashCode?(code: `0x${string}`): `0x${string}`;
}

interface CurveFamilyVerificationInput<Policy> {
  policy?: Policy;
  nowSec: number;
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
}

interface CurveFamilyPinnedBlock {
  number: number;
  timestamp: number;
  hash?: `0x${string}`;
}

interface CurveFamilyCodeBinding<Policy, Failure extends string> {
  key: string;
  address(policy: Policy): `0x${string}`;
  expectedHash(policy: Policy): `0x${string}`;
  unavailable: Failure;
  absent: Failure;
  mismatch: Failure;
}
interface CurveFamilyBindingResult {
  registeredPoolAddress: `0x${string}`;
  poolTokenAddresses: `0x${string}`[];
  identityCallData: `0x${string}`;
  identityReturnData: `0x${string}`;
  coinsCallData: `0x${string}`;
  coinsReturnData: `0x${string}`;
  lpTokenAddress?: `0x${string}`;
}

interface CurveFamilyBindingSpec<Policy, Failure extends string> {
  kind: "legacy-registry" | "ng-factory";
  address(policy: Policy): `0x${string}`;
  poolIndex?(policy: Policy): number;
  lpTokenAddress?(policy: Policy): `0x${string}`;
  unavailable: Failure;
  mismatch: Failure;
  lpTokenMismatch?: Failure;
}

interface CurveFamilyVerificationContext<
  Policy extends CurveStableSwapExecutionPolicy,
  Failure extends string,
  Input extends CurveFamilyVerificationInput<Policy>,
> {
  input: Input;
  policy: Policy;
  block: CurveFamilyPinnedBlock;
  requestOptions: EvmRpcOptions;
  codeHashes: ReadonlyMap<string, `0x${string}`>;
  readCall(address: `0x${string}`, callData: `0x${string}`): Promise<`0x${string}` | null>;
  fail(reason: Failure): { ok: false; reason: Failure };
}

/**
 * Canonical verifier skeleton for Curve families whose deployment proof is a
 * pinned block, a declarative code allowlist, binding calls, and coin metadata.
 * Family specs retain control of block selection, binding evidence, failures,
 * confirmation, and the exact published result.
 */
export function createCurveFamilyDeploymentVerifier<
  Policy extends CurveStableSwapExecutionPolicy,
  Failure extends string,
  Result,
  Input extends CurveFamilyVerificationInput<Policy> = CurveFamilyVerificationInput<Policy>,
>(spec: {
  defaultPolicy: Policy;
  dependencies: CurveFamilyVerificationDependencies;
  resolveBlock(input: Input, policy: Policy, requestOptions: EvmRpcOptions):
    Promise<CurveFamilyPinnedBlock | { ok: false; reason: Failure }>;
  codeBindings: readonly CurveFamilyCodeBinding<Policy, Failure>[];
  binding: CurveFamilyBindingSpec<Policy, Failure>;
  tokenFailures: {
    poolTokenUnavailable: Failure;
    poolTokenMismatch: Failure;
    tokenDecimalsUnavailable: Failure;
    tokenDecimalsMismatch: Failure;
  };
  confirmBlock?(context: CurveFamilyVerificationContext<Policy, Failure, Input>):
    Promise<{ ok: true } | { ok: false; reason: Failure }>;
  makeResult(
    context: CurveFamilyVerificationContext<Policy, Failure, Input>,
    binding: CurveFamilyBindingResult,
    tokenProof: {
      poolCoinsProof: CurveStableSwapIndexedProof[];
      tokenDecimalsProof: CurveStableSwapDecimalsProof[];
    },
  ): Result | { ok: false; reason: Failure };
}) {
  return async (input: Input): Promise<Result | { ok: false; reason: Failure }> => {
    const policy = input.policy ?? spec.defaultPolicy;
    const requestOptions: EvmRpcOptions = {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
    };
    const block = await spec.resolveBlock(input, policy, requestOptions);
    if ("ok" in block) return block;
    const { readCode, readCall } = createCurveStableSwapPinnedReaders(
      { policy, blockNumber: block.number, rpcBudget: input.rpcBudget },
      spec.dependencies,
      requestOptions,
    );
    const hashCode = spec.dependencies.hashCode ?? ((code: `0x${string}`) => keccak256(code));
    const codeHashes = new Map<string, `0x${string}`>();
    for (const codeBinding of spec.codeBindings) {
      throwIfAborted(input.signal);
      const result = await readCode(codeBinding.address(policy));
      if (result.status === "unavailable") return { ok: false, reason: codeBinding.unavailable };
      if (result.status === "absent") return { ok: false, reason: codeBinding.absent };
      const codeHash = hashCode(result.code).toLowerCase() as `0x${string}`;
      if (codeHash !== codeBinding.expectedHash(policy)) {
        return { ok: false, reason: codeBinding.mismatch };
      }
      codeHashes.set(codeBinding.key, codeHash);
    }
    const context: CurveFamilyVerificationContext<Policy, Failure, Input> = {
      input, policy, block, requestOptions, codeHashes, readCall,
      fail: (reason) => ({ ok: false, reason }),
    };
    const bindingAddress = spec.binding.address(policy);
    const isLegacy = spec.binding.kind === "legacy-registry";
    const identityCallData = (isLegacy
      ? encodeFunctionData({
          abi: CURVE_FAMILY_LEGACY_REGISTRY_ABI,
          functionName: "get_lp_token",
          args: [policy.poolAddress],
        })
      : encodeFunctionData({
          abi: CURVE_FAMILY_NG_FACTORY_ABI,
          functionName: "pool_list",
          args: [BigInt(spec.binding.poolIndex!(policy))],
        })).toLowerCase() as `0x${string}`;
    const coinsCallData = (isLegacy
      ? encodeFunctionData({
          abi: CURVE_FAMILY_LEGACY_REGISTRY_ABI,
          functionName: "get_coins",
          args: [policy.poolAddress],
        })
      : encodeFunctionData({
          abi: CURVE_FAMILY_NG_FACTORY_ABI,
          functionName: "get_coins",
          args: [policy.poolAddress],
        })).toLowerCase() as `0x${string}`;
    const identityReturnData = await readCall(bindingAddress, identityCallData);
    const coinsReturnData = await readCall(bindingAddress, coinsCallData);
    if (identityReturnData == null || coinsReturnData == null) {
      return { ok: false, reason: spec.binding.unavailable };
    }
    let identityAddress: `0x${string}` | null;
    let coins: readonly (`0x${string}` | null)[];
    try {
      identityAddress = canonicalEvmAddress(decodeFunctionResult({
        abi: isLegacy ? CURVE_FAMILY_LEGACY_REGISTRY_ABI : CURVE_FAMILY_NG_FACTORY_ABI,
        functionName: isLegacy ? "get_lp_token" : "pool_list",
        data: identityReturnData,
      } as never));
      coins = (decodeFunctionResult({
        abi: isLegacy ? CURVE_FAMILY_LEGACY_REGISTRY_ABI : CURVE_FAMILY_NG_FACTORY_ABI,
        functionName: "get_coins",
        data: coinsReturnData,
      } as never) as readonly string[]).map(canonicalEvmAddress);
    } catch {
      return { ok: false, reason: spec.binding.mismatch };
    }
    const poolTokenAddresses = policy.poolTokens.map((token) => token.address);
    if (isLegacy && identityAddress !== spec.binding.lpTokenAddress!(policy)) {
      return { ok: false, reason: spec.binding.lpTokenMismatch! };
    }
    if (
      (!isLegacy && identityAddress !== policy.poolAddress) ||
      coins.length !== (isLegacy ? 8 : poolTokenAddresses.length) ||
      poolTokenAddresses.some((address, index) => coins[index] !== address) ||
      (isLegacy && coins.slice(poolTokenAddresses.length).some((address) =>
        address !== "0x0000000000000000000000000000000000000000"
      ))
    ) return { ok: false, reason: spec.binding.mismatch };
    const binding: CurveFamilyBindingResult = {
      registeredPoolAddress: policy.poolAddress,
      poolTokenAddresses,
      identityCallData,
      identityReturnData: identityReturnData.toLowerCase() as `0x${string}`,
      coinsCallData,
      coinsReturnData: coinsReturnData.toLowerCase() as `0x${string}`,
      ...(isLegacy ? { lpTokenAddress: identityAddress! } : {}),
    };
    const tokenProof = await verifyCurveStableSwapPoolTokens({
      policy, signal: input.signal, readCall, failures: spec.tokenFailures,
    });
    if (!tokenProof.ok) return tokenProof;
    const confirmation = await spec.confirmBlock?.(context);
    if (confirmation && !confirmation.ok) return confirmation;
    return spec.makeResult(context, binding, tokenProof);
  };
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
  encodeGetDy(input: {
    policy: Policy;
    inputIndex: number;
    outputIndex: number;
    amountInRaw: bigint;
  }): `0x${string}`;
  decodeAmountOutRaw?(policy: Policy, returnData: `0x${string}`): bigint | null;
  eligibilityFailure?(eligibility: Eligibility): Failure;
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
          failureReason: strategy.eligibilityFailure?.(eligibility) ?? (
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
          policy,
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
        decodeAmountOutRaw: (returnData) =>
          strategy.decodeAmountOutRaw
            ? strategy.decodeAmountOutRaw(request.policy, returnData)
            : decodeCurveStableSwapGetDyResult(returnData),
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
