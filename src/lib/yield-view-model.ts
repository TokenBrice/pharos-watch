import { getYieldRankingBenchmarkKey, resolveYieldScatterBenchmarkFrame } from "@/lib/yield-benchmark";
import {
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_DEPTH_DEFINITIONS,
  YIELD_SOURCE_POSTURE_DEFINITIONS,
  classifyYieldSourceDepth,
  classifyYieldSourcePosture,
  type YieldSourceDepthLens,
  type YieldSourcePosture,
} from "@/lib/yield-source-risk";
import {
  BENCHMARK_ORDER,
  CURRENCY_TAB_AUD_CAD_PEGS,
  CURRENCY_TAB_ENUMERATED_PEGS,
  CURRENCY_TAB_PEGS,
  DEFAULT_FILTERS,
  EXTERNAL_OPPORTUNITY_YIELD_TYPES,
  HIDDEN_INDIVIDUAL_YIELD_PEG_FILTERS,
  MIN_SAFETY_OPTIONS,
  MIN_TVL_OPTIONS,
  SOURCE_CONFIDENCE_ORDER,
  YIELD_PRESET_SPECS,
  YIELD_RISK_BUDGET_SPECS,
  compareYieldPegs,
  getYieldPegLabel,
  type YieldBenchmarkFilter,
  type YieldDepthFilter,
  type YieldOpportunityFilter,
  type YieldPegFilter,
  type YieldPresetSpec,
  type YieldSourceChangedFilter,
  type YieldSourceConfidenceFilter,
  type YieldSourcePostureFilter,
  type YieldTrendingFilter,
  type YieldViewModelFilters,
  type YieldViewModelUrlParams,
  type YieldWarningsFilter,
  type YieldWatchlistFilter,
  type YieldRiskBudgetSpec,
  type YieldFilterOption,
} from "@/lib/yield-view-config";
import { normalizeFilters } from "@/lib/yield-view-url";
import { YIELD_TYPE_LABELS } from "@shared/lib/classification";
import { median } from "@shared/lib/stats";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import {
  type PegCurrency,
  type ReportCardGrade,
  type YieldBenchmarkKey,
  type YieldBenchmarkMeta,
  type YieldBenchmarkRegistry,
  type YieldRanking,
  type YieldType,
} from "@shared/types";

export type {
  YieldPegFilter,
  YieldWarningsFilter,
  YieldSourceConfidenceFilter,
  YieldBenchmarkFilter,
  YieldOpportunityFilter,
  YieldDepthFilter,
  YieldSourceChangedFilter,
  YieldSourcePostureFilter,
  YieldTrendingFilter,
  YieldWatchlistFilter,
  YieldViewModelFilters,
  YieldViewModelUrlParams,
  YieldFilterOption,
};

export interface YieldViewModelOptions {
  peg: YieldFilterOption<YieldPegFilter>[];
  currencyTabs: YieldFilterOption<YieldPegFilter>[];
  yieldType: YieldFilterOption<YieldType | "all">[];
  warnings: YieldFilterOption<YieldWarningsFilter>[];
  minSafety: YieldFilterOption[];
  minTvl: YieldFilterOption[];
  sourceConfidence: YieldFilterOption<YieldSourceConfidenceFilter>[];
  benchmark: YieldFilterOption<YieldBenchmarkFilter>[];
  opportunity: YieldFilterOption<YieldOpportunityFilter>[];
  depth: YieldFilterOption<YieldDepthFilter>[];
  sourceChanged: YieldFilterOption<YieldSourceChangedFilter>[];
  sourcePosture: YieldFilterOption<YieldSourcePostureFilter>[];
  watchlist: YieldFilterOption<YieldWatchlistFilter>[];
}

export type YieldPresetKey =
  | "treasury-grade"
  | "best-dollar"
  | "non-usd"
  | "new-rising"
  | "watchlist-warnings";

export interface YieldPresetState {
  key: YieldPresetKey;
  label: string;
  description: string;
  count: number;
  active: boolean;
  overrides: Partial<YieldViewModelFilters>;
}

export type YieldRiskBudgetKey =
  | "conservative"
  | "balanced"
  | "opportunistic"
  | "all";

export interface YieldRiskBudgetStop {
  key: YieldRiskBudgetKey;
  label: string;
  description: string;
  count: number;
  active: boolean;
  overrides: Partial<YieldViewModelFilters>;
}

export interface YieldRiskBudgetState {
  matching: YieldRiskBudgetKey | null;
  stops: YieldRiskBudgetStop[];
}

export interface YieldEmptyStateSuggestion {
  filterKey: keyof YieldViewModelFilters;
  targetValue: string | null;
  gain: number;
  label: string;
}

export interface YieldCohortPercentile {
  value: number | null;
  cohortSize: number;
  cohortKey: string;
}

export type YieldViewModelRow = YieldRanking & {
  peg: PegCurrency | null;
  viewRank: number;
  rankLabel: string;
  opportunity: Exclude<YieldOpportunityFilter, "all">;
  sourceDepthLens: YieldSourceDepthLens;
  sourcePosture: YieldSourcePosture;
  cohortPercentile: YieldCohortPercentile | null;
};

