/**
 * Monthly yield coverage audit.
 *
 * Identifies DeFiLlama stablecoin pools that are not covered by Pharos yield
 * tracking — either because the pool UUID is not in YIELD_POOL_MAP, or because
 * the protocol is not in LENDING_PROTOCOL_ALLOWLIST — and persists a summary
 * report to the cache for operator review.
 */

import type { CronResult } from "../lib/cron-logger";
import { getCache, setCache } from "../lib/db-cache";
import { loadDlStablecoinPools } from "./yield-sync/sources";
import {
  AUTO_LENDING_POOL_MAP,
  EXPLICIT_YIELD_SOURCE_POOL_MAP,
  LENDING_PROTOCOL_ALLOWLIST,
  YIELD_ADAPTER_MANIFEST,
  YIELD_POOL_MAP,
} from "./yield-config";
import type { DlPool } from "./yield-sync/types";
import { ACTIVE_YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";

/** Minimum TVL (USD) for a pool to be flagged as an unmatched high-TVL pool. */
const HIGH_TVL_THRESHOLD_USD = 5_000_000;

export interface CoverageGapPool {
  pool: string;
  project: string;
  symbol: string;
  chain: string;
  tvlUsd: number;
  apy: number;
}

export interface ProtocolRecommendation {
  project: string;
  poolCount: number;
  totalTvlUsd: number;
  recommendedTier: "high-confidence" | "review-needed";
  examplePools: string[];
}

export interface CoverageGaps {
  /** Pools above the TVL threshold that are not in the covered set. */
  unmatchedHighTvlPools: CoverageGapPool[];
  /** Protocols with stablecoin pools but not in the lending allowlist. */
  missingProtocols: CoverageGapPool[];
  /** Actionable protocol recommendations based on TVL and pool count. */
  protocolRecommendations: ProtocolRecommendation[];
}

/**
 * Pure function: given a list of DL pools and the exact DL pool IDs already
 * covered by Pharos, returns coverage gaps.
 *
 * @param dlPools       - Full list of DL stablecoin pools.
 * @param coveredPools  - Set of exact covered DL pool UUIDs.
 */
export function identifyCoverageGaps(
  dlPools: DlPool[],
  coveredPools: Set<string>,
  supportedProtocols: Set<string> = LENDING_PROTOCOL_ALLOWLIST,
): CoverageGaps {
  const unmatchedHighTvlPools: CoverageGapPool[] = [];
  const missingProtocols: CoverageGapPool[] = [];
  const seenMissingProtocols = new Set<string>();

  for (const pool of dlPools) {
    // Skip pools already covered
    if (coveredPools.has(pool.pool)) continue;

    const poolEntry: CoverageGapPool = {
      pool: pool.pool,
      project: pool.project,
      symbol: pool.symbol,
      chain: pool.chain,
      tvlUsd: pool.tvlUsd,
      apy: pool.apy,
    };

    // High-TVL gaps should focus on surfaces outside the already-supported
    // allowlisted protocol universe; otherwise the report is dominated by
    // pools the runtime already treats as covered opportunities.
    if (pool.tvlUsd >= HIGH_TVL_THRESHOLD_USD && !supportedProtocols.has(pool.project)) {
      unmatchedHighTvlPools.push(poolEntry);
    }

    // Flag protocols not in the allowlist (once per project, any TVL)
    if (
      !supportedProtocols.has(pool.project) &&
      !seenMissingProtocols.has(pool.project)
    ) {
      seenMissingProtocols.add(pool.project);
      missingProtocols.push(poolEntry);
    }
  }

  // Sort by TVL descending for easier triage
  unmatchedHighTvlPools.sort((a, b) => b.tvlUsd - a.tvlUsd);
  missingProtocols.sort((a, b) => b.tvlUsd - a.tvlUsd);

  // Build protocol recommendations from non-allowlisted pools
  const byProject = new Map<string, { pools: CoverageGapPool[]; tvl: number }>();
  for (const pool of dlPools) {
    if (LENDING_PROTOCOL_ALLOWLIST.has(pool.project)) continue;
    if (pool.exposure !== "single" || !pool.stablecoin) continue;
    const entry = byProject.get(pool.project) ?? { pools: [], tvl: 0 };
    entry.pools.push({ pool: pool.pool, project: pool.project, symbol: pool.symbol, chain: pool.chain, tvlUsd: pool.tvlUsd, apy: pool.apy });
    entry.tvl += pool.tvlUsd;
    byProject.set(pool.project, entry);
  }

  const protocolRecommendations: ProtocolRecommendation[] = [...byProject.entries()]
    .filter(([, v]) => v.tvl >= HIGH_TVL_THRESHOLD_USD)
    .map(([project, v]) => ({
      project,
      poolCount: v.pools.length,
      totalTvlUsd: v.tvl,
      recommendedTier: (v.tvl >= 10_000_000 && v.pools.length >= 3 ? "high-confidence" : "review-needed") as "high-confidence" | "review-needed",
      examplePools: v.pools.slice(0, 3).map((p) => p.pool),
    }))
    .sort((a, b) => b.totalTvlUsd - a.totalTvlUsd)
    .slice(0, 20);

  return { unmatchedHighTvlPools, missingProtocols, protocolRecommendations };
}

/**
 * Async cron function: loads DL pools from cache/API, loads the existing yield
 * coverage state from the DB, computes gaps, and persists a summary report.
 */
export async function runYieldCoverageAudit(
  db: D1Database,
  signal?: AbortSignal,
): Promise<CronResult> {
  // Load DL stablecoin pools (uses cache written by dex-liquidity sync)
  const { pools: dlPools, meta: poolMeta } = await loadDlStablecoinPools(db, signal);

  if (dlPools.length === 0) {
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "no-dl-pools",
        poolMeta,
      }),
    };
  }

  // Track the exact DL pool IDs already covered by static native mappings,
  // explicit auto-discovery overrides, and curated exact-pool overrides.
  const coveredPools = new Set([
    ...Object.values(YIELD_POOL_MAP),
    ...Object.values(AUTO_LENDING_POOL_MAP),
    ...Object.values(EXPLICIT_YIELD_SOURCE_POOL_MAP).flat().map((config) => config.poolId),
  ]);
  const gaps = identifyCoverageGaps(dlPools, coveredPools, LENDING_PROTOCOL_ALLOWLIST);
  const manifestById = new Map(YIELD_ADAPTER_MANIFEST.map((entry) => [entry.stablecoinId, entry]));
  const manifestMissingIds = ACTIVE_YIELD_BEARING_STABLECOINS
    .filter((coin) => !manifestById.has(coin.id))
    .map((coin) => coin.id);
  const intentionalGapIds = YIELD_ADAPTER_MANIFEST
    .filter((entry) => entry.status === "intentional-gap")
    .map((entry) => entry.stablecoinId);

  let publishedYieldIds = new Set<string>();
  const rankingsCache = await getCache(db, "yield-rankings");
  if (rankingsCache) {
    try {
      const parsed = JSON.parse(rankingsCache.value) as { rankings?: Array<{ id?: string }> };
      publishedYieldIds = new Set(
        (parsed.rankings ?? [])
          .map((ranking) => ranking.id)
          .filter((id): id is string => typeof id === "string"),
      );
    } catch {
      publishedYieldIds = new Set<string>();
    }
  }

  const yieldBearingMissingFromRankings = ACTIVE_YIELD_BEARING_STABLECOINS
    .filter((coin) => {
      const manifestEntry = manifestById.get(coin.id);
      return manifestEntry?.status !== "intentional-gap" && !publishedYieldIds.has(coin.id);
    })
    .map((coin) => coin.id);

  const reportedAt = Math.floor(Date.now() / 1000);
  const report = {
    reportedAt,
    totalDlPools: dlPools.length,
    coveredPoolCount: coveredPools.size,
    manifestYieldBearingCount: YIELD_ADAPTER_MANIFEST.length,
    manifestMissingIds,
    intentionalGapIds,
    yieldBearingMissingFromRankings,
    unmatchedHighTvlPoolCount: gaps.unmatchedHighTvlPools.length,
    missingProtocolCount: gaps.missingProtocols.length,
    unmatchedHighTvlPools: gaps.unmatchedHighTvlPools.slice(0, 50),
    missingProtocols: gaps.missingProtocols.slice(0, 50),
    manifest: YIELD_ADAPTER_MANIFEST.map((entry) => ({
      stablecoinId: entry.stablecoinId,
      status: entry.status,
      strategyKinds: entry.strategies.map((strategy) => strategy.kind),
      strategyLabels: entry.strategies.map((strategy) => strategy.label),
    })),
    poolMeta,
  };

  await setCache(db, "yield-coverage-audit", JSON.stringify(report));

  const itemCount =
    gaps.unmatchedHighTvlPools.length +
    gaps.missingProtocols.length +
    manifestMissingIds.length +
    yieldBearingMissingFromRankings.length;

  return {
    status: "ok",
    itemCount,
    metadata: JSON.stringify({
      totalDlPools: dlPools.length,
      coveredPoolCount: coveredPools.size,
      manifestYieldBearingCount: YIELD_ADAPTER_MANIFEST.length,
      manifestMissingCount: manifestMissingIds.length,
      intentionalGapCount: intentionalGapIds.length,
      yieldBearingMissingFromRankingsCount: yieldBearingMissingFromRankings.length,
      unmatchedHighTvlPoolCount: gaps.unmatchedHighTvlPools.length,
      missingProtocolCount: gaps.missingProtocols.length,
    }),
  };
}
