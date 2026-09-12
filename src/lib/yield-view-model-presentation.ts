import { resolveYieldScatterBenchmarkFrame } from "@/lib/yield-benchmark";
import { countRowsMatchingFilters } from "@/lib/yield-view-model-facets";
import { YIELD_FILTER_AXIS_REGISTRY } from "@/lib/yield-view-model-filter-axes";
import type {
  BuildYieldViewModelOptions,
  YieldActiveFilterSummary,
  YieldEmptyStateSuggestion,
  YieldPresetKey,
  YieldPresetState,
  YieldRiskBudgetKey,
  YieldRiskBudgetState,
  YieldRiskBudgetStop,
  YieldRowFacet,
  YieldViewModel,
  YieldViewModelOptions,
  YieldViewModelRow,
  YieldViewModelStats,
} from "@/lib/yield-view-model-types";
import {
  DEFAULT_FILTERS,
  YIELD_PRESET_SPECS,
  YIELD_RISK_ANY_PARAM,
  YIELD_RISK_BUDGET_SPECS,
  type YieldPresetSpec,
  type YieldRiskBudgetSpec,
  type YieldViewModelFilters,
} from "@/lib/yield-view-config";

// Only the scatter's benchmark frame is consumed from the view-model stats
// (hero callouts and leaderboard derive their tiles from rows directly), so
// the stats builder stays a thin projection instead of re-aggregating APY and
// TVL over the visible rows on every URL param change.
export function buildYieldStats(
  rows: readonly YieldViewModelRow[],
  options: BuildYieldViewModelOptions,
): YieldViewModelStats {
  return resolveYieldScatterBenchmarkFrame({
    rankings: [...rows],
    benchmarks: options.benchmarks,
    fallbackBenchmark: options.fallbackBenchmark ?? null,
  });
}

const EMPTY_STATE_SUGGESTION_LIMIT = 3;

function buildEmptyStateSuggestions(
  facets: readonly YieldRowFacet[],
  filters: YieldViewModelFilters,
  options: YieldViewModelOptions,
): YieldEmptyStateSuggestion[] {
  const scored: YieldEmptyStateSuggestion[] = [];
  for (const axis of YIELD_FILTER_AXIS_REGISTRY) {
    if (!axis.isActive(filters)) continue;
    const relaxed = { ...filters, [axis.key]: DEFAULT_FILTERS[axis.key] } as YieldViewModelFilters;
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
  // Band keys often only recover rows together (a low-grade row with a
  // warning is blocked by both the safety floor and the warnings filter), so
  // offer lifting the whole band as one move.
  if (RISK_BUDGET_FILTER_KEYS.some((key) => filters[key] !== DEFAULT_FILTERS[key])) {
    const unbanded = { ...filters };
    for (const key of RISK_BUDGET_FILTER_KEYS) (unbanded as Record<keyof YieldViewModelFilters, unknown>)[key] = DEFAULT_FILTERS[key];
    const gain = countRowsMatchingFilters(facets, unbanded);
    if (gain > 0) {
      scored.push({ filterKey: "risk", targetValue: YIELD_RISK_ANY_PARAM, gain, label: "Show all risk levels" });
    }
  }
  scored.sort((left, right) => right.gain - left.gain);
  return scored.slice(0, EMPTY_STATE_SUGGESTION_LIMIT);
}

export function buildYieldEmptyState(
  totalRows: number,
  visibleRows: readonly YieldViewModelRow[],
  facets: readonly YieldRowFacet[],
  filters: YieldViewModelFilters,
  options: YieldViewModelOptions,
): YieldViewModel["emptyState"] {
  if (visibleRows.length > 0) {
    return { isEmpty: false, title: "", description: "", suggestions: [] };
  }
  return {
    isEmpty: true,
    title: totalRows === 0 ? "No yield rows published" : "No rows match this view",
    description: totalRows === 0
      ? "The latest payload did not include any yield rankings."
      : "Reset one or more filters to broaden the comparable set.",
    suggestions: totalRows > 0 ? buildEmptyStateSuggestions(facets, filters, options) : [],
  };
}

// Presets merge onto the current filters when clicked (see
// `handleApplyPreset`), so counts and the active state must be evaluated on the
// same stacked base — otherwise the landing risk band makes every count lie.
function presetFilters(filters: YieldViewModelFilters, spec: YieldPresetSpec): YieldViewModelFilters {
  return { ...filters, ...spec.overrides };
}

function filtersMatchPreset(filters: YieldViewModelFilters, spec: YieldPresetSpec): boolean {
  return (Object.keys(spec.overrides) as Array<keyof YieldViewModelFilters>).every(
    (key) => filters[key] === spec.overrides[key],
  );
}

export function buildYieldPresets(
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
      count: countRowsMatchingFilters(facets, presetFilters(filters, spec)),
      active,
      overrides: spec.overrides,
    } satisfies YieldPresetState;
  });
  return { presets, matchingPreset };
}

export const RISK_BUDGET_FILTER_KEYS: readonly (keyof YieldViewModelFilters)[] = [
  "minSafety",
  "depth",
  "sourcePosture",
  "sourceConfidence",
  "warnings",
];

// The risk-budget slider merges band overrides onto the current filters when
// clicked (see `handleApplyRiskBudget`), so like presets its counts and active
// state must be evaluated on the same stacked base — otherwise an active
// peg/search filter makes every stop count lie.
function riskBudgetTargetFilters(filters: YieldViewModelFilters, spec: YieldRiskBudgetSpec): YieldViewModelFilters {
  const riskOverrides = Object.fromEntries(
    RISK_BUDGET_FILTER_KEYS.filter((key) => key in spec.overrides).map((key) => [key, spec.overrides[key]]),
  ) as Partial<YieldViewModelFilters>;
  return { ...filters, ...riskOverrides };
}

function filtersMatchRiskBudget(filters: YieldViewModelFilters, spec: YieldRiskBudgetSpec): boolean {
  for (const key of RISK_BUDGET_FILTER_KEYS) {
    const target = (spec.overrides as Record<string, unknown>)[key] ?? DEFAULT_FILTERS[key];
    if (filters[key] !== target) return false;
  }
  return true;
}

export function buildYieldRiskBudget(
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
      count: countRowsMatchingFilters(facets, riskBudgetTargetFilters(filters, spec)),
      active,
      overrides: spec.overrides,
    } satisfies YieldRiskBudgetStop;
  });
  return { matching, stops };
}

export function getYieldActiveFilterSummaries(viewModel: YieldViewModel): YieldActiveFilterSummary[] {
  const summaries: YieldActiveFilterSummary[] = [];
  for (const axis of YIELD_FILTER_AXIS_REGISTRY) {
    if (axis.describeActive && axis.isActive(viewModel.filters)) {
      summaries.push({ key: axis.key, label: axis.describeActive(viewModel.filters, viewModel.options) });
    }
  }
  return summaries;
}
