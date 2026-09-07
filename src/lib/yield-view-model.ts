import {
  buildYieldCohortIndex,
  buildYieldOptions,
  buildYieldRowFacets,
  getYieldComparisonLabel,
  rankYieldRows,
  rowMatchesYieldFilters,
  type CohortBucket,
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
  YieldRowFacet,
  YieldViewModel,
  YieldViewModelOptions,
  YieldViewModelRow,
  YieldViewModelUrlParams,
} from "@/lib/yield-view-model-types";
import { normalizeFilters } from "@/lib/yield-view-url";
import type { YieldWorkbenchRanking } from "@/lib/yield-workbench-row";

export type { BuildYieldViewModelOptions, YieldActiveFilterSummary, YieldCohortPercentile, YieldPresetKey, YieldRiskBudgetKey, YieldRiskBudgetStop, YieldViewModel, YieldViewModelRow, YieldViewModelUrlParams } from "@/lib/yield-view-model-types";

export { YIELD_PRESET_SPECS, YIELD_RISK_BUDGET_MIN_SAFETY, YIELD_RISK_BUDGET_SPECS } from "@/lib/yield-view-config";
export { YIELD_FILTER_AXIS_REGISTRY } from "@/lib/yield-view-model-filter-axes";
export { RISK_BUDGET_FILTER_KEYS } from "@/lib/yield-view-model-presentation";

/** Per-universe preparation shared by every view over one rankings set: row facets, filter options, and the cohort index over the unfiltered rows. */
export interface PreparedYieldUniverse {
  rowFacets: YieldRowFacet[];
  options: YieldViewModelOptions;
  cohortIndex: ReadonlyMap<string, CohortBucket>;
}

export function prepareYieldUniverse(rows: readonly YieldWorkbenchRanking[], watchlistIds: ReadonlySet<string> | null): PreparedYieldUniverse {
  const rowFacets = buildYieldRowFacets(rows, watchlistIds);
  return { rowFacets, options: buildYieldOptions(rowFacets), cohortIndex: buildYieldCohortIndex(rows) };
}

/** Filtered, ranked rows for auxiliary views that skip the full view model. */
export function selectVisibleYieldRows(universe: PreparedYieldUniverse, params: YieldViewModelUrlParams): YieldViewModelRow[] {
  const { filters } = normalizeFilters(params, universe.options);
  return rankYieldRows(universe.rowFacets.filter((facet) => rowMatchesYieldFilters(facet, filters)), filters, universe.cohortIndex);
}

export function buildYieldViewModel(
  universe: PreparedYieldUniverse,
  params: YieldViewModelUrlParams,
  buildOptions: Omit<BuildYieldViewModelOptions, "watchlistIds"> = {},
): YieldViewModel {
  const { rowFacets, options: filterOptions, cohortIndex } = universe;
  const { filters, normalizedParams, invalidParamKeys } = normalizeFilters(params, filterOptions);
  const visibleFacets = rowFacets.filter((facet) => rowMatchesYieldFilters(facet, filters));
  const visibleRows = rankYieldRows(visibleFacets, filters, cohortIndex);
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
