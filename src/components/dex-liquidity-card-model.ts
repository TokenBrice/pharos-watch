import { LIQUIDITY_SCORE_WEIGHTS } from "@shared/lib/liquidity-score-weights";
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

/**
 * One-line verdict derived from the published score components — a template
 * over data, never authored per coin: the strongest components "carry" the
 * score and the weakest is named the drag (below 60) or the softest spot.
 * Replaces the methodology disclaimer as the module's opening line; the
 * disclaimer lives verbatim in the liquidityScore methodology hint.
 */
export function buildLiquidityVerdictLine(components: DexLiquidityData["scoreComponents"]): string | null {
  if (!components) return null;
  const entries = LIQUIDITY_SCORE_WEIGHTS.map((weight) => ({
    label: weight.label,
    value: Math.round(components[weight.key]),
  }));
  if (entries.some((entry) => !Number.isFinite(entry.value))) return null;

  const sorted = [...entries].sort((a, b) => b.value - a.value);
  const strengths = sorted.filter((entry) => entry.value >= 70).slice(0, 2);
  const weakest = sorted[sorted.length - 1]!;

  const strengthClause =
    strengths.length === 2
      ? `${strengths[0]!.label} ${strengths[0]!.value} and ${strengths[1]!.label.toLowerCase()} ${strengths[1]!.value} carry the score`
      : strengths.length === 1
        ? `${strengths[0]!.label} ${strengths[0]!.value} carries the score`
        : "No component clears 70";
  const weakClause =
    weakest.value < 60
      ? `${weakest.label.toLowerCase()} ${weakest.value} is the drag`
      : `${weakest.label.toLowerCase()} ${weakest.value} is the softest`;

  return `${strengthClause}; ${weakClause}.`;
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
