import type { DexVolumeAvailability } from "@shared/types/dex-liquidity";

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
  /** Pool-TVL-weighted 7d change over coins with a 7d baseline, or global 7d change when published.
   *  Null when no global 7d change exists and any observed member's prior TVL is non-invertible. */
  agg7dChange: number | null;
  /** Basis for `agg7dChange`: published global row vs coin-weighted sum. */
  agg7dChangeBasis?: "global" | "weighted" | null;
  /** Exact all-member median 7d TVL change across every coin with a finite 7d baseline (including -100%). */
  median7dChange?: number | null;
  /** Count of observed coins with a finite 7d TVL change. */
  change7dCoinCount?: number;
  /** Deduped global DEX TVL divided by total circulating supply when every observed DEX coin has positive supply; null otherwise. */
  aggDepthToMcapRatio?: number | null;
  /** Exact per-coin median DEX TVL / circulating supply across observed DEX coins with positive supply (immune to cross-coin pool overlap). */
  medianDepthToMcapRatio?: number | null;
  /** Coins with valid positive circulating supply among observed DEX coins. */
  aggDepthToMcapObservedCount?: number;
  avgBalance: number | null;
  avgOrganic: number | null;
}
