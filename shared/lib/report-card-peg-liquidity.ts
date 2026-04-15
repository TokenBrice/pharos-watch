import type {
  DexLiquidityData,
  PegSummaryCoin,
  RedemptionBackstopEntry,
  ReportCardDimension,
  StablecoinMeta,
} from "../types";
import {
  computeEffectiveExitScore,
  isStrongLiveDirectRoute,
  REDEMPTION_ROUTE_FAMILY_LABELS,
} from "./redemption-backstop-scoring";
import { ACTIVE_DEPEG_CAP_F_BPS } from "./report-card-active-depeg";
import { scoreToGrade } from "./report-card-core";

interface PegStabilityFacts {
  score: number;
  label: string;
  activeDepeg: boolean;
  eventCount: number;
  worstDeviationBps: number | null;
  yieldBearing: boolean;
}

function buildPegStabilityFacts(
  peg: PegSummaryCoin,
  meta: StablecoinMeta,
  label: string,
): PegStabilityFacts {
  return {
    score: Math.round(Math.max(0, Math.min(100, peg.pegScore ?? 0))),
    label,
    activeDepeg: peg.activeDepeg,
    eventCount: peg.eventCount,
    worstDeviationBps: peg.worstDeviationBps,
    yieldBearing: !!meta.flags.yieldBearing,
  };
}

