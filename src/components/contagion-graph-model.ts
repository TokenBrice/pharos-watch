import { GRADE_RADAR_COLORS } from "@shared/lib/report-cards";
import { v9GradeRange } from "@shared/types/safety-score-v9-grade";
import type { V9Grade } from "@shared/types/safety-score-v9";
import type { ContagionEdgeMateriality } from "@/lib/contagion-layout";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Ordered by how much exposure the relationship implies: full serial
 * pass-through first, then the weighted basket share, then the two degraded
 * dispositions whose magnitude the engine could not bound.
 */
export const DEPENDENCY_TYPE_ORDER = [
  "serial",
  "basket-weighted",
  "serial-blocked",
  "basket-bounded-unknown",
] as const satisfies readonly ContagionEdgeMateriality[];

/**
 * Solid strokes carry a quantified magnitude; dashed strokes flag a
 * disposition the engine could not size. Violet reads serial, slate reads
 * basket, so hue encodes the V9 dependency kind and dash encodes confidence.
 */
export const DEPENDENCY_TYPE_PRESENTATION: Record<
  ContagionEdgeMateriality,
  {
    label: string;
    color: string;
    dash?: string;
  }
> = {
  serial: {
    label: "Serial",
    color: "#8b5cf6",
  },
  "basket-weighted": {
    label: "Basket weighted",
    color: "#64748b",
  },
  "serial-blocked": {
    label: "Serial blocked",
    color: "#ef4444",
    dash: "6 3",
  },
  "basket-bounded-unknown": {
    label: "Basket unbounded",
    color: "#f59e0b",
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
