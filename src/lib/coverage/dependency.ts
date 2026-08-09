import type {
  CoverageBreakdownItem,
  CoverageRow,
  CoverageStatus,
} from "@/lib/coverage-types";
import type { DependencyCoverageFact, DependencyCoverageKind } from "@/lib/dependency-coverage-facts";
import {
  breakdownItem,
  createBreakdownCounter,
  createDataUnavailableStatus,
  createPresetStatus,
  DATA_UNAVAILABLE_KIND,
  defineCoverageFeature,
  statusKindsFromPresets,
  type CoverageLegendItem,
  type CoverageStatusPreset,
} from "./shared";

type DependencyResolverInput = DependencyCoverageFact | boolean | null | undefined;

const DEPENDENCY_PRESETS: Record<DependencyCoverageKind, CoverageStatusPreset> = {
  both: {
    kind: "both",
    label: "Both",
    tone: "violet",
    available: true,
    sortRank: 4,
    detail: "This asset has tracked upstream dependencies and tracked dependent assets.",
  },
  dependent: {
    kind: "dependent",
    label: "Dep.",
    tone: "amber",
    available: true,
    sortRank: 3,
    detail: "This asset depends on at least one tracked upstream stablecoin.",
    spokenLabel: "Dependent",
  },
  upstream: {
    kind: "upstream",
    label: "Hub",
    tone: "sky",
    available: true,
    sortRank: 2,
    detail: "At least one tracked stablecoin depends on this asset.",
    spokenLabel: "Upstream hub",
  },
  "resolved-none": {
    kind: "resolved-none",
    label: "No deps",
    tone: "emerald",
    available: true,
    sortRank: 1,
    detail: "The report-card snapshot resolved this asset with no tracked stablecoin dependency edge.",
    spokenLabel: "Resolved with no tracked dependencies",
  },
  "unmapped-gap": {
    kind: "unmapped-gap",
    label: "Gap",
    tone: "slate",
    available: false,
    sortRank: 0,
    detail: "Dependency evidence exists, but no live dependency-map edge was resolved.",
    spokenLabel: "Unmapped dependency gap",
  },
};

function legacyBooleanFact(hasDependencyCoverage: boolean): DependencyCoverageFact {
  return {
    kind: hasDependencyCoverage ? "dependent" : "unmapped-gap",
    upstreamCount: hasDependencyCoverage ? 1 : 0,
    dependentCount: 0,
    rawDependencyCount: hasDependencyCoverage ? 1 : 0,
    mappedDependencyWeight: hasDependencyCoverage ? 1 : 0,
  };
}

function normalizeDependencyInput(input: DependencyResolverInput): DependencyCoverageFact {
  if (typeof input === "boolean") {
    return legacyBooleanFact(input);
  }
  return input ?? {
    kind: "unmapped-gap",
    upstreamCount: 0,
    dependentCount: 0,
    rawDependencyCount: 0,
    mappedDependencyWeight: 0,
  };
}

function formatDetail(fact: DependencyCoverageFact, fallback: string): string {
  switch (fact.kind) {
    case "both":
      return `Depends on ${fact.upstreamCount} tracked upstream asset${fact.upstreamCount === 1 ? "" : "s"} and supports ${fact.dependentCount} tracked dependent asset${fact.dependentCount === 1 ? "" : "s"}.`;
    case "dependent":
      return `Depends on ${fact.upstreamCount} tracked upstream asset${fact.upstreamCount === 1 ? "" : "s"}.`;
    case "upstream":
      return `Supports ${fact.dependentCount} tracked dependent asset${fact.dependentCount === 1 ? "" : "s"}.`;
    case "unmapped-gap":
      if (fact.missingReportCard) return "No report-card row was available for this asset.";
      return fact.rawDependencyCount > 0
        ? `Has ${fact.rawDependencyCount} raw dependency input${fact.rawDependencyCount === 1 ? "" : "s"}, but no live graph edge after filtering.`
        : fallback;
    default:
      return fallback;
  }
}

function resolveDependency(
  dependencyCoverage: DependencyResolverInput,
  dataAvailable = true,
): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Dependency map");
  }

  const fact = normalizeDependencyInput(dependencyCoverage);
  const preset = DEPENDENCY_PRESETS[fact.kind];
  return { ...createPresetStatus(preset), detail: formatDetail(fact, preset.detail) };
}

function formatDependency(
  _rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
): CoverageBreakdownItem[] {
  const get = createBreakdownCounter(breakdownMap);
  return [
    breakdownItem("both", "both", get("both")),
    breakdownItem("dependent", "dependent", get("dependent")),
    breakdownItem("upstream", "upstream", get("upstream")),
    breakdownItem("resolved-none", "resolved none", get("resolved-none")),
    breakdownItem("gaps", "gaps", get("unmapped-gap")),
    breakdownItem(DATA_UNAVAILABLE_KIND, "data n/a", get(DATA_UNAVAILABLE_KIND)),
  ];
}

const DEPENDENCY_LEGEND: readonly CoverageLegendItem[] = [
  {
    term: "Both",
    description: "The asset has tracked upstream dependencies and tracked dependents.",
    kinds: ["both"],
  },
  {
    term: "Dep.",
    description: "The asset depends on at least one tracked upstream stablecoin.",
    kinds: ["dependent"],
  },
  {
    term: "Hub",
    description: "At least one tracked stablecoin depends on the asset.",
    kinds: ["upstream"],
  },
  {
    term: "No deps",
    description: "The asset is resolved with no tracked stablecoin dependency edge.",
    kinds: ["resolved-none"],
  },
  {
    term: "Gap",
    description: "Dependency evidence exists, but no live dependency-map edge was resolved.",
    kinds: ["unmapped-gap"],
  },
] as const;

export const coverageFeature = defineCoverageFeature({
  statusKinds: [...statusKindsFromPresets(DEPENDENCY_PRESETS), DATA_UNAVAILABLE_KIND],
  legendItems: DEPENDENCY_LEGEND,
  resolve: resolveDependency,
  formatBreakdown: formatDependency,
});
