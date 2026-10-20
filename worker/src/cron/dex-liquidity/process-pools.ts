import { buildPrimaryPoolKey, samePrimaryPoolObservation } from "./pool-identity";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { DEX_LIQUIDITY_POOL_MIN_TVL_USD } from "./constants";
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
  type ResolvedPoolIdentity,
  type PoolProtocolEnrichment,
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
  return {
    ...input,
    uniV3ExecutionCandidates: input.uniV3ExecutionCandidates ?? new Map(),
    measuredTargetCapturedAt:
      input.measuredTargetCapturedAt ?? Math.floor(Date.now() / 1000),
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
  const observations: { identity: ResolvedPoolIdentity; enrichment: PoolProtocolEnrichment; key: string; providerKey: string }[] = [];
  const firstByKey = new Map<string, ResolvedPoolIdentity["pool"]>();
  const conflictingKeys = new Set<string>();
  const enforceDexProjectFilter = context.dexProjects.size > 0;
  if (!enforceDexProjectFilter) {
    logWorkerEventArgs("handler", "warn",
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
    const key = buildPrimaryPoolKey(identity.chainNorm, pool.pool, pool.project,
      enrichment.curveAddressMatch ? enrichment.curveData?.poolAddress : undefined);
    const providerKey = `${identity.chainNorm}:defillama:${pool.pool.trim()}`;
    for (const observationKey of [key, providerKey]) {
      const previous = firstByKey.get(observationKey);
      if (previous && !samePrimaryPoolObservation(previous, pool)) conflictingKeys.add(observationKey);
      else if (!previous) firstByKey.set(observationKey, pool);
    }
    observations.push({ identity, enrichment, key, providerKey });
  }

  // Resolve the whole batch before accumulation: a later conflict retracts every
  // observation of that identity, rather than selecting the first arriving row.
  const seenPools = new Set<string>();
  for (const { identity, enrichment, key, providerKey } of observations) {
    if (conflictingKeys.has(key) || conflictingKeys.has(providerKey)) {
      recordRejection(rejectionMap, identity.pool, new ExpectedPoolInputError("conflicting-pool-observations"));
      continue;
    }
    if (seenPools.has(key)) continue;
    seenPools.add(key);
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
        input.fallbackCounters,
      );
    }
  }

  logWorkerEventArgs("handler", "info",
    `[dex-liquidity] Matched ${metrics.size} stablecoins with DEX liquidity`,
  );
  return { metrics, rejections: [...rejectionMap.values()] };
}
