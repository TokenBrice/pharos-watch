import type { TableSortState } from "@/hooks/use-sorted-table-rows";
import { createTableComparator } from "@/lib/table-comparator";
import type { StablecoinClientMeta } from "@shared/lib/stablecoins/client-registry";
import type { DexLiquidityData } from "@shared/types";
import type { LiquidityScoreUnavailableReason } from "@shared/types/market";
import { dexVolumeToTvlRatio } from "@shared/lib/dex-volume-availability";

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

/** Short labels for the producer's NR reason codes (never inferred client-side). */
export const LIQUIDITY_NR_REASON_LABELS: Record<LiquidityScoreUnavailableReason, string> = {
  "activity-coverage-below-floor": "Volume coverage below floor",
  "activity-missing": "No 24h volume observed",
  "activity-stale": "24h volume stale",
  "activity-completeness-unknown": "Volume completeness unknown",
  "no-retained-pools": "No DEX pools retained",
  "invalid-coverage-evidence": "Coverage evidence invalid",
};

const compareByColumn = createTableComparator<LiquiditySortKey, LiquidityRow>({
  score: (r) => r.liq.liquidityScore,
  tvl: (r) => r.liq.totalTvlUsd,
  tvlTrend: (r) => r.liq.tvlChange7d,
  // Unavailable volume (null) is not zero activity: it sorts last in both directions.
  volume: (r) => r.liq.totalVolume24hUsd,
  volume7d: (r) => r.liq.totalVolume7dUsd,
  vtRatio: (r) => dexVolumeToTvlRatio(r.liq.totalVolume24hUsd, r.liq.totalTvlUsd),
  pools: (r) => r.liq.poolCount,
  chains: (r) => r.liq.chainCount,
  balance: (r) => r.liq.weightedBalanceRatio,
  organic: (r) => r.liq.organicFraction,
  durability: (r) => r.liq.durabilityScore,
});

/**
 * The `≥ $X` text of a partial window, or null when the admitted sum would
 * print as $0.00: an empty bound carries no information and reads like a
 * measured zero (R1), so callers keep the unavailable dash instead.
 */
export function informativeVolumeLowerBound(volume: {
  view: { partialGrossUsd: number | null };
  lowerBound: { text: string } | null;
}): string | null {
  return volume.lowerBound != null && (volume.view.partialGrossUsd ?? 0) >= 0.005 ? volume.lowerBound.text : null;
}

/** NR rows sit after every rated row in both directions and on every column (owner decision). */
export function compareLiquidityRows(
  a: LiquidityRow,
  b: LiquidityRow,
  sort: TableSortState<LiquiditySortKey>,
): number {
  const aRated = a.liq.liquidityScore != null;
  const bRated = b.liq.liquidityScore != null;
  if (aRated !== bRated) return aRated ? -1 : 1;
  return compareByColumn(a, b, sort);
}