interface YieldRowFacet {
  row: YieldRanking;
  peg: PegCurrency | null;
  benchmarkKey: YieldBenchmarkKey;
  opportunity: Exclude<YieldOpportunityFilter, "all">;
  sourceDepthLens: YieldSourceDepthLens;
  sourcePosture: YieldSourcePosture;
  confidenceTier: Exclude<YieldSourceConfidenceFilter, "all"> | null;
  hasWarning: boolean;
  sourceChanged: boolean;
  isRising: boolean;
  inWatchlist: boolean;
}

export interface YieldViewModelStats {
  avgApy: number;
  medianApy: number;
  topYield: { symbol: string; apy: number; safetyGrade: string | null } | null;
  bestPys: { name: string; symbol: string; score: number } | null;
  referenceBenchmark: YieldBenchmarkMeta | null;
  hasMixedBenchmarks: boolean;
  usesDefaultBenchmarkFrame: boolean;
  sharedBenchmarkKey: YieldBenchmarkKey | null;
  warningRowCount: number;
  nullSafetyCount: number;
  nullTvlCount: number;
}

export interface YieldViewModel {
  filters: YieldViewModelFilters;
  options: YieldViewModelOptions;
  normalizedParams: Record<keyof YieldViewModelUrlParams, string | null>;
  invalidParamKeys: Array<keyof YieldViewModelUrlParams>;
  totalRows: number;
  visibleRows: YieldViewModelRow[];
  emptyState: {
    isEmpty: boolean;
    title: string;
    description: string;
    suggestions: YieldEmptyStateSuggestion[];
  };
  comparisonLabel: string;
  stats: YieldViewModelStats;
  presets: YieldPresetState[];
  matchingPreset: YieldPresetKey | null;
  riskBudget: YieldRiskBudgetState;
}

export interface BuildYieldViewModelOptions {
  benchmarks?: YieldBenchmarkRegistry | null;
  fallbackBenchmark?: YieldBenchmarkMeta | null;
  watchlistIds?: ReadonlySet<string> | null;
}

// Static filter-config tables (peg orderings, currency tabs, presets, risk-budget
// specs, default filter state) live in `yield-view-config.ts`. The exports below
// are re-surfaced here so existing consumers keep importing from this module.
export {
  YIELD_PRESET_SPECS,
  YIELD_RISK_BUDGET_MIN_SAFETY,
  YIELD_RISK_BUDGET_SPECS,
} from "@/lib/yield-view-config";

function formatTvlOption(value: number): string {
  if (value >= 1_000_000_000) return `$${value / 1_000_000_000}B+`;
  if (value >= 1_000_000) return `$${value / 1_000_000}M+`;
  return `$${value.toLocaleString()}+`;
}

function getYieldRankingPeg(rankingId: string): PegCurrency | null {
  return TRACKED_META_BY_ID.get(rankingId)?.flags.pegCurrency ?? null;
}

function getOpportunity(row: YieldRanking): Exclude<YieldOpportunityFilter, "all"> {
  return EXTERNAL_OPPORTUNITY_YIELD_TYPES.has(row.yieldType)
    ? "lending-opportunity"
    : "holder-yield";
}

function getSourceDepthLens(row: YieldRanking): YieldSourceDepthLens {
  return classifyYieldSourceDepth({
    sourceRisk: row.sourceRisk,
    sourceTvlUsd: row.sourceTvlUsd,
  });
}

function getSourcePosture(row: YieldRanking, sourceDepthLens: YieldSourceDepthLens): YieldSourcePosture {
  return classifyYieldSourcePosture({
    sourceRisk: row.sourceRisk,
    sourceTvlUsd: row.sourceTvlUsd,
    sourceDepthLens,
    sourceChanged: row.provenance?.sourceSwitch ?? false,
    warningSignals: row.warningSignals,
  });
}

function isRowRising(row: YieldRanking): boolean {
  const observations = row.sourceRisk?.observationCount30d;
  return row.currentApy > row.apy30d && observations != null && observations >= 7;
}

function buildYieldRowFacet(row: YieldRanking, watchlistIds: ReadonlySet<string> | null): YieldRowFacet {
  const sourceDepthLens = getSourceDepthLens(row);
  return {
    row,
    peg: getYieldRankingPeg(row.id),
    benchmarkKey: getYieldRankingBenchmarkKey(row),
    opportunity: getOpportunity(row),
    sourceDepthLens,
    sourcePosture: getSourcePosture(row, sourceDepthLens),
    confidenceTier: row.provenance?.confidenceTier ?? null,
    hasWarning: row.warningSignals.length > 0,
    sourceChanged: row.provenance?.sourceSwitch === true,
    isRising: isRowRising(row),
    inWatchlist: watchlistIds != null && watchlistIds.has(row.id),
  };
}

function buildYieldRowFacets(rows: readonly YieldRanking[], watchlistIds: ReadonlySet<string> | null): YieldRowFacet[] {
  return rows.map((row) => buildYieldRowFacet(row, watchlistIds));
}

function matchesSearch(row: YieldRanking, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return normalized.length === 0
    ? true
    : row.symbol.toLowerCase().includes(normalized) || row.name.toLowerCase().includes(normalized);
}

