import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import { DexLiquidityCronMetadataSchema } from "../../lib/schemas";
import type { DexPriceObs, FullScoreResult, GlobalAgg, LiquidityMetrics } from "./types";
import type { DirectCexOrderbookDepthSummary } from "../../lib/cex-orderbooks";
import {
  DRIFT_WATCHLIST,
  computeDexLiquidityDriftSummary,
  readPreviousDexLiquiditySummary,
  round4,
  type DexLiquidityDriftSummary,
} from "./orchestrator-drift";

type DexLiquidityCronMetadata = ReturnType<typeof DexLiquidityCronMetadataSchema.parse>;

type ParsedPreviousCronRow = {
  startedAt: number | null;
  status: string | null;
  metadata: DexLiquidityCronMetadata;
};

type ValueBaselineSource = "dex_liquidity_global" | "cron_metadata_source_complete" | "none";

type ValueBaselineSelection = {
  previousGlobalTvl: number | null;
  minExpectedGlobalTvl: number | null;
  valueBaselineSource: ValueBaselineSource;
  valueBaselineGlobalTvl: number | null;
  ignoredPersistedGlobalTvl: number | null;
};

type CoverageClasses = {
  primary: number;
  mixed: number;
  fallback: number;
  legacy: number;
  unobserved: number;
};

