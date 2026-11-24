import {
  buildYieldCohortIndex,
  buildYieldOptions,
  buildYieldRowFacets,
  getYieldComparisonLabel,
  isYieldBlockingCoinState,
  rankYieldRows,
  rowMatchesYieldFilters,
  type CohortBucket,
} from "@/lib/yield-view-model-facets";
import {
  buildYieldEmptyState,
  buildYieldPresets,
  buildYieldRiskBudget,
  buildYieldStats,
} from "@/lib/yield-view-model-presentation";
import type {
  BuildYieldViewModelOptions,
  YieldRowFacet,
  YieldViewModel,
  YieldViewModelOptions,
  YieldViewModelRow,
  YieldViewModelUrlParams,
} from "@/lib/yield-view-model-types";
import { normalizeFilters } from "@/lib/yield-view-url";
import type { YieldWorkbenchRanking } from "@/lib/yield-row-types";
import type { CoinState } from "@shared/lib/coin-state";

export type { BuildYieldViewModelOptions, YieldCohortPercentile, YieldPresetKey, YieldRiskBudgetKey, YieldRiskBudgetStop, YieldViewModel, YieldViewModelRow, YieldViewModelUrlParams } from "@/lib/yield-view-model-types";

export { YIELD_LANDING_RISK_BUDGET, YIELD_PRESET_SPECS, YIELD_RISK_BUDGET_MIN_SAFETY, YIELD_RISK_BUDGET_SPECS } from "@/lib/yield-view-config";
export { YIELD_FILTER_AXIS_REGISTRY } from "@/lib/yield-view-model-filter-axes";
export { RISK_BUDGET_FILTER_KEYS } from "@/lib/yield-view-config";
export { riskBudgetUrlValue } from "@/lib/yield-view-url";
export { isYieldBlockingCoinState } from "@/lib/yield-view-model-facets";

/** Per-universe preparation shared by every view over one rankings set: row facets (with each row's coin/venue states), filter options, and the cohort index over the unfiltered rows. */
export interface PreparedYieldUniverse {
  rowFacets: YieldRowFacet[];
  options: YieldViewModelOptions;
  nonFundOptions: YieldViewModelOptions;
  nonFundRowCount: number;
  cohortIndex: ReadonlyMap<string, CohortBucket>;
}

export function prepareYieldUniverse(
  rows: readonly YieldWorkbenchRanking[],
  watchlistIds: ReadonlySet<string> | null,
  coinStatesById: ReadonlyMap<string, readonly CoinState[]> | null = null,
): PreparedYieldUniverse {
  const rowFacets = buildYieldRowFacets(rows, watchlistIds, coinStatesById);
  const tokenizedFundCount = rowFacets.reduce((sum, facet) => sum + (facet.isTokenizedFund ? 1 : 0), 0);
  const nonFundFacets = tokenizedFundCount > 0 ? rowFacets.filter((facet) => !facet.isTokenizedFund) : rowFacets;
  const options = buildYieldOptions(rowFacets, tokenizedFundCount);
  const nonFundOptions = tokenizedFundCount > 0 ? buildYieldOptions(nonFundFacets, tokenizedFundCount) : options;
  return {
    rowFacets,
    options,
    nonFundOptions,
    nonFundRowCount: nonFundFacets.length,
    cohortIndex: buildYieldCohortIndex(rows),
  };
}

/** Filtered, ranked rows for auxiliary views that skip the full view model. */
export function selectVisibleYieldRows(universe: PreparedYieldUniverse, params: YieldViewModelUrlParams): YieldViewModelRow[] {
  const { filters } = normalizeFilters(params, universe.options);
  return rankYieldRows(universe.rowFacets.filter((facet) => rowMatchesYieldFilters(facet, filters)), filters, universe.cohortIndex);
}

/**
 * The /yield/ hero answer for a view: rows with the highest Pharos Yield Score
 * (best-paid risk, not the highest raw APY). Shared by the Yield page hero and
 * the homepage Yield card so both lead with the same coin. A row whose coin or
 * linked venue is in a blocking exceptional state never leads: the next one does.
 * Before live states are known a row with none is eligible, so both heroes
 * qualify the pick (`describeYieldPickLiveState`).
 */
export function selectTopPysRows(rows: readonly YieldViewModelRow[], count = 3): YieldViewModelRow[] {
  return rows
    .filter((row) => row.pharosYieldScore != null && !(row.coinStates ?? []).some(isYieldBlockingCoinState))
    .sort((a, b) => (b.pharosYieldScore ?? 0) - (a.pharosYieldScore ?? 0))
    .slice(0, count);
}

/**
 * The hero pick's caveat while a blocking state can still be unknown: until the
 * peg summary (depegs) and the visitor's day clock (deadlines) are known the
 * pick stands but says so, and a failed peg read says that instead. A DEWS band
 * never blocks a row, so stress signals are not awaited.
 */
export function describeYieldPickLiveState(peg: { data?: unknown; isError: boolean }, clockReady: boolean): string | null {
  if (peg.data === undefined) return peg.isError ? "live peg state unavailable" : "live state pending";
  return clockReady ? null : "live state pending";
}

export function buildYieldViewModel(
  universe: PreparedYieldUniverse,
  params: YieldViewModelUrlParams,
  buildOptions: Omit<BuildYieldViewModelOptions, "watchlistIds"> = {},
): YieldViewModel {
  const { rowFacets, cohortIndex } = universe;
  const wantsFunds = params.includeFunds === "true" || params.includeFunds === "include";
  const filterOptions = wantsFunds ? universe.options : universe.nonFundOptions;
  const { filters, normalizedParams, invalidParamKeys } = normalizeFilters(params, filterOptions);
  const visibleFacets = rowFacets.filter((facet) => rowMatchesYieldFilters(facet, filters));
  const visibleRows = rankYieldRows(visibleFacets, filters, cohortIndex);
  const { presets, matchingPreset } = buildYieldPresets(rowFacets, filters);
  const totalRows = filters.includeFunds === "include" ? rowFacets.length : universe.nonFundRowCount;

  return {
    filters,
    options: filterOptions,
    normalizedParams,
    invalidParamKeys,
    totalRows,
    visibleRows,
    emptyState: buildYieldEmptyState(rowFacets.length, visibleRows, rowFacets, filters, filterOptions),
    comparisonLabel: getYieldComparisonLabel(filters),
    stats: buildYieldStats(visibleRows, buildOptions),
    presets,
    matchingPreset,
    riskBudget: buildYieldRiskBudget(rowFacets, filters),
  };
}
