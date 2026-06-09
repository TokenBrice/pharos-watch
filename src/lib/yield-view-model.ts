import { getYieldBenchmarkDisplayLabel, resolveYieldScatterBenchmarkFrame } from "@/lib/yield-benchmark";
import {
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_DEPTH_DEFINITIONS,
  classifyYieldSourceDepth,
  type YieldSourceDepthLens,
} from "@/lib/yield-source-risk";
import { PEG_BADGE_STYLES, YIELD_TYPE_LABELS } from "@shared/lib/classification";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { YIELD_BENCHMARK_KEY_VALUES } from "@shared/types/yield";
import {
  type PegCurrency,
  type ReportCardGrade,
  type YieldBenchmarkKey,
  type YieldBenchmarkMeta,
  type YieldBenchmarkRegistry,
  type YieldRanking,
  type YieldType,
} from "@shared/types";

export type YieldPegFilter = PegCurrency | "all" | "non-usd" | "aud-cad" | "other";
export type YieldWarningsFilter = "all" | "hide" | "only";
export type YieldSourceConfidenceFilter =
  | "all"
  | NonNullable<NonNullable<YieldRanking["provenance"]>["confidenceTier"]>;
export type YieldBenchmarkFilter = "all" | YieldBenchmarkKey;
export type YieldOpportunityFilter = "all" | "holder-yield" | "lending-opportunity";
export type YieldDepthFilter = "all" | YieldSourceDepthLens | "hide-thin";
export type YieldSourceChangedFilter = "all" | "only" | "none";
export type YieldTrendingFilter = "all" | "rising";
export type YieldWatchlistFilter = "all" | "only";

export interface YieldViewModelUrlParams {
  peg?: string | null;
  yieldType?: string | null;
  q?: string | null;
  warnings?: string | null;
  minSafety?: string | null;
  minTvl?: string | null;
  sourceConfidence?: string | null;
  benchmark?: string | null;
  opportunity?: string | null;
  depth?: string | null;
  sourceChanged?: string | null;
  trending?: string | null;
  watchlist?: string | null;
}

export interface YieldFilterOption<T extends string = string> {
  value: T;
  label: string;
  count: number;
}

export interface YieldViewModelFilters {
  peg: YieldPegFilter;
  yieldType: YieldType | "all";
  q: string;
  warnings: YieldWarningsFilter;
  minSafety: number | null;
  minTvl: number | null;
  sourceConfidence: YieldSourceConfidenceFilter;
  benchmark: YieldBenchmarkFilter;
  opportunity: YieldOpportunityFilter;
  depth: YieldDepthFilter;
  sourceChanged: YieldSourceChangedFilter;
  trending: YieldTrendingFilter;
  watchlist: YieldWatchlistFilter;
}

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

export interface YieldComparableSet {
  key: string;
  label: string;
  count: number;
  basis: "yield-type" | "peg" | "benchmark" | "warning-state" | "source-confidence" | "tvl" | "source-depth";
}

export type YieldViewModelRow = YieldRanking & {
  peg: PegCurrency | null;
  viewRank: number;
  rankWithinSet: number;
  rankLabel: string;
  comparableSetLabel: string;
  opportunity: Exclude<YieldOpportunityFilter, "all">;
  sourceDepthLens: YieldSourceDepthLens;
  cohortPercentile: YieldCohortPercentile | null;
};

interface YieldRowFacet {
  row: YieldRanking;
  peg: PegCurrency | null;
  benchmarkKey: YieldBenchmarkKey;
  opportunity: Exclude<YieldOpportunityFilter, "all">;
  sourceDepthLens: YieldSourceDepthLens;
  confidenceTier: Exclude<YieldSourceConfidenceFilter, "all"> | null;
  hasWarning: boolean;
  sourceChanged: boolean;
  isRising: boolean;
  inWatchlist: boolean;
}