function parseDexLiquidityCronMetadata(metadata: string | null): DexLiquidityCronMetadata | null {
  if (!metadata) return null;
  try {
    return DexLiquidityCronMetadataSchema.parse(JSON.parse(metadata));
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

function isFinitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasCriticalDlSourceFailure(metadata: DexLiquidityCronMetadata): boolean {
  const failed = new Set([...(metadata.failedSources ?? []), ...(metadata.sourceCoverage.sourceDegradedFamilies ?? [])]);
  return failed.has("defillama-yields") || failed.has("defillama-protocols");
}

function isSourceCompleteMetadata(metadata: DexLiquidityCronMetadata): boolean {
  return (
    metadata.sourceCoverage.dlYieldsAvailable === true &&
    metadata.sourceCoverage.dlProtocolsAvailable === true &&
    !hasCriticalDlSourceFailure(metadata) &&
    isFinitePositive(metadata.sourceCoverage.currentGlobalTvl)
  );
}

function isSourceIncompleteMetadata(metadata: DexLiquidityCronMetadata): boolean {
  return (
    metadata.sourceCoverage.dlYieldsAvailable === false ||
    metadata.sourceCoverage.dlProtocolsAvailable === false ||
    hasCriticalDlSourceFailure(metadata)
  );
}

function parsePreviousCronRows(
  rows: Array<{ started_at: number | null; status: string | null; metadata: string | null }>,
): ParsedPreviousCronRow[] {
  const parsedRows: ParsedPreviousCronRow[] = [];
  for (const row of rows) {
    const parsed = parseDexLiquidityCronMetadata(row.metadata);
    if (!parsed) continue;
    parsedRows.push({
      startedAt: typeof row.started_at === "number" && Number.isFinite(row.started_at) ? row.started_at : null,
      status: row.status,
      metadata: parsed,
    });
  }
  return parsedRows;
}

function isApproxSameTvl(left: number | null, right: number | null): boolean {
  if (!isFinitePositive(left) || !isFinitePositive(right)) return false;
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) / scale <= 0.0001;
}

function findPersistedCronMetadata(
  rows: ParsedPreviousCronRow[],
  persistedUpdatedAt: number | null,
  persistedGlobalTvl: number | null,
): ParsedPreviousCronRow | null {
  for (const row of rows) {
    const rowGlobalTvl = row.metadata.sourceCoverage.currentGlobalTvl ?? null;
    const timestampMatches =
      persistedUpdatedAt != null && row.startedAt != null && Math.abs(row.startedAt - persistedUpdatedAt) <= 5;
    if (timestampMatches || isApproxSameTvl(rowGlobalTvl, persistedGlobalTvl)) {
      return row;
    }
  }
  return null;
}

function selectValueBaseline(params: {
  persistedGlobalTvl: number | null;
  persistedUpdatedAt: number | null;
  previousCronRows: ParsedPreviousCronRow[];
}): ValueBaselineSelection {
  const persistedRun = findPersistedCronMetadata(
    params.previousCronRows,
    params.persistedUpdatedAt,
    params.persistedGlobalTvl,
  );
  const persistedSourceIncomplete = persistedRun != null && isSourceIncompleteMetadata(persistedRun.metadata);
  const sourceCompleteRun = params.previousCronRows.find(
    (row) => (row.status === "ok" || row.status === "degraded") && isSourceCompleteMetadata(row.metadata),
  );

  if (persistedSourceIncomplete) {
    const value = sourceCompleteRun?.metadata.sourceCoverage.currentGlobalTvl ?? null;
    return {
      previousGlobalTvl: isFinitePositive(value) ? value : null,
      minExpectedGlobalTvl: isFinitePositive(value) ? value * 0.6 : null,
      valueBaselineSource: isFinitePositive(value) ? "cron_metadata_source_complete" : "none",
      valueBaselineGlobalTvl: isFinitePositive(value) ? value : null,
      ignoredPersistedGlobalTvl: params.persistedGlobalTvl,
    };
  }

  if (params.persistedGlobalTvl != null) {
    return {
      previousGlobalTvl: params.persistedGlobalTvl,
      minExpectedGlobalTvl: params.persistedGlobalTvl * 0.6,
      valueBaselineSource: "dex_liquidity_global",
      valueBaselineGlobalTvl: params.persistedGlobalTvl,
      ignoredPersistedGlobalTvl: null,
    };
  }

  const value = sourceCompleteRun?.metadata.sourceCoverage.currentGlobalTvl ?? null;
  return {
    previousGlobalTvl: isFinitePositive(value) ? value : null,
    minExpectedGlobalTvl: isFinitePositive(value) ? value * 0.6 : null,
    valueBaselineSource: isFinitePositive(value) ? "cron_metadata_source_complete" : "none",
    valueBaselineGlobalTvl: isFinitePositive(value) ? value : null,
    ignoredPersistedGlobalTvl: null,
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
  valueBaselineSource: ValueBaselineSource;
  valueBaselineGlobalTvl: number | null;
  ignoredPersistedGlobalTvl: number | null;
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
    valueBaselineSource: ValueBaselineSource;
    valueBaselineGlobalTvl: number | null;
    ignoredPersistedGlobalTvl: number | null;
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
  } & DexLiquidityDriftSummary;
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
    previousCronRows,
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
      .prepare("SELECT total_tvl_usd, updated_at FROM dex_liquidity WHERE stablecoin_id = '__global__'")
      .first<{ total_tvl_usd: number | null; updated_at: number | null }>()
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
        `SELECT started_at, status, metadata
         FROM cron_runs
         WHERE job = 'sync-dex-liquidity'
           AND metadata IS NOT NULL
         ORDER BY started_at DESC
         LIMIT 12`,
      )
      .all<{ started_at: number | null; status: string | null; metadata: string | null }>()
      .catch((e) => {
        console.warn("[dex-liquidity] Failed to read previous cron metadata:", e);
        return {
          results: [] as Array<{ started_at: number | null; status: string | null; metadata: string | null }>,
        };
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
  const persistedGlobalTvl = previousGlobalRow?.total_tvl_usd ?? null;
  const persistedGlobalUpdatedAt = previousGlobalRow?.updated_at ?? null;
  const parsedPreviousCronRows = parsePreviousCronRows(previousCronRows.results ?? []);
  const valueBaseline = selectValueBaseline({
    persistedGlobalTvl,
    persistedUpdatedAt: persistedGlobalUpdatedAt,
    previousCronRows: parsedPreviousCronRows,
  });
  const previousGlobalTvl = valueBaseline.previousGlobalTvl;
  const minExpectedGlobalTvl = valueBaseline.minExpectedGlobalTvl;
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
    valueBaseline.ignoredPersistedGlobalTvl == null &&
    previousTop10CoveredTvl >= 5_000_000 &&
    currentTop10CoveredTvl < previousTop10CoveredTvl * 0.6;

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

  const previousSummary = readPreviousDexLiquiditySummary(parsedPreviousCronRows[0]?.metadata ?? null);
  const watchlistPreviousById = new Map((previousWatchlistRows.results ?? []).map((row) => [row.stablecoin_id, row]));

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

  const driftSummary = computeDexLiquidityDriftSummary({
    previousSummary,
    priceObservations: params.priceObservations,
    stagedMergedCount: params.stagedMergedCount,
    stagedSkippedCount: params.stagedSkippedCount,
    weakCoverageCoinsBeforeFallback: params.weakCoverageCoinsBeforeFallback,
    measuredBalanceCoveragePct,
    watchlistPreviousById,
    scoreResults: params.scoreResults,
    retainedPoolsByStablecoin: params.retainedPoolsByStablecoin,
  });

  return {
    currentCoverage,
    previousCoverage,
    previousCoverageBaselineAvailable,
    minExpectedCoverage,
    currentGlobalTvl,
    previousGlobalTvl,
    minExpectedGlobalTvl,
    valueBaselineSource: valueBaseline.valueBaselineSource,
    valueBaselineGlobalTvl: valueBaseline.valueBaselineGlobalTvl,
    ignoredPersistedGlobalTvl: valueBaseline.ignoredPersistedGlobalTvl,
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
      valueBaselineSource: valueBaseline.valueBaselineSource,
      valueBaselineGlobalTvl: valueBaseline.valueBaselineGlobalTvl,
      ignoredPersistedGlobalTvl: valueBaseline.ignoredPersistedGlobalTvl,
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
      qualityDriftFlags: driftSummary.qualityDriftFlags,
      qualityDriftSeverity: driftSummary.qualityDriftSeverity,
      qualityDriftMetrics: driftSummary.qualityDriftMetrics,
      topAssetCoverageDeltas: driftSummary.topAssetCoverageDeltas,
    },
  };
}
