import type {
  CoverageBreakdownItem,
  CoverageRow,
  CoverageStatus,
} from "@/lib/coverage-types";
import {
  breakdownItem,
  createDataUnavailableStatus,
  DATA_UNAVAILABLE_KIND,
  defineCoverageFeature,
  resolveBooleanCoverageStatus,
  statusKindsFromPresets,
  type CoverageLegendItem,
  type CoverageStatusPreset,
} from "./shared";

const YIELD_STATUS_PRESETS = {
  ranked: {
    kind: "ranked",
    label: "Ranked",
    tone: "emerald",
    available: true,
    sortRank: 1,
    detail: "This asset currently appears in the Yield Intelligence rankings.",
  },
  none: {
    kind: "none",
    label: "Gap",
    tone: "slate",
    available: false,
    sortRank: 0,
    detail: "This asset is not currently present in the Yield Intelligence rankings.",
    spokenLabel: "Gap",
  },
} satisfies Record<string, CoverageStatusPreset>;

function resolveYield(hasYieldCoverage: boolean, dataAvailable = true): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Yield");
  }

  return resolveBooleanCoverageStatus(hasYieldCoverage, YIELD_STATUS_PRESETS.ranked, YIELD_STATUS_PRESETS.none);
}

function formatYield(
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

const YIELD_LEGEND: readonly CoverageLegendItem[] = [
  {
    term: "Ranked",
    description: "This asset currently appears in the Yield Intelligence rankings.",
    kinds: ["ranked"],
  },
] as const;

export const coverageFeature = defineCoverageFeature({
  statusKinds: [...statusKindsFromPresets(YIELD_STATUS_PRESETS), DATA_UNAVAILABLE_KIND],
  legendItems: YIELD_LEGEND,
  resolve: resolveYield,
  formatBreakdown: formatYield,
});
