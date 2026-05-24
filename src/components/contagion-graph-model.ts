import { GRADE_RADAR_COLORS, gradeRange } from "@shared/lib/report-cards";
import type { ReportCardGrade, DependencyType } from "@shared/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEPENDENCY_TYPE_ORDER = ["collateral", "mechanism", "wrapper"] as const satisfies readonly DependencyType[];

export const DEPENDENCY_TYPE_PRESENTATION: Record<
  DependencyType,
  {
    label: string;
    color: string;
    dash?: string;
  }
> = {
  collateral: {
    label: "Collateral",
    color: "#64748b",
  },
  mechanism: {
    label: "Mechanism",
    color: "#f59e0b",
    dash: "6 3",
  },
  wrapper: {
    label: "Wrapper",
    color: "#8b5cf6",
    dash: "2 3",
  },
};

export const DEPENDENCY_TYPE_FILTERS = [
  { value: "all" as const, label: "All" },
  ...DEPENDENCY_TYPE_ORDER.map((type) => ({
    value: type,
    label: DEPENDENCY_TYPE_PRESENTATION[type].label,
  })),
] as const;

export const TYPE_COLORS: Record<DependencyType, string> = Object.fromEntries(
  DEPENDENCY_TYPE_ORDER.map((type) => [type, DEPENDENCY_TYPE_PRESENTATION[type].color]),
) as Record<DependencyType, string>;

export const TYPE_DASH: Record<DependencyType, string | undefined> = Object.fromEntries(
  DEPENDENCY_TYPE_ORDER.map((type) => [type, DEPENDENCY_TYPE_PRESENTATION[type].dash]),
) as Record<DependencyType, string | undefined>;

const DEPENDENCY_TYPE_RANK = new Map<DependencyType, number>(
  DEPENDENCY_TYPE_ORDER.map((type, index) => [type, index]),
);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function gradeColor(grade: string): string {
  return GRADE_RADAR_COLORS[gradeRange(grade as ReportCardGrade)] ?? GRADE_RADAR_COLORS.NR;
}

export function compareDependencyTypes(a: DependencyType, b: DependencyType): number {
  const rank = (DEPENDENCY_TYPE_RANK.get(a) ?? Number.MAX_SAFE_INTEGER)
    - (DEPENDENCY_TYPE_RANK.get(b) ?? Number.MAX_SAFE_INTEGER);
  if (rank !== 0) return rank;
  return a.localeCompare(b);
}
