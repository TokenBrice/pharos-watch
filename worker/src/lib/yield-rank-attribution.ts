import { compareCodeUnits } from "@shared/lib/compare";
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
  return compareCodeUnits(a.name, b.name);
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
  sourceRiskDelta: number | null;
}): YieldRankChangeDriver {
  if (params.methodologyChanged) return "methodology";
  if (params.safetyChanged) return "stablecoin-safety";
  if (params.row.provenance?.sourceSwitch) return "source-switch";
  if (params.sourceRiskDelta != null && params.sourceRiskDelta !== 0) return "source-risk";
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
  /** Only hydration may retain movement measured in this same publication. */
  comparison?: "publication" | "hydration";
}

export function buildYieldRankChangeAttribution(
  params: YieldRankChangeAttributionParams,
): YieldRankChangeAttribution | null {
  // Rows published before the ranking contract carry no published rank, so there
  // is no baseline to attribute against — never synthesize movement for them.
  const publishedRank = positiveInteger(params.originalRow.publishedRank);
  const publishedAttribution = params.comparison === "publication" ? null : params.originalRow.rankChangeAttribution;
  const previousRank = positiveInteger(publishedAttribution?.previousRank) ?? params.previousRank;
  const liveRank = positiveInteger(params.hydratedRow.liveRank);
  if (params.methodologyChanged) return null;
  if (publishedRank == null || params.previousRank == null || previousRank == null || liveRank == null) return null;
  if (params.previousRank === liveRank && params.comparison !== "publication") {
    return publishedAttribution ?? null;
  }
  if (previousRank === liveRank) return null;

  const previousPys = publishedAttribution
    ? finiteNumber(publishedAttribution.previousPys)
    : finiteNumber(params.originalRow.pharosYieldScore);
  const livePys = finiteNumber(params.hydratedRow.pharosYieldScore);
  const pysDelta = previousPys != null && livePys != null ? roundDelta(livePys - previousPys) : null;
  const rankDelta = previousRank - liveRank;
  const sourceRiskPenalty = finiteNumber(params.hydratedRow.sourceRisk?.sourceRiskPenalty);
  const previousSourceRiskPenalty = finiteNumber(params.originalRow.sourceRisk?.sourceRiskPenalty);
  const sourceRiskDelta = sourceRiskPenalty != null && previousSourceRiskPenalty != null
    ? roundDelta(sourceRiskPenalty - previousSourceRiskPenalty)
    : null;
  const sourceDepthRatio = finiteNumber(params.hydratedRow.sourceRisk?.sourceDepthRatio);

  const primaryDriver = selectRankChangeDriver({
    row: params.hydratedRow,
    safetyChanged: params.safetyChanged,
    methodologyChanged: params.methodologyChanged,
    pysDelta,
    sourceRiskDelta,
  });

  return {
    previousRank,
    rankDelta,
    previousPys,
    pysDelta,
    primaryDriver,
    driverContributions: {
      // Heuristic rank-place context, not an additive causal decomposition.
      apy: primaryDriver === "apy" ? rankDelta : null,
      benchmark: primaryDriver === "benchmark" ? rankDelta : null,
      // Whole-row PYS-point change accompanying a safety change, not isolated causation.
      stablecoinSafety: params.safetyChanged && pysDelta != null ? pysDelta : null,
      // Measured penalty-multiplier change; unchanged penalties explain no movement.
      sourceRisk: sourceRiskDelta !== 0 ? sourceRiskDelta : null,
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
