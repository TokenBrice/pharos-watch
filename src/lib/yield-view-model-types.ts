import type { YieldSourceDepthLens, YieldSourcePosture } from "@/lib/yield-source-risk";
import type {
  YieldAttentionFilter,
  YieldBenchmarkFilter,
  YieldDepthFilter,
  YieldFilterOption,
  YieldOpportunityFilter,
  YieldPegFilter,
  YieldSourceChangedFilter,
  YieldSourceConfidenceFilter,
  YieldSourcePostureFilter,
  YieldTrendingFilter,
  YieldViewModelFilters,
  YieldViewModelUrlParams,
  YieldWarningsFilter,
  YieldWatchlistFilter,
} from "@/lib/yield-view-config";
import type {
  PegCurrency,
  YieldBenchmarkKey,
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldType,
} from "@shared/types";
import type { YieldWorkbenchRanking } from "@/lib/yield-workbench-row";

export type { YieldAttentionFilter, YieldBenchmarkFilter, YieldDepthFilter, YieldFilterOption, YieldOpportunityFilter, YieldPegFilter, YieldSourceChangedFilter, YieldSourceConfidenceFilter, YieldSourcePostureFilter, YieldViewModelFilters, YieldViewModelUrlParams, YieldWarningsFilter, YieldWatchlistFilter };

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
  attention: YieldFilterOption<YieldAttentionFilter>[];
}

export type YieldPresetKey = "treasury-grade" | "best-dollar" | "non-usd" | "new-rising" | "watchlist-warnings";

export interface YieldPresetState {
  key: YieldPresetKey;
  label: string;
  description: string;
  count: number;
  active: boolean;
  overrides: Partial<YieldViewModelFilters>;
}

export type YieldRiskBudgetKey = "conservative" | "balanced" | "opportunistic" | "all";

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

export type YieldViewModelRow = YieldWorkbenchRanking & {
  peg: PegCurrency | null;
  viewRank: number;
  rankLabel: string;
  opportunity: Exclude<YieldOpportunityFilter, "all">;
  sourceDepthLens: YieldSourceDepthLens;
  sourcePosture: YieldSourcePosture;
  cohortPercentile: YieldCohortPercentile | null;
};

export interface YieldRowFacet {
  row: YieldWorkbenchRanking;
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
  needsWatchlistAttention: boolean;
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

export interface YieldActiveFilterSummary {
  key: string;
  label: string;
}
