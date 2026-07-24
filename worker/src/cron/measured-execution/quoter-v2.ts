import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";

import {
  DEX_MEASURED_MAX_COST_BPS,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionPoolBindingProof,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { throwIfAborted } from "../../lib/abort";
import {
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmMulticall3Call,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import type {
  DexMeasuredExecutionBudgetStopReason,
  DexMeasuredExecutionRpcBudget,
  DexMeasuredRawQuotePoint,
} from "./profiles";
import { getDexMeasuredExecutionDeployment } from "./registry";

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
const MAX_UINT256 = (1n << 256n) - 1n;

interface QuoterV2Request {
  target: DexMeasuredExecutionTarget;
  inputUsd: number;
  endpointAddress: `0x${string}`;
}

interface EncodedQuoterV2Request extends QuoterV2Request {
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

interface AdaptiveChunkResult {
  results: EvmMulticall3Result[];
  transportFailureLabels: string[];
  budgetStopReasonsByLabel: Map<string, DexMeasuredExecutionBudgetStopReason>;
}

async function runWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        await run(values[index]!);
      }
    }),
  );
}

function usdToRawAmount(inputUsd: number, decimals: number, referencePriceUsd: number): bigint | null {
  if (
    !Number.isFinite(inputUsd) ||
    inputUsd <= 0 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255 ||
    !Number.isFinite(referencePriceUsd) ||
    referencePriceUsd <= 0
  )
    return null;
  const usdScale = 1_000_000n;
  const priceScale = 100_000_000n;
  const usdScaled = BigInt(Math.floor(inputUsd * Number(usdScale)));
  const priceScaled = BigInt(Math.round(referencePriceUsd * Number(priceScale)));
  if (priceScaled <= 0n) return null;
  const amount = (usdScaled * 10n ** BigInt(decimals) * priceScale) / (usdScale * priceScaled);
  return amount > 0n && amount <= MAX_UINT256 ? amount : null;
}

function rawAmountToUsd(amount: bigint, decimals: number, referencePriceUsd: number): number {
  const priceScale = 100_000_000n;
  const usdScale = 1_000_000n;
  const priceScaled = BigInt(Math.round(referencePriceUsd * Number(priceScale)));
  const usdScaled = (amount * priceScaled * usdScale) / (10n ** BigInt(decimals) * priceScale);
  return Number(usdScaled) / Number(usdScale);
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
  );
  if (amountInRaw == null || !hasAdapterParameter(request.target)) return null;
  try {
    return {
      ...request,
      label: `${index}:${request.target.targetId}`,
      amountInRaw,
      callData: encodeQuoterV2ExactInputSingle(request.target, amountInRaw),
    };
  } catch {
    return null;
  }
}

