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
  YIELD_RISK_BUDGET_SPECS,
  type YieldPresetSpec,
  type YieldRiskBudgetSpec,
  type YieldViewModelFilters,
} from "@/lib/yield-view-config";
import { median } from "@shared/lib/stats";

export function buildYieldStats(
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

  return {
    avgApy: rows.length === 0 ? 0 : tvlSum > 0 ? weightedApySum / tvlSum : unweightedApySum / rows.length,
    medianApy: median(apys) ?? 0,
    topYield,
    bestPys,
    warningRowCount,
    nullSafetyCount,
    nullTvlCount,
    ...benchmarkFrame,
  };
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
      count: countRowsMatchingFilters(facets, presetFilters(spec)),
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

function riskBudgetTargetFilters(spec: YieldRiskBudgetSpec): YieldViewModelFilters {
  const riskOverrides = Object.fromEntries(
    RISK_BUDGET_FILTER_KEYS.filter((key) => key in spec.overrides).map((key) => [key, spec.overrides[key]]),
  ) as Partial<YieldViewModelFilters>;
  return applyOverrides(riskOverrides);
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
      count: countRowsMatchingFilters(facets, riskBudgetTargetFilters(spec)),
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