function matchesPeg(peg: PegCurrency | null, filter: YieldPegFilter): boolean {
  if (filter === "all") return true;
  if (!peg) return false;
  if (filter === "non-usd") return peg !== "USD";
  if (filter === "aud-cad") return peg === "AUD" || peg === "CAD";
  if (filter === "other") return !CURRENCY_TAB_ENUMERATED_PEGS.has(peg);
  return peg === filter;
}

function countPegs(facets: readonly YieldRowFacet[]): Map<PegCurrency, number> {
  const pegCounts = new Map<PegCurrency, number>();
  for (const facet of facets) {
    if (facet.peg) {
      pegCounts.set(facet.peg, (pegCounts.get(facet.peg) ?? 0) + 1);
    }
  }
  return pegCounts;
}

function buildPegOptions(facets: readonly YieldRowFacet[]): YieldFilterOption<YieldPegFilter>[] {
  const pegCounts = countPegs(facets);
  const pegs = Array.from(pegCounts.keys()).sort(compareYieldPegs);
  const nonUsdCount = pegs.reduce((sum, peg) => sum + (peg !== "USD" ? pegCounts.get(peg) ?? 0 : 0), 0);
  const options: YieldFilterOption<YieldPegFilter>[] = [
    { value: "all", label: "All", count: facets.length },
  ];

  if (nonUsdCount > 0) options.push({ value: "non-usd", label: "Non-USD", count: nonUsdCount });
  if (pegCounts.has("USD")) options.push({ value: "USD", label: "USD", count: pegCounts.get("USD") ?? 0 });

  for (const peg of pegs) {
    if (peg === "USD" || HIDDEN_INDIVIDUAL_YIELD_PEG_FILTERS.has(peg)) continue;
    options.push({ value: peg, label: getYieldPegLabel(peg), count: pegCounts.get(peg) ?? 0 });
  }

  return options;
}

// Tab-strip option set: a curated, conditional list of currency tabs for the
// leaderboard. Tabs only appear when at least one row matches.
function buildCurrencyTabOptions(facets: readonly YieldRowFacet[]): YieldFilterOption<YieldPegFilter>[] {
  const pegCounts = countPegs(facets);
  const options: YieldFilterOption<YieldPegFilter>[] = [
    { value: "all", label: "All", count: facets.length },
  ];

  for (const peg of CURRENCY_TAB_PEGS) {
    const count = pegCounts.get(peg) ?? 0;
    if (count > 0) options.push({ value: peg, label: getYieldPegLabel(peg), count });
  }

  const audCadCount = CURRENCY_TAB_AUD_CAD_PEGS.reduce(
    (sum, peg) => sum + (pegCounts.get(peg) ?? 0),
    0,
  );
  if (audCadCount > 0) options.push({ value: "aud-cad", label: "AUD/CAD", count: audCadCount });

  let otherCount = 0;
  for (const [peg, count] of pegCounts) {
    if (!CURRENCY_TAB_ENUMERATED_PEGS.has(peg)) otherCount += count;
  }
  if (otherCount > 0) options.push({ value: "other", label: "Other", count: otherCount });

  return options;
}