async function executeAdaptiveChunk(input: {
  chain: string;
  calls: readonly EvmMulticall3Call[];
  blockNumber: number;
  chainRpcs: Map<string, ChainRpcConfig>;
  signal?: AbortSignal;
  rpcBudget?: DexMeasuredExecutionRpcBudget;
}): Promise<AdaptiveChunkResult> {
  if (input.rpcBudget && !input.rpcBudget.canRequestChain(input.chain)) {
    return {
      results: input.calls.map((call) => ({ label: call.label, success: false, returnData: "0x" })),
      transportFailureLabels: input.calls.map((call) => call.label),
      budgetStopReasonsByLabel: new Map(),
    };
  }
  let budgetStopReason: DexMeasuredExecutionBudgetStopReason | null = null;
  const result = await fetchEvmMulticall3Aggregate3AtBlock(input.chain, input.calls, input.blockNumber, {
    chainRpcs: input.chainRpcs,
    signal: input.signal,
    timeoutMs: 30_000,
    ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
    ...(input.rpcBudget
      ? {
          beforeRequest: () => {
            const consumed = input.rpcBudget!.tryConsume();
            if (!consumed) budgetStopReason = input.rpcBudget!.stopReason;
            return consumed;
          },
        }
      : {}),
    maxRetries: 0,
    gas: QUOTER_MULTICALL_GAS,
    multicallBatchSize: Math.min(QUOTER_MULTICALL_BATCH_SIZE, input.calls.length),
  });
  if (result != null) {
    input.rpcBudget?.recordChainResult(input.chain, true);
    return { results: result, transportFailureLabels: [], budgetStopReasonsByLabel: new Map() };
  }
  if (budgetStopReason == null && input.rpcBudget && Date.now() >= input.rpcBudget.deadlineMs) {
    budgetStopReason = "runtime-deadline-exceeded";
  }
  if (budgetStopReason != null) {
    return {
      results: input.calls.map((call) => ({ label: call.label, success: false, returnData: "0x" })),
      transportFailureLabels: input.calls.map((call) => call.label),
      budgetStopReasonsByLabel: new Map(input.calls.map((call) => [call.label, budgetStopReason!])),
    };
  }
  if (input.calls.length === 1) {
    input.rpcBudget?.recordChainResult(input.chain, false);
    return {
      results: [{ label: input.calls[0]!.label, success: false, returnData: "0x" }],
      transportFailureLabels: [input.calls[0]!.label],
      budgetStopReasonsByLabel: new Map(),
    };
  }
  const midpoint = Math.ceil(input.calls.length / 2);
  const left = await executeAdaptiveChunk({ ...input, calls: input.calls.slice(0, midpoint) });
  const right = await executeAdaptiveChunk({ ...input, calls: input.calls.slice(midpoint) });
  return {
    results: [...left.results, ...right.results],
    transportFailureLabels: [...left.transportFailureLabels, ...right.transportFailureLabels],
    budgetStopReasonsByLabel: new Map([
      ...left.budgetStopReasonsByLabel,
      ...right.budgetStopReasonsByLabel,
    ]),
  };
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
    const inputUsd = rawAmountToUsd(
      request.amountInRaw,
      request.target.tokenIn.decimals,
      request.target.tokenIn.referencePriceUsd,
    );
    const outputUsd = rawAmountToUsd(
      amountOutRaw,
      request.target.tokenOut.decimals,
      request.target.tokenOut.referencePriceUsd,
    );
    if (!Number.isFinite(inputUsd) || inputUsd <= 0 || !Number.isFinite(outputUsd) || outputUsd < 0) return null;
    const costBps = Math.max(0, (1 - outputUsd / inputUsd) * 10_000);
    return {
      amountInRaw: request.amountInRaw.toString(),
      amountOutRaw: amountOutRaw.toString(),
      callData: request.callData.toLowerCase(),
      returnData: result.returnData.toLowerCase() as `0x${string}`,
      inputUsd,
      outputUsd,
      costBps,
      passesCostBound: costBps <= DEX_MEASURED_MAX_COST_BPS,
      adapterMetadata: {
        sqrtPriceX96After: sqrtPriceX96After.toString(),
        initializedTicksCrossed: Number(initializedTicksCrossed),
        gasEstimate: gasEstimate.toString(),
      },
    };
  } catch {
    return null;
  }
}

