import {
  DEX_MEASURED_EXECUTION_SCHEMA_VERSION,
  DEX_MEASURED_MAX_COST_BPS,
  buildDexMeasuredCapacityCurve,
  type DexMeasuredExecutionProfile,
  type DexMeasuredExecutionPoolBindingProof,
  type DexMeasuredExecutionQuotePointProof,
  type DexMeasuredExecutionRegistryBindingProof,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";

export interface DexMeasuredRawQuotePoint extends DexMeasuredExecutionQuotePointProof {
  adapterMetadata?: Record<string, string | number | boolean>;
}

export type DexMeasuredExecutionBudgetStopReason = "request-budget-exhausted" | "runtime-deadline-exceeded";

export interface DexMeasuredExecutionRpcBudget {
  tryConsume(): boolean;
  canRequestChain(chain: string): boolean;
  recordChainResult(chain: string, success: boolean): void;
  isChainCircuitOpen(chain: string): boolean;
  readonly requestsUsed: number;
  readonly deadlineMs: number;
  readonly openChains: readonly string[];
  readonly stopReason: DexMeasuredExecutionBudgetStopReason | null;
}

export function createDexMeasuredExecutionRpcBudget(input: {
  maxRequests: number;
  deadlineMs: number;
  now?: () => number;
}): DexMeasuredExecutionRpcBudget {
  const now = input.now ?? Date.now;
  let requestsUsed = 0;
  let stopReason: DexMeasuredExecutionBudgetStopReason | null = null;
  const consecutiveFailuresByChain = new Map<string, number>();
  const openChains = new Set<string>();
  const normalizeChain = (chain: string) => chain.trim().toLowerCase();
  return {
    tryConsume() {
      if (stopReason != null) return false;
      if (now() >= input.deadlineMs) {
        stopReason = "runtime-deadline-exceeded";
        return false;
      }
      if (requestsUsed >= input.maxRequests) {
        stopReason = "request-budget-exhausted";
        return false;
      }
      requestsUsed++;
      return true;
    },
    canRequestChain(chain) {
      return !openChains.has(normalizeChain(chain));
    },
    recordChainResult(chain, success) {
      const normalized = normalizeChain(chain);
      if (success) {
        consecutiveFailuresByChain.delete(normalized);
        return;
      }
      const failures = (consecutiveFailuresByChain.get(normalized) ?? 0) + 1;
      consecutiveFailuresByChain.set(normalized, failures);
      if (failures >= 2) openChains.add(normalized);
    },
    isChainCircuitOpen(chain) {
      return openChains.has(normalizeChain(chain));
    },
    get requestsUsed() {
      return requestsUsed;
    },
    get deadlineMs() {
      return input.deadlineMs;
    },
    get openChains() {
      return [...openChains].sort();
    },
    get stopReason() {
      if (stopReason == null && now() >= input.deadlineMs) {
        stopReason = "runtime-deadline-exceeded";
      }
      return stopReason;
    },
  };
}

export interface DexMeasuredExecutionAdapter {
  readonly profileId: string;
  quotePoints(input: {
    target: DexMeasuredExecutionTarget;
    inputNotionalsUsd: readonly number[];
    blockNumber: number;
    endpointAddress: `0x${string}`;
    chainRpcs: Map<string, import("../../lib/chain-registry").ChainRpcConfig>;
    signal?: AbortSignal;
  }): Promise<{
    points: DexMeasuredRawQuotePoint[];
    failures: Array<{ inputUsd: number; reason: string }>;
  }>;
}

export function buildDexMeasuredExecutionProfile(input: {
  target: DexMeasuredExecutionTarget;
  targetGenerationId: string;
  quoteGenerationId: string;
  quotedAt: number;
  blockNumber: number;
  endpointAddress: `0x${string}`;
  endpointCodeHash: `0x${string}`;
  poolBindingProof?: DexMeasuredExecutionPoolBindingProof;
  registryBindingProof?: DexMeasuredExecutionRegistryBindingProof;
  points: readonly DexMeasuredRawQuotePoint[];
}): DexMeasuredExecutionProfile {
  const sortedPoints = [...input.points].sort((left, right) => left.inputUsd - right.inputUsd);
  const marginal = sortedPoints[0];
  if (!marginal || Math.abs(marginal.inputUsd - 1_000) > 0.02) {
    throw new Error(`Measured execution target ${input.target.targetId} has no marginal quote`);
  }
  const quoteProof = sortedPoints.map((point) => ({
    amountInRaw: point.amountInRaw,
    amountOutRaw: point.amountOutRaw,
    callData: point.callData,
    returnData: point.returnData,
    inputUsd: point.inputUsd,
    outputUsd: point.outputUsd,
    costBps: point.costBps,
    passesCostBound: point.passesCostBound,
    ...(point.reverted ? { reverted: true as const } : {}),
  }));

  return {
    schemaVersion: DEX_MEASURED_EXECUTION_SCHEMA_VERSION,
    kind: "measured-executable-depth",
    targetId: input.target.targetId,
    targetGenerationId: input.targetGenerationId,
    quoteGenerationId: input.quoteGenerationId,
    adapterProfileId: input.target.adapterProfileId,
    protocol: input.target.protocol,
    chain: input.target.chain,
    poolId: input.target.poolId,
    ...(input.target.poolTokenAddresses ? { poolTokenAddresses: input.target.poolTokenAddresses } : {}),
    tokenIn: input.target.tokenIn,
    tokenOut: input.target.tokenOut,
    ...(input.target.feePips != null ? { feePips: input.target.feePips } : {}),
    ...(input.target.tickSpacing != null ? { tickSpacing: input.target.tickSpacing } : {}),
    retainedTvlUsdAtQuote: input.target.retainedTvlUsd,
    retainedPoolPriceUsdAtQuote: input.target.retainedPoolPriceUsd,
    quotedAt: input.quotedAt,
    blockNumber: input.blockNumber,
    executionEndpoint: {
      address: input.endpointAddress.toLowerCase() as `0x${string}`,
      codeHash: input.endpointCodeHash.toLowerCase() as `0x${string}`,
    },
    ...(input.poolBindingProof ? { poolBindingProof: input.poolBindingProof } : {}),
    ...(input.registryBindingProof ? { registryBindingProof: input.registryBindingProof } : {}),
    maxCostBps: DEX_MEASURED_MAX_COST_BPS,
    marginalOutputRatio: marginal.outputUsd / marginal.inputUsd,
    capacityCurve: buildDexMeasuredCapacityCurve(quoteProof, input.target.retainedTvlUsd),
    quoteProof,
  };
}
