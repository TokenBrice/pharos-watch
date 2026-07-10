import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import { createTableComparator } from "@/lib/table-comparator";
import { getYieldAlternateSourceCount, type YieldWorkbenchRanking } from "@/lib/yield-workbench-row";

export type YieldTableSortKey =
  "pys" | "apy30d" | "safetyScore" | "tvl" | "yieldStability" | "yieldType" | "sourceCount";

export const compareYieldRows: (
  a: YieldWorkbenchRanking,
  b: YieldWorkbenchRanking,
  sort: TableSortState<YieldTableSortKey>,
) => number = createTableComparator<YieldTableSortKey, YieldWorkbenchRanking>({
  pys: (r) => r.pharosYieldScore ?? -1,
  apy30d: (r) => r.apy30d,
  safetyScore: (r) => r.safetyScore ?? -1,
  tvl: (r) => r.sourceTvlUsd ?? 0,
  yieldStability: (r) => r.yieldStability ?? -1,
  yieldType: (r) => r.yieldType,
  sourceCount: (r) => 1 + getYieldAlternateSourceCount(r),
});
