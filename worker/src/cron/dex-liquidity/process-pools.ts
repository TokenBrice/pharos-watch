import { DEX_LIQUIDITY_POOL_MIN_TVL_USD } from "./constants";
import { buildUniqueEvmV2ExecutionCandidateFingerprintIndex } from "./constant-product-v2";
import type { LiquidityMetrics } from "./types";
import { accumulatePoolMetrics } from "./process-pool-accumulation";
import { admitAndResolvePoolIdentity } from "./process-pool-admission-identity";
import { buildPoolExecutionCapability } from "./process-pool-execution-capability";
import { enrichPoolProtocol } from "./process-pool-protocol-enrichment";
import {
  ExpectedPoolInputError,
  POOL_REJECTION_POOL_ID_LIMIT,
  type PoolProcessingContext,
  type PoolProcessingRejection,
  type ProcessPoolMetricsInput,
  type ProcessPoolMetricsResult,
} from "./process-pool-types";

export * from "./process-pool-execution-capability";
export type {
  PoolProcessingRejection,
  PoolRejectionReason,
  ProcessPoolMetricsInput,
  ProcessPoolMetricsResult,
} from "./process-pool-types";

export const POOL_REJECTION_MATERIAL_TVL_USD =
  DEX_LIQUIDITY_POOL_MIN_TVL_USD;

export function hasMaterialPoolRejections(
  rejections: readonly PoolProcessingRejection[] | undefined,
): boolean {
  return (
    rejections?.reduce(
      (totalTvlUsd, rejection) => totalTvlUsd + rejection.tvlUsd,
      0,
    ) ?? 0
  ) >= POOL_REJECTION_MATERIAL_TVL_USD;
}

function buildProcessingContext(
  input: ProcessPoolMetricsInput,
): PoolProcessingContext {
  const aerodromeV2ExecutionCandidates =
    input.aerodromeV2ExecutionCandidates ?? new Map();
  return {
    ...input,
    uniV3ExecutionCandidates: input.uniV3ExecutionCandidates ?? new Map(),
    measuredTargetCapturedAt:
      input.measuredTargetCapturedAt ?? Math.floor(Date.now() / 1000),
    aerodromeV2ExecutionCandidates,
    uniqueAerodromeV2ExecutionCandidates:
      buildUniqueEvmV2ExecutionCandidateFingerprintIndex(
        aerodromeV2ExecutionCandidates,
      ),
    curvePoolCandidatesByFingerprint:
      input.curvePoolCandidatesByFingerprint ?? new Map(),
    uniswapV4ExecutionCandidates:
      input.uniswapV4ExecutionCandidates ?? new Map(),
  };
}

function rejectionPoolId(pool: ProcessPoolMetricsInput["pools"][number]): string {
  return typeof pool.pool === "string" && pool.pool.length > 0
    ? pool.pool.slice(0, 160)
    : "<unknown>";
}

function recordRejection(
  rejections: Map<string, PoolProcessingRejection>,
  pool: ProcessPoolMetricsInput["pools"][number],
  error: ExpectedPoolInputError,
): void {
  const rejection = rejections.get(error.reason) ?? {
    reason: error.reason,
    poolIds: [],
    count: 0,
    tvlUsd: 0,
  };
  rejection.count++;
  if (Number.isFinite(pool.tvlUsd) && pool.tvlUsd > 0) {
    rejection.tvlUsd += pool.tvlUsd;
  }
  const poolId = rejectionPoolId(pool);
  if (
    rejection.poolIds.length < POOL_REJECTION_POOL_ID_LIMIT &&
    !rejection.poolIds.includes(poolId)
  ) {
    rejection.poolIds.push(poolId);
  }
  rejections.set(error.reason, rejection);
}

/** Match DeFiLlama pools to tracked stablecoins and compute per-pool metrics. */
export function processPoolMetrics(
  input: ProcessPoolMetricsInput,
): ProcessPoolMetricsResult {
  const context = buildProcessingContext(input);
  const metrics = new Map<string, LiquidityMetrics>();
  const rejectionMap = new Map<string, PoolProcessingRejection>();
  const enforceDexProjectFilter = context.dexProjects.size > 0;
  if (!enforceDexProjectFilter) {
    console.warn(
      "[dex-liquidity] DEX project index is empty — project whitelist filter disabled for this run",
    );
  }

  for (const pool of context.pools) {
    let identity;
    try {
      identity = admitAndResolvePoolIdentity(
        context,
        pool,
        enforceDexProjectFilter,
      );
    } catch (error) {
      if (!(error instanceof ExpectedPoolInputError)) throw error;
      recordRejection(rejectionMap, pool, error);
      continue;
    }
    if (!identity) continue;

    const enrichment = enrichPoolProtocol(context, identity);
    for (const stablecoinId of identity.matchedIds) {
      const capability = buildPoolExecutionCapability(
        context,
        identity,
        enrichment,
        stablecoinId,
      );
      accumulatePoolMetrics(
        metrics,
        identity,
        enrichment,
        capability,
        stablecoinId,
      );
    }
  }

  console.log(
    `[dex-liquidity] Matched ${metrics.size} stablecoins with DEX liquidity`,
  );
  return { metrics, rejections: [...rejectionMap.values()] };
}