function buildOptions(facets: readonly YieldRowFacet[]): YieldViewModelOptions {
  const yieldTypeCounts = new Map<YieldType, number>();
  const confidenceCounts = new Map<Exclude<YieldSourceConfidenceFilter, "all">, number>();
  const benchmarkCounts = new Map<YieldBenchmarkKey, number>();
  let warningCount = 0;
  let noWarningCount = 0;
  let holderYieldCount = 0;
  let lendingOpportunityCount = 0;
  let sourceChangedCount = 0;
  let sourceUnchangedCount = 0;
  let watchlistCount = 0;
  const depthCounts = new Map<YieldSourceDepthLens, number>();
  const sourcePostureCounts = new Map<YieldSourcePosture, number>();
  // Fold minSafety/minTvl/hide-thin threshold counts into the main loop to
  // avoid 8 redundant O(n) filter passes per buildOptions call (vm-3).
  const safetyCounts = new Map<number, number>();
  const tvlCounts = new Map<number, number>();

  for (const facet of facets) {
    const row = facet.row;
    yieldTypeCounts.set(row.yieldType, (yieldTypeCounts.get(row.yieldType) ?? 0) + 1);

    if (facet.confidenceTier) {
      confidenceCounts.set(facet.confidenceTier, (confidenceCounts.get(facet.confidenceTier) ?? 0) + 1);
    }

    benchmarkCounts.set(facet.benchmarkKey, (benchmarkCounts.get(facet.benchmarkKey) ?? 0) + 1);

    if (facet.hasWarning) warningCount += 1;
    else noWarningCount += 1;

    if (facet.opportunity === "lending-opportunity") lendingOpportunityCount += 1;
    else holderYieldCount += 1;

    if (facet.sourceChanged) sourceChangedCount += 1;
    else sourceUnchangedCount += 1;

    if (facet.inWatchlist) watchlistCount += 1;

    depthCounts.set(facet.sourceDepthLens, (depthCounts.get(facet.sourceDepthLens) ?? 0) + 1);
    sourcePostureCounts.set(facet.sourcePosture, (sourcePostureCounts.get(facet.sourcePosture) ?? 0) + 1);

    if (row.safetyScore !== null) {
      for (const threshold of MIN_SAFETY_OPTIONS) {
        if (row.safetyScore >= threshold) {
          safetyCounts.set(threshold, (safetyCounts.get(threshold) ?? 0) + 1);
        }
      }
    }
    if (row.sourceTvlUsd !== null) {
      for (const threshold of MIN_TVL_OPTIONS) {
        if (row.sourceTvlUsd >= threshold) {
          tvlCounts.set(threshold, (tvlCounts.get(threshold) ?? 0) + 1);
        }
      }
    }
  }

  // hide-thin = all facets that are not "thin"; derive from depthCounts to avoid an extra pass.
  const hideThinCount = facets.length - (depthCounts.get("thin") ?? 0);
  const cleanPostureCount = sourcePostureCounts.get("clean") ?? 0;
  const watchPostureCount = sourcePostureCounts.get("watch") ?? 0;
  const cleanOrWatchPostureCount = cleanPostureCount + watchPostureCount;

  return {
    peg: buildPegOptions(facets),
    currencyTabs: buildCurrencyTabOptions(facets),
    yieldType: [
      { value: "all", label: "All types", count: facets.length },
      ...Array.from(yieldTypeCounts.entries())
        .map(([value, count]) => ({ value, label: YIELD_TYPE_LABELS[value] ?? value, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    ],
    warnings: [
      { value: "all", label: "All rows", count: facets.length },
      { value: "hide", label: "No warnings", count: noWarningCount },
      { value: "only", label: "Warnings", count: warningCount },
    ],
    minSafety: [
      { value: "all", label: "Any safety", count: facets.length },
      ...MIN_SAFETY_OPTIONS.map((minSafety) => ({
        value: String(minSafety),
        label: `${minSafety}+ safety`,
        count: safetyCounts.get(minSafety) ?? 0,
      })),
    ],
    minTvl: [
      { value: "all", label: "Any TVL", count: facets.length },
      ...MIN_TVL_OPTIONS.map((minTvl) => ({
        value: String(minTvl),
        label: formatTvlOption(minTvl),
        count: tvlCounts.get(minTvl) ?? 0,
      })),
    ],
    sourceConfidence: [
      { value: "all", label: "All confidence", count: facets.length },
      ...SOURCE_CONFIDENCE_ORDER
        .filter((value) => confidenceCounts.has(value))
        .map((value) => ({
          value,
          label: YIELD_SOURCE_CONFIDENCE_DEFINITIONS[value].label,
          count: confidenceCounts.get(value) ?? 0,
        })),
    ],
    benchmark: [
      { value: "all", label: "All benchmarks", count: facets.length },
      ...BENCHMARK_ORDER
        .filter((value) => benchmarkCounts.has(value))
        .map((value) => ({ value, label: value, count: benchmarkCounts.get(value) ?? 0 })),
    ],
    opportunity: [
      { value: "all", label: "All opportunities", count: facets.length },
      { value: "holder-yield", label: "Holder yield", count: holderYieldCount },
      { value: "lending-opportunity", label: "External opportunities", count: lendingOpportunityCount },
    ],
    depth: [
      { value: "all", label: "All depth", count: facets.length },
      {
        value: "hide-thin",
        label: "Hide thin venues",
        count: hideThinCount,
      },
      ...(["deep", "moderate", "thin", "unknown"] as const).map((value) => ({
        value,
        label: YIELD_SOURCE_DEPTH_DEFINITIONS[value].label,
        count: depthCounts.get(value) ?? 0,
      })),
    ],
    sourceChanged: [
      { value: "all", label: "All changes", count: facets.length },
      { value: "only", label: "Source changed", count: sourceChangedCount },
      { value: "none", label: "No source change", count: sourceUnchangedCount },
    ],
    sourcePosture: [
      { value: "all", label: "All postures", count: facets.length },
      { value: "clean", label: YIELD_SOURCE_POSTURE_DEFINITIONS.clean.label, count: cleanPostureCount },
      { value: "watch", label: "Clean + watch", count: cleanOrWatchPostureCount },
      {
        value: "speculative",
        label: YIELD_SOURCE_POSTURE_DEFINITIONS.speculative.label,
        count: sourcePostureCounts.get("speculative") ?? 0,
      },
    ],
    watchlist: [
      { value: "all", label: "All rows", count: facets.length },
      { value: "only", label: "Watchlist only", count: watchlistCount },
    ],
  };
}

function countRowsMatchingFilters(facets: readonly YieldRowFacet[], filters: YieldViewModelFilters): number {
  let count = 0;
  for (const facet of facets) {
    if (rowMatchesFilters(facet, filters)) count += 1;
  }
  return count;
}

function rowMatchesFilters(facet: YieldRowFacet, filters: YieldViewModelFilters): boolean {
  return YIELD_FILTER_AXIS_REGISTRY.every((axis) => axis.matches(facet, filters));
}

function getComparisonLabel(filters: YieldViewModelFilters): string {
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
  if (filters.sourcePosture === "clean") return "Clean source posture";
  if (filters.sourcePosture === "watch") return "Clean/watch source posture";
  if (filters.sourcePosture === "speculative") return "Speculative source posture";
  if (filters.opportunity === "holder-yield") return "Holder yield";
  if (filters.opportunity === "lending-opportunity") return "External opportunities";
  return "Current view";
}

function rankRows(
  facets: readonly YieldRowFacet[],
  filters: YieldViewModelFilters,
  cohortIndex: ReadonlyMap<string, CohortBucket>,
): YieldViewModelRow[] {
  const comparisonLabel = getComparisonLabel(filters);
  return facets.map((facet, index) => {
    const row = facet.row;
    const rank = index + 1;
    return {
      ...row,
      peg: facet.peg,
      viewRank: rank,
      rankLabel: `#${rank} in ${comparisonLabel}`,
      opportunity: facet.opportunity,
      sourceDepthLens: facet.sourceDepthLens,
      sourcePosture: facet.sourcePosture,
      cohortPercentile: computeRowCohortPercentile(row, cohortIndex),
    };
  });
}

// Cohort = yieldType + safety band. Bands collapse adjacent letter grades
// to keep cohort sizes meaningful; A- is grouped with A+/A. F and NR are
// pooled because NR almost always behaves as a worst-case bucket.
const COHORT_GRADE_BAND: Readonly<Record<ReportCardGrade, string>> = {
  "A+": "A",
  "A": "A",
  "A-": "A",
  "B+": "B",
  "B": "B",
  "B-": "B",
  "C+": "C",
  "C": "C",
  "C-": "C",
  "D": "D",
  "F": "F",
  "NR": "F",
};
const COHORT_MIN_SIZE = 8;

interface CohortBucket {
  scoresDescending: number[];
}

function cohortKey(row: YieldRanking): string | null {
  if (row.safetyGrade === null) return null;
  if (row.pharosYieldScore === null) return null;
  const band = COHORT_GRADE_BAND[row.safetyGrade];
  if (band === undefined) return null;
  return `${row.yieldType}::${band}`;
}

function buildCohortIndex(rows: readonly YieldRanking[]): Map<string, CohortBucket> {
  const buckets = new Map<string, CohortBucket>();
  for (const row of rows) {
    // cohortKey returns null when pharosYieldScore is null, so score is non-null here.
    const score = row.pharosYieldScore;
    if (score === null) continue;
    const key = cohortKey(row);
    if (key === null) continue;
    const existing = buckets.get(key);
    if (existing) {
      existing.scoresDescending.push(score);
    } else {
      buckets.set(key, { scoresDescending: [score] });
    }
  }
  for (const bucket of buckets.values()) {
    bucket.scoresDescending.sort((a, b) => b - a);
  }
  return buckets;
}

function computeRowCohortPercentile(
  row: YieldRanking,
  cohortIndex: ReadonlyMap<string, CohortBucket>,
): YieldCohortPercentile | null {
  const key = cohortKey(row);
  if (key === null) return null;
  const bucket = cohortIndex.get(key);
  if (!bucket) return null;
  const cohortSize = bucket.scoresDescending.length;
  if (cohortSize < COHORT_MIN_SIZE) {
    return { value: null, cohortSize, cohortKey: key };
  }
  // cohortKey returns null when pharosYieldScore is null; key being non-null guarantees score is non-null.
  const score = row.pharosYieldScore ?? 0;
  // Rank: how many cohort members have a strictly higher PYS, plus 1 for self.
  // Percentile reported as "top X%" by mapping rank 1 → 100, rank N → ~0.
  const sorted = bucket.scoresDescending;
  let higherCount = 0;
  for (const candidate of sorted) {
    if (candidate > score) higherCount += 1;
    else break;
  }
  const percentile = Math.round(((cohortSize - higherCount) / cohortSize) * 100);
  return { value: percentile, cohortSize, cohortKey: key };
}

function buildStats(
  rows: readonly YieldViewModelRow[],
  options: BuildYieldViewModelOptions,
): YieldViewModelStats {
  const benchmarkFrame = resolveYieldScatterBenchmarkFrame({
    rankings: [...rows],
    benchmarks: options.benchmarks,
    fallbackBenchmark: options.fallbackBenchmark ?? null,
  });

  let tvlSum = 0;
  let weightedApySum = 0;
  let unweightedApySum = 0;
  let bestPys: YieldViewModelStats["bestPys"] = null;
  let topYield: YieldViewModelStats["topYield"] = null;
  let warningRowCount = 0;
  let nullSafetyCount = 0;
  let nullTvlCount = 0;
  const apys: number[] = [];

  for (const row of rows) {
    const tvl = row.sourceTvlUsd ?? 0;
    if (tvl > 0) {
      tvlSum += tvl;
      weightedApySum += row.apy30d * tvl;
    }
    unweightedApySum += row.apy30d;
    apys.push(row.apy30d);
    if (row.pharosYieldScore !== null && (bestPys === null || row.pharosYieldScore > bestPys.score)) {
      bestPys = { name: row.name, symbol: row.symbol, score: row.pharosYieldScore };
    }
    if (topYield === null || row.apy30d > topYield.apy) {
      topYield = { symbol: row.symbol, apy: row.apy30d, safetyGrade: row.safetyGrade };
    }
    if (row.warningSignals.length > 0) warningRowCount += 1;
    if (row.safetyScore === null) nullSafetyCount += 1;
    if (row.sourceTvlUsd === null) nullTvlCount += 1;
  }

  const medianApy = median(apys) ?? 0;

  return {
    avgApy: rows.length === 0 ? 0 : tvlSum > 0 ? weightedApySum / tvlSum : unweightedApySum / rows.length,
    medianApy,
    topYield,
    bestPys,
    warningRowCount,
    nullSafetyCount,
    nullTvlCount,
    ...benchmarkFrame,
  };
}

function buildEmptyState(
  totalRows: number,
  visibleRows: readonly YieldViewModelRow[],
  facets: readonly YieldRowFacet[],
  filters: YieldViewModelFilters,
  options: YieldViewModelOptions,
): YieldViewModel["emptyState"] {
  if (visibleRows.length > 0) {
    return {
      isEmpty: false,
      title: "",
      description: "",
      suggestions: [],
    };
  }

  const suggestions =
    totalRows > 0 ? buildEmptyStateSuggestions(facets, filters, options) : [];

  return {
    isEmpty: true,
    title: totalRows === 0 ? "No yield rows published" : "No rows match this view",
    description: totalRows === 0
      ? "The latest payload did not include any yield rankings."
      : "Reset one or more filters to broaden the comparable set.",
    suggestions,
  };
}

const EMPTY_STATE_SUGGESTION_LIMIT = 3;

function describeOption<T extends string>(
  options: ReadonlyArray<YieldFilterOption<T>>,
  value: T | string,
): string {
  return options.find((option) => option.value === value)?.label ?? String(value);
}

interface YieldFilterAxisDescriptor {
  key: keyof YieldViewModelFilters;
  isActive: (filters: YieldViewModelFilters) => boolean;
  matches: (facet: YieldRowFacet, filters: YieldViewModelFilters) => boolean;
  // Empty-state chip label ("Drop type filter (Lending Opp.)") + URL reset target.
  describeRelax: (filters: YieldViewModelFilters, options: YieldViewModelOptions) => string;
  relaxTargetValue: string | null;
  // Active-filter summary chip label. Undefined = axis has its own UI elsewhere
  // (currency tabs / search box / trending toggle) and shouldn't appear as a chip.
  describeActive?: (filters: YieldViewModelFilters, options: YieldViewModelOptions) => string;
}

// Single source of truth for every filter axis. Active-summary order = array order;
// `listFilterRelaxations` walks the same array. Adding a 13th axis = one entry, both
// surfaces update — guards against drift (watchlist was previously in summary but not
// in relax suggestions).
export const YIELD_FILTER_AXIS_REGISTRY: readonly YieldFilterAxisDescriptor[] = [
  {
    key: "yieldType",
    isActive: (f) => f.yieldType !== DEFAULT_FILTERS.yieldType,
    matches: (facet, f) => f.yieldType === "all" || facet.row.yieldType === f.yieldType,
    describeRelax: (f, o) => `Drop type filter (${describeOption(o.yieldType, f.yieldType)})`,
    relaxTargetValue: null,
    describeActive: (f, o) => `Type: ${describeOption(o.yieldType, f.yieldType)}`,
  },
  {
    key: "warnings",
    isActive: (f) => f.warnings !== DEFAULT_FILTERS.warnings,
    matches: (facet, f) => {
      if (f.warnings === "hide") return !facet.hasWarning;
      if (f.warnings === "only") return facet.hasWarning;
      return true;
    },
    describeRelax: (f, o) => `Drop warnings filter (${describeOption(o.warnings, f.warnings)})`,
    relaxTargetValue: null,
    describeActive: (f, o) => describeOption(o.warnings, f.warnings),
  },
  {
    key: "watchlist",
    isActive: (f) => f.watchlist !== DEFAULT_FILTERS.watchlist,
    matches: (facet, f) => f.watchlist !== "only" || facet.inWatchlist,
    describeRelax: () => `Drop watchlist-only filter`,
    relaxTargetValue: null,
    describeActive: () => "Watching only",
  },
  {
    key: "minSafety",
    isActive: (f) => f.minSafety !== DEFAULT_FILTERS.minSafety,
    matches: (facet, f) => f.minSafety === null || (facet.row.safetyScore !== null && facet.row.safetyScore >= f.minSafety),
    describeRelax: (f) => `Drop ${f.minSafety}+ safety floor`,
    relaxTargetValue: null,
    describeActive: (f, o) => describeOption(o.minSafety, String(f.minSafety)),
  },
  {
    key: "minTvl",
    isActive: (f) => f.minTvl !== DEFAULT_FILTERS.minTvl,
    matches: (facet, f) => f.minTvl === null || (facet.row.sourceTvlUsd !== null && facet.row.sourceTvlUsd >= f.minTvl),
    describeRelax: (f) => `Drop ${formatTvlOption(f.minTvl!)} TVL floor`,
    relaxTargetValue: null,
    describeActive: (f, o) => describeOption(o.minTvl, String(f.minTvl)),
  },
  {
    key: "depth",
    isActive: (f) => f.depth !== DEFAULT_FILTERS.depth,
    matches: (facet, f) => {
      if (f.depth === "all") return true;
      if (f.depth === "hide-thin") return facet.sourceDepthLens !== "thin";
      return facet.sourceDepthLens === f.depth;
    },
    describeRelax: (f, o) => `Drop depth filter (${describeOption(o.depth, f.depth)})`,
    relaxTargetValue: null,
    describeActive: (f, o) => `Depth: ${describeOption(o.depth, f.depth)}`,
  },
  {
    key: "sourceChanged",
    isActive: (f) => f.sourceChanged !== DEFAULT_FILTERS.sourceChanged,
    matches: (facet, f) => {
      if (f.sourceChanged === "only") return facet.sourceChanged;
      if (f.sourceChanged === "none") return !facet.sourceChanged;
      return true;
    },
    describeRelax: (f, o) => `Drop source-changed filter (${describeOption(o.sourceChanged, f.sourceChanged)})`,
    relaxTargetValue: null,
    describeActive: (f, o) => describeOption(o.sourceChanged, f.sourceChanged),
  },
  {
    key: "sourcePosture",
    isActive: (f) => f.sourcePosture !== DEFAULT_FILTERS.sourcePosture,
    matches: (facet, f) => {
      if (f.sourcePosture === "all") return true;
      if (f.sourcePosture === "clean") return facet.sourcePosture === "clean";
      if (f.sourcePosture === "watch") return facet.sourcePosture === "clean" || facet.sourcePosture === "watch";
      return facet.sourcePosture === "speculative";
    },
    describeRelax: (f, o) => `Drop source posture filter (${describeOption(o.sourcePosture, f.sourcePosture)})`,
    relaxTargetValue: null,
    describeActive: (f, o) => `Source: ${describeOption(o.sourcePosture, f.sourcePosture)}`,
  },
  {
    key: "sourceConfidence",
    isActive: (f) => f.sourceConfidence !== DEFAULT_FILTERS.sourceConfidence,
    matches: (facet, f) => f.sourceConfidence === "all" || facet.confidenceTier === f.sourceConfidence,
    describeRelax: (f, o) => `Drop confidence filter (${describeOption(o.sourceConfidence, f.sourceConfidence)})`,
    relaxTargetValue: null,
    describeActive: (f, o) => `Confidence: ${describeOption(o.sourceConfidence, f.sourceConfidence)}`,
  },
  {
    key: "benchmark",
    isActive: (f) => f.benchmark !== DEFAULT_FILTERS.benchmark,
    matches: (facet, f) => f.benchmark === "all" || facet.benchmarkKey === f.benchmark,
    describeRelax: (f, o) => `Drop benchmark filter (${describeOption(o.benchmark, f.benchmark)})`,
    relaxTargetValue: null,
    describeActive: (f, o) => `Benchmark: ${describeOption(o.benchmark, f.benchmark)}`,
  },
  {
    key: "opportunity",
    isActive: (f) => f.opportunity !== DEFAULT_FILTERS.opportunity,
    matches: (facet, f) => f.opportunity === "all" || facet.opportunity === f.opportunity,
    describeRelax: (f, o) => `Drop opportunity filter (${describeOption(o.opportunity, f.opportunity)})`,
    relaxTargetValue: null,
    describeActive: (f, o) => describeOption(o.opportunity, f.opportunity),
  },
  // Axes that DON'T render as active-summary chips — they have dedicated UI
  // (currency tabs, search box, trending toggle), but the empty state still
  // proposes relaxing them so users can recover rows in one click.
  {
    key: "peg",
    isActive: (f) => f.peg !== DEFAULT_FILTERS.peg,
    matches: (facet, f) => matchesPeg(facet.peg, f.peg),
    describeRelax: (f, o) => `Drop peg filter (${describeOption(o.peg, f.peg)})`,
    relaxTargetValue: null,
  },
  {
    key: "q",
    isActive: (f) => f.q !== DEFAULT_FILTERS.q,
    matches: (facet, f) => matchesSearch(facet.row, f.q),
    describeRelax: (f) => `Clear search "${f.q}"`,
    relaxTargetValue: null,
  },
  {
    key: "trending",
    isActive: (f) => f.trending !== DEFAULT_FILTERS.trending,
    matches: (facet, f) => f.trending !== "rising" || facet.isRising,
    describeRelax: () => `Drop trending filter`,
    relaxTargetValue: null,
  },
];

function buildEmptyStateSuggestions(
  facets: readonly YieldRowFacet[],
  filters: YieldViewModelFilters,
  options: YieldViewModelOptions,
): YieldEmptyStateSuggestion[] {
  const scored: YieldEmptyStateSuggestion[] = [];
  for (const axis of YIELD_FILTER_AXIS_REGISTRY) {
    if (!axis.isActive(filters)) continue;
    const relaxed: YieldViewModelFilters = {
      ...filters,
      [axis.key]: DEFAULT_FILTERS[axis.key],
    } as YieldViewModelFilters;
    const gain = countRowsMatchingFilters(facets, relaxed);
    if (gain > 0) {
      scored.push({
        filterKey: axis.key,
        targetValue: axis.relaxTargetValue,
        gain,
        label: axis.describeRelax(filters, options),
      });
    }
  }
  scored.sort((a, b) => b.gain - a.gain);
  return scored.slice(0, EMPTY_STATE_SUGGESTION_LIMIT);
}

function applyOverrides(overrides: Partial<YieldViewModelFilters>): YieldViewModelFilters {
  return { ...DEFAULT_FILTERS, ...overrides };
}

function presetFilters(spec: YieldPresetSpec): YieldViewModelFilters {
  return applyOverrides(spec.overrides);
}

function filtersMatchPreset(filters: YieldViewModelFilters, spec: YieldPresetSpec): boolean {
  const target = presetFilters(spec);
  return (Object.keys(DEFAULT_FILTERS) as Array<keyof YieldViewModelFilters>).every(
    (key) => filters[key] === target[key],
  );
}

function buildPresets(
  facets: readonly YieldRowFacet[],
  filters: YieldViewModelFilters,
): { presets: YieldPresetState[]; matchingPreset: YieldPresetKey | null } {
  let matchingPreset: YieldPresetKey | null = null;
  const presets = YIELD_PRESET_SPECS.map((spec) => {
    const active = filtersMatchPreset(filters, spec);
    if (active) matchingPreset = spec.key;
    return {
      key: spec.key,
      label: spec.label,
      description: spec.description,
      count: countRowsMatchingFilters(facets, presetFilters(spec)),
      active,
      overrides: spec.overrides,
    } satisfies YieldPresetState;
  });
  return { presets, matchingPreset };
}

const RISK_BUDGET_FILTER_KEYS: readonly (keyof YieldViewModelFilters)[] = [
  "minSafety",
  "depth",
  "sourcePosture",
  "sourceConfidence",
  "warnings",
];

function riskBudgetTargetFilters(spec: YieldRiskBudgetSpec): YieldViewModelFilters {
  // A risk-budget stop only constrains the four risk-axis keys; other filters
  // are normalized to defaults for the purpose of computing the stop's count.
  const riskOverrides = Object.fromEntries(
    RISK_BUDGET_FILTER_KEYS.filter((k) => k in spec.overrides).map((k) => [k, spec.overrides[k]]),
  ) as Partial<YieldViewModelFilters>;
  return applyOverrides(riskOverrides);
}

function filtersMatchRiskBudget(
  filters: YieldViewModelFilters,
  spec: YieldRiskBudgetSpec,
): boolean {
  for (const key of RISK_BUDGET_FILTER_KEYS) {
    const target = (spec.overrides as Record<string, unknown>)[key] ?? DEFAULT_FILTERS[key];
    if (filters[key] !== target) return false;
  }
  return true;
}

function buildRiskBudget(
  facets: readonly YieldRowFacet[],
  filters: YieldViewModelFilters,
): YieldRiskBudgetState {
  let matching: YieldRiskBudgetKey | null = null;
  const stops = YIELD_RISK_BUDGET_SPECS.map((spec) => {
    const active = filtersMatchRiskBudget(filters, spec);
    if (active) matching = spec.key;
    return {
      key: spec.key,
      label: spec.label,
      description: spec.description,
      count: countRowsMatchingFilters(facets, riskBudgetTargetFilters(spec)),
      active,
      overrides: spec.overrides,
    } satisfies YieldRiskBudgetStop;
  });
  return { matching, stops };
}

export function buildYieldViewModel(
  rows: readonly YieldRanking[],
  params: YieldViewModelUrlParams,
  buildOptionsParams: BuildYieldViewModelOptions = {},
): YieldViewModel {
  const rowFacets = buildYieldRowFacets(rows, buildOptionsParams.watchlistIds ?? null);
  const filterOptions = buildOptions(rowFacets);
  const { filters, normalizedParams, invalidParamKeys } = normalizeFilters(params, filterOptions);
  const visibleFacets = rowFacets.filter((facet) => rowMatchesFilters(facet, filters));
  const cohortIndex = buildCohortIndex(rows);
  const visibleRows = rankRows(visibleFacets, filters, cohortIndex);
  const comparisonLabel = getComparisonLabel(filters);
  const { presets, matchingPreset } = buildPresets(rowFacets, filters);
  const riskBudget = buildRiskBudget(rowFacets, filters);

  return {
    filters,
    options: filterOptions,
    normalizedParams,
    invalidParamKeys,
    totalRows: rowFacets.length,
    visibleRows,
    emptyState: buildEmptyState(rowFacets.length, visibleRows, rowFacets, filters, filterOptions),
    comparisonLabel,
    stats: buildStats(visibleRows, buildOptionsParams),
    presets,
    matchingPreset,
    riskBudget,
  };
}

export interface YieldActiveFilterSummary {
  key: string;
  label: string;
}

export function getActiveFilterSummaries(viewModel: YieldViewModel): YieldActiveFilterSummary[] {
  const summaries: YieldActiveFilterSummary[] = [];
  for (const axis of YIELD_FILTER_AXIS_REGISTRY) {
    if (!axis.describeActive) continue;
    if (!axis.isActive(viewModel.filters)) continue;
    summaries.push({ key: axis.key, label: axis.describeActive(viewModel.filters, viewModel.options) });
  }
  return summaries;
}
