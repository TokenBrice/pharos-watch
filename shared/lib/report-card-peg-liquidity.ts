import type {
  DexLiquidityData,
  PegSummaryCoin,
  RedemptionBackstopEntry,
  ReportCardDimension,
  StablecoinMeta,
} from "../types";
import { computeEffectiveExitScore, REDEMPTION_ROUTE_FAMILY_LABELS } from "./redemption-backstop-scoring";
import { ACTIVE_DEPEG_CAP_F_BPS, scoreToGrade } from "./report-card-core";

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
  if (!peg || peg.pegScore === null) {
    if (meta.flags.navToken) {
      return { grade: "NR", score: null, detail: "NAV token - peg tracking not applicable" };
    }
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

type RedemptionLiquidityInput = Pick<
  RedemptionBackstopEntry,
  | "score"
  | "routeFamily"
  | "immediateCapacityUsd"
  | "immediateCapacityRatio"
  | "resolutionState"
  | "modelConfidence"
  | "capacitySemantics"
> & Partial<Pick<
  RedemptionBackstopEntry,
  | "routeStatus"
  | "routeStatusReason"
  | "capacityConfidence"
  | "sourceMode"
  | "accessModel"
  | "settlementModel"
>>;

function formatCapacityUsd(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

function hasStrongLiveDirectRoute(redemption: RedemptionLiquidityInput): boolean {
  return redemption.capacityConfidence === "live-direct" &&
    redemption.sourceMode === "dynamic" &&
    redemption.accessModel === "permissionless-onchain" &&
    (redemption.settlementModel === "atomic" || redemption.settlementModel === "immediate");
}

function isSevereActiveDepeg(activeDepegBps: number | null | undefined): boolean {
  return activeDepegBps != null && activeDepegBps >= ACTIVE_DEPEG_CAP_F_BPS;
}

function getRedemptionExclusionReason(
  redemption: RedemptionLiquidityInput | undefined,
  options?: { activeDepegBps?: number | null },
): string | null {
  if (!redemption) return null;
  if (redemption.resolutionState === "impaired") {
    return "route currently impaired";
  }
  if (redemption.resolutionState !== "resolved" || redemption.score == null) {
    return "route currently unrated";
  }
  if (redemption.modelConfidence === "low") {
    return "low confidence";
  }
  const routeStatus = redemption.routeStatus ?? "unknown";
  if (routeStatus === "degraded" || routeStatus === "paused" || routeStatus === "cohort-limited") {
    return `route currently ${routeStatus}`;
  }
  if (isSevereActiveDepeg(options?.activeDepegBps) && !hasStrongLiveDirectRoute(redemption)) {
    return "active severe depeg requires live-open redemption evidence";
  }
  return null;
}

export function isRedemptionEligibleForLiquidity(
  redemption: RedemptionLiquidityInput | undefined,
  options?: { activeDepegBps?: number | null },
): boolean {
  return redemption != null && getRedemptionExclusionReason(redemption, options) == null;
}

export function scoreLiquidity(
  liq: Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount"> | undefined,
  redemption?: RedemptionLiquidityInput,
  options?: { activeDepegBps?: number | null },
): ReportCardDimension {
  const dexScore = liq?.liquidityScore ?? null;
  const redemptionEligibleForLiquidity = isRedemptionEligibleForLiquidity(redemption, options);
  const redemptionExclusionReason = getRedemptionExclusionReason(redemption, options);
  const redemptionScore = redemption?.score ?? null;
  const effectiveScore = computeEffectiveExitScore(
    dexScore,
    redemptionEligibleForLiquidity ? redemptionScore : null,
  );
  const hasConfiguredRedemption = !!redemption;
  const hasResolvedRedemption = redemption?.resolutionState === "resolved";
  const hasLowConfidenceRedemption = redemption?.modelConfidence === "low";
  const hasImpairedRedemption = redemption?.resolutionState === "impaired";

  if (effectiveScore === null) {
    return {
      grade: "NR",
      score: null,
      detail: hasConfiguredRedemption
        ? hasImpairedRedemption
          ? "DEX liquidity unavailable. Redemption route is configured but currently impaired by market or route-availability evidence"
          : hasLowConfidenceRedemption
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
      parts.push(
        redemptionExclusionReason
          ? `not used for Safety Score uplift (${redemptionExclusionReason})`
          : "not used for Safety Score uplift",
      );
    }
    if (redemption?.immediateCapacityRatio != null) {
      parts.push(`immediate capacity ${(redemption.immediateCapacityRatio * 100).toFixed(1)}% of supply`);
    } else if (redemption?.capacitySemantics === "eventual-only") {
      parts.push("eventual redeemability modeled; immediate buffer not separately quantified");
    } else if (redemption?.immediateCapacityUsd != null) {
      parts.push(`immediate capacity ${formatCapacityUsd(redemption.immediateCapacityUsd)}`);
    }
  } else if (hasConfiguredRedemption && hasImpairedRedemption) {
    parts.push("Redemption route configured but currently impaired");
    if (redemption?.routeStatusReason) parts.push(redemption.routeStatusReason);
  } else if (hasConfiguredRedemption && !hasResolvedRedemption) {
    parts.push("Redemption route configured but currently unrated");
  }

  return { grade: scoreToGrade(score), score, detail: parts.join(". ") };
}
