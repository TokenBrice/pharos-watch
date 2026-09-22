import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";

import {
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionPoolBindingProof,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import {
  DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
  type DexMeasuredExecutionRpcBudget,
  type DexMeasuredRawQuotePoint,
} from "./profiles";
import { getDexMeasuredExecutionDeployment } from "./registry";
import { MAX_UINT256, usdToRawAmount } from "./fixed-point";
import { executeEvmQuotePlan, materializeEvmQuotePoint } from "./evm-quote-plan";

const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const SLIPSTREAM_QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const V3_FACTORY_ABI = parseAbi([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)",
]);
const SLIPSTREAM_FACTORY_ABI = parseAbi([
  "function getPool(address tokenA,address tokenB,int24 tickSpacing) view returns (address pool)",
]);
const AERODROME_SLIPSTREAM_ADAPTER_PROFILE_ID = "aerodrome-slipstream-quoter-v2";
const QUOTER_MULTICALL_BATCH_SIZE = 8;
const QUOTER_MULTICALL_GAS = "0x1c9c380";

interface QuoterV2Request {
  target: DexMeasuredExecutionTarget;
  inputUsd: number;
  endpointAddress: `0x${string}`;
}

interface EncodedQuoterV2Request extends QuoterV2Request {
  index: number;
  label: string;
  amountInRaw: bigint;
  callData: `0x${string}`;
}

export interface QuoterV2BatchOutcome {
  targetId: string;
  inputUsd: number;
  point?: DexMeasuredRawQuotePoint;
  failureReason?: string;
}


function isSlipstreamTarget(target: Pick<DexMeasuredExecutionTarget, "adapterProfileId">): boolean {
  return target.adapterProfileId === AERODROME_SLIPSTREAM_ADAPTER_PROFILE_ID;
}

function hasAdapterParameter(target: DexMeasuredExecutionTarget): boolean {
  return isSlipstreamTarget(target) ? target.tickSpacing != null : target.feePips != null;
}

