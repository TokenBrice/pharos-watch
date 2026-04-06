import type {
  DexLiquidityData,
  PegSummaryCoin,
  RedemptionBackstopEntry,
  ReportCardDimension,
  StablecoinMeta,
} from "../types";
import { computeEffectiveExitScore, REDEMPTION_ROUTE_FAMILY_LABELS } from "./redemption-backstop-scoring";
import { scoreToGrade } from "./report-card-core";

function buildPegStabilityDimension(
  peg: PegSummaryCoin,
  meta: StablecoinMeta,
  label: string,
): ReportCardDimension {
  let score = Math.round(Math.max(0, Math.min(100, peg.pegScore ?? 0)));
  if (peg.activeDepeg) score = Math.min(65, score);

  const parts: string[] = [];
  parts.push(`${label}: ${score}/100`);
  if (peg.activeDepeg) parts.push("(active depeg, capped at C)");
  if (peg.eventCount === 0) {
    parts.push("No depeg events recorded");
  } else {
    parts.push(`${peg.eventCount} depeg event${peg.eventCount === 1 ? "" : "s"}`);
  }
  if (peg.worstDeviationBps !== null) {
    parts.push(`worst deviation: ${peg.worstDeviationBps} bps`);
  }

  let detail = parts.join(". ");
  if (meta.flags.yieldBearing) {
    detail += " (yield-bearing — expected price appreciation excluded)";
  }

  return { grade: scoreToGrade(score), score, detail };
}

export function scorePegStability(
  peg: PegSummaryCoin | undefined,
  meta: StablecoinMeta,
  options?: {
    inheritedFromReference?: boolean;
    pegReferenceMeta?: Pick<StablecoinMeta, "id" | "symbol" | "name"> | null;
  },
): ReportCardDimension {
  if (meta.flags.navToken) {
    return { grade: "NR", score: null, detail: "NAV token - peg tracking not applicable" };
  }

  if (!peg || peg.pegScore === null) {
    return { grade: "NR", score: null, detail: "Insufficient peg tracking data" };
  }

  if (peg.currentDeviationBps === null && peg.eventCount === 0 && !options?.inheritedFromReference) {
    return { grade: "NR", score: null, detail: "No price data available for peg evaluation" };
  }

  const label = options?.inheritedFromReference && options.pegReferenceMeta
    ? `Peg reference (${options.pegReferenceMeta.symbol})`
    : "Peg score";
  return buildPegStabilityDimension(peg, meta, label);
}

function formatCapacityUsd(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

export function scoreLiquidity(
  liq: Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount"> | undefined,
  redemption?: Pick<
    RedemptionBackstopEntry,
    | "score"
    | "routeFamily"
    | "immediateCapacityUsd"
    | "immediateCapacityRatio"
    | "resolutionState"
    | "modelConfidence"
    | "capacitySemantics"
  >,
): ReportCardDimension {
  const dexScore = liq?.liquidityScore ?? null;
  const redemptionEligibleForLiquidity =
    redemption?.resolutionState === "resolved" && redemption?.modelConfidence !== "low";
  const redemptionScore = redemption?.score ?? null;
  const effectiveScore = computeEffectiveExitScore(
    dexScore,
    redemptionEligibleForLiquidity ? redemptionScore : null,
  );
  const hasConfiguredRedemption = !!redemption;
  const hasResolvedRedemption = redemption?.resolutionState === "resolved";
  const hasLowConfidenceRedemption = redemption?.modelConfidence === "low";

  if (effectiveScore === null) {
    return {
      grade: "NR",
      score: null,
      detail: hasConfiguredRedemption
        ? hasLowConfidenceRedemption
          ? "DEX liquidity unavailable. A low-confidence redemption route exists, but it is excluded from Safety Score liquidity until evidence improves"
          : "DEX liquidity unavailable. Redemption route is configured but currently unrated"
        : "No DEX liquidity data",
    };
  }

  const score = Math.round(Math.max(0, Math.min(100, effectiveScore)));
  const parts: string[] = [];
  parts.push(`Effective exit score: ${score}/100`);
  if (dexScore !== null) {
    parts.push(`DEX liquidity ${Math.round(Math.max(0, Math.min(100, dexScore)))}/100`);
  } else {
    parts.push("DEX liquidity unavailable");
  }
  if (liq) {
    parts.push(
      `${liq.poolCount} pool${liq.poolCount === 1 ? "" : "s"} across ${liq.chainCount} chain${liq.chainCount === 1 ? "" : "s"}`,
    );
  }
  if (liq?.concentrationHhi != null && liq.concentrationHhi > 0.5) {
    parts.push(`high concentration (HHI: ${liq.concentrationHhi.toFixed(2)})`);
  }
  if (redemptionScore !== null) {
    parts.push(`Redemption backstop ${Math.round(redemptionScore)}/100`);
    if (redemption?.routeFamily) {
      parts.push(REDEMPTION_ROUTE_FAMILY_LABELS[redemption.routeFamily]);
    }
    if (!redemptionEligibleForLiquidity) {
      parts.push("not used for Safety Score uplift (low confidence)");
    }
    if (redemption?.immediateCapacityRatio != null) {
      parts.push(`immediate capacity ${(redemption.immediateCapacityRatio * 100).toFixed(1)}% of supply`);
    } else if (redemption?.capacitySemantics === "eventual-only") {
      parts.push("eventual redeemability modeled; immediate buffer not separately quantified");
    } else if (redemption?.immediateCapacityUsd != null) {
      parts.push(`immediate capacity ${formatCapacityUsd(redemption.immediateCapacityUsd)}`);
    }
  } else if (hasConfiguredRedemption && !hasResolvedRedemption) {
    parts.push("Redemption route configured but currently unrated");
  }

  return { grade: scoreToGrade(score), score, detail: parts.join(". ") };
}
