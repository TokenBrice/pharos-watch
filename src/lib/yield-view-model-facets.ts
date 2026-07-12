import { getYieldRankingBenchmarkKey } from "@/lib/yield-benchmark";
import { YIELD_FILTER_AXIS_REGISTRY } from "@/lib/yield-view-model-filter-axes";
import { formatTvlOption } from "@/lib/yield-view-model-helpers";
import type {
  YieldCohortPercentile,
  YieldRowFacet,
  YieldViewModelOptions,
  YieldViewModelRow,
} from "@/lib/yield-view-model-types";
import {
  BENCHMARK_ORDER,
  CURRENCY_TAB_AUD_CAD_PEGS,
  CURRENCY_TAB_ENUMERATED_PEGS,
  CURRENCY_TAB_PEGS,
  EXTERNAL_OPPORTUNITY_YIELD_TYPES,
  HIDDEN_INDIVIDUAL_YIELD_PEG_FILTERS,
  MIN_SAFETY_OPTIONS,
  MIN_TVL_OPTIONS,
  SOURCE_CONFIDENCE_ORDER,
  compareYieldPegs,
  getYieldPegLabel,
  type YieldOpportunityFilter,
  type YieldPegFilter,
  type YieldSourceConfidenceFilter,
  type YieldViewModelFilters,
  type YieldFilterOption,
} from "@/lib/yield-view-config";
import {
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_DEPTH_DEFINITIONS,
  YIELD_SOURCE_POSTURE_DEFINITIONS,
  classifyYieldSourceDepth,
  classifyYieldSourcePosture,
  type YieldSourceDepthLens,
  type YieldSourcePosture,
} from "@/lib/yield-source-risk";
import { YIELD_TYPE_LABELS } from "@shared/lib/classification";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { PegCurrency, ReportCardGrade, YieldBenchmarkKey, YieldType } from "@shared/types";
import type { YieldWorkbenchRanking } from "@/lib/yield-workbench-row";

function getYieldRankingPeg(rankingId: string): PegCurrency | null {
  return TRACKED_META_BY_ID.get(rankingId)?.flags.pegCurrency ?? null;
}

function getOpportunity(row: YieldWorkbenchRanking): Exclude<YieldOpportunityFilter, "all"> {
  return EXTERNAL_OPPORTUNITY_YIELD_TYPES.has(row.yieldType) ? "lending-opportunity" : "holder-yield";
}

function getSourceDepthLens(row: YieldWorkbenchRanking): YieldSourceDepthLens {
  return classifyYieldSourceDepth({ sourceRisk: row.sourceRisk, sourceTvlUsd: row.sourceTvlUsd });
}

function getSourcePosture(row: YieldWorkbenchRanking, sourceDepthLens: YieldSourceDepthLens): YieldSourcePosture {
  return classifyYieldSourcePosture({
    sourceRisk: row.sourceRisk,
    sourceTvlUsd: row.sourceTvlUsd,
    sourceDepthLens,
    sourceChanged: row.provenance?.sourceSwitch ?? false,
    sourceFreshness: row.provenance?.sourceFreshness,
    warningSignals: row.warningSignals,
  });
}

function buildYieldRowFacet(row: YieldWorkbenchRanking, watchlistIds: ReadonlySet<string> | null): YieldRowFacet {
  const sourceDepthLens = getSourceDepthLens(row);
  const inWatchlist = watchlistIds?.has(row.id) ?? false;
  const sourceChanged = row.provenance?.sourceSwitch === true;
  const hasWarning = row.warningSignals.length > 0;
  const observations = row.sourceRisk?.observationCount30d;
  return {
    row,
    peg: getYieldRankingPeg(row.id),
    benchmarkKey: getYieldRankingBenchmarkKey(row),
    opportunity: getOpportunity(row),
    sourceDepthLens,
    sourcePosture: getSourcePosture(row, sourceDepthLens),
    confidenceTier: row.provenance?.confidenceTier ?? null,
    hasWarning,
    sourceChanged,
    isRising: row.currentApy > row.apy30d && observations != null && observations >= 7,
    inWatchlist,
    needsWatchlistAttention: inWatchlist && (hasWarning || sourceChanged),
  };
}

export function buildYieldRowFacets(
  rows: readonly YieldWorkbenchRanking[],
  watchlistIds: ReadonlySet<string> | null,
): YieldRowFacet[] {
  return rows.map((row) => buildYieldRowFacet(row, watchlistIds));
}

