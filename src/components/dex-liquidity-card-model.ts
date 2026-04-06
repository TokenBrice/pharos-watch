import type { DexLiquidityData, DexLiquidityPool } from "@shared/types";

type PoolBalanceDetails = NonNullable<NonNullable<DexLiquidityPool["extra"]>["balanceDetails"]>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function getConcentrationLabel(hhi: number): { label: string; color: string } {
  if (hhi >= 0.5) return { label: "High", color: "text-red-700 dark:text-red-400" };
  if (hhi >= 0.25) return { label: "Medium", color: "text-amber-700 dark:text-amber-400" };
  return { label: "Low", color: "text-emerald-700 dark:text-emerald-400" };
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

export function getLiquidityEvidenceLabel(liq: DexLiquidityData): string | null {
  switch (liq.liquidityEvidenceClass) {
    case "measured":
      return "Measured liquidity evidence";
    case "partial_measured":
      return `Measured balances cover ${Math.round((liq.balanceMeasuredTvlUsd / Math.max(liq.totalTvlUsd, 1)) * 100)}% of observed TVL`;
    case "observed_unmeasured":
      return "Observed liquidity without measured pool balances";
    default:
      return null;
  }
}
