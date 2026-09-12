import { numberValue as finiteNumber } from "@shared/lib/type-guards";
import { YIELD_BENCHMARK_KEY_CURRENCY } from "@shared/types/yield";
import type {
  YieldRankChangeAttribution,
  YieldRankChangeDriver,
  YieldRanking,
} from "@shared/types/yield";

/**
 * Rank-change attribution for the served yield rankings (yield v8.43, backlog B7).
 *
 * The publisher ranks rows by published PYS alone with a stable sort, while the
 * read path serves the three-key order below after live safety hydration, so
 * comparing `publishedRank` with the served `liveRank` reported tie-group
 * re-sorting as movement: live, 141 of 157 rows sat inside a tie group and 129
 * carried a non-zero published/live delta with a zero PYS delta. The served
 * payload therefore re-derives the baseline rank with {@link compareYieldRankRows}
 * over the *pre-hydration* rows, and only comparator-consistent non-zero deltas
 * are attributed — a row that merely moved inside its tie group is not movement.
 */

/** Served ranking order: PYS desc (null last), current APY desc, then name. */
export function compareYieldRankRows(a: YieldRanking, b: YieldRanking): number {
  const aScore = finiteNumber(a.pharosYieldScore);
  const bScore = finiteNumber(b.pharosYieldScore);
  if (aScore != null || bScore != null) {
    if (aScore == null) return 1;
    if (bScore == null) return -1;
    if (aScore !== bScore) return bScore - aScore;
  }
  const apyDiff = b.currentApy - a.currentApy;
  if (apyDiff !== 0) return apyDiff;
  return a.name.localeCompare(b.name);
}

/**
 * Baseline rank per row id over a pre-change row set, using the served
 * comparator so the baseline and the served ranks are comparable (B7). Also the
 * publish-time entry point: a later wave re-ranks the previous publication's
 * rows with the same helper before calling {@link buildYieldRankChangeAttribution}.
 */
