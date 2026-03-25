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
import { YIELD_POOL_MAP, LENDING_PROTOCOL_ALLOWLIST } from "./yield-config";
import type { DlPool } from "./yield-sync/types";

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

export interface CoverageGaps {
  /** Pools above the TVL threshold that are not in the covered set. */
  unmatchedHighTvlPools: CoverageGapPool[];
  /** Protocols with stablecoin pools but not in the lending allowlist. */
  missingProtocols: CoverageGapPool[];
}

/**
 * Pure function: given a list of DL pools, the set of covered pool UUIDs, and
 * the set of tracked stablecoin symbols, returns coverage gaps.
 *
 * @param dlPools       - Full list of DL stablecoin pools.
 * @param coveredPools  - Set of pool UUIDs already matched by YIELD_POOL_MAP.
 * @param trackedSymbols - Set of stablecoin symbols tracked by Pharos.
 */
export function identifyCoverageGaps(
  dlPools: DlPool[],
  coveredPools: Set<string>,
  _trackedSymbols: Set<string>,
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

    // Flag high-TVL pools not covered
    if (pool.tvlUsd >= HIGH_TVL_THRESHOLD_USD) {
      unmatchedHighTvlPools.push(poolEntry);
    }

    // Flag protocols not in the allowlist (once per project, any TVL)
    if (
      !LENDING_PROTOCOL_ALLOWLIST.has(pool.project) &&
      !seenMissingProtocols.has(pool.project)
    ) {
      seenMissingProtocols.add(pool.project);
      missingProtocols.push(poolEntry);
    }
  }

  // Sort by TVL descending for easier triage
  unmatchedHighTvlPools.sort((a, b) => b.tvlUsd - a.tvlUsd);
  missingProtocols.sort((a, b) => b.tvlUsd - a.tvlUsd);

  return { unmatchedHighTvlPools, missingProtocols };
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

  // Build the set of covered pool UUIDs from YIELD_POOL_MAP values
  const coveredPools = new Set(Object.values(YIELD_POOL_MAP));

  // Load tracked stablecoin symbols from the DB yield_data table (if available)
  const trackedSymbols = new Set<string>();
  try {
    const rows = await db
      .prepare("SELECT DISTINCT symbol FROM yield_data WHERE symbol IS NOT NULL")
      .all<{ symbol: string }>();
    for (const row of rows.results ?? []) {
      if (row.symbol) trackedSymbols.add(row.symbol.toUpperCase());
    }
  } catch {
    // Table may not exist or be empty — continue with empty set
  }

  // Also load symbols from cache/stablecoins if possible
  const cachedStablecoins = await getCache(db, "stablecoins");
  if (cachedStablecoins) {
    try {
      const parsed = JSON.parse(cachedStablecoins.value) as Array<{ symbol?: string }>;
      if (Array.isArray(parsed)) {
        for (const coin of parsed) {
          if (coin.symbol) trackedSymbols.add(coin.symbol.toUpperCase());
        }
      }
    } catch {
      // Ignore parse failures
    }
  }

  const gaps = identifyCoverageGaps(dlPools, coveredPools, trackedSymbols);

  const reportedAt = Math.floor(Date.now() / 1000);
  const report = {
    reportedAt,
    totalDlPools: dlPools.length,
    coveredPoolCount: coveredPools.size,
    unmatchedHighTvlPoolCount: gaps.unmatchedHighTvlPools.length,
    missingProtocolCount: gaps.missingProtocols.length,
    unmatchedHighTvlPools: gaps.unmatchedHighTvlPools.slice(0, 50),
    missingProtocols: gaps.missingProtocols.slice(0, 50),
    poolMeta,
  };

  await setCache(db, "yield-coverage-audit", JSON.stringify(report));

  const itemCount = gaps.unmatchedHighTvlPools.length + gaps.missingProtocols.length;

  return {
    status: "ok",
    itemCount,
    metadata: JSON.stringify({
      totalDlPools: dlPools.length,
      coveredPoolCount: coveredPools.size,
      unmatchedHighTvlPoolCount: gaps.unmatchedHighTvlPools.length,
      missingProtocolCount: gaps.missingProtocols.length,
    }),
  };
}
