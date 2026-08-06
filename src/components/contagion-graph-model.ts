import { GRADE_RADAR_COLORS } from "@shared/lib/report-cards";
import { v9GradeRange } from "@shared/types/safety-score-v9-grade";
import type { V9Grade } from "@shared/types/safety-score-v9";
import type { ContagionEdgeMateriality } from "@/lib/contagion-layout";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Ordered by how much exposure the relationship implies: the full pass-through
 * claim first, then the weighted backing share, then the same two relationships
 * where the upstream score could not be resolved.
 */
export const DEPENDENCY_TYPE_ORDER = [
  "serial",
  "basket-weighted",
  "serial-blocked",
  "basket-bounded-unknown",
] as const satisfies readonly ContagionEdgeMateriality[];

/**
 * Reader-facing names for the V9 materiality dispositions. The engine's own
 * terms (`serial`, `basket`, `blocked`, `bounded-unknown`) describe the
 * traversal, not the relationship, so the map uses the vocabulary the
 * methodology page already publishes: a serial claim is a wrapper, a basket
 * claim is weighted collateral, and both degrade the same way when the upstream
 * score cannot be resolved — a cycle, or an upstream that is itself unrated.
 *
 * Encoding: hue is the relationship (violet wrapper, slate collateral, matching
 * the retired V8 palette), and a broken stroke means the upstream score was
 * unavailable. Only a weighted collateral share carries a meaningful percentage.
 */
export const DEPENDENCY_TYPE_PRESENTATION: Record<
  ContagionEdgeMateriality,
  {
    label: string;
    description: string;
    color: string;
    dash?: string;
    showWeight?: boolean;
  }
> = {
  serial: {
    label: "Wrapper",
    description:
      "A full pass-through claim on the upstream asset. The wrapper inherits the upstream's risk in full and cannot be safer than it.",
    color: "#8b5cf6",
  },
  "basket-weighted": {
    label: "Collateral",
    description:
      "A weighted share of this asset's backing. Risk is inherited in proportion to that share.",
    color: "#64748b",
    showWeight: true,
  },
  "serial-blocked": {
    label: "Wrapper · unscored",
    description:
      "A full pass-through claim whose upstream score could not be resolved, because the upstream is unrated or the dependency is circular.",
    color: "#8b5cf6",
    dash: "6 3",
  },
  "basket-bounded-unknown": {
    label: "Collateral · unscored",
    description:
      "A backing share whose upstream score could not be resolved, because the upstream is unrated or the dependency is circular. Its size is not modeled.",
    color: "#64748b",
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

export const TYPE_COLORS: Record<ContagionEdgeMateriality, string> = Object.fromEntries(
  DEPENDENCY_TYPE_ORDER.map((type) => [type, DEPENDENCY_TYPE_PRESENTATION[type].color]),
) as Record<ContagionEdgeMateriality, string>;

export const TYPE_DASH: Record<ContagionEdgeMateriality, string | undefined> = Object.fromEntries(
  DEPENDENCY_TYPE_ORDER.map((type) => [type, DEPENDENCY_TYPE_PRESENTATION[type].dash]),
) as Record<ContagionEdgeMateriality, string | undefined>;

const DEPENDENCY_TYPE_RANK = new Map<ContagionEdgeMateriality, number>(
  DEPENDENCY_TYPE_ORDER.map((type, index) => [type, index]),
);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function gradeColor(grade: V9Grade): string {
  return GRADE_RADAR_COLORS[v9GradeRange(grade)] ?? GRADE_RADAR_COLORS.NR;
}

export function compareDependencyTypes(a: ContagionEdgeMateriality, b: ContagionEdgeMateriality): number {
  const rank = (DEPENDENCY_TYPE_RANK.get(a) ?? Number.MAX_SAFE_INTEGER)
    - (DEPENDENCY_TYPE_RANK.get(b) ?? Number.MAX_SAFE_INTEGER);
  if (rank !== 0) return rank;
  return a.localeCompare(b);
}
