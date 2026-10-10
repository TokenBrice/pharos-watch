import type { DexVolumeAvailability } from "@shared/types/market";

export interface LiquidityStatsData {
  totalTvl: number | null;
  /** Global measured 24h DEX volume; null when the window is not complete. */
  totalVol: number | null;
  /** Absent for legacy payloads (completeness unrecorded). */
  totalVolAvailability?: DexVolumeAvailability;
  avgScore: number | null;
  withLiquidity: number;
  highConfidenceCoverage: number;
  fallbackCoverage: number;
  totalTracked: number;
  agg7dChange: number | null;
  avgBalance: number | null;
  avgOrganic: number | null;
}