function countPegs(facets: readonly YieldRowFacet[]): Map<PegCurrency, number> {
  const counts = new Map<PegCurrency, number>();
  for (const facet of facets) {
    if (facet.peg) counts.set(facet.peg, (counts.get(facet.peg) ?? 0) + 1);
  }
  return counts;
}

function buildPegOptions(facets: readonly YieldRowFacet[]): YieldFilterOption<YieldPegFilter>[] {
  const counts = countPegs(facets);
  const pegs = Array.from(counts.keys()).sort(compareYieldPegs);
  const nonUsdCount = pegs.reduce((sum, peg) => sum + (peg !== "USD" ? (counts.get(peg) ?? 0) : 0), 0);
  const options: YieldFilterOption<YieldPegFilter>[] = [{ value: "all", label: "All", count: facets.length }];
  if (nonUsdCount > 0) options.push({ value: "non-usd", label: "Non-USD", count: nonUsdCount });
  if (counts.has("USD")) options.push({ value: "USD", label: "USD", count: counts.get("USD") ?? 0 });
  for (const peg of pegs) {
    if (peg === "USD" || HIDDEN_INDIVIDUAL_YIELD_PEG_FILTERS.has(peg)) continue;
    options.push({ value: peg, label: getYieldPegLabel(peg), count: counts.get(peg) ?? 0 });
  }
  return options;
}

function buildCurrencyTabOptions(facets: readonly YieldRowFacet[]): YieldFilterOption<YieldPegFilter>[] {
  const counts = countPegs(facets);
  const options: YieldFilterOption<YieldPegFilter>[] = [{ value: "all", label: "All", count: facets.length }];
  for (const peg of CURRENCY_TAB_PEGS) {
    const count = counts.get(peg) ?? 0;
    if (count > 0) options.push({ value: peg, label: getYieldPegLabel(peg), count });
  }
  const audCadCount = CURRENCY_TAB_AUD_CAD_PEGS.reduce((sum, peg) => sum + (counts.get(peg) ?? 0), 0);
  if (audCadCount > 0) options.push({ value: "aud-cad", label: "AUD/CAD", count: audCadCount });
  let otherCount = 0;
  for (const [peg, count] of counts) {
    if (!CURRENCY_TAB_ENUMERATED_PEGS.has(peg)) otherCount += count;
  }
  if (otherCount > 0) options.push({ value: "other", label: "Other", count: otherCount });
  return options;
}

