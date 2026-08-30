import type { LiquidityCoverageClass } from "@shared/types";
import type { CoverageStatus } from "@/lib/coverage-types";
import {
  createDataUnavailableStatus,
  createPresetStatus,
  DATA_UNAVAILABLE_KIND,
  definePresetCoverageFeature,
  type CoverageLegendItem,
  type CoverageStatusPreset,
} from "./shared";

const DEX_STATUS_PRESETS = {
  primary: {
    kind: "primary",
    label: "Primary",
    tone: "emerald",
    available: true,
    sortRank: 4,
    detail: "Observed with primary DEX-liquidity source coverage.",
  },
  mixed: {
    kind: "mixed",
    label: "Mixed",
    tone: "sky",
    available: true,
    sortRank: 3,
    detail: "Observed across a mix of primary and fallback DEX-liquidity sources.",
  },
  fallback: {
    kind: "fallback",
    label: "Fallback",
    tone: "amber",
    available: true,
    sortRank: 2,
    detail: "Observed via fallback DEX-liquidity discovery only.",
  },
  legacy: {
    kind: "legacy",
    label: "Legacy",
    tone: "violet",
    available: true,
    sortRank: 1,
    detail: "Legacy liquidity history exists, but the row predates the current coverage model.",
  },
  unobserved: {
    kind: "unobserved",
    label: "Not Covered",
    tone: "slate",
    available: false,
    sortRank: 0,
    detail: "No observed DEX-liquidity row is currently available.",
    spokenLabel: "Not covered",
  },
  unknown: {
    kind: "unknown",
    label: "Unknown",
    tone: "slate",
    available: false,
    sortRank: 0,
    detail: "DEX-liquidity coverage data is unavailable right now.",
  },
} satisfies Record<string, CoverageStatusPreset>;

function resolveDex(
  coverageClass: LiquidityCoverageClass | null | undefined,
  dataAvailable = true,
): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("DEX liquidity");
  }

  return createPresetStatus(DEX_STATUS_PRESETS[coverageClass ?? "unknown"] ?? DEX_STATUS_PRESETS.unknown);
}

const DEX_LEGEND: readonly CoverageLegendItem[] = [
  {
    term: "Primary / Mixed / Fallback",
    description:
      "DEX coverage quality: primary sources, blended primary plus fallback sources, or fallback-only discovery.",
    kinds: ["primary", "mixed", "fallback"],
  },
  {
    term: "Legacy",
    description: "Legacy liquidity history exists, but the row predates the current coverage model.",
    kinds: ["legacy"],
  },
] as const;

export const coverageFeature = definePresetCoverageFeature({
  presets: DEX_STATUS_PRESETS,
  extraStatusKinds: [DATA_UNAVAILABLE_KIND],
  breakdown: [
    { key: "primary", label: "primary" },
    { key: "mixed", label: "mixed" },
    { key: "fallback", label: "fallback" },
    { key: DATA_UNAVAILABLE_KIND, label: "data n/a" },
  ],
  legendItems: DEX_LEGEND,
  resolve: resolveDex,
});
