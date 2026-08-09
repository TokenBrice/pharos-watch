import type { StatusCause } from "@shared/types";

/**
 * Rank for `StatusCause["severity"]`, ordered **worst first** (`critical` = 0).
 * Every consumer therefore picks the more severe cause with `<` and sorts
 * ascending to put criticals at the top.
 *
 * This is the opposite direction from `SEVERITY_RANK` in
 * `@/lib/status/workspace-mode`, which ranks the workspace severity vocabulary
 * best-first. The two vocabularies are disjoint (`critical|warning|info` vs
 * `healthy|watch|critical|unknown`); do not merge or reuse them.
 */
export const STATUS_CAUSE_SEVERITY_RANK: Readonly<Record<StatusCause["severity"], number>> = {
  critical: 0,
  warning: 1,
  info: 2,
};
