import type {
  CoverageBreakdownItem,
  CoverageRow,
  CoverageStatus,
} from "@/lib/coverage-types";
import {
  breakdownItem,
  createDataUnavailableStatus,
  createBreakdownCounter,
  createPresetStatus,
  DATA_UNAVAILABLE_KIND,
  defineCoverageFeature,
  statusKindsFromPresets,
  type CoverageLegendItem,
  type CoverageStatusPreset,
} from "./shared";

const SAFETY_STATUS_PRESETS = {
  rated: {
    kind: "rated",
    label: "Rated",
    tone: "emerald",
    available: true,
    sortRank: 2,
    detail: "This asset currently receives an overall Safety Score.",
  },
  nr: {
    kind: "nr",
    label: "NR",
    tone: "slate",
    available: false,
    sortRank: 0,
    detail: "No overall Safety Score is currently assigned.",
    spokenLabel: "Not rated",
  },
} satisfies Record<string, CoverageStatusPreset>;

function resolveSafety(
  safetyScore: number | null | undefined,
  dataAvailable = true,
): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Safety Score");
  }

  return createPresetStatus(safetyScore != null ? SAFETY_STATUS_PRESETS.rated : SAFETY_STATUS_PRESETS.nr);
}

function formatSafety(
  _rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
): CoverageBreakdownItem[] {
  const get = createBreakdownCounter(breakdownMap);
  return [
    breakdownItem("rated", "rated", get("rated")),
    breakdownItem("nr", "NR", get("nr")),
    breakdownItem(DATA_UNAVAILABLE_KIND, "data n/a", get(DATA_UNAVAILABLE_KIND)),
  ];
}

// "NR" is shared with DEX; the dedicated "general" legend entry covers it.
const SAFETY_LEGEND: readonly CoverageLegendItem[] = [
  {
    term: "Rated",
    description: "This asset currently receives an overall Safety Score.",
    kinds: ["rated"],
  },
] as const;

export const coverageFeature = defineCoverageFeature({
  statusKinds: [...statusKindsFromPresets(SAFETY_STATUS_PRESETS), DATA_UNAVAILABLE_KIND],
  legendItems: SAFETY_LEGEND,
  resolve: resolveSafety,
  formatBreakdown: formatSafety,
});
