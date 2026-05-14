import type {
  CoverageBreakdownItem,
  CoverageRow,
  CoverageStatus,
} from "@/lib/coverage-types";
import {
  breakdownItem,
  createDataUnavailableStatus,
  defineCoverageFeature,
  resolveBooleanCoverageStatus,
  type CoverageLegendItem,
  type CoverageStatusPreset,
} from "./shared";

const DEPENDENCY_NODE_PRESET: CoverageStatusPreset = {
  kind: "node",
  label: "Node",
  tone: "amber",
  available: true,
  sortRank: 1,
  detail: "This asset participates in the report-card dependency graph.",
};

const DEPENDENCY_NONE_PRESET: CoverageStatusPreset = {
  kind: "none",
  label: "Gap",
  tone: "slate",
  available: false,
  sortRank: 0,
  detail: "This asset currently has no dependency-graph edge coverage.",
  spokenLabel: "Gap",
};

function resolveDependency(
  hasDependencyCoverage: boolean,
  dataAvailable = true,
): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Dependency map");
  }

  return resolveBooleanCoverageStatus(hasDependencyCoverage, DEPENDENCY_NODE_PRESET, DEPENDENCY_NONE_PRESET);
}

function formatDependency(
  _rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
): CoverageBreakdownItem[] {
  const availableCount = breakdownMap.get("node") ?? 0;
  const noneCount = breakdownMap.get("none") ?? 0;
  const unavailable = breakdownMap.get("data-unavailable") ?? 0;
  return [
    breakdownItem("covered", "covered", availableCount),
    breakdownItem("uncovered", "uncovered", noneCount + unavailable),
  ];
}

const DEPENDENCY_KINDS: readonly string[] = ["node", "none", "data-unavailable"] as const;

const DEPENDENCY_LEGEND: readonly CoverageLegendItem[] = [
  {
    term: "Node",
    description: "The asset participates in the report-card dependency graph.",
    kinds: ["node"],
  },
] as const;

export const coverageFeature = defineCoverageFeature({
  statusKinds: DEPENDENCY_KINDS,
  legendItems: DEPENDENCY_LEGEND,
  resolve: resolveDependency,
  formatBreakdown: formatDependency,
});

export const resolveDependencyCoverage = coverageFeature.resolve;
export const formatDependencyBreakdown = coverageFeature.formatBreakdown;
export const DEPENDENCY_STATUS_KINDS = coverageFeature.statusKinds;
export const DEPENDENCY_LEGEND_ITEMS = coverageFeature.legendItems;
