import type { CoverageStatus } from "@/lib/coverage-types";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
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
  ratingStatus: SafetyScoreV9CurrentCard["ratingStatus"] | null | undefined,
  dataAvailable = true,
  reasonCodes: readonly string[] = [],
): CoverageStatus {
  if (!dataAvailable || ratingStatus == null) {
    return createDataUnavailableStatus("Safety Score");
  }
  if (ratingStatus === "pipeline-gap") {
    return {
      ...createDataUnavailableStatus("Safety Score"),
      detail: `Safety Score pipeline gap${reasonCodes.length > 0 ? ` (${reasonCodes.join(", ")})` : ""}. Technical evidence is unavailable; this state is not counted as a coverage gap.`,
    };
  }
  if (ratingStatus === "rated" && safetyScore == null) {
    return createDataUnavailableStatus("Safety Score");
  }

  return createPresetStatus(ratingStatus === "rated" ? SAFETY_STATUS_PRESETS.rated : SAFETY_STATUS_PRESETS.nr);
}

// "NR" is shared with DEX; the dedicated "general" legend entry covers it.
const SAFETY_LEGEND: readonly CoverageLegendItem[] = [
  {
    term: "Rated",
    description: "This asset currently receives an overall Safety Score.",
    kinds: ["rated"],
  },
  {
    term: "Data n/a (pipeline gap)",
    description: "Technical evidence is unavailable, not an issuer NR. Pipeline gaps and absent cards are excluded from known coverage reach.",
    kinds: [DATA_UNAVAILABLE_KIND],
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
