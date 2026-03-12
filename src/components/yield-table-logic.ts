import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import type { YieldRanking } from "@shared/types";

export type YieldTableSortKey = "pys" | "apy30d" | "safetyScore" | "tvl" | "yieldStability" | "yieldType";

export function compareYieldRows(
  a: YieldRanking,
  b: YieldRanking,
  sort: TableSortState<YieldTableSortKey>,
): number {
  let aVal: number;
  let bVal: number;

  switch (sort.key) {
    case "pys":
      aVal = a.pharosYieldScore ?? -1;
      bVal = b.pharosYieldScore ?? -1;
      break;
    case "apy30d":
      aVal = a.apy30d;
      bVal = b.apy30d;
      break;
    case "safetyScore":
      aVal = a.safetyScore ?? -1;
      bVal = b.safetyScore ?? -1;
      break;
    case "tvl":
      aVal = a.sourceTvlUsd ?? 0;
      bVal = b.sourceTvlUsd ?? 0;
      break;
    case "yieldStability":
      aVal = a.yieldStability ?? -1;
      bVal = b.yieldStability ?? -1;
      break;
    case "yieldType":
      return sort.direction === "asc"
        ? a.yieldType.localeCompare(b.yieldType)
        : b.yieldType.localeCompare(a.yieldType);
    default:
      aVal = a.pharosYieldScore ?? -1;
      bVal = b.pharosYieldScore ?? -1;
      break;
  }

  return sort.direction === "asc" ? aVal - bVal : bVal - aVal;
}
