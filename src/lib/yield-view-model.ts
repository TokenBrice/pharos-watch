import { resolveYieldScatterBenchmarkFrame } from "@/lib/yield-benchmark";
import {
  YIELD_SOURCE_CONFIDENCE_DEFINITIONS,
  YIELD_SOURCE_DEPTH_DEFINITIONS,
  classifyYieldSourceDepth,
  type YieldSourceDepthLens,
} from "@/lib/yield-source-risk";
import { PEG_BADGE_STYLES, YIELD_TYPE_LABELS } from "@shared/lib/classification";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type {
  PegCurrency,
  YieldBenchmarkKey,
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldRanking,
  YieldType,
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
};

export interface YieldViewModelStats {
  avgApy: number;
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
  };
  comparableSets: YieldComparableSet[];
  comparisonLabel: string;
  stats: YieldViewModelStats;
  presets: YieldPresetState[];
  matchingPreset: YieldPresetKey | null;
}

export interface BuildYieldViewModelOptions {
  benchmarks?: YieldBenchmarkRegistry | null;
  fallbackBenchmark?: YieldBenchmarkMeta | null;
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
const BENCHMARK_ORDER: readonly YieldBenchmarkKey[] = ["USD", "EUR", "CHF"];
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
  return row.yieldType === "lending-opportunity" ? "lending-opportunity" : "holder-yield";
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

function countPegs(rows: readonly YieldRanking[]): Map<PegCurrency, number> {
  const pegCounts = new Map<PegCurrency, number>();
  for (const row of rows) {
    const peg = getYieldRankingPeg(row.id);
    if (peg) pegCounts.set(peg, (pegCounts.get(peg) ?? 0) + 1);
  }
  return pegCounts;
}

function buildPegOptions(rows: readonly YieldRanking[]): YieldFilterOption<YieldPegFilter>[] {
  const pegCounts = countPegs(rows);
  const pegs = Array.from(pegCounts.keys()).sort(compareYieldPegs);
  const nonUsdCount = pegs.reduce((sum, peg) => sum + (peg !== "USD" ? pegCounts.get(peg) ?? 0 : 0), 0);
  const options: YieldFilterOption<YieldPegFilter>[] = [
    { value: "all", label: "All", count: rows.length },
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
function buildCurrencyTabOptions(rows: readonly YieldRanking[]): YieldFilterOption<YieldPegFilter>[] {
  const pegCounts = countPegs(rows);
  const options: YieldFilterOption<YieldPegFilter>[] = [
    { value: "all", label: "All", count: rows.length },
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

function buildOptions(rows: readonly YieldRanking[]): YieldViewModelOptions {
  const yieldTypeCounts = new Map<YieldType, number>();
  const confidenceCounts = new Map<Exclude<YieldSourceConfidenceFilter, "all">, number>();
  const benchmarkCounts = new Map<YieldBenchmarkKey, number>();
  let warningCount = 0;
  let noWarningCount = 0;
  let holderYieldCount = 0;
  let lendingOpportunityCount = 0;
  let sourceChangedCount = 0;
  let sourceUnchangedCount = 0;
  const depthCounts = new Map<YieldSourceDepthLens, number>();

  for (const row of rows) {
    yieldTypeCounts.set(row.yieldType, (yieldTypeCounts.get(row.yieldType) ?? 0) + 1);

    const confidence = row.provenance?.confidenceTier;
    if (confidence) confidenceCounts.set(confidence, (confidenceCounts.get(confidence) ?? 0) + 1);

    const benchmark = getBenchmarkKey(row);
    benchmarkCounts.set(benchmark, (benchmarkCounts.get(benchmark) ?? 0) + 1);

    if (row.warningSignals.length > 0) warningCount += 1;
    else noWarningCount += 1;

    if (getOpportunity(row) === "lending-opportunity") lendingOpportunityCount += 1;
    else holderYieldCount += 1;

    if (row.provenance?.sourceSwitch) sourceChangedCount += 1;
    else sourceUnchangedCount += 1;

    const sourceDepthLens = getSourceDepthLens(row);
    depthCounts.set(sourceDepthLens, (depthCounts.get(sourceDepthLens) ?? 0) + 1);
  }

  return {
    peg: buildPegOptions(rows),
    currencyTabs: buildCurrencyTabOptions(rows),
    yieldType: [
      { value: "all", label: "All types", count: rows.length },
      ...Array.from(yieldTypeCounts.entries())
        .map(([value, count]) => ({ value, label: YIELD_TYPE_LABELS[value] ?? value, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    ],
    warnings: [
      { value: "all", label: "All rows", count: rows.length },
      { value: "hide", label: "No warnings", count: noWarningCount },
      { value: "only", label: "Warnings", count: warningCount },
    ],
    minSafety: [
      { value: "all", label: "Any safety", count: rows.length },
      ...MIN_SAFETY_OPTIONS.map((minSafety) => ({
        value: String(minSafety),
        label: `${minSafety}+ safety`,
        count: rows.filter((row) => row.safetyScore !== null && row.safetyScore >= minSafety).length,
      })),
    ],
    minTvl: [
      { value: "all", label: "Any TVL", count: rows.length },
      ...MIN_TVL_OPTIONS.map((minTvl) => ({
        value: String(minTvl),
        label: formatTvlOption(minTvl),
        count: rows.filter((row) => row.sourceTvlUsd !== null && row.sourceTvlUsd >= minTvl).length,
      })),
    ],
    sourceConfidence: [
      { value: "all", label: "All confidence", count: rows.length },
      ...SOURCE_CONFIDENCE_ORDER
        .filter((value) => confidenceCounts.has(value))
        .map((value) => ({
          value,
          label: YIELD_SOURCE_CONFIDENCE_DEFINITIONS[value].label,
          count: confidenceCounts.get(value) ?? 0,
        })),
    ],
    benchmark: [
      { value: "all", label: "All benchmarks", count: rows.length },
      ...BENCHMARK_ORDER
        .filter((value) => benchmarkCounts.has(value))
        .map((value) => ({ value, label: value, count: benchmarkCounts.get(value) ?? 0 })),
    ],
    opportunity: [
      { value: "all", label: "All opportunities", count: rows.length },
      { value: "holder-yield", label: "Holder yield", count: holderYieldCount },
      { value: "lending-opportunity", label: "Lending opp.", count: lendingOpportunityCount },
    ],
    depth: [
      { value: "all", label: "All depth", count: rows.length },
      { value: "hide-thin", label: "Hide thin venues", count: rows.filter((row) => getSourceDepthLens(row) !== "thin").length },
      ...(["deep", "moderate", "thin", "unknown"] as const).map((value) => ({
        value,
        label: YIELD_SOURCE_DEPTH_DEFINITIONS[value].label,
        count: depthCounts.get(value) ?? 0,
      })),
    ],
    sourceChanged: [
      { value: "all", label: "All changes", count: rows.length },
      { value: "only", label: "Source changed", count: sourceChangedCount },
      { value: "none", label: "No source change", count: sourceUnchangedCount },
    ],
  };
}

function countRowsMatchingFilters(rows: readonly YieldRanking[], filters: YieldViewModelFilters): number {
  let count = 0;
  for (const row of rows) {
    if (rowMatchesFilters(row, filters)) count += 1;
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
  };

  const invalidParamKeys = (Object.keys(normalizedParams) as Array<keyof YieldViewModelUrlParams>)
    .filter((key) => {
      const raw = params[key];
      const normalized = normalizedParams[key];
      return raw != null && raw.trim() !== "" && raw !== normalized;
    });

  return { filters, normalizedParams, invalidParamKeys };
}

function rowMatchesFilters(row: YieldRanking, filters: YieldViewModelFilters): boolean {
  const peg = getYieldRankingPeg(row.id);

  if (!matchesPeg(peg, filters.peg)) return false;
  if (filters.yieldType !== "all" && row.yieldType !== filters.yieldType) return false;
  if (!matchesSearch(row, filters.q)) return false;
  if (filters.warnings === "hide" && row.warningSignals.length > 0) return false;
  if (filters.warnings === "only" && row.warningSignals.length === 0) return false;
  if (filters.minSafety !== null && (row.safetyScore === null || row.safetyScore < filters.minSafety)) return false;
  if (filters.minTvl !== null && (row.sourceTvlUsd === null || row.sourceTvlUsd < filters.minTvl)) return false;
  if (filters.sourceConfidence !== "all" && row.provenance?.confidenceTier !== filters.sourceConfidence) return false;
  if (filters.benchmark !== "all" && getBenchmarkKey(row) !== filters.benchmark) return false;
  if (filters.opportunity !== "all" && getOpportunity(row) !== filters.opportunity) return false;
  if (filters.depth === "hide-thin" && getSourceDepthLens(row) === "thin") return false;
  if (filters.depth !== "all" && filters.depth !== "hide-thin" && getSourceDepthLens(row) !== filters.depth) return false;
  if (filters.sourceChanged === "only" && !row.provenance?.sourceSwitch) return false;
  if (filters.sourceChanged === "none" && row.provenance?.sourceSwitch) return false;
  if (filters.trending === "rising" && !isRowRising(row)) return false;

  return true;
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

function rankRows(rows: readonly YieldRanking[], filters: YieldViewModelFilters): YieldViewModelRow[] {
  const comparisonLabel = getComparisonLabel(filters);
  return rows.map((row, index) => {
    const rank = index + 1;
    return {
      ...row,
      peg: getYieldRankingPeg(row.id),
      viewRank: rank,
      rankWithinSet: rank,
      rankLabel: `#${rank} in ${comparisonLabel}`,
      comparableSetLabel: comparisonLabel,
      opportunity: getOpportunity(row),
      sourceDepthLens: getSourceDepthLens(row),
    };
  });
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
  let warningRowCount = 0;
  let nullSafetyCount = 0;
  let nullTvlCount = 0;

  for (const row of rows) {
    const tvl = row.sourceTvlUsd ?? 0;
    if (tvl > 0) {
      tvlSum += tvl;
      weightedApySum += row.apy30d * tvl;
    }
    unweightedApySum += row.apy30d;
    if (row.pharosYieldScore !== null && (bestPys === null || row.pharosYieldScore > bestPys.score)) {
      bestPys = { name: row.name, symbol: row.symbol, score: row.pharosYieldScore };
    }
    if (row.warningSignals.length > 0) warningRowCount += 1;
    if (row.safetyScore === null) nullSafetyCount += 1;
    if (row.sourceTvlUsd === null) nullTvlCount += 1;
  }

  return {
    avgApy: rows.length === 0 ? 0 : tvlSum > 0 ? weightedApySum / tvlSum : unweightedApySum / rows.length,
    bestPys,
    warningRowCount,
    nullSafetyCount,
    nullTvlCount,
    ...benchmarkFrame,
  };
}

function buildComparableSets(rows: readonly YieldViewModelRow[]): YieldComparableSet[] {
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

  for (const row of rows) {
    const peg = getYieldRankingPeg(row.id);
    add("yield-type", row.yieldType, YIELD_TYPE_LABELS[row.yieldType] ?? row.yieldType);
    if (peg) add("peg", peg, `${getYieldPegLabel(peg)} peg`);
    add("benchmark", getBenchmarkKey(row), `${getBenchmarkKey(row)} benchmark`);
    add("warning-state", row.warningSignals.length > 0 ? "warning" : "no-warning", row.warningSignals.length > 0 ? "Warning rows" : "No-warning rows");
    if (row.provenance?.confidenceTier) add("source-confidence", row.provenance.confidenceTier, `${row.provenance.confidenceTier} confidence`);
    add("tvl", row.sourceTvlUsd === null ? "unknown" : "available", row.sourceTvlUsd === null ? "TVL unknown" : "TVL available");
    add("source-depth", row.sourceDepthLens, `${YIELD_SOURCE_DEPTH_DEFINITIONS[row.sourceDepthLens].label} source depth`);
  }

  return Array.from(sets.values()).sort((a, b) => {
    const basisCompare = a.basis.localeCompare(b.basis);
    if (basisCompare !== 0) return basisCompare;
    return b.count - a.count || a.label.localeCompare(b.label);
  });
}

function buildEmptyState(totalRows: number, visibleRows: readonly YieldViewModelRow[]): YieldViewModel["emptyState"] {
  if (visibleRows.length > 0) {
    return {
      isEmpty: false,
      title: "",
      description: "",
    };
  }

  return {
    isEmpty: true,
    title: totalRows === 0 ? "No yield rows published" : "No rows match this view",
    description: totalRows === 0
      ? "The latest payload did not include any yield rankings."
      : "Reset one or more filters to broaden the comparable set.",
  };
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
  rows: readonly YieldRanking[],
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
      count: countRowsMatchingFilters(rows, presetFilters(spec)),
      active,
      overrides: spec.overrides,
    } satisfies YieldPresetState;
  });
  return { presets, matchingPreset };
}

export function buildYieldViewModel(
  rows: readonly YieldRanking[],
  params: YieldViewModelUrlParams,
  buildOptionsParams: BuildYieldViewModelOptions = {},
): YieldViewModel {
  const filterOptions = buildOptions(rows);
  const { filters, normalizedParams, invalidParamKeys } = normalizeFilters(params, filterOptions);
  const visibleRows = rankRows(rows.filter((row) => rowMatchesFilters(row, filters)), filters);
  const comparisonLabel = getComparisonLabel(filters);
  const { presets, matchingPreset } = buildPresets(rows, filters);

  return {
    filters,
    options: filterOptions,
    normalizedParams,
    invalidParamKeys,
    totalRows: rows.length,
    visibleRows,
    emptyState: buildEmptyState(rows.length, visibleRows),
    comparableSets: buildComparableSets(visibleRows),
    comparisonLabel,
    stats: buildStats(visibleRows, buildOptionsParams),
    presets,
    matchingPreset,
  };
}

export function labelYieldFilterOption(option: YieldFilterOption): string {
  return formatCountLabel(option.label, option.count);
}
