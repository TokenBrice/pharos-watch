import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, parseAbi } from "viem/utils";

import {
  DEX_MEASURED_MAX_COST_BPS,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionPoolBindingProof,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import {
  fetchEvmMulticall3Aggregate3AtBlock,
  type EvmMulticall3Call,
  type EvmMulticall3Result,
} from "../../lib/evm-rpc";
import type { DexMeasuredExecutionAdapter, DexMeasuredExecutionRpcBudget, DexMeasuredRawQuotePoint } from "./profiles";
import { getDexMeasuredExecutionDeployment } from "./registry";

const QUOTER_V2_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const V3_FACTORY_ABI = parseAbi([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)",
]);
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

export function encodeQuoterV2ExactInputSingle(target: DexMeasuredExecutionTarget, amountInRaw: bigint): `0x${string}` {
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
  if (amountInRaw == null || request.target.feePips == null) return null;
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
}): Promise<EvmMulticall3Result[]> {
  if (input.rpcBudget && !input.rpcBudget.canRequestChain(input.chain)) {
    return input.calls.map((call) => ({ label: call.label, success: false, returnData: "0x" }));
  }
  const result = await fetchEvmMulticall3Aggregate3AtBlock(input.chain, input.calls, input.blockNumber, {
    chainRpcs: input.chainRpcs,
    signal: input.signal,
    timeoutMs: 30_000,
    ...(input.rpcBudget ? { deadlineMs: input.rpcBudget.deadlineMs } : {}),
    ...(input.rpcBudget ? { beforeRequest: () => input.rpcBudget!.tryConsume() } : {}),
    maxRetries: 0,
    gas: QUOTER_MULTICALL_GAS,
    multicallBatchSize: Math.min(QUOTER_MULTICALL_BATCH_SIZE, input.calls.length),
  });
  if (result != null) {
    input.rpcBudget?.recordChainResult(input.chain, true);
    return result;
  }
  if (input.rpcBudget?.stopReason) {
    return input.calls.map((call) => ({ label: call.label, success: false, returnData: "0x" }));
  }
  if (input.calls.length === 1) {
    input.rpcBudget?.recordChainResult(input.chain, false);
    return [{ label: input.calls[0]!.label, success: false, returnData: "0x" }];
  }
  const midpoint = Math.ceil(input.calls.length / 2);
  const left = await executeAdaptiveChunk({ ...input, calls: input.calls.slice(0, midpoint) });
  const right = await executeAdaptiveChunk({ ...input, calls: input.calls.slice(midpoint) });
  return [...left, ...right];
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
  await runWithConcurrency([...byChain], 3, async ([chain, requests]) => {
    for (let offset = 0; offset < requests.length; offset += QUOTER_MULTICALL_BATCH_SIZE) {
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
      for (const result of initial) resultsByLabel.set(result.label, result);

      const failedCalls = calls.filter((call) => !resultsByLabel.get(call.label)?.success);
      for (const failedCall of failedCalls) {
        const retry = await executeAdaptiveChunk({
          chain,
          calls: [failedCall],
          blockNumber: input.blockNumber,
          chainRpcs: input.chainRpcs,
          signal: input.signal,
          rpcBudget: input.rpcBudget,
        });
        for (const result of retry) resultsByLabel.set(result.label, result);
      }
    }
  });

  for (const request of valid) {
    const result = resultsByLabel.get(request.label);
    const outcomeIndex = Number.parseInt(request.label.slice(0, request.label.indexOf(":")), 10);
    const point = result ? decodePoint(request, result) : null;
    outcomes[outcomeIndex] = point
      ? { targetId: request.target.targetId, inputUsd: request.inputUsd, point }
      : {
          targetId: request.target.targetId,
          inputUsd: request.inputUsd,
          failureReason: "quoter-revert-or-invalid-result",
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
  if (target.feePips == null) throw new Error(`Measured target ${target.targetId} has no fee pips`);
  return encodeFunctionData({
    abi: V3_FACTORY_ABI,
    functionName: "getPool",
    args: [target.tokenIn.address as `0x${string}`, target.tokenOut.address as `0x${string}`, target.feePips],
  });
}

export function decodeV3FactoryGetPool(returnData: `0x${string}`): `0x${string}` | null {
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
    if (!expectedPool || request.target.feePips == null) return null;
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
      const chunk = requests.slice(offset, offset + QUOTER_MULTICALL_BATCH_SIZE);
      const results = await executeAdaptiveChunk({
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
      const byLabel = new Map(results.map((result) => [result.label, result]));
      for (const request of chunk) {
        const index = Number.parseInt(request.label.slice(0, request.label.indexOf(":")), 10);
        const result = byLabel.get(request.label);
        const resolvedPool = result?.success ? decodeV3FactoryGetPool(result.returnData as `0x${string}`) : null;
        if (!result || !resolvedPool) {
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
      const decodedCall = decodeFunctionData({ abi: V3_FACTORY_ABI, data: binding.callData as `0x${string}` });
      const [tokenA, tokenB, fee] = decodedCall.args as readonly [string, string, number];
      if (
        decodedCall.functionName !== "getPool" ||
        tokenA.toLowerCase() !== profile.tokenIn.address ||
        tokenB.toLowerCase() !== profile.tokenOut.address ||
        fee !== profile.feePips
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
      const decodedCall = decodeFunctionData({ abi: QUOTER_V2_ABI, data: point.callData as `0x${string}` });
      if (decodedCall.functionName !== "quoteExactInputSingle") {
        issues.add("wrong-function-selector");
        continue;
      }
      const params = decodedCall.args[0] as {
        tokenIn: string;
        tokenOut: string;
        amountIn: bigint;
        fee: number;
        sqrtPriceLimitX96: bigint;
      };
      if (
        params.tokenIn.toLowerCase() !== profile.tokenIn.address ||
        params.tokenOut.toLowerCase() !== profile.tokenOut.address ||
        params.amountIn.toString() !== point.amountInRaw ||
        params.fee !== profile.feePips ||
        params.sqrtPriceLimitX96 !== 0n
      )
        issues.add("call-data-mismatch");

      const decodedResult = decodeFunctionResult({
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        data: point.returnData as `0x${string}`,
      }) as readonly [bigint, bigint, number, bigint];
      if (decodedResult[0].toString() !== point.amountOutRaw) issues.add("return-data-mismatch");
    } catch {
      issues.add("abi-decode-failed");
    }
  }
  return [...issues];
}

export const QUOTER_V2_ADAPTER: DexMeasuredExecutionAdapter = {
  profileId: "quoter-v2",
  async quotePoints(input) {
    const outcomes = await quoteQuoterV2Requests({
      requests: input.inputNotionalsUsd.map((inputUsd) => ({
        target: input.target,
        inputUsd,
        endpointAddress: input.endpointAddress,
      })),
      blockNumber: input.blockNumber,
      chainRpcs: input.chainRpcs,
      signal: input.signal,
    });
    return {
      points: outcomes.flatMap((outcome) => (outcome.point ? [outcome.point] : [])),
      failures: outcomes.flatMap((outcome) =>
        outcome.failureReason ? [{ inputUsd: outcome.inputUsd, reason: outcome.failureReason }] : [],
      ),
    };
  },
};
