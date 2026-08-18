import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import { createTableComparator } from "@/lib/table-comparator";
import type { StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import type { DexLiquidityData } from "@shared/types";

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
  meta: StablecoinClientMeta;
  liq: DexLiquidityData;
}

export const compareLiquidityRows: (
  a: LiquidityRow,
  b: LiquidityRow,
  sort: TableSortState<LiquiditySortKey>,
) => number = createTableComparator<LiquiditySortKey, LiquidityRow>({
  score: (r) => r.liq.liquidityScore ?? 0,
  tvl: (r) => r.liq.totalTvlUsd,
  tvlTrend: (r) => r.liq.tvlChange7d ?? 0,
  volume: (r) => r.liq.totalVolume24hUsd,
  volume7d: (r) => r.liq.totalVolume7dUsd ?? 0,
  vtRatio: (r) => r.liq.totalTvlUsd > 0 ? r.liq.totalVolume24hUsd / r.liq.totalTvlUsd : 0,
  pools: (r) => r.liq.poolCount,
  chains: (r) => r.liq.chainCount,
  balance: (r) => r.liq.weightedBalanceRatio ?? 0,
  organic: (r) => r.liq.organicFraction ?? 0,
  durability: (r) => r.liq.durabilityScore ?? 0,
});