export function buildYieldRankBaseline(rows: readonly YieldRanking[]): Map<string, number> {
  const baseline = new Map<string, number>();
  [...rows].sort(compareYieldRankRows).forEach((row, index) => {
    baseline.set(row.id, index + 1);
  });
  return baseline;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function roundDelta(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const rounded = Number(value.toFixed(4));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * True when the row's score carries the USD-reference re-base term (yield
 * v8.43, B24): a benchmark quoted in another currency with a known rate. Such a
 * row's PYS moves with the reference as well as with its own APY, so a delta
 * with no other identifiable driver is attributed to the benchmark instead of
 * to an APY that is only one input to the re-based hurdle.
 */
function isRebasedBenchmarkRow(row: YieldRanking): boolean {
  const benchmarkCurrency =
    row.benchmarkCurrency ??
    row.provenance?.benchmarkCurrency ??
    (row.benchmarkKey != null ? YIELD_BENCHMARK_KEY_CURRENCY[row.benchmarkKey] : null) ??
    null;
  return (
    benchmarkCurrency != null &&
    benchmarkCurrency !== "USD" &&
    finiteNumber(row.benchmarkRate ?? row.provenance?.benchmarkRate) != null
  );
}

/**
 * Primary driver for a comparator-consistent rank delta.
 *
 * `stablecoin-safety` is returned only when the row's *own* safety differs from
 * the published one — the previous shared "any row's safety changed" gate
 * labelled every unchanged row `stablecoin-safety` whenever hydration moved
 * anyone. Rows whose payload was published under a different methodology
 * version are attributed to `methodology`: their delta measures the version
 * bump, not the row's evidence.
 */
function selectRankChangeDriver(params: {
  row: YieldRanking;
  safetyChanged: boolean;
  methodologyChanged: boolean;
  pysDelta: number | null;
}): YieldRankChangeDriver {
  if (params.methodologyChanged) return "methodology";
  if (params.safetyChanged) return "stablecoin-safety";
  if (params.row.provenance?.sourceSwitch) return "source-switch";
  const sourceRiskPenalty = finiteNumber(params.row.sourceRisk?.sourceRiskPenalty);
  if (sourceRiskPenalty != null && sourceRiskPenalty > 1) return "source-risk";
  if (params.row.warningSignals.includes("data-stale")) return "freshness";
  if (finiteNumber(params.row.yieldStability) != null && (params.row.yieldStability ?? 1) < 0.7) {
    return "volatility";
  }
  if (
    finiteNumber(params.row.sourceRisk?.sourceDepthRatio) != null &&
    (params.row.sourceRisk?.sourceDepthRatio ?? 1) < 0.05
  ) {
    return "tvl-depth";
  }
  if (params.row.benchmarkIsFallback === true || params.row.benchmarkFallbackMode) return "benchmark";
  if (isRebasedBenchmarkRow(params.row)) return "benchmark";
  return "apy";
}

export interface YieldRankChangeAttributionParams {
  /** Row as published — supplies the baseline PYS and the published attribution. */
  originalRow: YieldRanking;
  /** Row as served; must carry `liveRank` for a comparable delta. */
  hydratedRow: YieldRanking;
  /** Baseline rank from {@link buildYieldRankBaseline}; null suppresses attribution. */
  previousRank: number | null;
  /** This row's own served safety score differs from its published one. */
  safetyChanged: boolean;
  /** The baseline payload was published under a different methodology version. */
  methodologyChanged: boolean;
}

export function buildYieldRankChangeAttribution(
  params: YieldRankChangeAttributionParams,
): YieldRankChangeAttribution | null {
  // Rows published before the ranking contract carry no published rank, so there
  // is no baseline to attribute against — never synthesize movement for them.
  const publishedRank = positiveInteger(params.originalRow.publishedRank);
  const previousRank = params.previousRank;
  const liveRank = positiveInteger(params.hydratedRow.liveRank);
  if (publishedRank == null || previousRank == null || liveRank == null || previousRank === liveRank) {
    return params.originalRow.rankChangeAttribution ?? null;
  }

  const previousPys = finiteNumber(params.originalRow.pharosYieldScore);
  const livePys = finiteNumber(params.hydratedRow.pharosYieldScore);
  const pysDelta = previousPys != null && livePys != null ? roundDelta(livePys - previousPys) : null;
  const rankDelta = previousRank - liveRank;
  const sourceRiskPenalty = finiteNumber(params.hydratedRow.sourceRisk?.sourceRiskPenalty);
  const sourceDepthRatio = finiteNumber(params.hydratedRow.sourceRisk?.sourceDepthRatio);

  const primaryDriver = selectRankChangeDriver({
    row: params.hydratedRow,
    safetyChanged: params.safetyChanged,
    methodologyChanged: params.methodologyChanged,
    pysDelta,
  });

  return {
    previousRank,
    rankDelta,
    previousPys,
    pysDelta,
    primaryDriver,
    driverContributions: {
      apy: primaryDriver === "apy" ? rankDelta : null,
      benchmark: primaryDriver === "benchmark" ? rankDelta : null,
      // A rank delta with no published/live PYS pair has no measurable safety
      // contribution: 0 claimed a scored move the row never had.
      stablecoinSafety: params.safetyChanged && pysDelta != null ? pysDelta : null,
      sourceRisk: sourceRiskPenalty != null && sourceRiskPenalty > 1 ? roundDelta(1 - sourceRiskPenalty) : null,
      sourceSwitch: params.hydratedRow.provenance?.sourceSwitch ? rankDelta : null,
      freshness: params.hydratedRow.warningSignals.includes("data-stale") ? rankDelta : null,
      volatility:
        finiteNumber(params.hydratedRow.yieldStability) != null && (params.hydratedRow.yieldStability ?? 1) < 0.7
          ? rankDelta
          : null,
      tvlDepth: sourceDepthRatio != null && sourceDepthRatio < 0.05 ? rankDelta : null,
    },
  };
}
