import type { CoverageStatus } from "@/lib/coverage-types";
import {
  createDataUnavailableStatus,
  createPresetStatus,
  DATA_UNAVAILABLE_KIND,
  definePresetCoverageFeature,
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

// "NR" is shared with DEX; the dedicated "general" legend entry covers it.
const SAFETY_LEGEND: readonly CoverageLegendItem[] = [
  {
    term: "Rated",
    description: "This asset currently receives an overall Safety Score.",
    kinds: ["rated"],
  },
] as const;

export const coverageFeature = definePresetCoverageFeature({
  presets: SAFETY_STATUS_PRESETS,
  extraStatusKinds: [DATA_UNAVAILABLE_KIND],
  breakdown: [
    { key: "rated", label: "rated" },
    { key: "nr", label: "NR" },
    { key: DATA_UNAVAILABLE_KIND, label: "data n/a" },
  ],
  legendItems: SAFETY_LEGEND,
  resolve: resolveSafety,
});
