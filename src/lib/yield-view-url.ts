import {
  DEFAULT_FILTERS,
  YIELD_LANDING_RISK_BUDGET,
  YIELD_RISK_ANY_PARAM,
  YIELD_RISK_BUDGET_SPECS,
  type YieldRiskBudgetKey,
} from "@/lib/yield-view-config";
import type {
  YieldBenchmarkFilter,
  YieldDepthFilter,
  YieldAttentionFilter,
  YieldOpportunityFilter,
  YieldPegFilter,
  YieldSourceChangedFilter,
  YieldSourceConfidenceFilter,
  YieldSourcePostureFilter,
  YieldTrendingFilter,
  YieldViewModelUrlParams,
  YieldViewModelFilters,
  YieldWatchlistFilter,
  YieldWarningsFilter,
  YieldFilterOption,
} from "@/lib/yield-view-config";
import type { YieldType } from "@shared/types";

interface YieldViewModelOptions {
  peg: YieldFilterOption<YieldPegFilter>[];
  currencyTabs: YieldFilterOption<YieldPegFilter>[];
  yieldType: YieldFilterOption<YieldType | "all">[];
  warnings: YieldFilterOption[];
  sourceConfidence: YieldFilterOption[];
  benchmark: YieldFilterOption[];
  opportunity: YieldFilterOption[];
  depth: YieldFilterOption[];
  sourceChanged: YieldFilterOption[];
  sourcePosture: YieldFilterOption[];
  attention: YieldFilterOption[];
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

function parseRiskBudgetParam(value: string | null | undefined): YieldRiskBudgetKey {
  if (value == null || value.trim() === "") return YIELD_LANDING_RISK_BUDGET;
  if (value === YIELD_RISK_ANY_PARAM || value === "all") return "all";
  return YIELD_RISK_BUDGET_SPECS.some((spec) => spec.key === value)
    ? (value as YieldRiskBudgetKey)
    : YIELD_LANDING_RISK_BUDGET;
}

/** URL tokens that parse to a risk-budget band, including the neutral aliases. */
function isKnownRiskBudgetParam(value: string): boolean {
  return value === YIELD_RISK_ANY_PARAM || value === "all"
    || YIELD_RISK_BUDGET_SPECS.some((spec) => spec.key === value);
}

export function riskBudgetUrlValue(key: YieldRiskBudgetKey): string {
  return key === "all" ? YIELD_RISK_ANY_PARAM : key;
}

/**
 * Applies the URL risk band to every risk-budget key the URL leaves unset, so
 * `/yield/` lands on the opportunistic band while explicit filter params still
 * win (stackable semantics). `risk=any` requests the neutral defaults.
 */
function expandRiskBudget(params: YieldViewModelUrlParams): {
  risk: YieldRiskBudgetKey;
  params: YieldViewModelUrlParams;
} {
  const risk = parseRiskBudgetParam(params.risk);
  const spec = YIELD_RISK_BUDGET_SPECS.find((entry) => entry.key === risk);
  const expanded: YieldViewModelUrlParams = { ...params };
  for (const [key, value] of Object.entries(spec?.overrides ?? {})) {
    const paramKey = key as keyof YieldViewModelUrlParams;
    const raw = expanded[paramKey];
    if ((raw == null || raw.trim() === "") && value != null) expanded[paramKey] = String(value);
  }
  return { risk, params: expanded };
}

export function normalizeFilters(rawParams: YieldViewModelUrlParams, options: YieldViewModelOptions): {
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
  const validSourcePosture = new Set(options.sourcePosture.map((option) => option.value));
  const validTrending = new Set<YieldTrendingFilter>(["all", "rising"]);
  const validWatchlist = new Set<YieldWatchlistFilter>(["all", "only"]);
  const validAttention = new Set<YieldAttentionFilter>(["all", "watchlist"]);
  const { risk, params } = expandRiskBudget(rawParams);

  const filters: YieldViewModelFilters = {
    peg: normalizeOption(params.peg, validPegValues, DEFAULT_FILTERS.peg),
    yieldType: normalizeOption(params.yieldType, validYieldTypes, DEFAULT_FILTERS.yieldType),
    q: normalizeTextParam(params.q),
    warnings: normalizeOption(params.warnings, validWarnings, DEFAULT_FILTERS.warnings) as YieldWarningsFilter,
    minSafety: parseNumberParam(params.minSafety, 100),
    minTvl: parseNumberParam(params.minTvl, Number.MAX_SAFE_INTEGER),
    sourceConfidence: normalizeOption(params.sourceConfidence, validConfidence, DEFAULT_FILTERS.sourceConfidence) as YieldSourceConfidenceFilter,
    benchmark: normalizeOption(params.benchmark, validBenchmarks, DEFAULT_FILTERS.benchmark) as YieldBenchmarkFilter,
    opportunity: normalizeOption(params.opportunity, validOpportunities, DEFAULT_FILTERS.opportunity) as YieldOpportunityFilter,
    depth: normalizeOption(params.depth, validDepth, DEFAULT_FILTERS.depth) as YieldDepthFilter,
    sourceChanged: normalizeOption(params.sourceChanged, validSourceChanged, DEFAULT_FILTERS.sourceChanged) as YieldSourceChangedFilter,
    sourcePosture: normalizeOption(params.sourcePosture, validSourcePosture, DEFAULT_FILTERS.sourcePosture) as YieldSourcePostureFilter,
    trending: normalizeOption(params.trending, validTrending, DEFAULT_FILTERS.trending),
    watchlist: normalizeOption(params.watchlist, validWatchlist, DEFAULT_FILTERS.watchlist),
    attention: normalizeOption(params.attention, validAttention, DEFAULT_FILTERS.attention),
  };

  // A param that names a band (including the landing band and the "any"/"all"
  // neutral aliases) round-trips through its URL value; only unknown strings
  // fall back to the paramless landing state and get flagged for the rewrite.
  const rawRisk = params.risk?.trim() ?? "";
  const normalizedParams: Record<keyof YieldViewModelUrlParams, string | null> = {
    risk: rawRisk !== "" && isKnownRiskBudgetParam(rawRisk) ? riskBudgetUrlValue(risk) : null,
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
    sourcePosture: filters.sourcePosture === DEFAULT_FILTERS.sourcePosture ? null : filters.sourcePosture,
    trending: filters.trending === DEFAULT_FILTERS.trending ? null : filters.trending,
    watchlist: filters.watchlist === DEFAULT_FILTERS.watchlist ? null : filters.watchlist,
    attention: filters.attention === DEFAULT_FILTERS.attention ? null : filters.attention,
  };

  const invalidParamKeys = (Object.keys(normalizedParams) as Array<keyof YieldViewModelUrlParams>)
    .filter((key) => {
      const raw = rawParams[key];
      const normalized = normalizedParams[key];
      if (raw == null || raw.trim() === "") return false;
      if (key === "risk") return !isKnownRiskBudgetParam(raw.trim());
      return raw !== normalized;
    });

  return { filters, normalizedParams, invalidParamKeys };
}
