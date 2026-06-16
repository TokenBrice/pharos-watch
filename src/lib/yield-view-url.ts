import { DEFAULT_FILTERS } from "@/lib/yield-view-config";
import type {
  YieldPegFilter,
  YieldTrendingFilter,
  YieldViewModelFilters,
  YieldWatchlistFilter,
} from "@/lib/yield-view-config";
import type { YieldType } from "@shared/types";

interface YieldViewModelUrlParams {
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

interface YieldFilterOption<T extends string = string> {
  value: T;
  label: string;
  count: number;
}

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

export function normalizeFilters(params: YieldViewModelUrlParams, options: YieldViewModelOptions): {
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
