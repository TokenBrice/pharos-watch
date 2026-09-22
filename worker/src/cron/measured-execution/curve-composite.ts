import { encodeFunctionData, parseAbi } from "viem/utils";

import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import type { DexMeasuredExecutionTarget } from "@shared/types/measured-execution";
import type {
  DexMeasuredExecutionBudgetStopReason,
  DexMeasuredRawQuotePoint,
} from "./profiles";
import { canonicalEvmAddress } from "./evm-codecs";
import { getCurveCompositePolicy, type CurveCompositePoolPolicy } from "./curve-composite-policies";
import { buildMeasuredExecutionTargetValue } from "./inventory";
import {
  createCurveStableSwapExecutionPipeline,
  executeCurveGetDyMulticall,
  type CurveGetDyQuoteDependencies,
} from "./curve-stableswap-execution-pipeline";
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
  return buildMeasuredExecutionTargetValue({
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
  });
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

export function createCurveCompositeQuoteExecutor(dependencies: CurveGetDyQuoteDependencies) {
  return createCurveStableSwapExecutionPipeline<
    CurveCompositePoolPolicy,
    CurveCompositeRuntimeEvidence,
    CurveCompositeEligibility,
    QuoteFailure
  >({
    invalidTargetFailure: "invalid-curve-composite-target",
    runtimeEvidenceUnavailableReason: "block-header-unavailable",
    getPolicy: getCurveCompositePolicy,
    evaluateEligibility: evaluateCurveCompositeEligibility,
    resolveTokenIndices: resolveCurveCompositeTokenIndices,
    encodeGetDy: encodeCurveCompositeQuote,
    decodeAmountOutRaw: decodeCurveCompositeQuote,
    eligibilityFailure: () => "runtime-evidence-missing",
    quoteMetadata: (request) => ({
      executionPool: request.endpointAddress,
      blockNumber: request.blockNumber,
      inputIndex: request.inputIndex,
      outputIndex: request.outputIndex,
      quoteFunction: request.policy.quoteFunction,
    }),
  }, dependencies);
}

export const quoteCurveCompositeRequests = createCurveCompositeQuoteExecutor({
  executeMulticall: executeCurveGetDyMulticall,
});