export interface YieldViewModelLedeFacts {
  aGradeAboveBenchmark: { count: number; bps: number } | null;
  doubleDigitInLowGrade: number;
  benchmarkLabel: string | null;
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
  ledeFacts: YieldViewModelLedeFacts;
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
  comparableSets: YieldComparableSet[];
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

const YIELD_PEG_PRIORITY: readonly PegCurrency[] = [
  "EUR",
  "CHF",
  "GOLD",
  "GBP",
  "JPY",
  "AUD",
  "CAD",
  "BRL",
  "ZAR",
  "CNH",
  "CNY",
  "PHP",
  "TRY",
  "IDR",
  "RUB",
  "UAH",
  "ARS",
  "SILVER",
  "VAR",
  "OTHER",
];

const HIDDEN_INDIVIDUAL_YIELD_PEG_FILTERS = new Set<PegCurrency>(["SGD", "MXN"]);
// Currencies that get their own tab in the leaderboard currency tab strip.
// Anything not in this set rolls into the "Other" tab. AUD + CAD share a tab.
const CURRENCY_TAB_PEGS: readonly PegCurrency[] = ["USD", "EUR", "GBP", "JPY", "CHF", "MXN", "BRL"];
const CURRENCY_TAB_AUD_CAD_PEGS: readonly PegCurrency[] = ["AUD", "CAD"];
const CURRENCY_TAB_ENUMERATED_PEGS = new Set<PegCurrency>([
  ...CURRENCY_TAB_PEGS,
  ...CURRENCY_TAB_AUD_CAD_PEGS,
]);
const SOURCE_CONFIDENCE_ORDER: readonly Exclude<YieldSourceConfidenceFilter, "all">[] = [
  "deterministic",
  "curated",
  "discovered",
  "fallback",
];
const BENCHMARK_ORDER: readonly YieldBenchmarkKey[] = YIELD_BENCHMARK_KEY_VALUES;
const MIN_SAFETY_OPTIONS = [50, 60, 70, 80] as const;
const MIN_TVL_OPTIONS = [1_000_000, 10_000_000, 100_000_000] as const;

const DEFAULT_FILTERS: YieldViewModelFilters = {
  peg: "all",
  yieldType: "all",
  q: "",
  warnings: "all",
  minSafety: null,
  minTvl: null,
  sourceConfidence: "all",
  benchmark: "all",
  opportunity: "all",
  depth: "all",
  sourceChanged: "all",
  trending: "all",
  watchlist: "all",
};

interface YieldPresetSpec {
  key: YieldPresetKey;
  label: string;
  description: string;
  overrides: Partial<YieldViewModelFilters>;
}

// Treasury-grade approximates "rate-derived, NAV, lending vaults, lending opportunities"
// via safety+depth+confidence instead of multi-value yieldType (which is single-select).
// Best-dollar approximates ">5% APY" via PYS ranking + safety floor; the leaderboard
// is already sorted by PYS which correlates with APY for safe rows.
interface YieldRiskBudgetSpec {
  key: YieldRiskBudgetKey;
  label: string;
  description: string;
  overrides: Partial<YieldViewModelFilters>;
}

// Risk budget collapses safety/depth/source-confidence/warnings into a single
// conservative→all dimension. Stops are stackable on top of other
// filters via merge semantics in `handleApplyRiskBudget`.
export const YIELD_RISK_BUDGET_SPECS: readonly YieldRiskBudgetSpec[] = [
  {
    key: "conservative",
    label: "Conservative",
    description: "A- safety, hide thin venues, hide warnings",
    overrides: {
      minSafety: 80,
      depth: "hide-thin",
      warnings: "hide",
    },
  },
  {
    key: "balanced",
    label: "Balanced",
    description: "B- safety, hide thin venues, hide warnings",
    overrides: {
      minSafety: 70,
      depth: "hide-thin",
      warnings: "hide",
    },
  },
  {
    key: "opportunistic",
    label: "Opportunistic",
    description: "C+ safety, hide warnings",
    overrides: {
      minSafety: 50,
      warnings: "hide",
    },
  },
  {
    key: "all",
    label: "All",
    description: "No constraints — show all rows",
    overrides: {},
  },
];

export const YIELD_PRESET_SPECS: readonly YieldPresetSpec[] = [
  {
    key: "treasury-grade",
    label: "Treasury-grade picks",
    description: "A- safety, non-thin depth, deterministic source",
    overrides: { minSafety: 80, depth: "hide-thin", sourceConfidence: "deterministic" },
  },
  {
    key: "best-dollar",
    label: "Best dollar yields",
    description: "USD-pegged, A- safety, ranked by PYS",
    overrides: { peg: "USD", minSafety: 80 },
  },
  {
    key: "non-usd",
    label: "Non-USD opportunities",
    description: "EUR, GBP, JPY, MXN, BRL and other non-USD pegs",
    overrides: { peg: "non-usd" },
  },
  {
    key: "new-rising",
    label: "New & rising",
    description: "Current APY above 30d average, 7+ daily observations",
    overrides: { trending: "rising" },
  },
  {
    key: "watchlist-warnings",
    label: "Watchlist warnings",
    description: "Rows surfacing one or more warning signals",
    overrides: { warnings: "only" },
  },
];

function formatCountLabel(label: string, count: number): string {
  return `${label} (${count})`;
}

function formatTvlOption(value: number): string {
  if (value >= 1_000_000_000) return `$${value / 1_000_000_000}B+`;
  if (value >= 1_000_000) return `$${value / 1_000_000}M+`;
  return `$${value.toLocaleString()}+`;
}

function getYieldPegLabel(peg: PegCurrency): string {
  return PEG_BADGE_STYLES[peg].label.replace(/\s+Peg$/, "");
}

function getYieldRankingPeg(rankingId: string): PegCurrency | null {
  return TRACKED_META_BY_ID.get(rankingId)?.flags.pegCurrency ?? null;
}

function compareYieldPegs(a: PegCurrency, b: PegCurrency): number {
  const aIndex = YIELD_PEG_PRIORITY.indexOf(a);
  const bIndex = YIELD_PEG_PRIORITY.indexOf(b);

  if (aIndex !== -1 || bIndex !== -1) {
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  }

  return getYieldPegLabel(a).localeCompare(getYieldPegLabel(b));
}

function normalizeTextParam(value: string | null | undefined): string {
  return (value ?? "").trim().slice(0, 80);
}

function parseNumberParam(value: string | null | undefined, max: number): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) return null;
  return parsed;
}

