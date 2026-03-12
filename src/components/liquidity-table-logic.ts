import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import type { DexLiquidityData, StablecoinMeta } from "@shared/types";

export type LiquiditySortKey =
  | "score"
  | "tvl"
  | "tvlTrend"
  | "volume"
  | "volume7d"
  | "vtRatio"
  | "pools"
  | "chains"
  | "balance"
  | "organic"
  | "durability";

export interface LiquidityRow {
  meta: StablecoinMeta;
  liq: DexLiquidityData;
}

export function compareLiquidityRows(
  a: LiquidityRow,
  b: LiquidityRow,
  sort: TableSortState<LiquiditySortKey>,
): number {
  const aLiq = a.liq;
  const bLiq = b.liq;
  let aVal: number;
  let bVal: number;

  switch (sort.key) {
    case "score":
      aVal = aLiq.liquidityScore ?? 0;
      bVal = bLiq.liquidityScore ?? 0;
      break;
    case "tvl":
      aVal = aLiq.totalTvlUsd;
      bVal = bLiq.totalTvlUsd;
      break;
    case "tvlTrend":
      aVal = aLiq.tvlChange7d ?? 0;
      bVal = bLiq.tvlChange7d ?? 0;
      break;
    case "volume":
      aVal = aLiq.totalVolume24hUsd;
      bVal = bLiq.totalVolume24hUsd;
      break;
    case "volume7d":
      aVal = aLiq.totalVolume7dUsd;
      bVal = bLiq.totalVolume7dUsd;
      break;
    case "vtRatio":
      aVal = aLiq.totalTvlUsd > 0 ? aLiq.totalVolume24hUsd / aLiq.totalTvlUsd : 0;
      bVal = bLiq.totalTvlUsd > 0 ? bLiq.totalVolume24hUsd / bLiq.totalTvlUsd : 0;
      break;
    case "pools":
      aVal = aLiq.poolCount;
      bVal = bLiq.poolCount;
      break;
    case "chains":
      aVal = aLiq.chainCount;
      bVal = bLiq.chainCount;
      break;
    case "balance":
      aVal = aLiq.weightedBalanceRatio ?? 0;
      bVal = bLiq.weightedBalanceRatio ?? 0;
      break;
    case "organic":
      aVal = aLiq.organicFraction ?? 0;
      bVal = bLiq.organicFraction ?? 0;
      break;
    case "durability":
      aVal = aLiq.durabilityScore ?? 0;
      bVal = bLiq.durabilityScore ?? 0;
      break;
    default:
      aVal = aLiq.liquidityScore ?? 0;
      bVal = bLiq.liquidityScore ?? 0;
      break;
  }

  return sort.direction === "asc" ? aVal - bVal : bVal - aVal;
}
