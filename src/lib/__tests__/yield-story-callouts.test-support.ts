import type { YieldViewModelRow } from "@/lib/yield-view-model";

/** Minimal row for story-callout selection tests; only the ranked fields matter. */
export function row(id: string, overrides: Partial<YieldViewModelRow>): YieldViewModelRow {
  return {
    id,
    symbol: id.toUpperCase(),
    name: id,
    apy30d: 0,
    safetyGrade: "B",
    yieldStability: null,
    sourceTvlUsd: null,
    warningSignals: [],
    ...overrides,
  } as YieldViewModelRow;
}
