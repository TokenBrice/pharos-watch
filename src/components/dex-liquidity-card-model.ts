import { QUALITY_TIER_3_CLASSES, getHhiBand } from "@shared/lib/classification";
import { LIQUIDITY_SCORE_WEIGHTS } from "@shared/lib/liquidity-score-weights";
import type { DexLiquidityData, DexLiquidityPool } from "@shared/types";

type PoolBalanceDetails = NonNullable<NonNullable<DexLiquidityPool["extra"]>["balanceDetails"]>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function getConcentrationLabel(hhi: number | null | undefined): { label: string; color: string } | null {
  const band = getHhiBand(hhi);
  return band ? { label: band.concentrationLabel, color: band.color } : null;
}

export function getOrganicFractionTier(
  fraction: number,
  maturityDays = 0,
): { label: "Organic" | "Mixed" | "Established" | "Incentivized"; badgeClass: string; summaryColor: string } {
  if (fraction >= 0.7) {
    return {
      label: "Organic",
      badgeClass: QUALITY_TIER_3_CLASSES.good.badgeSoft,
      summaryColor: QUALITY_TIER_3_CLASSES.good.text,
    };
  }
  if (fraction >= 0.3 || maturityDays >= 365) {
    return {
      label: maturityDays >= 365 && fraction < 0.3 ? "Established" : "Mixed",
      badgeClass: QUALITY_TIER_3_CLASSES.watch.badgeSoft,
      summaryColor: QUALITY_TIER_3_CLASSES.watch.text,
    };
  }
  return {
    label: "Incentivized",
    badgeClass: QUALITY_TIER_3_CLASSES.bad.badgeSoft,
    summaryColor: QUALITY_TIER_3_CLASSES.bad.text,
  };
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
  const entries = LIQUIDITY_SCORE_WEIGHTS.map((weight) => {
    const value = components[weight.key];
    return { label: weight.label, value: value == null ? Number.NaN : Math.round(value) };
  });
  // A DEC-19 NR activity component leaves no complete composite to explain.
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
