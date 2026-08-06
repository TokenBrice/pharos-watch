import { GRADE_RADAR_COLORS } from "@shared/lib/report-cards";
import { v9GradeRange } from "@shared/types/safety-score-v9-grade";
import type { V9Grade } from "@shared/types/safety-score-v9";
import type { ContagionEdgeRelationship } from "@/lib/contagion-layout";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** V8's legend order, which readers already know. */
export const DEPENDENCY_TYPE_ORDER = [
  "collateral",
  "wrapper",
] as const satisfies readonly ContagionEdgeRelationship[];

/**
 * The two relationships the map draws, in the vocabulary the methodology page
 * already publishes ("a serial wrapper cannot escape its parent; basket
 * exposure is weighted") and the V8 palette readers already know — solid slate
 * collateral, dotted violet wrapper.
 *
 * Whether the upstream score resolved is deliberately not encoded here. It is a
 * data-quality fact, reported by the detail modules that exist to report it;
 * folding it into the legend split two relationships into four categories and
 * made the map harder to read for no structural gain.
 */
export const DEPENDENCY_TYPE_PRESENTATION: Record<
  ContagionEdgeRelationship,
  {
    label: string;
    description: string;
    color: string;
    dash?: string;
    showWeight?: boolean;
  }
> = {
  collateral: {
    label: "Collateral",
    description:
      "A weighted share of this asset's backing. Risk is inherited in proportion to that share.",
    color: "#64748b",
    showWeight: true,
  },
  wrapper: {
    label: "Wrapper",
    description:
      "A full pass-through claim on the upstream asset. The wrapper inherits the upstream's risk in full and cannot be safer than it.",
    color: "#8b5cf6",
    dash: "2 3",
  },
};

export const DEPENDENCY_TYPE_FILTERS = [
  { value: "all" as const, label: "All", description: "Draw every dependency relationship." },
  ...DEPENDENCY_TYPE_ORDER.map((type) => ({
    value: type,
    label: DEPENDENCY_TYPE_PRESENTATION[type].label,
    description: DEPENDENCY_TYPE_PRESENTATION[type].description,
  })),
] as const;

export const TYPE_COLORS: Record<ContagionEdgeRelationship, string> = Object.fromEntries(
  DEPENDENCY_TYPE_ORDER.map((type) => [type, DEPENDENCY_TYPE_PRESENTATION[type].color]),
) as Record<ContagionEdgeRelationship, string>;

export const TYPE_DASH: Record<ContagionEdgeRelationship, string | undefined> = Object.fromEntries(
  DEPENDENCY_TYPE_ORDER.map((type) => [type, DEPENDENCY_TYPE_PRESENTATION[type].dash]),
) as Record<ContagionEdgeRelationship, string | undefined>;

const DEPENDENCY_TYPE_RANK = new Map<ContagionEdgeRelationship, number>(
  DEPENDENCY_TYPE_ORDER.map((type, index) => [type, index]),
);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function gradeColor(grade: V9Grade): string {
  return GRADE_RADAR_COLORS[v9GradeRange(grade)] ?? GRADE_RADAR_COLORS.NR;
}

export function compareDependencyTypes(a: ContagionEdgeRelationship, b: ContagionEdgeRelationship): number {
  const rank = (DEPENDENCY_TYPE_RANK.get(a) ?? Number.MAX_SAFE_INTEGER)
    - (DEPENDENCY_TYPE_RANK.get(b) ?? Number.MAX_SAFE_INTEGER);
  if (rank !== 0) return rank;
  return a.localeCompare(b);
}