function buildRevertedPoint(
  request: EncodedQuoterV2Request,
  result: EvmMulticall3Result,
): DexMeasuredRawQuotePoint {
  return {
    amountInRaw: request.amountInRaw.toString(),
    amountOutRaw: "0",
    callData: request.callData.toLowerCase(),
    returnData: result.returnData.toLowerCase() as `0x${string}`,
    inputUsd: rawAmountToUsd(
      request.amountInRaw,
      request.target.tokenIn.decimals,
      request.target.tokenIn.referencePriceUsd,
    ),
    outputUsd: 0,
    costBps: 10_000,
    passesCostBound: false,
    reverted: true,
    adapterMetadata: { executionReverted: true },
  };
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
  const valid = encoded.filter((request): request is EncodedQuoterV2Request => request != null);
  const byChain = new Map<string, EncodedQuoterV2Request[]>();
  for (const request of valid) {
    const chainRequests = byChain.get(request.target.chain) ?? [];
    chainRequests.push(request);
    byChain.set(request.target.chain, chainRequests);
  }

  const resultsByLabel = new Map<string, EvmMulticall3Result>();
  const transportFailureLabels = new Set<string>();
  const budgetStopReasonsByLabel = new Map<string, DexMeasuredExecutionBudgetStopReason>();
  await runWithConcurrency([...byChain], 3, async ([chain, requests]) => {
    for (let offset = 0; offset < requests.length; offset += QUOTER_MULTICALL_BATCH_SIZE) {
      throwIfAborted(input.signal);
      const chunk = requests.slice(offset, offset + QUOTER_MULTICALL_BATCH_SIZE);
      const calls = chunk.map((request) => ({
        label: request.label,
        target: request.endpointAddress,
        callData: request.callData,
        allowFailure: true,
      }));
      const initial = await executeAdaptiveChunk({
        chain,
        calls,
        blockNumber: input.blockNumber,
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        rpcBudget: input.rpcBudget,
      });
      for (const result of initial.results) resultsByLabel.set(result.label, result);
      for (const label of initial.transportFailureLabels) transportFailureLabels.add(label);
      for (const [label, reason] of initial.budgetStopReasonsByLabel) {
        budgetStopReasonsByLabel.set(label, reason);
      }

      const failedCalls = calls.filter((call) => !resultsByLabel.get(call.label)?.success);
      for (const failedCall of failedCalls) {
        throwIfAborted(input.signal);
        const retry = await executeAdaptiveChunk({
          chain,
          calls: [failedCall],
          blockNumber: input.blockNumber,
          chainRpcs: input.chainRpcs,
          signal: input.signal,
          rpcBudget: input.rpcBudget,
        });
        for (const result of retry.results) resultsByLabel.set(result.label, result);
        for (const [label, reason] of retry.budgetStopReasonsByLabel) {
          budgetStopReasonsByLabel.set(label, reason);
        }
        if (retry.transportFailureLabels.includes(failedCall.label)) transportFailureLabels.add(failedCall.label);
        else transportFailureLabels.delete(failedCall.label);
      }
    }
  });

  for (const request of valid) {
    const result = resultsByLabel.get(request.label);
    const outcomeIndex = Number.parseInt(request.label.slice(0, request.label.indexOf(":")), 10);
    const budgetStopReason = budgetStopReasonsByLabel.get(request.label);
    if (budgetStopReason) {
      outcomes[outcomeIndex] = {
        targetId: request.target.targetId,
        inputUsd: request.inputUsd,
        failureReason: budgetStopReason,
      };
      continue;
    }
    if (!result || transportFailureLabels.has(request.label)) {
      outcomes[outcomeIndex] = {
        targetId: request.target.targetId,
        inputUsd: request.inputUsd,
        failureReason: "quoter-rpc-unavailable",
      };
      continue;
    }
    if (!result.success) {
      outcomes[outcomeIndex] = {
        targetId: request.target.targetId,
        inputUsd: request.inputUsd,
        point: buildRevertedPoint(request, result),
      };
      continue;
    }
    const point = decodePoint(request, result);
    outcomes[outcomeIndex] = point
      ? { targetId: request.target.targetId, inputUsd: request.inputUsd, point }
      : {
          targetId: request.target.targetId,
          inputUsd: request.inputUsd,
          failureReason: "quoter-invalid-result",
        };
  }
  return outcomes;
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
  const valid = encoded.filter((request): request is NonNullable<typeof request> => request != null);
  const byChain = new Map<string, typeof valid>();
  for (const request of valid) {
    const rows = byChain.get(request.target.chain) ?? [];
    rows.push(request);
    byChain.set(request.target.chain, rows);
  }

  await runWithConcurrency([...byChain], 3, async ([chain, requests]) => {
    for (let offset = 0; offset < requests.length; offset += QUOTER_MULTICALL_BATCH_SIZE) {
      throwIfAborted(input.signal);
      const chunk = requests.slice(offset, offset + QUOTER_MULTICALL_BATCH_SIZE);
      const execution = await executeAdaptiveChunk({
        chain,
        calls: chunk.map((request) => ({
          label: request.label,
          target: request.factoryAddress,
          callData: request.callData,
          allowFailure: true,
        })),
        blockNumber: input.blockNumber,
        chainRpcs: input.chainRpcs,
        signal: input.signal,
        rpcBudget: input.rpcBudget,
      });
      const byLabel = new Map(execution.results.map((result) => [result.label, result]));
      const transportFailures = new Set(execution.transportFailureLabels);
      for (const request of chunk) {
        const index = Number.parseInt(request.label.slice(0, request.label.indexOf(":")), 10);
        const result = byLabel.get(request.label);
        const resolvedPool = result?.success ? decodeV3FactoryGetPool(result.returnData as `0x${string}`) : null;
        if (!result || transportFailures.has(request.label) || !resolvedPool) {
          outcomes[index] = { targetId: request.target.targetId, failureReason: "factory-get-pool-failed" };
        } else if (resolvedPool !== request.expectedPool) {
          outcomes[index] = { targetId: request.target.targetId, failureReason: "factory-pool-mismatch" };
        } else {
          outcomes[index] = {
            targetId: request.target.targetId,
            proof: {
              factoryAddress: request.factoryAddress,
              factoryCodeHash: request.factoryCodeHash,
              resolvedPoolAddress: resolvedPool,
              callData: request.callData.toLowerCase(),
              returnData: result.returnData.toLowerCase(),
            },
          };
        }
      }
    }
  });
  for (let index = 0; index < encoded.length; index++) {
    if (encoded[index] == null) {
      outcomes[index] = { targetId: input.requests[index]!.target.targetId, failureReason: "invalid-target-pool-id" };
    }
  }
  return outcomes;
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
