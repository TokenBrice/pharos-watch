import type { DexVolumeAvailability } from "@shared/types/market";

export interface LiquidityStatsData {
  /** Global DEX TVL; null with `totalTvlUnavailableReason` when unpublished. */
  totalTvl: number | null;
  totalTvlUnavailableReason: string | null;
  /** Global measured 24h DEX volume; null when the window is not complete. */
  totalVol: number | null;
  /** Absent for legacy payloads (completeness unrecorded). */
  totalVolAvailability?: DexVolumeAvailability;
  /** Rows with a published LiquidityScore. */
  ratedCount: number;
  /** Observed markets whose score is NR. */
  nrObservedCount: number;
  withLiquidity: number;
  highConfidenceCoverage: number;
  fallbackCoverage: number;
  totalTracked: number;
  /** Pool-TVL-weighted 7d change over coins with a 7d baseline, not the global total's own change.
   *  Null when any observed member's prior TVL is non-invertible; never a survivor-only aggregate. */
  agg7dChange: number | null;
  avgBalance: number | null;
  avgOrganic: number | null;
}