export function buildYieldOptions(facets: readonly YieldRowFacet[]): YieldViewModelOptions {
  const yieldTypeCounts = new Map<YieldType, number>();
  const confidenceCounts = new Map<Exclude<YieldSourceConfidenceFilter, "all">, number>();
  const benchmarkCounts = new Map<YieldBenchmarkKey, number>();
  const depthCounts = new Map<YieldSourceDepthLens, number>();
  const postureCounts = new Map<YieldSourcePosture, number>();
  const safetyCounts = new Map<number, number>();
  const tvlCounts = new Map<number, number>();
  let warningCount = 0;
  let holderYieldCount = 0;
  let lendingOpportunityCount = 0;
  let sourceChangedCount = 0;
  let watchlistCount = 0;
  let watchlistAttentionCount = 0;

  for (const facet of facets) {
    const { row } = facet;
    yieldTypeCounts.set(row.yieldType, (yieldTypeCounts.get(row.yieldType) ?? 0) + 1);
    if (facet.confidenceTier) {
      confidenceCounts.set(facet.confidenceTier, (confidenceCounts.get(facet.confidenceTier) ?? 0) + 1);
    }
    benchmarkCounts.set(facet.benchmarkKey, (benchmarkCounts.get(facet.benchmarkKey) ?? 0) + 1);
    if (facet.hasWarning) warningCount += 1;
    if (facet.opportunity === "lending-opportunity") lendingOpportunityCount += 1;
    else holderYieldCount += 1;
    if (facet.sourceChanged) sourceChangedCount += 1;
    if (facet.inWatchlist) watchlistCount += 1;
    if (facet.needsWatchlistAttention) watchlistAttentionCount += 1;
    depthCounts.set(facet.sourceDepthLens, (depthCounts.get(facet.sourceDepthLens) ?? 0) + 1);
    postureCounts.set(facet.sourcePosture, (postureCounts.get(facet.sourcePosture) ?? 0) + 1);
    if (row.safetyScore !== null) {
      for (const threshold of MIN_SAFETY_OPTIONS) {
        if (row.safetyScore >= threshold) safetyCounts.set(threshold, (safetyCounts.get(threshold) ?? 0) + 1);
      }
    }
    if (row.sourceTvlUsd !== null) {
      for (const threshold of MIN_TVL_OPTIONS) {
        if (row.sourceTvlUsd >= threshold) tvlCounts.set(threshold, (tvlCounts.get(threshold) ?? 0) + 1);
      }
    }
  }

  const thinCount = depthCounts.get("thin") ?? 0;
  const cleanCount = postureCounts.get("clean") ?? 0;
  const watchCount = postureCounts.get("watch") ?? 0;
  return {
    peg: buildPegOptions(facets),
    currencyTabs: buildCurrencyTabOptions(facets),
    yieldType: [
      { value: "all", label: "All types", count: facets.length },
      ...Array.from(yieldTypeCounts.entries())
        .map(([value, count]) => ({ value, label: YIELD_TYPE_LABELS[value] ?? value, count }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    ],
    warnings: [
      { value: "all", label: "All rows", count: facets.length },
      { value: "hide", label: "No warnings", count: facets.length - warningCount },
      { value: "only", label: "Warnings", count: warningCount },
    ],
    minSafety: [
      { value: "all", label: "Any safety", count: facets.length },
      ...MIN_SAFETY_OPTIONS.map((value) => ({
        value: String(value),
        label: `${value}+ safety`,
        count: safetyCounts.get(value) ?? 0,
      })),
    ],
    minTvl: [
      { value: "all", label: "Any TVL", count: facets.length },
      ...MIN_TVL_OPTIONS.map((value) => ({
        value: String(value),
        label: formatTvlOption(value),
        count: tvlCounts.get(value) ?? 0,
      })),
    ],
    sourceConfidence: [
      { value: "all", label: "All confidence", count: facets.length },
      ...SOURCE_CONFIDENCE_ORDER.filter((value) => confidenceCounts.has(value)).map((value) => ({
        value,
        label: YIELD_SOURCE_CONFIDENCE_DEFINITIONS[value].label,
        count: confidenceCounts.get(value) ?? 0,
      })),
    ],
    benchmark: [
      { value: "all", label: "All benchmarks", count: facets.length },
      ...BENCHMARK_ORDER.filter((value) => benchmarkCounts.has(value)).map((value) => ({
        value,
        label: value,
        count: benchmarkCounts.get(value) ?? 0,
      })),
    ],
    opportunity: [
      { value: "all", label: "All opportunities", count: facets.length },
      { value: "holder-yield", label: "Holder yield", count: holderYieldCount },
      { value: "lending-opportunity", label: "External opportunities", count: lendingOpportunityCount },
    ],
    depth: [
      { value: "all", label: "All depth", count: facets.length },
      { value: "hide-thin", label: "Hide thin venues", count: facets.length - thinCount },
      ...(["deep", "moderate", "thin", "unknown"] as const).map((value) => ({
        value,
        label: YIELD_SOURCE_DEPTH_DEFINITIONS[value].label,
        count: depthCounts.get(value) ?? 0,
      })),
    ],
    sourceChanged: [
      { value: "all", label: "All changes", count: facets.length },
      { value: "only", label: "Source changed", count: sourceChangedCount },
      { value: "none", label: "No source change", count: facets.length - sourceChangedCount },
    ],
    sourcePosture: [
      { value: "all", label: "All postures", count: facets.length },
      { value: "clean", label: YIELD_SOURCE_POSTURE_DEFINITIONS.clean.label, count: cleanCount },
      { value: "watch", label: "Clean + watch", count: cleanCount + watchCount },
      { value: "watch-only", label: "Watch only", count: watchCount },
      {
        value: "speculative",
        label: YIELD_SOURCE_POSTURE_DEFINITIONS.speculative.label,
        count: postureCounts.get("speculative") ?? 0,
      },
    ],
    watchlist: [
      { value: "all", label: "All rows", count: facets.length },
      { value: "only", label: "Watchlist only", count: watchlistCount },
    ],
    attention: [
      { value: "all", label: "All rows", count: facets.length },
      { value: "watchlist", label: "Watching needs attention", count: watchlistAttentionCount },
    ],
  };
}

export function rowMatchesYieldFilters(facet: YieldRowFacet, filters: YieldViewModelFilters): boolean {
  return YIELD_FILTER_AXIS_REGISTRY.every((axis) => axis.matches(facet, filters));
}

export function countRowsMatchingFilters(facets: readonly YieldRowFacet[], filters: YieldViewModelFilters): number {
  let count = 0;
  for (const facet of facets) {
    if (rowMatchesYieldFilters(facet, filters)) count += 1;
  }
  return count;
}

export function getYieldComparisonLabel(filters: YieldViewModelFilters): string {
  if (filters.yieldType !== "all") return YIELD_TYPE_LABELS[filters.yieldType] ?? filters.yieldType;
  if (filters.peg !== "all") {
    if (filters.peg === "non-usd") return "Non-USD set";
    if (filters.peg === "aud-cad") return "AUD/CAD set";
    if (filters.peg === "other") return "Other currencies set";
    return `${getYieldPegLabel(filters.peg)} peg`;
  }
  if (filters.benchmark !== "all") return `${filters.benchmark} benchmark`;
  if (filters.warnings === "hide") return "No-warning set";
  if (filters.warnings === "only") return "Warning set";
  if (filters.sourceConfidence !== "all") return `${filters.sourceConfidence} confidence`;
  if (filters.minTvl !== null) return `${formatTvlOption(filters.minTvl)} TVL`;
  if (filters.depth === "hide-thin") return "Non-thin source depth";
  if (filters.depth !== "all") return `${YIELD_SOURCE_DEPTH_DEFINITIONS[filters.depth].label} source depth`;
  if (filters.sourceChanged === "only") return "Rows with source changed";
  if (filters.sourceChanged === "none") return "Rows without source changed";
  if (filters.attention === "watchlist") return "Watched rows needing attention";
  if (filters.sourcePosture === "clean") return "Clean source posture";
  if (filters.sourcePosture === "watch") return "Clean/watch source posture";
  if (filters.sourcePosture === "watch-only") return "Watch source posture";
  if (filters.sourcePosture === "speculative") return "Speculative source posture";
  if (filters.opportunity === "holder-yield") return "Holder yield";
  if (filters.opportunity === "lending-opportunity") return "External opportunities";
  return "Current view";
}

const COHORT_GRADE_BAND: Readonly<Record<ReportCardGrade, string>> = {
  "A+": "A",
  A: "A",
  "A-": "A",
  "B+": "B",
  B: "B",
  "B-": "B",
  "C+": "C",
  C: "C",
  "C-": "C",
  D: "D",
  F: "F",
  NR: "F",
};
const COHORT_MIN_SIZE = 8;
interface CohortBucket {
  scoresDescending: number[];
}

function cohortKey(row: YieldWorkbenchRanking): string | null {
  if (row.safetyGrade === null || row.pharosYieldScore === null) return null;
  const band = COHORT_GRADE_BAND[row.safetyGrade];
  return band === undefined ? null : `${row.yieldType}::${band}`;
}

export function buildYieldCohortIndex(rows: readonly YieldWorkbenchRanking[]): Map<string, CohortBucket> {
  const buckets = new Map<string, CohortBucket>();
  for (const row of rows) {
    if (row.pharosYieldScore === null) continue;
    const key = cohortKey(row);
    if (key === null) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.scoresDescending.push(row.pharosYieldScore);
    else buckets.set(key, { scoresDescending: [row.pharosYieldScore] });
  }
  for (const bucket of buckets.values()) bucket.scoresDescending.sort((left, right) => right - left);
  return buckets;
}

function computeRowCohortPercentile(
  row: YieldWorkbenchRanking,
  cohortIndex: ReadonlyMap<string, CohortBucket>,
): YieldCohortPercentile | null {
  const key = cohortKey(row);
  if (key === null) return null;
  const bucket = cohortIndex.get(key);
  if (!bucket) return null;
  const cohortSize = bucket.scoresDescending.length;
  if (cohortSize < COHORT_MIN_SIZE) return { value: null, cohortSize, cohortKey: key };
  const score = row.pharosYieldScore ?? 0;
  let higherCount = 0;
  for (const candidate of bucket.scoresDescending) {
    if (candidate > score) higherCount += 1;
    else break;
  }
  return {
    value: Math.round(((cohortSize - higherCount) / cohortSize) * 100),
    cohortSize,
    cohortKey: key,
  };
}

export function rankYieldRows(
  facets: readonly YieldRowFacet[],
  filters: YieldViewModelFilters,
  cohortIndex: ReadonlyMap<string, CohortBucket>,
): YieldViewModelRow[] {
  const comparisonLabel = getYieldComparisonLabel(filters);
  return facets.map((facet, index) => ({
    ...facet.row,
    peg: facet.peg,
    viewRank: index + 1,
    rankLabel: `#${index + 1} in ${comparisonLabel}`,
    opportunity: facet.opportunity,
    sourceDepthLens: facet.sourceDepthLens,
    sourcePosture: facet.sourcePosture,
    cohortPercentile: computeRowCohortPercentile(facet.row, cohortIndex),
  }));
}