function normalizeOption<T extends string>(
  value: string | null | undefined,
  validValues: ReadonlySet<T>,
  fallback: T,
): T {
  return value != null && validValues.has(value as T) ? value as T : fallback;
}

function getBenchmarkKey(row: YieldRanking): YieldBenchmarkKey {
  return row.benchmarkKey ?? row.provenance?.benchmarkKey ?? "USD";
}

function getOpportunity(row: YieldRanking): Exclude<YieldOpportunityFilter, "all"> {
  return row.yieldType === "lending-opportunity" ||
    row.yieldType === "fixed-yield" ||
    row.yieldType === "structured-tranche"
    ? "lending-opportunity"
    : "holder-yield";
}

function getSourceDepthLens(row: YieldRanking): YieldSourceDepthLens {
  return classifyYieldSourceDepth({
    sourceRisk: row.sourceRisk,
    sourceTvlUsd: row.sourceTvlUsd,
  });
}

function isRowRising(row: YieldRanking): boolean {
  const observations = row.sourceRisk?.observationCount30d;
  return row.currentApy > row.apy30d && observations != null && observations >= 7;
}

function buildYieldRowFacet(row: YieldRanking, watchlistIds: ReadonlySet<string> | null): YieldRowFacet {
  return {
    row,
    peg: getYieldRankingPeg(row.id),
    benchmarkKey: getBenchmarkKey(row),
    opportunity: getOpportunity(row),
    sourceDepthLens: getSourceDepthLens(row),
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
  }

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
        count: facets.filter((facet) => facet.row.safetyScore !== null && facet.row.safetyScore >= minSafety).length,
      })),
    ],
    minTvl: [
      { value: "all", label: "Any TVL", count: facets.length },
      ...MIN_TVL_OPTIONS.map((minTvl) => ({
        value: String(minTvl),
        label: formatTvlOption(minTvl),
        count: facets.filter((facet) => facet.row.sourceTvlUsd !== null && facet.row.sourceTvlUsd >= minTvl).length,
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
      { value: "lending-opportunity", label: "Opportunity rows", count: lendingOpportunityCount },
    ],
    depth: [
      { value: "all", label: "All depth", count: facets.length },
      {
        value: "hide-thin",
        label: "Hide thin venues",
        count: facets.filter((facet) => facet.sourceDepthLens !== "thin").length,
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

function normalizeFilters(params: YieldViewModelUrlParams, options: YieldViewModelOptions): {
  filters: YieldViewModelFilters;
  normalizedParams: Record<keyof YieldViewModelUrlParams, string | null>;
  invalidParamKeys: Array<keyof YieldViewModelUrlParams>;
} {
  const validPegValues = new Set<YieldPegFilter>([
    ...options.peg.map((option) => option.value),
    ...options.currencyTabs.map((option) => option.value),
  ]);
  const validYieldTypes = new Set(options.yieldType.map((option) => option.value));
  const validWarnings = new Set(options.warnings.map((option) => option.value));
  const validConfidence = new Set(options.sourceConfidence.map((option) => option.value));
  const validBenchmarks = new Set(options.benchmark.map((option) => option.value));
  const validOpportunities = new Set(options.opportunity.map((option) => option.value));
  const validDepth = new Set(options.depth.map((option) => option.value));
  const validSourceChanged = new Set(options.sourceChanged.map((option) => option.value));
  const validTrending = new Set<YieldTrendingFilter>(["all", "rising"]);
  const validWatchlist = new Set<YieldWatchlistFilter>(["all", "only"]);

  const filters: YieldViewModelFilters = {
    peg: normalizeOption(params.peg, validPegValues, DEFAULT_FILTERS.peg),
    yieldType: normalizeOption(params.yieldType, validYieldTypes, DEFAULT_FILTERS.yieldType),
    q: normalizeTextParam(params.q),
    warnings: normalizeOption(params.warnings, validWarnings, DEFAULT_FILTERS.warnings),
    minSafety: parseNumberParam(params.minSafety, 100),
    minTvl: parseNumberParam(params.minTvl, Number.MAX_SAFE_INTEGER),
    sourceConfidence: normalizeOption(params.sourceConfidence, validConfidence, DEFAULT_FILTERS.sourceConfidence),
    benchmark: normalizeOption(params.benchmark, validBenchmarks, DEFAULT_FILTERS.benchmark),
    opportunity: normalizeOption(params.opportunity, validOpportunities, DEFAULT_FILTERS.opportunity),
    depth: normalizeOption(params.depth, validDepth, DEFAULT_FILTERS.depth),
    sourceChanged: normalizeOption(params.sourceChanged, validSourceChanged, DEFAULT_FILTERS.sourceChanged),
    trending: normalizeOption(params.trending, validTrending, DEFAULT_FILTERS.trending),
    watchlist: normalizeOption(params.watchlist, validWatchlist, DEFAULT_FILTERS.watchlist),
  };

  const normalizedParams: Record<keyof YieldViewModelUrlParams, string | null> = {
    peg: filters.peg === DEFAULT_FILTERS.peg ? null : filters.peg,
    yieldType: filters.yieldType === DEFAULT_FILTERS.yieldType ? null : filters.yieldType,
    q: filters.q === DEFAULT_FILTERS.q ? null : filters.q,
    warnings: filters.warnings === DEFAULT_FILTERS.warnings ? null : filters.warnings,
    minSafety: filters.minSafety === null ? null : String(filters.minSafety),
    minTvl: filters.minTvl === null ? null : String(filters.minTvl),
    sourceConfidence: filters.sourceConfidence === DEFAULT_FILTERS.sourceConfidence ? null : filters.sourceConfidence,
    benchmark: filters.benchmark === DEFAULT_FILTERS.benchmark ? null : filters.benchmark,
    opportunity: filters.opportunity === DEFAULT_FILTERS.opportunity ? null : filters.opportunity,
    depth: filters.depth === DEFAULT_FILTERS.depth ? null : filters.depth,
    sourceChanged: filters.sourceChanged === DEFAULT_FILTERS.sourceChanged ? null : filters.sourceChanged,
    trending: filters.trending === DEFAULT_FILTERS.trending ? null : filters.trending,
    watchlist: filters.watchlist === DEFAULT_FILTERS.watchlist ? null : filters.watchlist,
  };

  const invalidParamKeys = (Object.keys(normalizedParams) as Array<keyof YieldViewModelUrlParams>)
    .filter((key) => {
      const raw = params[key];
      const normalized = normalizedParams[key];
      return raw != null && raw.trim() !== "" && raw !== normalized;
    });

  return { filters, normalizedParams, invalidParamKeys };
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
      rankWithinSet: rank,
      rankLabel: `#${rank} in ${comparisonLabel}`,
      comparableSetLabel: comparisonLabel,
      opportunity: facet.opportunity,
      sourceDepthLens: facet.sourceDepthLens,
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
  size: number;
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
    const key = cohortKey(row);
    if (key === null) continue;
    const existing = buckets.get(key);
    if (existing) {
      existing.size += 1;
      existing.scoresDescending.push(row.pharosYieldScore!);
    } else {
      buckets.set(key, { size: 1, scoresDescending: [row.pharosYieldScore!] });
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
  if (bucket.size < COHORT_MIN_SIZE) {
    return { value: null, cohortSize: bucket.size, cohortKey: key };
  }
  const score = row.pharosYieldScore!;
  // Rank: how many cohort members have a strictly higher PYS, plus 1 for self.
  // Percentile reported as "top X%" by mapping rank 1 → 100, rank N → ~0.
  const sorted = bucket.scoresDescending;
  let higherCount = 0;
  for (const candidate of sorted) {
    if (candidate > score) higherCount += 1;
    else break;
  }
  const percentile = Math.round(((bucket.size - higherCount) / bucket.size) * 100);
  return { value: percentile, cohortSize: bucket.size, cohortKey: key };
}

const LEDE_HIGH_GRADE = new Set(["A+", "A"]);
const LEDE_LOW_GRADE = new Set(["C+", "C", "C-", "D", "F", "NR"]);
const LEDE_HIGH_GRADE_SPREAD_THRESHOLD = 1.5;
const LEDE_DOUBLE_DIGIT_THRESHOLD = 10;

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
  let aGradeAboveBenchmarkCount = 0;
  let aGradeMinSpread = Infinity;
  let doubleDigitInLowGrade = 0;
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

    const grade = row.safetyGrade;
    if (grade !== null && LEDE_HIGH_GRADE.has(grade)) {
      const benchmarkRate = row.benchmarkRate ?? benchmarkFrame.referenceBenchmark?.rate ?? null;
      if (benchmarkRate !== null) {
        const spread = row.apy30d - benchmarkRate;
        if (spread >= LEDE_HIGH_GRADE_SPREAD_THRESHOLD) {
          aGradeAboveBenchmarkCount += 1;
          if (spread < aGradeMinSpread) aGradeMinSpread = spread;
        }
      }
    }
    if (row.apy30d >= LEDE_DOUBLE_DIGIT_THRESHOLD && grade !== null && LEDE_LOW_GRADE.has(grade)) {
      doubleDigitInLowGrade += 1;
    }
  }

  const median = computeMedian(apys);
  const ledeBenchmarkLabel = benchmarkFrame.referenceBenchmark
    ? getYieldBenchmarkDisplayLabel(benchmarkFrame.referenceBenchmark)
    : null;

  return {
    avgApy: rows.length === 0 ? 0 : tvlSum > 0 ? weightedApySum / tvlSum : unweightedApySum / rows.length,
    medianApy: median,
    topYield,
    bestPys,
    warningRowCount,
    nullSafetyCount,
    nullTvlCount,
    ledeFacts: {
      aGradeAboveBenchmark:
        aGradeAboveBenchmarkCount > 0
          ? { count: aGradeAboveBenchmarkCount, bps: Math.round(aGradeMinSpread * 100) }
          : null,
      doubleDigitInLowGrade,
      benchmarkLabel: ledeBenchmarkLabel,
    },
    ...benchmarkFrame,
  };
}

function computeMedian(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function buildComparableSets(facets: readonly YieldRowFacet[]): YieldComparableSet[] {
  const sets = new Map<string, YieldComparableSet>();
  const add = (basis: YieldComparableSet["basis"], key: string, label: string) => {
    const id = `${basis}:${key}`;
    const current = sets.get(id);
    if (current) {
      current.count += 1;
    } else {
      sets.set(id, { key: id, label, basis, count: 1 });
    }
  };

  for (const facet of facets) {
    const row = facet.row;
    add("yield-type", row.yieldType, YIELD_TYPE_LABELS[row.yieldType] ?? row.yieldType);
    if (facet.peg) add("peg", facet.peg, `${getYieldPegLabel(facet.peg)} peg`);
    add("benchmark", facet.benchmarkKey, `${facet.benchmarkKey} benchmark`);
    add("warning-state", facet.hasWarning ? "warning" : "no-warning", facet.hasWarning ? "Warning rows" : "No-warning rows");
    if (facet.confidenceTier) add("source-confidence", facet.confidenceTier, `${facet.confidenceTier} confidence`);
    add("tvl", row.sourceTvlUsd === null ? "unknown" : "available", row.sourceTvlUsd === null ? "TVL unknown" : "TVL available");
    add("source-depth", facet.sourceDepthLens, `${YIELD_SOURCE_DEPTH_DEFINITIONS[facet.sourceDepthLens].label} source depth`);
  }

  return Array.from(sets.values()).sort((a, b) => {
    const basisCompare = a.basis.localeCompare(b.basis);
    if (basisCompare !== 0) return basisCompare;
    return b.count - a.count || a.label.localeCompare(b.label);
  });
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

function presetFilters(spec: YieldPresetSpec): YieldViewModelFilters {
  return { ...DEFAULT_FILTERS, ...spec.overrides };
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
  "sourceConfidence",
  "warnings",
];

function riskBudgetTargetFilters(spec: YieldRiskBudgetSpec): YieldViewModelFilters {
  // A risk-budget stop only constrains the four risk-axis keys; other filters
  // are normalized to defaults for the purpose of computing the stop's count.
  return { ...DEFAULT_FILTERS, ...spec.overrides };
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
    comparableSets: buildComparableSets(visibleFacets),
    comparisonLabel,
    stats: buildStats(visibleRows, buildOptionsParams),
    presets,
    matchingPreset,
    riskBudget,
  };
}

export function labelYieldFilterOption(option: YieldFilterOption): string {
  return formatCountLabel(option.label, option.count);
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
