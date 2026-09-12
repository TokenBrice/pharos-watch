import type { YieldViewModelRow } from "@/lib/yield-view-model";

export interface YieldStoryCallouts {
  topYield: YieldViewModelRow | null;
  mostStable: YieldViewModelRow | null;
  largestMarket: YieldViewModelRow | null;
  /**
   * Rows excluded from the largest-market tile because they publish no source
   * TVL (E11). The tile reads "largest *tracked* market", not an absolute
   * fact, and the hero footnotes this count.
   */
  unmeasuredTvlCount: number;
}

export function buildYieldStoryCallouts(
  visibleRows: readonly YieldViewModelRow[],
): YieldStoryCallouts | null {
  if (visibleRows.length === 0) return null;

  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

  const topYield = [...visibleRows].sort(
    (a, b) => b.apy30d - a.apy30d || byId(a, b),
  )[0] ?? null;

  const stableAplusRows = visibleRows
    .filter((row) => (row.safetyGrade === "A+" || row.safetyGrade === "A") && row.apy30d > 0)
    .sort((a, b) => {
      const scoreA = a.yieldStability ?? -1;
      const scoreB = b.yieldStability ?? -1;
      return scoreB - scoreA || b.apy30d - a.apy30d || byId(a, b);
    });
  const mostStable = stableAplusRows[0] ?? null;

  // E11: the tile filters rows with no measured source TVL, so a native giant
  // without a TVL figure can never win. Count the exclusions so the hero can
  // footnote them instead of presenting the tile as absolute fact.
  const unmeasuredTvlCount = visibleRows.filter((row) => !((row.sourceTvlUsd ?? 0) > 0)).length;

  const largestMarket = [...visibleRows]
    .filter((row) => (row.sourceTvlUsd ?? 0) > 0)
    .sort((a, b) => (b.sourceTvlUsd ?? 0) - (a.sourceTvlUsd ?? 0) || byId(a, b))[0] ?? null;

  return { topYield, mostStable, largestMarket, unmeasuredTvlCount };
}
