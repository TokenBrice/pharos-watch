import { encodeFunctionData, parseAbi } from "viem/utils";

import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import { DEX_MEASURED_TARGET_SCHEMA_VERSION, buildDexMeasuredExecutionTargetId, type DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmMulticall3Aggregate3AtBlock, type EvmMulticall3Call, type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import { DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS, type DexMeasuredExecutionBudgetStopReason, type DexMeasuredExecutionRpcBudget, type DexMeasuredRawQuotePoint } from "./profiles";
import { usdToRawAmount } from "./fixed-point";
import { canonicalEvmAddress } from "./evm-codecs";
import {
  createCurveGetDyQuoteAdapter, makeCurveGetDyPlan, type CurveGetDyPlan,
} from "./curve-get-dy-quote-engine";
import { decodeCurveMeasuredRawQuotePoint } from "./curve-quote-point";
import { getCurveCompositePolicy, type CurveCompositePoolPolicy } from "./curve-composite-policies";
import {
  decodeCurveCompositeQuote, evaluateCurveCompositeEligibility,
  resolveCurveCompositeTokenIndices, type CurveCompositeEligibility,
  type CurveCompositeRuntimeEvidence,
} from "./curve-composite-runtime-proof";

export * from "./curve-composite-policies";
export { evaluateCurveCompositeEligibility, validateCurveCompositeProfileProof, verifyCurveCompositeDeployment } from "./curve-composite-runtime-proof";
export type { CurveCompositeDeploymentVerification, CurveCompositeEligibility, CurveCompositeRuntimeEvidence } from "./curve-composite-runtime-proof";

const POOL_ABI = parseAbi([
  "function get_dy(int128 i,int128 j,uint256 dx) view returns (uint256)",
  "function get_dy_underlying(int128 i,int128 j,uint256 dx) view returns (uint256)",
]);
const BATCH_SIZE = 8;
const MULTICALL_GAS = "0x1c9c380";

interface CurveCompositePoolSource {
  poolAddress?: string;
  apiIsBroken?: boolean;
  registryId: string;
  isMetaPool: boolean;
  basePoolAddress?: string;
  poolCoins?: readonly {
    address: string;
    symbol: string;
    decimals: number;
    usdPrice: number;
    isBasePoolLpToken: boolean;
  }[];
  underlyingCoins?: readonly {
    address: string;
    symbol: string;
    decimals: number;
    usdPrice: number;
  }[];
}

/** Build one exact reviewed target from the current Curve source row. */
export function buildCurveCompositeMeasuredExecutionTarget(input: {
  curveData: CurveCompositePoolSource | undefined;
  chain: string;
  stablecoinId: string;
  chainAddressToId: Map<string, string>;
  stablecoinPriceById?: Map<string, number>;
  retainedTvlUsd: number;
  capturedAt: number;
}): DexMeasuredExecutionTarget | null {
  const curveData = input.curveData;
  const policy = curveData?.poolAddress
    ? getCurveCompositePolicy(input.chain, curveData.poolAddress)
    : null;
  if (
    !curveData ||
    !policy ||
    curveData.apiIsBroken ||
    input.stablecoinId !== policy.stablecoinId ||
    curveData.registryId.trim().toLowerCase() !== policy.expectedRegistryId ||
    curveData.isMetaPool !== (policy.quoteFunction === "get_dy_underlying") ||
    curveData.poolCoins?.length !== policy.poolTokens.length ||
    !Number.isFinite(input.retainedTvlUsd) ||
    input.retainedTvlUsd <= 0
  ) return null;
  if (
    policy.quoteFunction === "get_dy_underlying" &&
    canonicalEvmAddress(curveData.basePoolAddress) !== policy.metapool.basePoolAddress
  ) return null;
  for (let index = 0; index < policy.poolTokens.length; index += 1) {
    const expected = policy.poolTokens[index]!;
    const actual = curveData.poolCoins[index]!;
    if (
      canonicalEvmAddress(actual.address) !== expected.address ||
      actual.symbol.trim().toLowerCase() !== expected.symbol.toLowerCase() ||
      actual.decimals !== expected.decimals ||
      actual.isBasePoolLpToken !==
        (policy.quoteFunction === "get_dy_underlying" && index === 1)
    ) return null;
  }
  for (const token of policy.executionTokens) {
    if (
      token.trackedAssetId &&
      input.chainAddressToId.get(canonicalExitRouteAssetKey(policy.chain, token.address)) !==
        token.trackedAssetId
    ) return null;
  }
  if (curveData.underlyingCoins != null) {
    if (
      curveData.underlyingCoins.length !== policy.executionTokens.length ||
      curveData.underlyingCoins.some((actual, index) => {
        const expected = policy.executionTokens[index]!;
        return canonicalEvmAddress(actual.address) !== expected.address ||
          actual.symbol.trim().toLowerCase() !== expected.symbol.toLowerCase() ||
          actual.decimals !== expected.decimals ||
          !Number.isFinite(actual.usdPrice) ||
          actual.usdPrice <= 0;
      })
    ) return null;
  }
  const tokenIn = policy.executionTokens[policy.inputIndex];
  const tokenOut = policy.executionTokens[policy.outputIndex];
  if (!tokenIn || !tokenOut || tokenIn.trackedAssetId !== policy.stablecoinId) return null;
  const inputPrice = input.stablecoinPriceById?.get(policy.stablecoinId);
  const outputReferenceAssetId = tokenOut.trackedAssetId ?? tokenOut.referenceAssetId;
  const outputPrice = outputReferenceAssetId
    ? input.stablecoinPriceById?.get(outputReferenceAssetId)
    : undefined;
  if (
    inputPrice == null ||
    outputPrice == null ||
    !Number.isFinite(inputPrice) ||
    inputPrice <= 0 ||
    !Number.isFinite(outputPrice) ||
    outputPrice <= 0
  ) return null;
  const poolId = canonicalExitRouteAssetKey(policy.chain, policy.poolAddress);
  const poolTokenAddresses = policy.executionTokens.map((token) => token.address);
  const targetId = buildDexMeasuredExecutionTargetId({
    adapterProfileId: policy.adapterProfileId,
    stablecoinId: policy.stablecoinId,
    chain: policy.chain,
    protocol: "curve",
    poolId,
    tokenInAddress: tokenIn.address,
    tokenOutAddress: tokenOut.address,
    poolTokenAddresses,
  });
  return {
    schemaVersion: DEX_MEASURED_TARGET_SCHEMA_VERSION,
    targetId,
    stablecoinId: policy.stablecoinId,
    adapterProfileId: policy.adapterProfileId,
    protocol: "curve",
    chain: policy.chain,
    poolId,
    poolTokenAddresses,
    tokenIn: {
      address: tokenIn.address,
      symbol: tokenIn.symbol,
      decimals: tokenIn.decimals,
      referencePriceUsd: inputPrice,
      trackedAssetId: policy.stablecoinId,
    },
    tokenOut: {
      address: tokenOut.address,
      symbol: tokenOut.symbol,
      decimals: tokenOut.decimals,
      referencePriceUsd: outputPrice,
      ...(tokenOut.trackedAssetId ? { trackedAssetId: tokenOut.trackedAssetId } : {}),
    },
    retainedTvlUsd: input.retainedTvlUsd,
    retainedPoolPriceUsd: inputPrice,
    capturedAt: input.capturedAt,
  };
}

type QuoteFailure =
  | DexMeasuredExecutionBudgetStopReason
  | "unsupported-chain-or-pool"
  | "invalid-pinned-block"
  | "invalid-quote-input"
  | "invalid-curve-composite-target"
  | "runtime-evidence-missing"
  | "rpc-failure"
  | "pool-revert"
  | "malformed-pool-return";

export interface CurveCompositeRequest {
  target: DexMeasuredExecutionTarget;
  inputUsd: number;
  blockNumber: number;
  blockObservedAt: number;
  endpointAddress: `0x${string}`;
  runtimeEvidence?: CurveCompositeRuntimeEvidence;
}

interface EncodedRequest extends CurveCompositeRequest {
  index: number;
  label: string;
  amountInRaw: bigint;
  inputIndex: number;
  outputIndex: number;
  callData: `0x${string}`;
  policy: CurveCompositePoolPolicy;
  eligibility: CurveCompositeEligibility;
}

export interface CurveCompositeBatchOutcome {
  targetId: string;
  inputUsd: number;
  blockNumber: number;
  eligibility: CurveCompositeEligibility;
  point?: DexMeasuredRawQuotePoint;
  failureReason?: QuoteFailure;
}

export function encodeCurveCompositeQuote(input: {
  policy: CurveCompositePoolPolicy;
  inputIndex: number;
  outputIndex: number;
  amountInRaw: bigint;
}): `0x${string}` {
  if (
    input.inputIndex !== input.policy.inputIndex ||
    input.outputIndex !== input.policy.outputIndex ||
    input.amountInRaw <= 0n
  ) throw new Error("Curve composite quote indices or amount are invalid");
  return encodeFunctionData({
    abi: POOL_ABI,
    functionName: input.policy.quoteFunction,
    args: [BigInt(input.inputIndex), BigInt(input.outputIndex), input.amountInRaw],
  }).toLowerCase() as `0x${string}`;
}

function prepareRequest(
  request: CurveCompositeRequest,
  index: number,
): {
  encoded?: EncodedRequest;
  failureReason?: QuoteFailure;
  eligibility: CurveCompositeEligibility;
} {
  const policy = getCurveCompositePolicy(request.target.chain, request.endpointAddress);
  const eligibility = evaluateCurveCompositeEligibility({
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
  if (!eligibility.ok) return { failureReason: "runtime-evidence-missing", eligibility };
  const indices = resolveCurveCompositeTokenIndices(request.target);
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
    return { failureReason: "invalid-curve-composite-target", eligibility };
  }
  const amountInRaw = usdToRawAmount(
    request.inputUsd,
    request.target.tokenIn.decimals,
    request.target.tokenIn.referencePriceUsd,
  );
  if (!amountInRaw) return { failureReason: "invalid-quote-input", eligibility };
  return {
    eligibility,
    encoded: {
      ...request,
      index,
      label: `${index}:${request.target.targetId}`,
      amountInRaw,
      inputIndex: indices.inputIndex,
      outputIndex: indices.outputIndex,
      callData: encodeCurveCompositeQuote({
        policy,
        inputIndex: indices.inputIndex,
        outputIndex: indices.outputIndex,
        amountInRaw,
      }),
      policy,
      eligibility,
    },
  };
}

function decodeQuotePoint(
  request: EncodedRequest,
  result: EvmMulticall3Result,
): { point?: DexMeasuredRawQuotePoint; failureReason?: QuoteFailure } {
  return decodeCurveMeasuredRawQuotePoint({
    request,
    result,
    decodeAmountOutRaw: (returnData) => decodeCurveCompositeQuote(request.policy, returnData),
    adapterMetadata: {
      executionPool: request.endpointAddress,
      blockNumber: request.blockNumber,
      inputIndex: request.inputIndex,
      outputIndex: request.outputIndex,
      quoteFunction: request.policy.quoteFunction,
    },
    failureReasons: {
      poolRevert: "pool-revert",
      malformedPoolReturn: "malformed-pool-return",
    },
  });
}

interface QuoteDependencies {
  executeMulticall(input: {
    chain: string;
    calls: readonly EvmMulticall3Call[];
    blockNumber: number;
    chainRpcs: Map<string, ChainRpcConfig>;
    signal?: AbortSignal;
    rpcBudget?: DexMeasuredExecutionRpcBudget;
  }): Promise<EvmMulticall3Result[] | null>;
}

export function createCurveCompositeQuoteExecutor(dependencies: QuoteDependencies) {
  return createCurveGetDyQuoteAdapter<
    CurveCompositeRequest,
    CurveGetDyPlan<EncodedRequest>,
    CurveCompositeEligibility,
    CurveCompositeBatchOutcome,
    QuoteFailure
  >({
    batchSize: BATCH_SIZE,
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
      ...decodeQuotePoint(request, result),
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

export const quoteCurveCompositeRequests = createCurveCompositeQuoteExecutor({
  executeMulticall: async (input) =>
    fetchEvmMulticall3Aggregate3AtBlock(input.chain, input.calls, input.blockNumber, {
      chainRpcs: input.chainRpcs,
      signal: input.signal,
      timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
      maxRetries: 1,
      ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
      ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
      gas: MULTICALL_GAS,
      multicallBatchSize: Math.min(BATCH_SIZE, input.calls.length),
    }),
});
