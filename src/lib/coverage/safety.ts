import type {
  CoverageBreakdownItem,
  CoverageRow,
  CoverageStatus,
} from "@/lib/coverage-types";
import {
  breakdownItem,
  createDataUnavailableStatus,
  createPresetStatus,
  DATA_UNAVAILABLE_KIND,
  type CoverageLegendItem,
  type CoverageStatusPreset,
} from "./shared";

export const SAFETY_STATUS_PRESETS = {
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

export function resolveSafetyCoverage(
  safetyScore: number | null | undefined,
  dataAvailable = true,
): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Safety Score");
  }

  return createPresetStatus(safetyScore != null ? SAFETY_STATUS_PRESETS.rated : SAFETY_STATUS_PRESETS.nr);
}

export function formatSafetyBreakdown(
  _rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
): CoverageBreakdownItem[] {
  const get = (kind: string) => breakdownMap.get(kind) ?? 0;
  return [
    breakdownItem("rated", "rated", get("rated")),
    breakdownItem("nr", "NR", get("nr")),
    breakdownItem(DATA_UNAVAILABLE_KIND, "data n/a", get(DATA_UNAVAILABLE_KIND)),
  ];
}

export const SAFETY_STATUS_KINDS: readonly string[] = [
  "rated",
  "nr",
  DATA_UNAVAILABLE_KIND,
] as const;

// "NR" is shared with DEX; the dedicated "general" legend entry covers it.
export const SAFETY_LEGEND_ITEMS: readonly CoverageLegendItem[] = [
  {
    term: "Rated",
    description: "This asset currently receives an overall Safety Score.",
    kinds: ["rated"],
  },
] as const;
