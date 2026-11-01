import { logWorkerEventArgs } from "../../lib/structured-log";
import { ACTIVE_IDS, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { DexLiquidityCronMetadataSchema, type DexLiquidityCronMetadata, type DexLiquidityProtocolTvlQuarantine } from "../../lib/schemas";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../../lib/dex-liquidity";
import type { DexPriceObs, FullScoreResult, GlobalAgg, LiquidityMetrics } from "./types";
import { round4 } from "@shared/lib/math";
import { median } from "@shared/lib/stats";
import {
  DRIFT_WATCHLIST,
  computeDexLiquidityDriftSummary,
  readPreviousDexLiquidityDriftCandidates,
  readPreviousDexLiquiditySummary,
  type DexLiquidityDriftCandidate,
  type DexLiquidityDriftSummary,
  type PreviousDexLiquiditySummary,
} from "./orchestrator-drift";
import { toErrorMessage } from "@shared/lib/error-utils";
import type { DexLiquidityBaselineReadFailure } from "@shared/types/status/yield-liquidity";


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

type TopCoverageRow = {
  stablecoin_id: string;
  total_tvl_usd: number;
  effective_tvl_usd?: number | null;
};

type PreviousCoinTvlRow = {
  stablecoin_id: string;
  total_tvl_usd: number;
  protocol_tvl_json: string | null;
};

type CoverageClasses = {
  primary: number;
  mixed: number;
  fallback: number;
  legacy: number;
  unobserved: number;
};

const MAJOR_COVERAGE_GUARD_RAW_TVL_MIN_USD = 100_000_000;
const MAJOR_COVERAGE_GUARD_MIN_EFFECTIVE_RATIO = 0.02;
/**
 * Coverage guards count rows that came from a score result. Since liquidity
 * methodology 6.9 an observed row may carry an NR composite (DEC-19: required
 * 24h activity unavailable), so a null score alone no longer marks a
 * placeholder; placeholders are the `unobserved` unscored rows.
 */
const DEX_LIQUIDITY_OBSERVED_ROW_FILTER =
  "(liquidity_score IS NOT NULL OR coverage_class != 'unobserved')";

function parseDexLiquidityCronMetadata(metadata: string | null): DexLiquidityCronMetadata | null {
  if (!metadata) return null;
  try {
    return DexLiquidityCronMetadataSchema.parse(JSON.parse(metadata));
  } catch (err) {
    logWorkerEventArgs("handler", "warn",
      "[dex-liquidity] Failed to parse previous cron metadata:",
      toErrorMessage(err),
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

function isFiniteNonNegative(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function computeMajorCoverageGuardTvl(totalTvl: number, effectiveTvl: number | null | undefined): number {
  if (!isFinitePositive(totalTvl)) return 0;
  if (!isFiniteNonNegative(effectiveTvl)) return totalTvl;

  const effectiveRatio = totalTvl > 0 ? effectiveTvl / totalTvl : 1;
  if (
    totalTvl >= MAJOR_COVERAGE_GUARD_RAW_TVL_MIN_USD &&
    effectiveRatio < MAJOR_COVERAGE_GUARD_MIN_EFFECTIVE_RATIO
  ) {
    return effectiveTvl;
  }

  return totalTvl;
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

/** `chain_tvl_json` is written by persistence; malformed/absent history skips the cohort comparison. */
function parsePreviousChainTvl(value: string | null | undefined): Record<string, number> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) return null;
    if (!entries.every(([, tvl]) => typeof tvl === "number" && Number.isFinite(tvl) && tvl >= 0)) return null;
    return Object.fromEntries(entries) as Record<string, number>;
  } catch {
    return null;
  }
}

/** Trailing window (productive published runs) used for the coverage/value guard baselines. */
const GUARD_BASELINE_RUNS = 6;

/** A run that produced a scoring result: `ok`/`degraded` and not persistence-skipped. */
function isProductiveCronRow(row: ParsedPreviousCronRow): boolean {
  return (row.status === "ok" || row.status === "degraded") && row.metadata.persistence?.skipped !== true;
}

/**
 * Median of the newest `GUARD_BASELINE_RUNS` values, most recent first. The
 * guards used to compare against the immediately previous run only, so a 20%
 * slide spread over six runs never crossed a 20% single-run bound and those
 * runs published as `ok`; a trailing median sees the decay while still ignoring
 * one noisy hour.
 */
function medianOfRecentRuns(values: number[]): number | null {
  return median(values.slice(0, GUARD_BASELINE_RUNS));
}

function readLatestProductiveDexLiquidityBaseline(rows: ParsedPreviousCronRow[]): {
  summary: PreviousDexLiquiditySummary | null;
  candidates: DexLiquidityDriftCandidate[];
} {
  const latestProductiveRow = rows.find(
    (row) =>
      isProductiveCronRow(row) &&
      [
        row.metadata.stagedPoolsMerged,
        row.metadata.stagedPoolsSkipped,
        row.metadata.sourceCoverage.priceObservationCoins,
        row.metadata.sourceCoverage.measuredBalanceCoveragePct,
        row.metadata.sourceCoverage.weakCoverageCoins,
      ].every((value) => typeof value === "number" && Number.isFinite(value)),
  );
  return {
    summary: readPreviousDexLiquiditySummary(latestProductiveRow?.metadata ?? null),
    candidates: readPreviousDexLiquidityDriftCandidates(latestProductiveRow?.metadata ?? null),
  };
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
  persistedSourceIncomplete: boolean;
  trailingSourceCompleteGlobalTvl: number | null;
}): ValueBaselineSelection {
  // The persisted `__global__` row is the most recent published baseline, so it
  // is the anchor of the guard window unless it came from a source-incomplete
  // run. Either way the trailing source-complete median smooths the comparison.
  const usesPersistedRow = !params.persistedSourceIncomplete && params.persistedGlobalTvl != null;
  const baseline = usesPersistedRow
    ? params.trailingSourceCompleteGlobalTvl ?? params.persistedGlobalTvl
    : params.trailingSourceCompleteGlobalTvl;

  return {
    previousGlobalTvl: baseline,
    minExpectedGlobalTvl: baseline != null ? baseline * 0.6 : null,
    valueBaselineSource:
      baseline == null ? "none" : usesPersistedRow ? "dex_liquidity_global" : "cron_metadata_source_complete",
    valueBaselineGlobalTvl: baseline,
    ignoredPersistedGlobalTvl: params.persistedSourceIncomplete ? params.persistedGlobalTvl : null,
  };
}

export interface DexLiquidityPostScoreAnalysis {
  currentCoverage: number;
  previousCoverage: number | null;
  previousCoverageBaselineAvailable: boolean;
  minExpectedCoverage: number | null;
  currentGlobalTvl: number;
  previousGlobalTvl: number | null;
  minExpectedGlobalTvl: number | null;
  valueBaselineSource: ValueBaselineSource;
  valueBaselineGlobalTvl: number | null;
  ignoredPersistedGlobalTvl: number | null;
  currentTop10CoveredTvl: number | null;
  previousTop10CoveredTvl: number | null;
  currentTop10GuardTvl: number | null;
  previousTop10GuardTvl: number | null;
  requiredBaselineUnavailable: boolean;
  nearCoverageGuard: boolean;
  nearValueGuard: boolean;
  hardValueGuard: boolean;
  nearMajorCoverageGuard: boolean;
  hardMajorCoverageGuard: boolean;
  hardCoverageGuard: boolean;
  sourceCoverage: {
    dlYieldsAvailable: boolean;
    dlProtocolsAvailable: boolean;
    currentCoverage: number;
    previousCoverage: number | null;
    previousCoverageBaselineAvailable: boolean;
    minExpectedCoverage: number | null;
    nearCoverageGuard: boolean;
    hardCoverageGuard: boolean;
    currentGlobalTvl: number;
    previousGlobalTvl: number | null;
    minExpectedGlobalTvl: number | null;
    valueBaselineSource: ValueBaselineSource;
    valueBaselineGlobalTvl: number | null;
    ignoredPersistedGlobalTvl: number | null;
    nearValueGuard: boolean;
    coinTvlStepCount150: number;
    coinTvlStepCount25: number;
    coinTvlStepIds150: string[];
    coinTvlStepIds150Omitted: number;
    coinTvlStepIds25: string[];
    coinTvlStepIds25Omitted: number;
    coinTvlStepComparisons: number;
    coinTvlStepMissingBaseline: number;
    coinTvlStepMissingCurrent: number;
    coinTvlStepBaselineUnavailable: boolean;
    coinTvlStepTop: Array<{
      stablecoinId: string;
      previousTvlUsd: number;
      currentTvlUsd: number;
      ratio: number;
      protocol: string | null;
      protocolDeltaUsd: number | null;
    }>;
    currentTop10CoveredTvl: number | null;
    previousTop10CoveredTvl: number | null;
    currentTop10GuardTvl: number | null;
    previousTop10GuardTvl: number | null;
    nearMajorCoverageGuard: boolean;
    currentCoverageClasses: CoverageClasses;
    previousCoverageClasses: CoverageClasses | null;
    baselineReadFailures: DexLiquidityBaselineReadFailure[];
    priceObservationCoins: number;
    weakCoverageCoins: number;
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
    globalProtocolOverCapUsd: number;
    protocolTvlQuarantine: DexLiquidityProtocolTvlQuarantine;
  } & DexLiquidityDriftSummary;
}

export async function analyzeDexLiquidityPostScoring(params: {
  db: D1Database;
  currentGenerationId?: string;
  scoreResults: Map<string, FullScoreResult>;
  globalAgg: GlobalAgg;
  retainedPoolsByStablecoin: Map<string, LiquidityMetrics["topPools"]>;
  priceObservations: Map<string, DexPriceObs[]>;
  diagnostics: {
    globalProtocolOverCapUsd: number;
    protocolTvlQuarantine: DexLiquidityProtocolTvlQuarantine;
  };
  stagedMergedCount: number;
  stagedSkippedCount: number;
  weakCoverageCoinsBeforeFallback: number;
  dlYieldsAvailable: boolean;
  dlProtocolsAvailable: boolean;
  criticalSourceFailures: string[];
}): Promise<DexLiquidityPostScoreAnalysis> {
  const currentCoverage = params.scoreResults.size;
  const activeIdsJson = JSON.stringify([...ACTIVE_IDS]);
  const [
    coverageRead,
    globalRead,
    classesRead,
    topTenRead,
    historyRead,
    watchlistRead,
    coinTvlRead,
  ] = await Promise.allSettled([
    params.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM dex_liquidity
         WHERE stablecoin_id != '__global__'
           AND stablecoin_id IN (SELECT value FROM json_each(?))
           AND ${DEX_LIQUIDITY_OBSERVED_ROW_FILTER}
           AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}
           AND NOT (
             json_valid(source_mix_json)
             AND COALESCE(json_extract(source_mix_json, '$.cg_tickers.tvlUsd'), 0) > 0
             AND total_tvl_usd <= COALESCE(json_extract(source_mix_json, '$.cg_tickers.tvlUsd'), 0)
           )`,
      )
      .bind(activeIdsJson)
      .first<{ cnt: number }>(),
    params.db
      .prepare(
        `SELECT total_tvl_usd, updated_at, chain_tvl_json FROM dex_liquidity WHERE stablecoin_id = '__global__' AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`,
      )
      .first<{ total_tvl_usd: number | null; chain_tvl_json: string | null; updated_at: number | null }>(),
    params.db
      .prepare(
        `SELECT coverage_class, COUNT(*) as cnt
         FROM dex_liquidity
         WHERE stablecoin_id != '__global__'
           AND stablecoin_id IN (SELECT value FROM json_each(?))
           AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}
         GROUP BY coverage_class`,
      )
      .bind(activeIdsJson)
      .all<{ coverage_class: string | null; cnt: number }>(),
    params.db
      .prepare(
        `SELECT stablecoin_id, total_tvl_usd, effective_tvl_usd
         FROM dex_liquidity
         WHERE stablecoin_id != '__global__'
           AND stablecoin_id IN (SELECT value FROM json_each(?))
           AND ${DEX_LIQUIDITY_OBSERVED_ROW_FILTER}
           AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}
         ORDER BY total_tvl_usd DESC
         LIMIT 10`,
      )
      .bind(activeIdsJson)
      .all<TopCoverageRow>(),
    params.db
      .prepare(
        `SELECT started_at, status, metadata
         FROM cron_runs
         WHERE job = 'sync-dex-liquidity'
           AND status IN ('ok', 'degraded')
           AND metadata IS NOT NULL
         ORDER BY started_at DESC
         LIMIT 12`,
      )
      .all<{ started_at: number | null; status: string | null; metadata: string | null }>(),
    params.db
      .prepare(
        `SELECT stablecoin_id, pool_count, coverage_confidence, total_tvl_usd, balance_measured_tvl_usd
         FROM dex_liquidity
         WHERE stablecoin_id IN (${DRIFT_WATCHLIST.map(() => "?").join(", ")})
           AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`,
      )
      .bind(...DRIFT_WATCHLIST)
      .all<{
        stablecoin_id: string;
        pool_count: number;
        coverage_confidence: number | null;
        total_tvl_usd: number;
        balance_measured_tvl_usd: number;
      }>(),
    params.db
      .prepare(
        `SELECT r.stablecoin_id, r.total_tvl_usd, r.protocol_tvl_json
         FROM dex_liquidity_run_rows r
         JOIN dex_liquidity_publication_generations g ON g.generation_id = r.generation_id
         WHERE g.state = 'published' AND r.stablecoin_id != '__global__'
           AND r.stablecoin_id IN (SELECT value FROM json_each(?))
           AND r.generation_id = (
             SELECT generation_id FROM dex_liquidity_publication_generations
             WHERE state = 'published' AND (? IS NULL OR generation_id != ?)
             ORDER BY started_at DESC, generation_id DESC
             LIMIT 1
           )`,
      )
      .bind(activeIdsJson, params.currentGenerationId ?? null, params.currentGenerationId ?? null)
      .all<PreviousCoinTvlRow>(),
  ]);
  // Fulfilled empty reads are bootstrap evidence; rejected reads are unavailable,
  // never an empty population. Optional drift/class reads cannot block publication.
  const baselineReadFailures: DexLiquidityBaselineReadFailure[] = [];
  const reads = [
    ["coverage-count-read-failed", coverageRead],
    ["global-tvl-read-failed", globalRead],
    ["coverage-classes-read-failed", classesRead],
    ["top-ten-read-failed", topTenRead],
    ["cron-history-read-failed", historyRead],
    ["watchlist-read-failed", watchlistRead],
    ["coin-tvl-read-failed", coinTvlRead],
  ] as const;
  for (const [reason, read] of reads) {
    if (read.status === "rejected") {
      baselineReadFailures.push(reason);
      logWorkerEventArgs("handler", "warn", `[dex-liquidity] ${reason}:`, toErrorMessage(read.reason));
    }
  }
  const requiredBaselineUnavailable = [coverageRead, globalRead, topTenRead, historyRead]
    .some((read) => read.status === "rejected");
  const previousCoverageRow = coverageRead.status === "fulfilled" ? coverageRead.value : null;
  const previousGlobalRow = globalRead.status === "fulfilled" ? globalRead.value : null;
  const previousCoverageClassRows = classesRead.status === "fulfilled" ? classesRead.value.results : null;
  const previousTopCoverageRows = topTenRead.status === "fulfilled" ? topTenRead.value.results : null;
  const previousCronRows = historyRead.status === "fulfilled" ? historyRead.value.results : [];
  const previousWatchlistRows = watchlistRead.status === "fulfilled" ? watchlistRead.value.results : [];
  const previousCoinTvlRows = coinTvlRead.status === "fulfilled" ? coinTvlRead.value.results : [];
  const coinTvlStepBaselineUnavailable = coinTvlRead.status === "rejected";

  const parsedPreviousCronRows = parsePreviousCronRows(previousCronRows ?? []);

  // Compare observed coverage on the price-only ticker policy. The current
  // published rows can be normalized exactly from their scored source mix;
  // old ticker-bearing cron counts cannot, so don't mix those policy epochs
  // into the trailing window. Real non-ticker losses still use the same gates.
  const coverageBaselineWindow = [
    ...(previousCoverageRow != null ? [previousCoverageRow.cnt] : []),
    ...parsedPreviousCronRows
      .filter((row) => isProductiveCronRow(row) &&
        isFiniteNonNegative(row.metadata.sourceCoverage.currentCoverage) &&
        row.metadata.sourceCoverage.retainedPoolCountBySourceFamily != null &&
        (row.metadata.sourceCoverage.retainedPoolCountBySourceFamily.cg_tickers ?? 0) === 0)
      .map((row) => row.metadata.sourceCoverage.currentCoverage!),
  ];
  const coverageBaseline = coverageRead.status === "fulfilled" && historyRead.status === "fulfilled"
    ? medianOfRecentRuns(coverageBaselineWindow) ?? 0 : null;
  const previousCoverageBaselineAvailable = coverageBaseline != null;
  const previousCoverage = coverageBaseline;
  const minExpectedCoverage = previousCoverage != null ? Math.max(1, Math.floor(previousCoverage * 0.6)) : null;
  const hardCoverageGuard =
    previousCoverage != null && previousCoverage >= 10 && currentCoverage < minExpectedCoverage!;
  const nearCoverageGuard =
    previousCoverage != null && previousCoverage >= 10 && currentCoverage < Math.floor(previousCoverage * 0.8);

  const currentGlobalTvl = params.globalAgg.totalTvl;
  const persistedGlobalTvl = previousGlobalRow?.total_tvl_usd ?? null;
  const persistedGlobalUpdatedAt = previousGlobalRow?.updated_at ?? null;
  const persistedRun = findPersistedCronMetadata(
    parsedPreviousCronRows,
    persistedGlobalUpdatedAt,
    persistedGlobalTvl,
  );
  const persistedSourceIncomplete = persistedRun != null && isSourceIncompleteMetadata(persistedRun.metadata);
  const trailingSourceCompleteGlobalTvl = medianOfRecentRuns(
    parsedPreviousCronRows
      .filter((row) => isProductiveCronRow(row) && isSourceCompleteMetadata(row.metadata))
      .map((row) => row.metadata.sourceCoverage.currentGlobalTvl!),
  );
  const valueBaseline = selectValueBaseline({
    persistedGlobalTvl: globalRead.status === "fulfilled" && historyRead.status === "fulfilled" ? persistedGlobalTvl : null,
    persistedSourceIncomplete,
    trailingSourceCompleteGlobalTvl: globalRead.status === "fulfilled" && historyRead.status === "fulfilled"
      ? trailingSourceCompleteGlobalTvl : null,
  });
  const previousGlobalTvl = valueBaseline.previousGlobalTvl;
  const minExpectedGlobalTvl = valueBaseline.minExpectedGlobalTvl;
  const nearValueGuard =
    previousGlobalTvl != null && previousGlobalTvl >= 10_000_000 && currentGlobalTvl < previousGlobalTvl * 0.85;
  const hardValueGuard =
    previousGlobalTvl != null && previousGlobalTvl >= 10_000_000 && currentGlobalTvl < previousGlobalTvl * 0.6;

  const previousTop10CoveredTvl = previousTopCoverageRows?.reduce(
    (sum, row) => sum + row.total_tvl_usd,
    0,
  ) ?? null;
  const currentTop10CoveredTvl = previousTopCoverageRows?.reduce(
    (sum, row) => sum + (params.scoreResults.get(row.stablecoin_id)?.tvl ?? 0),
    0,
  ) ?? null;
  const previousTop10GuardTvl = previousTopCoverageRows?.reduce(
    (sum, row) => sum + computeMajorCoverageGuardTvl(row.total_tvl_usd, row.effective_tvl_usd),
    0,
  ) ?? null;
  const currentTop10GuardTvl = previousTopCoverageRows?.reduce((sum, row) => {
    const current = params.scoreResults.get(row.stablecoin_id);
    return sum + (current ? computeMajorCoverageGuardTvl(current.tvl, current.effectiveTvl) : 0);
  }, 0) ?? null;
  const nearMajorCoverageGuard =
    previousTop10GuardTvl != null && currentTop10GuardTvl != null &&
    previousTop10GuardTvl >= 5_000_000 && currentTop10GuardTvl < previousTop10GuardTvl * 0.85;
  const hardMajorCoverageGuard =
    valueBaseline.ignoredPersistedGlobalTvl == null &&
    previousTop10GuardTvl != null && currentTop10GuardTvl != null &&
    previousTop10GuardTvl >= 5_000_000 &&
    currentTop10GuardTvl < previousTop10GuardTvl * 0.6;

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

  const previousCoverageClasses = previousCoverageClassRows == null ? null : emptyCoverageClasses();
  for (const row of previousCoverageClassRows ?? []) {
    const key = row.coverage_class;
    if (previousCoverageClasses && key && key in previousCoverageClasses) {
      previousCoverageClasses[key as keyof CoverageClasses] = row.cnt;
    }
  }

  const previousDriftBaseline = readLatestProductiveDexLiquidityBaseline(parsedPreviousCronRows);
  const watchlistPreviousById = new Map((previousWatchlistRows ?? []).map((row) => [row.stablecoin_id, row]));

  const retainedPoolCountBySourceFamily: Record<string, number> = {};
  const measuredBalanceTvlBySourceFamily: Record<string, number> = {};
  const priceObservationCoinsBySourceFamily: Record<string, number> = {};
  const retainedStablecoinProtocolTvl = new Map<string, Record<string, number>>();
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
      // A remembered DL/direct row (decayed staged backfill) is inventory, not a this-run
      // observation: it must not hide a total primary-lane outage from coverage classification.
      if (
        (pool.source === "dl" || pool.source === "direct_api") &&
        pool.extra?.measurement?.decayed !== true
      ) {
        hasPrimaryLiquidity = true;
      }
      if (pool.source === "gecko_terminal") hasGeckoTerminalLiquidity = true;
      if (pool.extra?.measurement?.balanceMeasured) {
        hasMeasuredBalanceLiquidity = true;
        measuredBalanceTvlBySourceFamily[pool.source] = round4(
          (measuredBalanceTvlBySourceFamily[pool.source] ?? 0) + pool.tvlUsd,
        );
      }

      const protocol = pool.project;
      stablecoinProtocolTvl[protocol] = (stablecoinProtocolTvl[protocol] ?? 0) + pool.tvlUsd;
    }

    retainedStablecoinProtocolTvl.set(stablecoinId, stablecoinProtocolTvl);
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

  let coinTvlStepCount150 = 0;
  let coinTvlStepCount25 = 0;
  let coinTvlStepMissingBaseline = 0;
  let coinTvlStepMissingCurrent = 0;
  const positiveBaselineIds = new Set<string>();
  const coinTvlSteps: DexLiquidityPostScoreAnalysis["sourceCoverage"]["coinTvlStepTop"] = [];
  for (const previous of previousCoinTvlRows ?? []) {
    const current = params.scoreResults.get(previous.stablecoin_id);
    if (!isFinitePositive(previous.total_tvl_usd)) continue;
    positiveBaselineIds.add(previous.stablecoin_id);
    if (!current) {
      coinTvlStepMissingCurrent++;
      continue;
    }
    if (!isFiniteNonNegative(current.tvl)) continue;
    const ratio = current.tvl / previous.total_tvl_usd;
    if (ratio > 1.5 || ratio < 0.5) coinTvlStepCount150++;
    if (ratio >= 1.25 || ratio <= 0.8) coinTvlStepCount25++;
    let protocol: string | null = null;
    let protocolDeltaUsd: number | null = null;
    const currentProtocols = retainedStablecoinProtocolTvl.get(previous.stablecoin_id);
    if (currentProtocols && previous.protocol_tvl_json) {
      try {
        const previousProtocols: unknown = JSON.parse(previous.protocol_tvl_json);
        if (
          previousProtocols != null &&
          typeof previousProtocols === "object" &&
          !Array.isArray(previousProtocols) &&
          Object.values(previousProtocols).every(isFiniteNonNegative)
        ) {
          const baseline = previousProtocols as Record<string, number>;
          for (const name of new Set([...Object.keys(baseline), ...Object.keys(currentProtocols)])) {
            const delta = (currentProtocols[name] ?? 0) - (baseline[name] ?? 0);
            if (
              protocolDeltaUsd == null ||
              Math.abs(delta) > Math.abs(protocolDeltaUsd) ||
              (Math.abs(delta) === Math.abs(protocolDeltaUsd) && name < protocol!)
            ) {
              protocol = name;
              protocolDeltaUsd = delta;
            }
          }
        }
      } catch {
        // Missing or malformed historical detail must not discard the total-TVL comparison.
      }
    }
    coinTvlSteps.push({
      stablecoinId: previous.stablecoin_id,
      previousTvlUsd: previous.total_tvl_usd,
      currentTvlUsd: current.tvl,
      ratio,
      protocol,
      protocolDeltaUsd,
    });
  }
  if (!coinTvlStepBaselineUnavailable) {
    for (const stablecoinId of params.scoreResults.keys()) {
      if (!positiveBaselineIds.has(stablecoinId)) coinTvlStepMissingBaseline++;
    }
  }
  coinTvlSteps.sort((left, right) =>
    Math.abs(right.currentTvlUsd - right.previousTvlUsd) - Math.abs(left.currentTvlUsd - left.previousTvlUsd) ||
    left.stablecoinId.localeCompare(right.stablecoinId),
  );
  const coinTvlStepIds150 = coinTvlSteps
    .filter((step) => step.ratio > 1.5 || step.ratio < 0.5)
    .slice(0, 50)
    .map((step) => step.stablecoinId);
  const coinTvlStepIds25 = coinTvlSteps
    .filter((step) => step.ratio >= 1.25 || step.ratio <= 0.8)
    .slice(0, 50)
    .map((step) => step.stablecoinId);
  const coinTvlStepTop = coinTvlSteps.slice(0, 5);

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

  const driftSummary = computeDexLiquidityDriftSummary({
    previousSummary: previousDriftBaseline.summary,
    previousCandidates: previousDriftBaseline.candidates,
    priceObservations: params.priceObservations,
    stagedMergedCount: params.stagedMergedCount,
    stagedSkippedCount: params.stagedSkippedCount,
    weakCoverageCoinsBeforeFallback: params.weakCoverageCoinsBeforeFallback,
    measuredBalanceCoveragePct,
    watchlistPreviousById,
    scoreResults: params.scoreResults,
    previousMajorTvlById: new Map(
      // Material coins remain monitored after leaving the top ten or accepting
      // a lasting cliff. The prior published generation owns the new baseline.
      [...(previousTopCoverageRows ?? []), ...(previousCoinTvlRows ?? [])]
        .map((row) => [row.stablecoin_id, row.total_tvl_usd]),
    ),
    previousChainTvl: parsePreviousChainTvl(previousGlobalRow?.chain_tvl_json),
    currentChainTvl: params.globalAgg.chainTvl,
    previousSourceFamilyPools: previousDriftBaseline.summary?.retainedPoolCountBySourceFamily ?? null,
    currentSourceFamilyPools: retainedPoolCountBySourceFamily,
  });

  return {
    currentCoverage,
    requiredBaselineUnavailable,
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
    currentTop10GuardTvl,
    previousTop10GuardTvl,
    nearCoverageGuard,
    hardCoverageGuard,
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
      hardCoverageGuard,
      currentGlobalTvl,
      previousGlobalTvl,
      minExpectedGlobalTvl,
      valueBaselineSource: valueBaseline.valueBaselineSource,
      valueBaselineGlobalTvl: valueBaseline.valueBaselineGlobalTvl,
      ignoredPersistedGlobalTvl: valueBaseline.ignoredPersistedGlobalTvl,
      nearValueGuard,
      coinTvlStepCount150,
      coinTvlStepCount25,
      coinTvlStepIds150,
      coinTvlStepIds150Omitted: coinTvlStepCount150 - coinTvlStepIds150.length,
      coinTvlStepIds25,
      coinTvlStepIds25Omitted: coinTvlStepCount25 - coinTvlStepIds25.length,
      coinTvlStepComparisons: coinTvlSteps.length,
      coinTvlStepMissingBaseline,
      coinTvlStepMissingCurrent,
      coinTvlStepBaselineUnavailable,
      coinTvlStepTop,
      currentTop10CoveredTvl,
      previousTop10CoveredTvl,
      currentTop10GuardTvl,
      previousTop10GuardTvl,
      nearMajorCoverageGuard,
      currentCoverageClasses,
      previousCoverageClasses,
      baselineReadFailures,
      priceObservationCoins: params.priceObservations.size,
      weakCoverageCoins: params.weakCoverageCoinsBeforeFallback,
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
      globalProtocolOverCapUsd: params.diagnostics.globalProtocolOverCapUsd,
      protocolTvlQuarantine: { ...params.diagnostics.protocolTvlQuarantine },
      qualityDriftFlags: driftSummary.qualityDriftFlags,
      cohortDriftFlags: driftSummary.cohortDriftFlags,
      qualityDriftCandidates: driftSummary.qualityDriftCandidates,
      qualityDriftRebaselined: driftSummary.qualityDriftRebaselined,
      qualityDriftSeverity: driftSummary.qualityDriftSeverity,
      qualityDriftMetrics: driftSummary.qualityDriftMetrics,
      topAssetCoverageDeltas: driftSummary.topAssetCoverageDeltas,
      majorTvlCliffs: driftSummary.majorTvlCliffs,
    },
  };
}
