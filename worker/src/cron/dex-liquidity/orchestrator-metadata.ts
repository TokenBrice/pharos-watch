import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { DexLiquidityCronMetadataSchema } from "../../lib/schemas";
import type { HistoricalSnapshotWriteResult, PersistScoresResult } from "./persistence";
import type { DexPriceObs, FullScoreResult, GlobalAgg, LiquidityMetrics } from "./types";
import type { DirectCexOrderbookDepthSummary } from "../../lib/cex-orderbooks";

const DRIFT_WATCHLIST = ["usdc-circle", "usdt-tether", "dai-makerdao", "usds-sky", "usde-ethena"] as const;

type PreviousDexLiquiditySummary = {
  stagedPoolsMerged: number;
  stagedPoolsSkipped: number;
  priceObservationCoins: number;
  measuredBalanceCoveragePct: number;
  weakCoverageCoins: number;
};

type CoverageClasses = {
  primary: number;
  mixed: number;
  fallback: number;
  legacy: number;
  unobserved: number;
};

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function pctDelta(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return round4((current - previous) / previous);
}

function readPreviousDexLiquiditySummary(metadata: string | null): PreviousDexLiquiditySummary | null {
  if (!metadata) return null;
  try {
    const parsed = DexLiquidityCronMetadataSchema.parse(JSON.parse(metadata));
    return {
      stagedPoolsMerged: parsed.stagedPoolsMerged ?? 0,
      stagedPoolsSkipped: parsed.stagedPoolsSkipped ?? 0,
      priceObservationCoins: parsed.sourceCoverage.priceObservationCoins ?? 0,
      measuredBalanceCoveragePct: parsed.sourceCoverage.measuredBalanceCoveragePct ?? 0,
      weakCoverageCoins: parsed.sourceCoverage.weakCoverageCoins ?? 0,
    };
  } catch (err) {
    console.warn(
      "[dex-liquidity] Failed to parse previous cron metadata:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function emptyCoverageClasses(): CoverageClasses {
  return {
    primary: 0,
    mixed: 0,
    fallback: 0,
    legacy: 0,
    unobserved: 0,
  };
}

export interface DexLiquidityPostScoreAnalysis {
  currentCoverage: number;
  previousCoverage: number;
  previousCoverageBaselineAvailable: boolean;
  minExpectedCoverage: number;
  currentGlobalTvl: number;
  previousGlobalTvl: number | null;
  minExpectedGlobalTvl: number | null;
  currentTop10CoveredTvl: number;
  previousTop10CoveredTvl: number;
  nearCoverageGuard: boolean;
  nearValueGuard: boolean;
  hardValueGuard: boolean;
  nearMajorCoverageGuard: boolean;
  hardMajorCoverageGuard: boolean;
  sourceCoverage: {
    dlYieldsAvailable: boolean;
    dlProtocolsAvailable: boolean;
    currentCoverage: number;
    previousCoverage: number;
    previousCoverageBaselineAvailable: boolean;
    minExpectedCoverage: number;
    nearCoverageGuard: boolean;
    currentGlobalTvl: number;
    previousGlobalTvl: number | null;
    minExpectedGlobalTvl: number | null;
    nearValueGuard: boolean;
    currentTop10CoveredTvl: number;
    previousTop10CoveredTvl: number;
    nearMajorCoverageGuard: boolean;
    currentCoverageClasses: CoverageClasses;
    previousCoverageClasses: CoverageClasses;
    priceObservationCoins: number;
    weakCoverageCoins: number;
    coverageRecoveredCoins: number;
    dsFallbackCoins: number;
    cgTickerFallbackCoins: number;
    directCexOrderbookDepth: DirectCexOrderbookDepthSummary | null;
    measuredBalanceCoveragePct: number;
    syntheticOnlyCoins: number;
    coinsWithoutMeasuredBalances: number;
    coinsGtOnly: number;
    coinsCrawlerOnly: number;
    coinsPriceOnlyNoMeasuredLiquidity: number;
    retainedPoolCountBySourceFamily: Record<string, number>;
    measuredBalanceTvlBySourceFamily: Record<string, number>;
    priceObservationCoinsBySourceFamily: Record<string, number>;
    sourceDegradedFamilies: string[];
    protocolCapReductions: {
      cappedPoolCount?: number;
      cappedProtocols?: number;
      reducedTvlUsd?: number;
      topProtocols: Array<{
        protocol: string;
        preCapTvlUsd: number;
        postCapTvlUsd: number;
        reducedTvlUsd: number;
      }>;
      topStablecoins: Array<{
        stablecoinId: string;
        reducedTvlUsd: number;
      }>;
    };
    qualityDriftFlags: string[];
    qualityDriftSeverity: "none" | "medium" | "high";
    qualityDriftMetrics: {
      previousPriceObservationCoins: number | null;
      currentPriceObservationCoins: number;
      priceObservationPctDelta: number | null;
      previousMeasuredBalanceCoveragePct: number | null;
      currentMeasuredBalanceCoveragePct: number;
      measuredBalanceCoverageDelta: number | null;
      previousStagedPoolsMerged: number | null;
      currentStagedPoolsMerged: number;
      stagedPoolsMergedPctDelta: number | null;
      previousStagedPoolsSkipped: number | null;
      currentStagedPoolsSkipped: number;
      stagedPoolsSkippedPctDelta: number | null;
      previousWeakCoverageCoins: number | null;
      currentWeakCoverageCoins: number;
      weakCoverageDelta: number | null;
    };
    topAssetCoverageDeltas: Array<{
      stablecoinId: string;
      previousPoolCount: number;
      currentPoolCount: number;
      poolCountPctDelta: number | null;
      previousCoverageConfidence: number | null;
      currentCoverageConfidence: number | null;
      previousMeasuredShare: number | null;
      currentMeasuredShare: number | null;
    }>;
  };
}

export function isDexLiquidityDegraded(params: {
  criticalSourceFailures: string[];
  analysis: DexLiquidityPostScoreAnalysis;
  persistence: PersistScoresResult;
  historicalSnapshot: HistoricalSnapshotWriteResult;
}): boolean {
  return (
    params.criticalSourceFailures.length > 0 ||
    !params.analysis.previousCoverageBaselineAvailable ||
    params.analysis.nearCoverageGuard ||
    params.analysis.nearValueGuard ||
    params.analysis.nearMajorCoverageGuard ||
    params.persistence.orphanCleanupFailed ||
    params.historicalSnapshot.writeFailed
  );
}

export function buildDexLiquidityCronMetadata(params: {
  rowsRead: number;
  rowsWritten: number;
  stagedPoolsMerged: number;
  stagedPoolsSkipped: number;
  stagedPoolsSkippedByExactIdentity: number;
  stagedPoolsSkippedByUniqueDerivedIdentity: number;
  stagedPoolsSkippedByOptionalWildcardIdentity: number;
  stagedPoolsSkippedByAuthoritativeProtocol: number;
  sourceCoverage: DexLiquidityPostScoreAnalysis["sourceCoverage"];
  challengerPublication: {
    publishedStablecoins: number;
    skippedStablecoins: number;
    missingTables: boolean;
  };
  failedSources: string[];
  fallbackSignals: string[];
  persistence: PersistScoresResult;
  historicalSnapshot: HistoricalSnapshotWriteResult;
}): Record<string, unknown> {
  return {
    rowsRead: params.rowsRead,
    rowsWritten: params.rowsWritten,
    rowsDropped: 0,
    stagedPoolsMerged: params.stagedPoolsMerged,
    stagedPoolsSkipped: params.stagedPoolsSkipped,
    stagedPoolsSkippedByExactIdentity: params.stagedPoolsSkippedByExactIdentity,
    stagedPoolsSkippedByUniqueDerivedIdentity: params.stagedPoolsSkippedByUniqueDerivedIdentity,
    stagedPoolsSkippedByOptionalWildcardIdentity: params.stagedPoolsSkippedByOptionalWildcardIdentity,
    stagedPoolsSkippedByAuthoritativeProtocol: params.stagedPoolsSkippedByAuthoritativeProtocol,
    sourceCoverage: {
      ...params.sourceCoverage,
      challengerSnapshotsPublished: params.challengerPublication.publishedStablecoins,
      challengerSnapshotsSkipped: params.challengerPublication.skippedStablecoins,
      challengerSnapshotTablesMissing: params.challengerPublication.missingTables,
    },
    failedSources: [...new Set(params.failedSources)],
    fallbackMode: [...new Set(params.fallbackSignals)],
    persistence: {
      placeholderRowsWritten: params.persistence.placeholderCount,
      orphanRowsDeleted: params.persistence.orphanRowsDeleted,
      orphanCleanupFailed: params.persistence.orphanCleanupFailed,
      historicalSnapshotRowsWritten: params.historicalSnapshot.snapshotRowsWritten,
      historicalSnapshotSkipped: params.historicalSnapshot.skipped,
      historicalSnapshotWriteFailed: params.historicalSnapshot.writeFailed,
    },
    validationFailures: 0,
  };
}

export async function analyzeDexLiquidityPostScoring(params: {
  db: D1Database;
  scoreResults: Map<string, FullScoreResult>;
  globalAgg: GlobalAgg;
  retainedPoolsByStablecoin: Map<string, LiquidityMetrics["topPools"]>;
  priceObservations: Map<string, DexPriceObs[]>;
  protocolTvlCaps: Map<string, number>;
  diagnostics: {
    protocolCapReductions: {
      cappedPoolCount?: number;
      cappedProtocols?: number;
      reducedTvlUsd?: number;
    };
  };
  stagedMergedCount: number;
  stagedSkippedCount: number;
  weakCoverageCoinsBeforeFallback: number;
  coverageRecoveredCoins: number;
  dsFallbackCoins: number;
  cgTickerFallbackCoins: number;
  directCexOrderbookDepth: DirectCexOrderbookDepthSummary | null;
  dlYieldsAvailable: boolean;
  dlProtocolsAvailable: boolean;
  criticalSourceFailures: string[];
}): Promise<DexLiquidityPostScoreAnalysis> {
  const currentCoverage = params.scoreResults.size;
  const [
    previousCoverageRow,
    previousGlobalRow,
    previousCoverageClassRows,
    previousTopCoverageRows,
    previousCronRow,
    previousWatchlistRows,
  ] = await Promise.all([
    params.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM dex_liquidity WHERE stablecoin_id != '__global__' AND liquidity_score IS NOT NULL",
      )
      .first<{ cnt: number }>()
      .catch((e) => {
        console.warn("[dex-liquidity] Failed to read previous coverage count:", e instanceof Error ? e.message : e);
        return null;
      }),
    params.db
      .prepare("SELECT total_tvl_usd FROM dex_liquidity WHERE stablecoin_id = '__global__'")
      .first<{ total_tvl_usd: number | null }>()
      .catch((e) => {
        console.warn("[dex-liquidity] Failed to read previous global TVL:", e);
        return null;
      }),
    params.db
      .prepare(
        `SELECT coverage_class, COUNT(*) as cnt
         FROM dex_liquidity
         WHERE stablecoin_id != '__global__'
         GROUP BY coverage_class`,
      )
      .all<{ coverage_class: string | null; cnt: number }>()
      .catch((e) => {
        console.warn("[dex-liquidity] Failed to read previous coverage classes:", e);
        return { results: [] as Array<{ coverage_class: string | null; cnt: number }> };
      }),
    params.db
      .prepare(
        `SELECT stablecoin_id, total_tvl_usd
         FROM dex_liquidity
         WHERE stablecoin_id != '__global__' AND liquidity_score IS NOT NULL
         ORDER BY total_tvl_usd DESC
         LIMIT 10`,
      )
      .all<{ stablecoin_id: string; total_tvl_usd: number }>()
      .catch((e) => {
        console.warn("[dex-liquidity] Failed to read previous top coverage:", e);
        return { results: [] as Array<{ stablecoin_id: string; total_tvl_usd: number }> };
      }),
    params.db
      .prepare(
        `SELECT metadata
         FROM cron_runs
         WHERE job = 'sync-dex-liquidity'
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .first<{ metadata: string | null }>()
      .catch((e) => {
        console.warn("[dex-liquidity] Failed to read previous cron metadata:", e);
        return null;
      }),
    params.db
      .prepare(
        `SELECT stablecoin_id, pool_count, coverage_confidence, total_tvl_usd, balance_measured_tvl_usd
         FROM dex_liquidity
         WHERE stablecoin_id IN (${DRIFT_WATCHLIST.map(() => "?").join(", ")})`,
      )
      .bind(...DRIFT_WATCHLIST)
      .all<{
        stablecoin_id: string;
        pool_count: number;
        coverage_confidence: number | null;
        total_tvl_usd: number;
        balance_measured_tvl_usd: number;
      }>()
      .catch((e) => {
        console.warn("[dex-liquidity] Failed to read previous watchlist rows:", e);
        return {
          results: [] as Array<{
            stablecoin_id: string;
            pool_count: number;
            coverage_confidence: number | null;
            total_tvl_usd: number;
            balance_measured_tvl_usd: number;
          }>,
        };
      }),
  ]);

  const previousCoverageBaselineAvailable = previousCoverageRow != null;
  const previousCoverage = previousCoverageRow?.cnt ?? 0;
  const minExpectedCoverage = previousCoverageBaselineAvailable ? Math.max(1, Math.floor(previousCoverage * 0.6)) : 0;
  const nearCoverageGuard =
    previousCoverageBaselineAvailable && previousCoverage >= 10 && currentCoverage < Math.floor(previousCoverage * 0.8);

  const currentGlobalTvl = params.globalAgg.totalTvl;
  const previousGlobalTvl = previousGlobalRow?.total_tvl_usd ?? null;
  const minExpectedGlobalTvl = previousGlobalTvl != null ? previousGlobalTvl * 0.6 : null;
  const nearValueGuard =
    previousGlobalTvl != null && previousGlobalTvl >= 10_000_000 && currentGlobalTvl < previousGlobalTvl * 0.85;
  const hardValueGuard =
    previousGlobalTvl != null && previousGlobalTvl >= 10_000_000 && currentGlobalTvl < previousGlobalTvl * 0.6;

  const previousTop10CoveredTvl = (previousTopCoverageRows.results ?? []).reduce(
    (sum, row) => sum + row.total_tvl_usd,
    0,
  );
  const currentTop10CoveredTvl = (previousTopCoverageRows.results ?? []).reduce(
    (sum, row) => sum + (params.scoreResults.get(row.stablecoin_id)?.tvl ?? 0),
    0,
  );
  const nearMajorCoverageGuard =
    previousTop10CoveredTvl >= 5_000_000 && currentTop10CoveredTvl < previousTop10CoveredTvl * 0.85;
  const hardMajorCoverageGuard =
    previousTop10CoveredTvl >= 5_000_000 && currentTop10CoveredTvl < previousTop10CoveredTvl * 0.6;

  const currentCoverageClasses: CoverageClasses = {
    ...emptyCoverageClasses(),
    unobserved: ACTIVE_STABLECOINS.length - currentCoverage,
  };
  for (const row of params.scoreResults.values()) {
    currentCoverageClasses[row.coverageClass] += 1;
  }

  const measuredBalanceCoveragePct =
    params.scoreResults.size > 0
      ? Math.round(
          (Array.from(params.scoreResults.values()).reduce((sum, row) => {
            if (row.tvl <= 0) return sum;
            return sum + Math.max(0, Math.min(1, (row.balanceMeasuredTvlUsd ?? 0) / row.tvl));
          }, 0) /
            params.scoreResults.size) *
            10000,
        ) / 10000
      : 0;

  const syntheticOnlyCoins = Array.from(params.scoreResults.values()).filter((row) => {
    const totalTvl = Object.values(row.sourceMix ?? {}).reduce((sum, entry) => sum + (entry?.tvlUsd ?? 0), 0);
    const primaryTvl = (row.sourceMix?.dl?.tvlUsd ?? 0) + (row.sourceMix?.direct_api?.tvlUsd ?? 0);
    return totalTvl > 0 && primaryTvl <= 0 && row.coverageClass === "fallback";
  }).length;

  const previousCoverageClasses = emptyCoverageClasses();
  for (const row of previousCoverageClassRows.results ?? []) {
    const key = row.coverage_class;
    if (key && key in previousCoverageClasses) {
      previousCoverageClasses[key as keyof CoverageClasses] = row.cnt;
    }
  }

  const previousSummary = readPreviousDexLiquiditySummary(previousCronRow?.metadata ?? null);
  const watchlistPreviousById = new Map((previousWatchlistRows.results ?? []).map((row) => [row.stablecoin_id, row]));
  const currentWatchlistDeltas = DRIFT_WATCHLIST.map((stablecoinId) => {
    const previous = watchlistPreviousById.get(stablecoinId);
    const currentScore = params.scoreResults.get(stablecoinId);
    const currentPools = params.retainedPoolsByStablecoin.get(stablecoinId)?.length ?? 0;
    const currentMeasuredShare =
      currentScore && currentScore.tvl > 0
        ? Math.max(0, Math.min(1, currentScore.balanceMeasuredTvlUsd / currentScore.tvl))
        : 0;
    const previousMeasuredShare =
      previous && previous.total_tvl_usd > 0
        ? Math.max(0, Math.min(1, (previous.balance_measured_tvl_usd ?? 0) / previous.total_tvl_usd))
        : 0;
    return {
      stablecoinId,
      previousPoolCount: previous?.pool_count ?? 0,
      currentPoolCount: currentPools,
      poolCountPctDelta: pctDelta(currentPools, previous?.pool_count ?? 0),
      previousCoverageConfidence: previous?.coverage_confidence ?? null,
      currentCoverageConfidence: currentScore?.coverageConfidence ?? null,
      previousMeasuredShare: previous ? round4(previousMeasuredShare) : null,
      currentMeasuredShare: currentScore ? round4(currentMeasuredShare) : null,
    };
  });

  const priceObservationPctDelta = previousSummary
    ? pctDelta(params.priceObservations.size, previousSummary.priceObservationCoins)
    : null;
  const stagedPoolsMergedPctDelta = previousSummary
    ? pctDelta(params.stagedMergedCount, previousSummary.stagedPoolsMerged)
    : null;
  const stagedPoolsSkippedPctDelta = previousSummary
    ? pctDelta(params.stagedSkippedCount, previousSummary.stagedPoolsSkipped)
    : null;
  const measuredBalanceCoverageDelta = previousSummary
    ? round4(measuredBalanceCoveragePct - previousSummary.measuredBalanceCoveragePct)
    : null;
  const weakCoverageDelta = previousSummary
    ? params.weakCoverageCoinsBeforeFallback - previousSummary.weakCoverageCoins
    : null;

  const qualityDriftFlags: string[] = [];
  if (priceObservationPctDelta != null && priceObservationPctDelta <= -0.1) {
    qualityDriftFlags.push("price-observation-drop");
  }
  if (stagedPoolsMergedPctDelta != null && stagedPoolsMergedPctDelta <= -0.1) {
    qualityDriftFlags.push("staged-merge-drop");
  }
  if (measuredBalanceCoverageDelta != null && measuredBalanceCoverageDelta <= -0.08) {
    qualityDriftFlags.push("measured-balance-drop");
  }
  if (weakCoverageDelta != null && weakCoverageDelta >= 5) {
    qualityDriftFlags.push("weak-coverage-rise");
  }
  for (const delta of currentWatchlistDeltas) {
    if (delta.poolCountPctDelta != null && delta.poolCountPctDelta <= -0.2) {
      qualityDriftFlags.push(`watchlist-pool-drop:${delta.stablecoinId}`);
    }
  }
  const qualityDriftSeverity =
    qualityDriftFlags.length === 0
      ? "none"
      : qualityDriftFlags.some((flag) => flag === "measured-balance-drop" || flag.startsWith("watchlist-pool-drop:"))
        ? "high"
        : "medium";

  const retainedPoolCountBySourceFamily: Record<string, number> = {};
  const measuredBalanceTvlBySourceFamily: Record<string, number> = {};
  const priceObservationCoinsBySourceFamily: Record<string, number> = {};
  const preCapProtocolTvl: Record<string, number> = {};
  const preCapStablecoinProtocolTvl = new Map<string, Record<string, number>>();
  let coinsWithoutMeasuredBalances = 0;
  let coinsCrawlerOnly = 0;
  let coinsGtOnly = 0;
  let coinsPriceOnlyNoMeasuredLiquidity = 0;

  for (const [stablecoinId, pools] of params.retainedPoolsByStablecoin) {
    const sourceFamilies = new Set<string>();
    let hasPrimaryLiquidity = false;
    let hasGeckoTerminalLiquidity = false;
    let hasMeasuredBalanceLiquidity = false;
    const stablecoinProtocolTvl: Record<string, number> = {};

    for (const pool of pools) {
      retainedPoolCountBySourceFamily[pool.source] = (retainedPoolCountBySourceFamily[pool.source] ?? 0) + 1;
      sourceFamilies.add(pool.source);
      if (pool.source === "dl" || pool.source === "direct_api") hasPrimaryLiquidity = true;
      if (pool.source === "gecko_terminal") hasGeckoTerminalLiquidity = true;
      if (pool.extra?.measurement?.balanceMeasured) {
        hasMeasuredBalanceLiquidity = true;
        measuredBalanceTvlBySourceFamily[pool.source] = round4(
          (measuredBalanceTvlBySourceFamily[pool.source] ?? 0) + pool.tvlUsd,
        );
      }

      const protocol = pool.project;
      preCapProtocolTvl[protocol] = (preCapProtocolTvl[protocol] ?? 0) + pool.tvlUsd;
      stablecoinProtocolTvl[protocol] = (stablecoinProtocolTvl[protocol] ?? 0) + pool.tvlUsd;
    }

    preCapStablecoinProtocolTvl.set(stablecoinId, stablecoinProtocolTvl);
    if (pools.length > 0 && !hasMeasuredBalanceLiquidity) coinsWithoutMeasuredBalances++;
    if (pools.length > 0 && !hasPrimaryLiquidity) coinsCrawlerOnly++;
    if (pools.length > 0 && sourceFamilies.size === 1 && hasGeckoTerminalLiquidity) coinsGtOnly++;
    if (
      pools.length > 0 &&
      !hasMeasuredBalanceLiquidity &&
      (params.priceObservations.get(stablecoinId)?.length ?? 0) > 0
    ) {
      coinsPriceOnlyNoMeasuredLiquidity++;
    }
  }

  for (const [_stablecoinId, observations] of params.priceObservations) {
    const families = new Set(
      observations
        .map((obs) => (typeof obs.sourceFamily === "string" && obs.sourceFamily.length > 0 ? obs.sourceFamily : null))
        .filter((family): family is string => family != null),
    );
    for (const family of families) {
      priceObservationCoinsBySourceFamily[family] = (priceObservationCoinsBySourceFamily[family] ?? 0) + 1;
    }
  }

  const cappedProtocolBreakdown = Object.entries(preCapProtocolTvl)
    .map(([protocol, preCapTvl]) => {
      const cap = params.protocolTvlCaps.get(protocol);
      if (cap == null || cap <= 0 || preCapTvl <= cap) return null;
      return {
        protocol,
        preCapTvlUsd: Math.round(preCapTvl),
        postCapTvlUsd: Math.round(cap),
        reducedTvlUsd: Math.round(preCapTvl - cap),
      };
    })
    .filter(
      (item): item is { protocol: string; preCapTvlUsd: number; postCapTvlUsd: number; reducedTvlUsd: number } =>
        item != null,
    )
    .sort((a, b) => b.reducedTvlUsd - a.reducedTvlUsd)
    .slice(0, 6);

  const cappedStablecoinBreakdown = Array.from(preCapStablecoinProtocolTvl.entries())
    .map(([stablecoinId, protocolTvl]) => {
      let reducedTvlUsd = 0;
      for (const [protocol, stablecoinTvl] of Object.entries(protocolTvl)) {
        const cap = params.protocolTvlCaps.get(protocol);
        const protocolPreCapTvl = preCapProtocolTvl[protocol] ?? 0;
        if (cap == null || cap <= 0 || protocolPreCapTvl <= cap || stablecoinTvl <= 0) continue;
        reducedTvlUsd += ((protocolPreCapTvl - cap) * stablecoinTvl) / protocolPreCapTvl;
      }
      return { stablecoinId, reducedTvlUsd: Math.round(reducedTvlUsd) };
    })
    .filter((item) => item.reducedTvlUsd > 0)
    .sort((a, b) => b.reducedTvlUsd - a.reducedTvlUsd)
    .slice(0, 6);

  return {
    currentCoverage,
    previousCoverage,
    previousCoverageBaselineAvailable,
    minExpectedCoverage,
    currentGlobalTvl,
    previousGlobalTvl,
    minExpectedGlobalTvl,
    currentTop10CoveredTvl,
    previousTop10CoveredTvl,
    nearCoverageGuard,
    nearValueGuard,
    hardValueGuard,
    nearMajorCoverageGuard,
    hardMajorCoverageGuard,
    sourceCoverage: {
      dlYieldsAvailable: params.dlYieldsAvailable,
      dlProtocolsAvailable: params.dlProtocolsAvailable,
      currentCoverage,
      previousCoverage,
      previousCoverageBaselineAvailable,
      minExpectedCoverage,
      nearCoverageGuard,
      currentGlobalTvl,
      previousGlobalTvl,
      minExpectedGlobalTvl,
      nearValueGuard,
      currentTop10CoveredTvl,
      previousTop10CoveredTvl,
      nearMajorCoverageGuard,
      currentCoverageClasses,
      previousCoverageClasses,
      priceObservationCoins: params.priceObservations.size,
      weakCoverageCoins: params.weakCoverageCoinsBeforeFallback,
      coverageRecoveredCoins: params.coverageRecoveredCoins,
      dsFallbackCoins: params.dsFallbackCoins,
      cgTickerFallbackCoins: params.cgTickerFallbackCoins,
      directCexOrderbookDepth: params.directCexOrderbookDepth,
      measuredBalanceCoveragePct,
      syntheticOnlyCoins,
      coinsWithoutMeasuredBalances,
      coinsGtOnly,
      coinsCrawlerOnly,
      coinsPriceOnlyNoMeasuredLiquidity,
      retainedPoolCountBySourceFamily,
      measuredBalanceTvlBySourceFamily,
      priceObservationCoinsBySourceFamily,
      sourceDegradedFamilies: [...new Set(params.criticalSourceFailures)],
      protocolCapReductions: {
        ...params.diagnostics.protocolCapReductions,
        topProtocols: cappedProtocolBreakdown,
        topStablecoins: cappedStablecoinBreakdown,
      },
      qualityDriftFlags,
      qualityDriftSeverity,
      qualityDriftMetrics: {
        previousPriceObservationCoins: previousSummary?.priceObservationCoins ?? null,
        currentPriceObservationCoins: params.priceObservations.size,
        priceObservationPctDelta,
        previousMeasuredBalanceCoveragePct: previousSummary?.measuredBalanceCoveragePct ?? null,
        currentMeasuredBalanceCoveragePct: measuredBalanceCoveragePct,
        measuredBalanceCoverageDelta,
        previousStagedPoolsMerged: previousSummary?.stagedPoolsMerged ?? null,
        currentStagedPoolsMerged: params.stagedMergedCount,
        stagedPoolsMergedPctDelta,
        previousStagedPoolsSkipped: previousSummary?.stagedPoolsSkipped ?? null,
        currentStagedPoolsSkipped: params.stagedSkippedCount,
        stagedPoolsSkippedPctDelta,
        previousWeakCoverageCoins: previousSummary?.weakCoverageCoins ?? null,
        currentWeakCoverageCoins: params.weakCoverageCoinsBeforeFallback,
        weakCoverageDelta,
      },
      topAssetCoverageDeltas: currentWatchlistDeltas,
    },
  };
}
