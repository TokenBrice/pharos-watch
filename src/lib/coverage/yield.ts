import type {
  CoverageBreakdownItem,
  CoverageRow,
  CoverageStatus,
} from "@/lib/coverage-types";
import {
  breakdownItem,
  createDataUnavailableStatus,
  resolveBooleanCoverageStatus,
  type CoverageLegendItem,
  type CoverageStatusPreset,
} from "./shared";

const YIELD_RANKED_PRESET: CoverageStatusPreset = {
  kind: "ranked",
  label: "Ranked",
  tone: "emerald",
  available: true,
  sortRank: 1,
  detail: "This asset currently appears in the Yield Intelligence rankings.",
};

const YIELD_NONE_PRESET: CoverageStatusPreset = {
  kind: "none",
  label: "—",
  tone: "slate",
  available: false,
  sortRank: 0,
  detail: "This asset is not currently present in the Yield Intelligence rankings.",
  spokenLabel: "Not ranked",
};

export function resolveYieldCoverage(hasYieldCoverage: boolean, dataAvailable = true): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Yield");
  }

  return resolveBooleanCoverageStatus(hasYieldCoverage, YIELD_RANKED_PRESET, YIELD_NONE_PRESET);
}

export function formatYieldBreakdown(
  _rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
): CoverageBreakdownItem[] {
  const availableCount = breakdownMap.get("ranked") ?? 0;
  const noneCount = breakdownMap.get("none") ?? 0;
  const unavailable = breakdownMap.get("data-unavailable") ?? 0;
  return [
    breakdownItem("covered", "covered", availableCount),
    breakdownItem("uncovered", "uncovered", noneCount + unavailable),
  ];
}

export const YIELD_STATUS_KINDS: readonly string[] = ["ranked", "none", "data-unavailable"] as const;

export const YIELD_LEGEND_ITEMS: readonly CoverageLegendItem[] = [
  {
    term: "Ranked",
    description: "This asset currently appears in the Yield Intelligence rankings.",
    kinds: ["ranked"],
  },
] as const;