export function encodeQuoterV2ExactInputSingle(target: DexMeasuredExecutionTarget, amountInRaw: bigint): `0x${string}` {
  if (isSlipstreamTarget(target)) {
    if (target.tickSpacing == null) throw new Error(`Measured target ${target.targetId} has no tick spacing`);
    return encodeFunctionData({
      abi: SLIPSTREAM_QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: target.tokenIn.address as `0x${string}`,
          tokenOut: target.tokenOut.address as `0x${string}`,
          amountIn: amountInRaw,
          tickSpacing: target.tickSpacing,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
  }
  if (target.feePips == null) throw new Error(`Measured target ${target.targetId} has no fee pips`);
  return encodeFunctionData({
    abi: QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: target.tokenIn.address as `0x${string}`,
        tokenOut: target.tokenOut.address as `0x${string}`,
        amountIn: amountInRaw,
        fee: target.feePips,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

function encodeRequest(request: QuoterV2Request, index: number): EncodedQuoterV2Request | null {
  const amountInRaw = usdToRawAmount(
    request.inputUsd,
    request.target.tokenIn.decimals,
    request.target.tokenIn.referencePriceUsd,
    { maxRawAmount: MAX_UINT256 },
  );
  if (amountInRaw == null || !hasAdapterParameter(request.target)) return null;
  try {
    return {
      ...request,
      index,
      label: `${index}:${request.target.targetId}`,
      amountInRaw,
      callData: encodeQuoterV2ExactInputSingle(request.target, amountInRaw),
    };
  } catch {
    return null;
  }
}


function decodePoint(request: EncodedQuoterV2Request, result: EvmMulticall3Result): DexMeasuredRawQuotePoint | null {
  if (!result.success || result.returnData === "0x") return null;
  try {
    const decoded = decodeFunctionResult({
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      data: result.returnData,
    }) as readonly [bigint, bigint, number, bigint];
    const [amountOutRaw, sqrtPriceX96After, initializedTicksCrossed, gasEstimate] = decoded;
    return materializeEvmQuotePoint({
      amountInRaw: request.amountInRaw,
      amountOutRaw,
      callData: request.callData,
      returnData: result.returnData,
      tokenIn: request.target.tokenIn,
      tokenOut: request.target.tokenOut,
      adapterMetadata: {
        sqrtPriceX96After: sqrtPriceX96After.toString(),
        initializedTicksCrossed: Number(initializedTicksCrossed),
        gasEstimate: gasEstimate.toString(),
      },
    });
  } catch {
    return null;
  }
}

function buildRevertedPoint(
  request: EncodedQuoterV2Request,
  result: EvmMulticall3Result,
): DexMeasuredRawQuotePoint {
  return materializeEvmQuotePoint({
    amountInRaw: request.amountInRaw,
    amountOutRaw: 0n,
    callData: request.callData,
    returnData: result.returnData,
    tokenIn: request.target.tokenIn,
    tokenOut: request.target.tokenOut,
    reverted: true,
    adapterMetadata: { executionReverted: true },
  })!;
}

export async function quoteQuoterV2Requests(input: {
  requests: readonly QuoterV2Request[];
  blockNumber: number;
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
}): Promise<QuoterV2BatchOutcome[]> {
  const encoded = input.requests.map(encodeRequest);
  const outcomes: QuoterV2BatchOutcome[] = input.requests.map((request, index) =>
    encoded[index] == null
      ? { targetId: request.target.targetId, inputUsd: request.inputUsd, failureReason: "invalid-quote-input" }
      : { targetId: request.target.targetId, inputUsd: request.inputUsd },
  );
  const plans = encoded.flatMap((request) => request ? [{
    ...request,
    chain: request.target.chain,
    blockNumber: input.blockNumber,
    index: request.index,
    call: {
        label: request.label,
        target: request.endpointAddress,
        callData: request.callData,
        allowFailure: true,
    },
  }] : []);
  return executeEvmQuotePlan({
    plans,
    outcomes,
    chainRpcs: input.chainRpcs,
    signal: input.signal,
    rpcBudget: input.rpcBudget,
    spec: {
      batchSize: QUOTER_MULTICALL_BATCH_SIZE,
      executeMulticall: ({ chain, calls, blockNumber, chainRpcs, signal, rpcBudget, onBudgetStop }) =>
        fetchEvmMulticall3Aggregate3AtBlock(chain, calls, blockNumber, {
          chainRpcs,
          signal,
          timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
          ...(rpcBudget ? { deadlineMs: rpcBudget.deadlineMs } : {}),
          ...(rpcBudget ? { beforeRequest: () => {
            const consumed = rpcBudget.tryConsume();
            const reason = rpcBudget.stopReason;
            if (!consumed && reason) onBudgetStop?.(reason);
            return consumed;
          } } : {}),
          maxRetries: 0,
          gas: QUOTER_MULTICALL_GAS,
          multicallBatchSize: Math.min(QUOTER_MULTICALL_BATCH_SIZE, calls.length),
        }),
      adaptive: {
        failedAttemptAccounting: "single-call",
        unattemptedResult: "failure-result",
        retryFailedCallsIndividually: true,
      },
      materializeTransportFailure: (request, reason) => ({
        targetId: request.target.targetId,
        inputUsd: request.inputUsd,
        failureReason: reason ?? "quoter-rpc-unavailable",
      }),
      resolveResult: (request, result) => {
        if (!result.success) {
          return {
            targetId: request.target.targetId,
            inputUsd: request.inputUsd,
            point: buildRevertedPoint(request, result),
          };
        }
        const point = decodePoint(request, result);
        return point
          ? { targetId: request.target.targetId, inputUsd: request.inputUsd, point }
          : {
          targetId: request.target.targetId,
          inputUsd: request.inputUsd,
          failureReason: "quoter-invalid-result",
        };
      },
    },
  });
}

function targetPoolAddress(target: Pick<DexMeasuredExecutionTarget, "chain" | "poolId">): `0x${string}` | null {
  const normalized = target.poolId.trim().toLowerCase();
  if (/^0x[a-f0-9]{40}$/.test(normalized)) return normalized as `0x${string}`;
  const prefix = `${target.chain.trim().toLowerCase()}:`;
  const address = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : "";
  return /^0x[a-f0-9]{40}$/.test(address) ? (address as `0x${string}`) : null;
}

export function encodeV3FactoryGetPool(target: DexMeasuredExecutionTarget): `0x${string}` {
  if (isSlipstreamTarget(target)) {
    if (target.tickSpacing == null) throw new Error(`Measured target ${target.targetId} has no tick spacing`);
    return encodeFunctionData({
      abi: SLIPSTREAM_FACTORY_ABI,
      functionName: "getPool",
      args: [target.tokenIn.address as `0x${string}`, target.tokenOut.address as `0x${string}`, target.tickSpacing],
    });
  }
  if (target.feePips == null) throw new Error(`Measured target ${target.targetId} has no fee pips`);
  return encodeFunctionData({
    abi: V3_FACTORY_ABI,
    functionName: "getPool",
    args: [target.tokenIn.address as `0x${string}`, target.tokenOut.address as `0x${string}`, target.feePips],
  });
}

function decodeV3FactoryGetPool(returnData: `0x${string}`): `0x${string}` | null {
  try {
    const value = decodeFunctionResult({
      abi: V3_FACTORY_ABI,
      functionName: "getPool",
      data: returnData,
    });
    const normalized = String(value).toLowerCase();
    return /^0x[a-f0-9]{40}$/.test(normalized) ? (normalized as `0x${string}`) : null;
  } catch {
    return null;
  }
}

export interface QuoterV2PoolBindingOutcome {
  targetId: string;
  proof?: DexMeasuredExecutionPoolBindingProof;
  failureReason?: string;
}

export async function resolveQuoterV2PoolBindings(input: {
  requests: ReadonlyArray<{
    target: DexMeasuredExecutionTarget;
    factoryAddress: `0x${string}`;
    factoryCodeHash: `0x${string}`;
  }>;
  blockNumber: number;
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
}): Promise<QuoterV2PoolBindingOutcome[]> {
  const encoded = input.requests.map((request, index) => {
    const expectedPool = targetPoolAddress(request.target);
    if (!expectedPool || !hasAdapterParameter(request.target)) return null;
    return {
      ...request,
      expectedPool,
      label: `${index}:${request.target.targetId}`,
      callData: encodeV3FactoryGetPool(request.target),
    };
  });
  const outcomes = input.requests.map<QuoterV2PoolBindingOutcome>((request) => ({
    targetId: request.target.targetId,
  }));
  const plans = encoded.flatMap((request, index) =>
    request
      ? [{
          ...request,
          index,
          chain: request.target.chain,
          blockNumber: input.blockNumber,
          call: {
            label: request.label,
            target: request.factoryAddress,
            callData: request.callData,
            allowFailure: true,
          },
        }]
      : [],
  );
  for (let index = 0; index < encoded.length; index++) {
    if (encoded[index] == null) {
      outcomes[index] = {
        targetId: input.requests[index]!.target.targetId,
        failureReason: "invalid-target-pool-id",
      };
    }
  }
  return executeEvmQuotePlan({
    plans,
    outcomes,
    chainRpcs: input.chainRpcs,
    signal: input.signal,
    rpcBudget: input.rpcBudget,
    spec: {
      batchSize: QUOTER_MULTICALL_BATCH_SIZE,
      executeMulticall: ({ chain, calls, blockNumber, chainRpcs, signal, rpcBudget, onBudgetStop }) =>
        fetchEvmMulticall3Aggregate3AtBlock(chain, calls, blockNumber, {
          chainRpcs,
          signal,
          timeoutMs: DEX_MEASURED_EVM_REQUEST_TIMEOUT_MS,
          ...(rpcBudget ? { deadlineMs: rpcBudget.deadlineMs } : {}),
          ...(rpcBudget
            ? {
                beforeRequest: () => {
                  const consumed = rpcBudget.tryConsume();
                  const reason = rpcBudget.stopReason;
                  if (!consumed && reason) onBudgetStop?.(reason);
                  return consumed;
                },
              }
            : {}),
          maxRetries: 0,
          gas: QUOTER_MULTICALL_GAS,
          multicallBatchSize: Math.min(QUOTER_MULTICALL_BATCH_SIZE, calls.length),
        }),
      adaptive: {
        failedAttemptAccounting: "single-call",
        unattemptedResult: "failure-result",
      },
      materializeTransportFailure: (request) => ({
        targetId: request.target.targetId,
        failureReason: "factory-get-pool-failed",
      }),
      resolveResult: (request, result) => {
        const resolvedPool = result.success
          ? decodeV3FactoryGetPool(result.returnData as `0x${string}`)
          : null;
        if (!resolvedPool) {
          return {
            targetId: request.target.targetId,
            failureReason: "factory-get-pool-failed",
          };
        }
        if (resolvedPool !== request.expectedPool) {
          return {
            targetId: request.target.targetId,
            failureReason: "factory-pool-mismatch",
          };
        }
        return {
          targetId: request.target.targetId,
          proof: {
            factoryAddress: request.factoryAddress,
            factoryCodeHash: request.factoryCodeHash,
            resolvedPoolAddress: resolvedPool,
            callData: request.callData.toLowerCase(),
            returnData: result.returnData.toLowerCase(),
          },
        };
      },
    },
  });
}

/** Decode-bound proof validation specific to the QuoterV2 adapter. */
export function validateQuoterV2ProfileProof(profile: DexMeasuredExecutionProfile): string[] {
  const issues = new Set<string>();
  const deployment = getDexMeasuredExecutionDeployment(profile.adapterProfileId, profile.chain);
  if (!deployment) {
    issues.add("unsupported-deployment");
  } else if (
    profile.executionEndpoint.address.toLowerCase() !== deployment.endpointAddress ||
    profile.executionEndpoint.codeHash.toLowerCase() !== deployment.expectedCodeHash
  ) {
    issues.add("execution-endpoint-identity-mismatch");
  }
  const binding = profile.poolBindingProof;
  if (!deployment || !binding) {
    issues.add("pool-binding-proof-missing");
  } else {
    if (
      binding.factoryAddress !== deployment.factoryAddress ||
      binding.factoryCodeHash !== deployment.expectedFactoryCodeHash
    )
      issues.add("factory-identity-mismatch");
    try {
      const slipstream = profile.adapterProfileId === AERODROME_SLIPSTREAM_ADAPTER_PROFILE_ID;
      const decodedCall = decodeFunctionData({
        abi: slipstream ? SLIPSTREAM_FACTORY_ABI : V3_FACTORY_ABI,
        data: binding.callData as `0x${string}`,
      });
      const [tokenA, tokenB, poolParameter] = decodedCall.args as readonly [string, string, number];
      if (
        decodedCall.functionName !== "getPool" ||
        tokenA.toLowerCase() !== profile.tokenIn.address ||
        tokenB.toLowerCase() !== profile.tokenOut.address ||
        poolParameter !== (slipstream ? profile.tickSpacing : profile.feePips)
      )
        issues.add("factory-call-data-mismatch");
    } catch {
      issues.add("factory-call-decode-failed");
    }
    const decodedPool = decodeV3FactoryGetPool(binding.returnData as `0x${string}`);
    const expectedPool = targetPoolAddress(profile);
    if (!decodedPool || !expectedPool || decodedPool !== binding.resolvedPoolAddress || decodedPool !== expectedPool)
      issues.add("factory-pool-binding-mismatch");
  }
  for (const point of profile.quoteProof) {
    try {
      const slipstream = profile.adapterProfileId === AERODROME_SLIPSTREAM_ADAPTER_PROFILE_ID;
      const decodedCall = decodeFunctionData({
        abi: slipstream ? SLIPSTREAM_QUOTER_V2_ABI : QUOTER_V2_ABI,
        data: point.callData as `0x${string}`,
      });
      if (decodedCall.functionName !== "quoteExactInputSingle") {
        issues.add("wrong-function-selector");
        continue;
      }
      const params = decodedCall.args[0] as {
        tokenIn: string;
        tokenOut: string;
        amountIn: bigint;
        fee?: number;
        tickSpacing?: number;
        sqrtPriceLimitX96: bigint;
      };
      if (
        params.tokenIn.toLowerCase() !== profile.tokenIn.address ||
        params.tokenOut.toLowerCase() !== profile.tokenOut.address ||
        params.amountIn.toString() !== point.amountInRaw ||
        (slipstream ? params.tickSpacing !== profile.tickSpacing : params.fee !== profile.feePips) ||
        params.sqrtPriceLimitX96 !== 0n
      )
        issues.add("call-data-mismatch");

      if (point.reverted) {
        if (
          point.amountOutRaw !== "0" ||
          point.outputUsd !== 0 ||
          point.costBps !== 10_000 ||
          point.passesCostBound
        ) issues.add("invalid-revert-proof");
        try {
          decodeFunctionResult({
            abi: QUOTER_V2_ABI,
            functionName: "quoteExactInputSingle",
            data: point.returnData as `0x${string}`,
          });
          issues.add("revert-data-decodes-as-success");
        } catch {
          // Revert data must not decode as a successful QuoterV2 result.
        }
      } else {
        const decodedResult = decodeFunctionResult({
          abi: QUOTER_V2_ABI,
          functionName: "quoteExactInputSingle",
          data: point.returnData as `0x${string}`,
        }) as readonly [bigint, bigint, number, bigint];
        if (decodedResult[0].toString() !== point.amountOutRaw) issues.add("return-data-mismatch");
      }
    } catch {
      issues.add("abi-decode-failed");
    }
  }
  return [...issues];
}
