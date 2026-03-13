import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import { createTableComparator } from "@/lib/table-comparator";
import type { YieldRanking } from "@shared/types";

export type YieldTableSortKey = "pys" | "apy30d" | "safetyScore" | "tvl" | "yieldStability" | "yieldType";

export const compareYieldRows: (
  a: YieldRanking,
  b: YieldRanking,
  sort: TableSortState<YieldTableSortKey>,
) => number = createTableComparator<YieldRanking, YieldTableSortKey>({
  pys: (r) => r.pharosYieldScore ?? -1,
  apy30d: (r) => r.apy30d,
  safetyScore: (r) => r.safetyScore ?? -1,
  tvl: (r) => r.sourceTvlUsd ?? 0,
  yieldStability: (r) => r.yieldStability ?? -1,
  yieldType: (r) => r.yieldType,
});