function buildPegStabilityDimension(
  peg: PegSummaryCoin,
  meta: StablecoinMeta,
  label: string,
): ReportCardDimension {
  const facts = buildPegStabilityFacts(peg, meta, label);
  const score = facts.score;

  const parts: string[] = [];
  parts.push(`${facts.label}: ${score}/100`);
  if (facts.activeDepeg) parts.push("active depeg");
  if (facts.eventCount === 0) {
    parts.push("No depeg events recorded");
  } else {
    parts.push(`${facts.eventCount} depeg event${facts.eventCount === 1 ? "" : "s"}`);
  }
  if (facts.worstDeviationBps !== null) {
    parts.push(`worst deviation: ${facts.worstDeviationBps} bps`);
  }

  let detail = parts.join(". ");
  if (facts.yieldBearing) {
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
  if (
    redemption.capacityConfidence == null ||
    redemption.sourceMode == null ||
    redemption.accessModel == null ||
    redemption.settlementModel == null
  ) {
    return false;
  }
  return isStrongLiveDirectRoute({
    capacityConfidence: redemption.capacityConfidence,
    sourceMode: redemption.sourceMode,
    accessModel: redemption.accessModel,
    settlementModel: redemption.settlementModel,
  });
}

function isSevereActiveDepeg(activeDepegBps: number | null | undefined): boolean {
  return activeDepegBps != null && activeDepegBps >= ACTIVE_DEPEG_CAP_F_BPS;
}

function isQueueLikeRedemption(redemption: RedemptionLiquidityInput): boolean {
  return redemption.routeFamily === "queue-redeem" || redemption.settlementModel === "queued";
}

function isDocumentedOffchainIssuerEventualRoute(redemption: RedemptionLiquidityInput): boolean {
  return (
    redemption.routeFamily === "offchain-issuer" &&
    redemption.capacitySemantics === "eventual-only" &&
    redemption.capacityConfidence === "documented-bound"
  );
}

function getSafetyEligibleRedemptionScore(
  redemption: RedemptionLiquidityInput | undefined,
  dexScore: number | null,
): number | null {
  if (!redemption || redemption.score == null) return null;
  if (isDocumentedOffchainIssuerEventualRoute(redemption)) {
    if (dexScore == null) return null;
    return Math.min(dexScore, redemption.score);
  }
  if (redemption.capacitySemantics === "eventual-only") return null;
  if (isQueueLikeRedemption(redemption)) {
    return Math.min(redemption.score, 70);
  }
  return redemption.score;
}

function getRedemptionExclusionReason(
  redemption: RedemptionLiquidityInput | undefined,
  options?: { activeDepegBps?: number | null; dexLiquidityScore?: number | null },
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
  const documentedIssuerEventual = isDocumentedOffchainIssuerEventualRoute(redemption);
  if (redemption.capacitySemantics === "eventual-only" && !documentedIssuerEventual) {
    return "eventual-only route";
  }
  const routeStatus = redemption.routeStatus ?? "unknown";
  if (routeStatus === "degraded" || routeStatus === "paused" || routeStatus === "cohort-limited") {
    return `route currently ${routeStatus}`;
  }
  if (isSevereActiveDepeg(options?.activeDepegBps) && !hasStrongLiveDirectRoute(redemption)) {
    return "active severe depeg requires live-open redemption evidence";
  }
  if (documentedIssuerEventual && options?.dexLiquidityScore == null) {
    return "primary-market route requires DEX liquidity floor";
  }
  return null;
}

export function isRedemptionEligibleForLiquidity(
  redemption: RedemptionLiquidityInput | undefined,
  options?: { activeDepegBps?: number | null; dexLiquidityScore?: number | null },
): boolean {
  return redemption != null && getRedemptionExclusionReason(redemption, options) == null;
}

interface LiquidityScoringFacts {
  dexScore: number | null;
  redemptionEligibleForLiquidity: boolean;
  redemptionExclusionReason: string | null;
  redemptionScore: number | null;
  effectiveScore: number | null;
  hasConfiguredRedemption: boolean;
  hasResolvedRedemption: boolean;
  hasLowConfidenceRedemption: boolean;
  hasImpairedRedemption: boolean;
}

function buildLiquidityScoringFacts(
  liq: Pick<DexLiquidityData, "liquidityScore"> | undefined,
  redemption: RedemptionLiquidityInput | undefined,
  options?: { activeDepegBps?: number | null },
): LiquidityScoringFacts {
  const dexScore = liq?.liquidityScore ?? null;
  const eligibilityOptions = { ...options, dexLiquidityScore: dexScore };
  const redemptionEligibleForLiquidity = isRedemptionEligibleForLiquidity(redemption, eligibilityOptions);
  const redemptionExclusionReason = getRedemptionExclusionReason(redemption, eligibilityOptions);
  const redemptionScore = redemption?.score ?? null;
  const eligibleRedemptionScore = redemptionEligibleForLiquidity
    ? getSafetyEligibleRedemptionScore(redemption, dexScore)
    : null;
  return {
    dexScore,
    redemptionEligibleForLiquidity,
    redemptionExclusionReason,
    redemptionScore,
    effectiveScore: computeEffectiveExitScore(
      dexScore,
      eligibleRedemptionScore,
    ),
    hasConfiguredRedemption: !!redemption,
    hasResolvedRedemption: redemption?.resolutionState === "resolved",
    hasLowConfidenceRedemption: redemption?.modelConfidence === "low",
    hasImpairedRedemption: redemption?.resolutionState === "impaired",
  };
}

export function scoreLiquidity(
  liq: Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount"> | undefined,
  redemption?: RedemptionLiquidityInput,
  options?: { activeDepegBps?: number | null },
): ReportCardDimension {
  const facts = buildLiquidityScoringFacts(liq, redemption, options);

  if (facts.effectiveScore === null) {
    return {
      grade: "NR",
      score: null,
      detail: facts.hasConfiguredRedemption
        ? facts.hasImpairedRedemption
          ? "DEX liquidity unavailable. Redemption route is configured but currently impaired by market or route-availability evidence"
          : facts.hasLowConfidenceRedemption
          ? "DEX liquidity unavailable. A low-confidence redemption route exists, but it is excluded from Safety Score liquidity until evidence improves"
          : !facts.hasResolvedRedemption
          ? "DEX liquidity unavailable. Redemption route is configured but currently unrated"
          : facts.redemptionExclusionReason
          ? `DEX liquidity unavailable. Redemption route is configured but not used for Safety Score liquidity (${facts.redemptionExclusionReason})`
          : "DEX liquidity unavailable. Redemption route is configured but currently unrated"
        : "No DEX liquidity data",
    };
  }

  const score = Math.round(Math.max(0, Math.min(100, facts.effectiveScore)));
  const parts: string[] = [];
  parts.push(`Effective exit score: ${score}/100`);
  if (facts.dexScore !== null) {
    parts.push(`DEX liquidity ${Math.round(Math.max(0, Math.min(100, facts.dexScore)))}/100`);
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
  if (facts.redemptionScore !== null) {
    parts.push(`Redemption backstop ${Math.round(facts.redemptionScore)}/100`);
    if (redemption?.routeFamily) {
      parts.push(REDEMPTION_ROUTE_FAMILY_LABELS[redemption.routeFamily]);
    }
    if (!facts.redemptionEligibleForLiquidity) {
      parts.push(
        facts.redemptionExclusionReason
          ? `not used for Safety Score uplift (${facts.redemptionExclusionReason})`
          : "not used for Safety Score uplift",
      );
    } else if (redemption && isDocumentedOffchainIssuerEventualRoute(redemption)) {
      parts.push("primary-market exit bonus only");
    }
    if (redemption?.immediateCapacityRatio != null) {
      parts.push(`immediate capacity ${(redemption.immediateCapacityRatio * 100).toFixed(1)}% of supply`);
    } else if (redemption?.capacitySemantics === "eventual-only") {
      parts.push("eventual redeemability modeled; immediate buffer not separately quantified");
    } else if (redemption?.immediateCapacityUsd != null) {
      parts.push(`immediate capacity ${formatCapacityUsd(redemption.immediateCapacityUsd)}`);
    }
  } else if (facts.hasConfiguredRedemption && facts.hasImpairedRedemption) {
    parts.push("Redemption route configured but currently impaired");
    if (redemption?.routeStatusReason) parts.push(redemption.routeStatusReason);
  } else if (facts.hasConfiguredRedemption && !facts.hasResolvedRedemption) {
    parts.push("Redemption route configured but currently unrated");
  }

  return { grade: scoreToGrade(score), score, detail: parts.join(". ") };
}
