import type { LiquidityCoverageClass } from "@shared/types";
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

function formatDex(
  _rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
): CoverageBreakdownItem[] {
  const get = createBreakdownCounter(breakdownMap);
  return [
    breakdownItem("primary", "primary", get("primary")),
    breakdownItem("mixed", "mixed", get("mixed")),
    breakdownItem("fallback", "fallback", get("fallback")),
    breakdownItem(DATA_UNAVAILABLE_KIND, "data n/a", get(DATA_UNAVAILABLE_KIND)),
  ];
}

const DEX_KINDS: readonly string[] = [
  "primary",
  "mixed",
  "fallback",
  "legacy",
  "unobserved",
  "unknown",
  DATA_UNAVAILABLE_KIND,
] as const;

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

export const coverageFeature = defineCoverageFeature({
  statusKinds: DEX_KINDS,
  legendItems: DEX_LEGEND,
  resolve: resolveDex,
  formatBreakdown: formatDex,
});
