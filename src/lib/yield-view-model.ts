import {
  buildYieldCohortIndex,
  buildYieldOptions,
  buildYieldRowFacets,
  getYieldComparisonLabel,
  rankYieldRows,
  rowMatchesYieldFilters,
} from "@/lib/yield-view-model-facets";
import {
  buildYieldEmptyState,
  buildYieldPresets,
  buildYieldRiskBudget,
  buildYieldStats,
  getYieldActiveFilterSummaries,
} from "@/lib/yield-view-model-presentation";
import type {
  BuildYieldViewModelOptions,
  YieldActiveFilterSummary,
  YieldViewModel,
  YieldViewModelUrlParams,
} from "@/lib/yield-view-model-types";
import { normalizeFilters } from "@/lib/yield-view-url";
import type { YieldWorkbenchRanking } from "@/lib/yield-workbench-row";

export type {
  BuildYieldViewModelOptions,
  YieldActiveFilterSummary,
  YieldAttentionFilter,
  YieldBenchmarkFilter,
  YieldCohortPercentile,
  YieldDepthFilter,
  YieldEmptyStateSuggestion,
  YieldFilterOption,
  YieldOpportunityFilter,
  YieldPegFilter,
  YieldPresetKey,
  YieldPresetState,
  YieldRiskBudgetKey,
  YieldRiskBudgetState,
  YieldRiskBudgetStop,
  YieldSourceChangedFilter,
  YieldSourceConfidenceFilter,
  YieldSourcePostureFilter,
  YieldTrendingFilter,
  YieldViewModel,
  YieldViewModelFilters,
  YieldViewModelOptions,
  YieldViewModelRow,
  YieldViewModelStats,
  YieldViewModelUrlParams,
  YieldWarningsFilter,
  YieldWatchlistFilter,
} from "@/lib/yield-view-model-types";

export { YIELD_PRESET_SPECS, YIELD_RISK_BUDGET_MIN_SAFETY, YIELD_RISK_BUDGET_SPECS } from "@/lib/yield-view-config";
export { YIELD_FILTER_AXIS_REGISTRY } from "@/lib/yield-view-model-filter-axes";
export { RISK_BUDGET_FILTER_KEYS } from "@/lib/yield-view-model-presentation";

export function buildYieldViewModel(
  rows: readonly YieldWorkbenchRanking[],
  params: YieldViewModelUrlParams,
  buildOptions: BuildYieldViewModelOptions = {},
): YieldViewModel {
  const rowFacets = buildYieldRowFacets(rows, buildOptions.watchlistIds ?? null);
  const filterOptions = buildYieldOptions(rowFacets);
  const { filters, normalizedParams, invalidParamKeys } = normalizeFilters(params, filterOptions);
  const visibleFacets = rowFacets.filter((facet) => rowMatchesYieldFilters(facet, filters));
  const visibleRows = rankYieldRows(visibleFacets, filters, buildYieldCohortIndex(rows));
  const { presets, matchingPreset } = buildYieldPresets(rowFacets, filters);

  return {
    filters,
    options: filterOptions,
    normalizedParams,
    invalidParamKeys,
    totalRows: rowFacets.length,
    visibleRows,
    emptyState: buildYieldEmptyState(rowFacets.length, visibleRows, rowFacets, filters, filterOptions),
    comparisonLabel: getYieldComparisonLabel(filters),
    stats: buildYieldStats(visibleRows, buildOptions),
    presets,
    matchingPreset,
    riskBudget: buildYieldRiskBudget(rowFacets, filters),
  };
}

export function getActiveFilterSummaries(viewModel: YieldViewModel): YieldActiveFilterSummary[] {
  return getYieldActiveFilterSummaries(viewModel);
}
