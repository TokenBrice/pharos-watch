import { buildPrimaryPoolKey, samePrimaryPoolObservation } from "./pool-identity";
import { logWorkerEventArgs } from "../../lib/structured-log";
import { canonicalExitRouteChain } from "@shared/types/exit-route-identity";
import { resolveLlamaPoolStablecoinMatches } from "./pool-match-resolution";
import { boundTelemetryEntries } from "./route-telemetry";
import type { DexLiquidityCronMetadata } from "../../lib/schemas";
import { DEX_LIQUIDITY_POOL_MIN_TVL_USD } from "./constants";
import type { SourcePoolGraph } from "./types";
import { accumulatePoolMetrics } from "./process-pool-accumulation";
import { admitAndResolvePoolIdentity } from "./process-pool-admission-identity";
import { buildPoolExecutionCapability } from "./process-pool-execution-capability";
import { enrichPoolProtocol } from "./process-pool-protocol-enrichment";
import {
  ExpectedPoolInputError,
  POOL_REJECTION_POOL_ID_LIMIT,
  type PoolProcessingContext,
  type PoolRejectionLookups,
  type PoolProcessingRejection,
  type PoolRejectionDetail,
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

const REJECTION_DETAIL_LIMIT = 8;
const REJECTION_DETAIL_BYTES = 1_024;

function compareRejectionDetails(a: PoolRejectionDetail, b: PoolRejectionDetail): number {
  return Number(a.scope === "non-dex-project") - Number(b.scope === "non-dex-project")
    || (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0);
}

/** Only affirmative non-DEX evidence may exclude a rejected project from health. */
export function scopePoolRejections(
  rejections: readonly PoolProcessingRejection[], dexProjects: ReadonlySet<string>,
  nonDexProjects: ReadonlySet<string> = new Set(),
): PoolProcessingRejection[] {
  const groups = new Map<string, PoolProcessingRejection>();
  for (const { project, ...row } of rejections) {
    const projectReadable = typeof project === "string" && project.trim().length > 0;
    const scope = !projectReadable
      ? "unknown-project" : dexProjects.has(project) ? "dex-project"
        : nonDexProjects.has(project) ? "non-dex-project" : "unknown-project";
    const key = `${row.reason}:${scope}`;
    const scoped = { ...row, scope,
      tvlUsdByStablecoin: row.tvlUsdByStablecoin == null ? undefined : { ...row.tvlUsdByStablecoin },
      attributionUnavailable: !projectReadable || row.attributionUnavailable || row.tvlUsdByStablecoin == null,
      details: (row.details ?? []).map((detail) => ({ ...detail, scope })),
    } satisfies PoolProcessingRejection;
    const group = groups.get(key);
    if (!group) { groups.set(key, scoped); continue; }
    group.count += row.count;
    group.tvlUsd += row.tvlUsd;
    group.attributionUnavailable ||= scoped.attributionUnavailable;
    group.unavailableTvlCount = group.unavailableTvlCount == null || row.unavailableTvlCount == null
      ? undefined : group.unavailableTvlCount + row.unavailableTvlCount;
    for (const [id, tvl] of Object.entries(row.tvlUsdByStablecoin ?? {})) {
      group.tvlUsdByStablecoin ??= {};
      group.tvlUsdByStablecoin[id] = (group.tvlUsdByStablecoin[id] ?? 0) + tvl;
    }
    group.poolIds = [...new Set([...group.poolIds, ...row.poolIds])].slice(0, POOL_REJECTION_POOL_ID_LIMIT);
    group.details = boundTelemetryEntries([...(group.details ?? []), ...scoped.details]
      .sort(compareRejectionDetails), REJECTION_DETAIL_LIMIT, REJECTION_DETAIL_BYTES);
  }
  const scoped = [...groups.values()];
  const kept = new Set(boundTelemetryEntries(scoped.flatMap((row) => row.details ?? [])
    .sort(compareRejectionDetails), REJECTION_DETAIL_LIMIT, REJECTION_DETAIL_BYTES));
  for (const row of scoped) row.details = row.details?.filter((detail) => kept.has(detail));
  return scoped;
}

export function getDexPoolRejectionCandidates(rejections: readonly PoolProcessingRejection[]): PoolProcessingRejection[] {
  return rejections.filter((row) => row.scope !== "non-dex-project");
}

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

/** Health-only loss threshold, evaluated per affected coin against accepted liquidity. */
export const POOL_REJECTION_MATERIAL_SHARE = 0.1;
type RejectionCoverage = NonNullable<DexLiquidityCronMetadata["sourceCoverage"]["poolRejectionCoverage"]>;

export function assessPoolRejectionCoverage(
  rejections: readonly PoolProcessingRejection[],
  previous: ReadonlyMap<string, number> | null,
  current: ReadonlyMap<string, number>,
  carried?: RejectionCoverage,
  baselineBeforeSec = carried?.baselineBeforeSec ?? Math.floor(Date.now() / 1000),
): RejectionCoverage {
  rejections = getDexPoolRejectionCandidates(rejections);
  const affected = new Set(rejections.flatMap((row) => Object.keys(row.tvlUsdByStablecoin ?? {})));
  const anchors = new Map(Object.entries(carried?.baselineTvlUsdByCoin ?? {}));
  const nextAnchors: RejectionCoverage["baselineTvlUsdByCoin"] = {};
  const unattributed = rejections.some((row) => row.attributionUnavailable
    || row.tvlUsdByStablecoin == null);
  const coins: RejectionCoverage["coins"] = [];
  let baselineMissing = false;
  for (const id of new Set([...affected, ...anchors.keys()])) {
    const baselineTvlUsd = anchors.get(id) ?? previous?.get(id) ?? (previous?.size === 0 ? 0 : undefined);
    if (baselineTvlUsd == null) { baselineMissing = true; nextAnchors[id] = null; continue; }
    const currentTvlUsd = current.get(id) ?? 0;
    const lossUsd = Math.max(0, baselineTvlUsd - currentTvlUsd);
    const lossRatio = baselineTvlUsd > 0 ? lossUsd / baselineTvlUsd : 0;
    const material = lossUsd >= POOL_REJECTION_MATERIAL_TVL_USD && lossRatio >= POOL_REJECTION_MATERIAL_SHARE;
    // Keep the original loss anchor even after a degraded publication overwrites the table.
    if (affected.has(id) || lossUsd > 0) {
      nextAnchors[id] = Math.max(baselineTvlUsd, currentTvlUsd);
      coins.push({ stablecoinId: id, baselineTvlUsd, currentTvlUsd, lossUsd, lossRatio, material });
    }
  }
  // An unassignable loss cannot be cleared merely by a later absent row.
  const reason = carried?.reason === "pool-rejection-attribution-unavailable"
    || (unattributed && (hasMaterialPoolRejections(rejections)
      || rejections.some((row) => (row.unavailableTvlCount ?? 0) > 0)))
    ? "pool-rejection-attribution-unavailable"
    : baselineMissing || ((affected.size > 0 || anchors.size > 0) && previous == null)
      ? "pool-rejection-baseline-unavailable"
      : coins.some((coin) => coin.material) ? "material-pool-rejections" : null;
  const boundedCoins = boundTelemetryEntries(coins.sort((a, b) => b.lossRatio - a.lossRatio), 32, 8_192);
  return { reason, material: reason === null ? false : reason === "material-pool-rejections" ? true : null, baselineBeforeSec, baselineTvlUsdByCoin: nextAnchors,
    coins: boundedCoins, coinsOmitted: coins.length - boundedCoins.length };
}

export function buildPoolRejectionMetadata(
  rejections: readonly PoolProcessingRejection[],
  coverage?: RejectionCoverage,
): Record<string, unknown> {
  const rejectedPoolCount = rejections.reduce((sum, row) => sum + row.count, 0);
  const candidates = getDexPoolRejectionCandidates(rejections);
  const outOfScope = rejections.filter((row) => !candidates.includes(row));
  const poolRejections = boundTelemetryEntries(rejections.flatMap((row) => row.details ?? [])
    .sort(compareRejectionDetails), REJECTION_DETAIL_LIMIT, REJECTION_DETAIL_BYTES);
  return { poolRejections, poolRejectionMateriality: {
    thresholdTvlUsd: POOL_REJECTION_MATERIAL_TVL_USD, thresholdShare: POOL_REJECTION_MATERIAL_SHARE,
    rejectedPoolCount, rejectedPoolTvlUsd: rejections.reduce((sum, row) => sum + row.tvlUsd, 0),
    candidateRejectedPoolCount: candidates.reduce((sum, row) => sum + row.count, 0),
    candidateRejectedPoolTvlUsd: candidates.reduce((sum, row) => sum + row.tvlUsd, 0),
    outOfScopeRejectedPoolCount: outOfScope.reduce((sum, row) => sum + row.count, 0),
    outOfScopeRejectedPoolTvlUsd: outOfScope.reduce((sum, row) => sum + row.tvlUsd, 0),
    reasons: rejections.map(({ reason, scope, count, tvlUsd }) => ({ reason, scope, count, tvlUsd })),
    detailsOmitted: rejectedPoolCount - poolRejections.length,
    unavailableTvlCount: rejections.some((row) => row.unavailableTvlCount == null)
      ? null : rejections.reduce((sum, row) => sum + row.unavailableTvlCount!, 0),
    attributionUnavailable: candidates.some((row) => row.attributionUnavailable || row.tvlUsdByStablecoin == null),
    assessment: coverage == null ? "pending-publisher" : "accepted-coin-liquidity",
    material: coverage ? coverage.material : candidates.length === 0 ? false : null, reason: coverage?.reason ?? null,
  } };
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
  return typeof pool?.pool === "string" && pool.pool.length > 0
    ? pool.pool.slice(0, 160)
    : "unknown";
}

export function recordPoolRejection(
  rejections: Map<string, PoolProcessingRejection>,
  pool: ProcessPoolMetricsInput["pools"][number],
  error: ExpectedPoolInputError,
  lookups: PoolRejectionLookups,
): void {
  const project = typeof pool?.project === "string" && pool.project.trim().length > 0 ? pool.project : null;
  const key = JSON.stringify([error.reason, project]);
  const rejection = rejections.get(key) ?? {
    reason: error.reason,
    project,
    poolIds: [],
    count: 0,
    tvlUsd: 0,
    tvlUsdByStablecoin: {},
    unavailableTvlCount: 0,
    details: [],
  };
  rejection.count++;
  const tvlUsd = Number.isFinite(pool?.tvlUsd) && pool.tvlUsd >= 0 ? pool.tvlUsd : null;
  rejection.tvlUsd += tvlUsd ?? 0;
  if (tvlUsd === null) rejection.unavailableTvlCount!++;
  const chainKnown = typeof pool?.chain === "string" && pool.chain.trim().length > 0;
  const symbolKnown = typeof pool?.symbol === "string" && pool.symbol.trim().length > 0;
  const tokensKnown = pool?.underlyingTokens == null || (Array.isArray(pool.underlyingTokens)
    && pool.underlyingTokens.every((token) => typeof token === "string"));
  const match = chainKnown ? resolveLlamaPoolStablecoinMatches({
    chain: pool.chain, symbol: symbolKnown ? pool.symbol : "",
    underlyingTokens: Array.isArray(pool.underlyingTokens)
      ? pool.underlyingTokens.filter((token) => typeof token === "string") : null,
  }, lookups) : null;
  const stablecoinIds = [...(match?.matchedIds ?? [])].sort();
  // Syntactically present tokens (including the zero address) prove no attribution.
  const attributable = chainKnown && tokensKnown && stablecoinIds.length > 0;
  rejection.attributionUnavailable ||= !attributable;
  for (const id of stablecoinIds) {
    rejection.tvlUsdByStablecoin![id] = (rejection.tvlUsdByStablecoin![id] ?? 0) + (tvlUsd ?? 0);
  }
  rejection.details = boundTelemetryEntries([...(rejection.details ?? []), {
    reason: error.reason, source: "defillama-yields" as const,
    protocol: typeof pool?.project === "string" ? pool.project.slice(0, 100) : null,
    chain: typeof pool?.chain === "string" ? canonicalExitRouteChain(pool.chain).slice(0, 100) : null,
    poolId: typeof pool?.pool === "string" ? pool.pool.slice(0, 160) : null,
    tvlUsd, stablecoinIds,
  }].sort(compareRejectionDetails), REJECTION_DETAIL_LIMIT, REJECTION_DETAIL_BYTES);
  const poolId = rejectionPoolId(pool);
  if (
    rejection.poolIds.length < POOL_REJECTION_POOL_ID_LIMIT &&
    !rejection.poolIds.includes(poolId)
  ) {
    rejection.poolIds.push(poolId);
  }
  rejections.set(key, rejection);
}

/** Match DeFiLlama pools to tracked stablecoins and compute per-pool metrics. */
export function processPoolMetrics(
  input: ProcessPoolMetricsInput,
): ProcessPoolMetricsResult {
  const context = buildProcessingContext(input);
  const metrics = new Map<string, SourcePoolGraph>();
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
      recordPoolRejection(rejectionMap, pool, error, context);
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
      recordPoolRejection(rejectionMap, identity.pool, new ExpectedPoolInputError("conflicting-pool-observations"), context);
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
