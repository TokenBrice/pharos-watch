import type { CoverageBreakdownItem, CoverageRow, CoverageStatus } from "@/lib/coverage-types";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import {
  breakdownItem,
  createBreakdownCounter,
  createDataUnavailableStatus,
  createPresetStatus,
  DATA_UNAVAILABLE_KIND,
  defineCoverageFeature,
  legendItemsFromPresets,
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
  "not-graded": {
    kind: "not-graded",
    label: "Not graded",
    tone: "slate",
    available: false,
    sortRank: 1,
    detail:
      "Tokenized fund shares are intentionally not graded on the stablecoin Safety Score scale and are excluded from Safety coverage denominators.",
    spokenLabel: "Not graded (tokenized fund)",
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
  isTokenizedFund = false,
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
  if (isTokenizedFund || reasonCodes.includes("tokenized-fund-not-graded")) {
    return createPresetStatus(SAFETY_STATUS_PRESETS["not-graded"]);
  }
  if (ratingStatus === "rated" && safetyScore == null) {
    return createDataUnavailableStatus("Safety Score");
  }

  return createPresetStatus(ratingStatus === "rated" ? SAFETY_STATUS_PRESETS.rated : SAFETY_STATUS_PRESETS.nr);
}

/**
 * Intentionally ungraded tokenized funds stay outside the Safety coverage
 * count and market-cap denominators, alongside technical `data-unavailable` rows.
 */
export function countsTowardSafetyCoverage(row: CoverageRow): boolean {
  const kind = row.statuses.safety.kind;
  return kind !== DATA_UNAVAILABLE_KIND && kind !== "not-graded";
}

function formatSafety(
  _rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
): CoverageBreakdownItem[] {
  const get = createBreakdownCounter(breakdownMap);
  const items: CoverageBreakdownItem[] = [
    breakdownItem("rated", "rated", get("rated")),
    breakdownItem("nr", "NR", get("nr")),
  ];
  const notGraded = get("not-graded");
  if (notGraded > 0) {
    items.push(breakdownItem("not-graded", "not graded", notGraded));
  }
  items.push(breakdownItem(DATA_UNAVAILABLE_KIND, "data n/a", get(DATA_UNAVAILABLE_KIND)));
  return items;
}

// "NR" is shared with DEX; the dedicated "general" legend entry covers it.
const SAFETY_LEGEND: readonly CoverageLegendItem[] = [
  ...legendItemsFromPresets(SAFETY_STATUS_PRESETS, ["rated", "not-graded"]),
  {
    term: "Data n/a (pipeline gap)",
    description: "Technical evidence is unavailable, not an issuer NR. Pipeline gaps and absent cards are excluded from known coverage reach.",
    kinds: [DATA_UNAVAILABLE_KIND],
  },
] as const;

export const coverageFeature = defineCoverageFeature({
  statusKinds: [...statusKindsFromPresets(SAFETY_STATUS_PRESETS), DATA_UNAVAILABLE_KIND],
  legendItems: SAFETY_LEGEND,
  resolve: resolveSafety,
  formatBreakdown: formatSafety,
});
