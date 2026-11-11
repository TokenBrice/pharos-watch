import { getHhiBand } from "@shared/lib/classification";
import type { DexLiquidityData, DexLiquidityPool } from "@shared/types/dex-liquidity";

type PoolBalanceDetails = NonNullable<NonNullable<DexLiquidityPool["extra"]>["balanceDetails"]>;

export function getConcentrationLabel(hhi: number | null | undefined): { label: string; color: string } | null {
  const band = getHhiBand(hhi);
  return band ? { label: band.concentrationLabel, color: band.color } : null;
}

export function formatFeeTierLabel(feeTier: number): string {
  if (Math.abs(feeTier - Math.round(feeTier)) < 0.01) return `${Math.round(feeTier)}bp`;
  return `${feeTier.toFixed(2).replace(/\.?0+$/, "")}bp`;
}

export function getPoolVariantLabel(poolType: string): string | null {
  switch (poolType) {
    case "balancer-stable":
      return "stable";
    case "balancer-weighted":
      return "weighted";
    case "raydium-clmm":
      return "CLMM";
    case "raydium-amm":
      return "AMM";
    case "orca-whirlpool":
      return "Whirlpool";
    default:
      return null;
  }
}

export function formatBalanceDetails(balanceDetails: PoolBalanceDetails | undefined): string | null {
  if (!balanceDetails || balanceDetails.length === 0) return null;
  return balanceDetails
    .map((entry) => `${entry.symbol} ${entry.balancePct.toFixed(1)}%`)
    .join(", ");
}

/**
 * DEC-19 read side: the published LiquidityScore is NR because required 24h
 * volume activity was unavailable (admitted pools below the TVL coverage
 * floor, or unknown completeness) — not because the token lacks a direct DEX
 * market. Legacy payloads never match.
 */
export function isLiquidityActivityNotRated(liq: DexLiquidityData): boolean {
  if (liq.liquidityScore != null) return false;
  if (liq.scoreComponents?.volumeActivity === null) return true;
  return liq.volume24hAvailability != null && liq.volume24hAvailability.completeness !== "complete";
}

export function getLiquidityEvidenceLabel(liq: DexLiquidityData): string | null {
  switch (liq.liquidityEvidenceClass) {
    case "measured":
      return "Measured liquidity evidence";
    case "partial_measured":
      if (liq.balanceMeasuredTvlUsd == null) return "Measured balance coverage unavailable";
      return `Measured balances cover ${Math.round((liq.balanceMeasuredTvlUsd / Math.max(liq.totalTvlUsd, 1)) * 100)}% of observed TVL`;
    case "observed_unmeasured":
      return "Observed liquidity without measured pool balances";
    default:
      return null;
  }
}
