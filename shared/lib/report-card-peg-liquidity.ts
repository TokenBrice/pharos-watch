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
import { formatCompactUsdShort } from "./format";
import { scoreToGrade } from "./report-card-core";
import { detailItemsFromParts, joinReportCardDetail, plural } from "./report-card-detail";
import { roundScore } from "./math";
import {
  applyReportCardDexEvidencePolicy,
  type ReportCardDexEvidenceInput,
  type ReportCardDexEvidencePolicy,
} from "./report-card-liquidity-evidence";

interface PegStabilityFacts {
  score: number;
  label: string;
  activeDepeg: boolean;
  eventCount: number;
  worstDeviationBps: number | null;
  yieldBearing: boolean;
}

function buildPegStabilityFacts(peg: PegSummaryCoin, meta: StablecoinMeta, label: string): PegStabilityFacts {
  return {
    score: roundScore(peg.pegScore ?? 0),
    label,
    activeDepeg: peg.activeDepeg,
    eventCount: peg.eventCount,
    worstDeviationBps: peg.worstDeviationBps,
    yieldBearing: !!meta.flags.yieldBearing,
  };
}

function buildPegStabilityDimension(peg: PegSummaryCoin, meta: StablecoinMeta, label: string): ReportCardDimension {
  const facts = buildPegStabilityFacts(peg, meta, label);
  const score = facts.score;

  const parts: string[] = [];
  parts.push(`${facts.label}: ${score}/100`);
  if (facts.activeDepeg) parts.push("active depeg");
  if (facts.eventCount === 0) {
    parts.push("No depeg events recorded");
  } else {
    parts.push(plural(facts.eventCount, "depeg event"));
  }
  if (facts.worstDeviationBps !== null) {
    parts.push(`worst deviation: ${facts.worstDeviationBps} bps`);
  }

  let detail = parts.join(". ");
  if (facts.yieldBearing) {
    detail += " (yield-bearing — expected price appreciation excluded)";
  }

  const detailItems = detailItemsFromParts(parts);
  if (facts.yieldBearing) {
    detailItems.push({
      label: "Adjustment",
      value: "Yield-bearing",
      detail: "yield-bearing — expected price appreciation excluded",
    });
  }

  return { grade: scoreToGrade(score), score, detail, detailItems };
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
      return {
        grade: "NR",
        score: null,
        detail: "NAV token - peg tracking not applicable",
        detailItems: [{ label: "Peg tracking", value: "Not applicable", detail: "NAV token" }],
      };
    }
    return {
      grade: "NR",
      score: null,
      detail: "Insufficient peg tracking data",
      detailItems: [{ label: "Peg tracking", value: "Insufficient data" }],
    };
  }

  if (peg.currentDeviationBps === null && peg.eventCount === 0 && !options?.inheritedFromReference) {
    return {
      grade: "NR",
      score: null,
      detail: "No price data available for peg evaluation",
      detailItems: [{ label: "Peg tracking", value: "No price data available" }],
    };
  }

  const label =
    options?.inheritedFromReference && options.pegReferenceMeta
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
  | "eventualRedeemabilityScore"
  | "resolutionState"
  | "modelConfidence"
  | "capacitySemantics"
  | "capacityProfile"
  | "routeExitCorrelation"
> &
  Partial<
    Pick<
      RedemptionBackstopEntry,
      | "routeStatus"
      | "routeStatusReason"
      | "capacityConfidence"
      | "capacityKind"
      | "sourceMode"
      | "accessModel"
      | "settlementModel"
    >
  >;

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
    capacityKind: redemption.capacityKind,
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

function getRedemptionRouteQualityScore(redemption: RedemptionLiquidityInput | undefined): number | null {
  if (!redemption) return null;
  if (redemption.score != null) return redemption.score;
  if (redemption.capacitySemantics === "eventual-only") {
    return redemption.eventualRedeemabilityScore ?? null;
  }
  return null;
}

function getSafetyEligibleRedemptionScore(
  redemption: RedemptionLiquidityInput | undefined,
  dexScore: number | null,
): number | null {
  const redemptionScore = getRedemptionRouteQualityScore(redemption);
  if (!redemption || redemptionScore == null) return null;
  if (isDocumentedOffchainIssuerEventualRoute(redemption)) {
    if (dexScore == null) return null;
    return Math.min(dexScore, redemptionScore);
  }
  if (redemption.capacitySemantics === "eventual-only") return null;
  if (isQueueLikeRedemption(redemption)) {
    return Math.min(redemptionScore, 70);
  }
  return redemptionScore;
}

function getRedemptionExclusionReason(
  redemption: RedemptionLiquidityInput | undefined,
  options?: { activeDepegBps?: number | null; dexLiquidityScore?: number | null },
): string | null {
  if (!redemption) return null;
  if (redemption.resolutionState === "impaired") {
    return "route currently impaired";
  }
  const routeQualityScore = getRedemptionRouteQualityScore(redemption);
  if (redemption.resolutionState !== "resolved" || routeQualityScore == null) {
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
  dexEvidencePolicy: ReportCardDexEvidencePolicy;
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
  liq: ReportCardDexEvidenceInput | undefined,
  redemption: RedemptionLiquidityInput | undefined,
  options?: { activeDepegBps?: number | null },
): LiquidityScoringFacts {
  const dexEvidencePolicy = applyReportCardDexEvidencePolicy(liq ?? { liquidityScore: null });
  const dexScore = dexEvidencePolicy.effectiveScore;
  const eligibilityOptions = { ...options, dexLiquidityScore: dexScore };
  const redemptionEligibleForLiquidity = isRedemptionEligibleForLiquidity(redemption, eligibilityOptions);
  const redemptionExclusionReason = getRedemptionExclusionReason(redemption, eligibilityOptions);
  const redemptionScore = getRedemptionRouteQualityScore(redemption);
  const eligibleRedemptionScore = redemptionEligibleForLiquidity
    ? getSafetyEligibleRedemptionScore(redemption, dexScore)
    : null;
  return {
    dexScore,
    dexEvidencePolicy,
    redemptionEligibleForLiquidity,
    redemptionExclusionReason,
    redemptionScore,
    effectiveScore: computeEffectiveExitScore(
      dexScore,
      eligibleRedemptionScore,
      redemption
        ? {
            modeledExitSizeUsd: redemption.capacityProfile?.modeledExitSizeUsd,
            currentExecutableCapacityUsd: redemption.capacityProfile?.scoringUsd ?? redemption.immediateCapacityUsd,
            routeExitCorrelation: redemption.routeExitCorrelation,
            modelConfidence: redemption.modelConfidence,
          }
        : undefined,
    ),
    hasConfiguredRedemption: !!redemption,
    hasResolvedRedemption: redemption?.resolutionState === "resolved",
    hasLowConfidenceRedemption: redemption?.modelConfidence === "low",
    hasImpairedRedemption: redemption?.resolutionState === "impaired",
  };
}

function describeUnavailableLiquidity(facts: LiquidityScoringFacts): string {
  if (!facts.hasConfiguredRedemption) return "No DEX liquidity data";
  if (facts.hasImpairedRedemption) {
    return "DEX liquidity unavailable. Redemption route is configured but currently impaired by market or route-availability evidence";
  }
  if (facts.hasLowConfidenceRedemption) {
    return "DEX liquidity unavailable. A low-confidence redemption route exists, but it is excluded from Safety Score liquidity until evidence improves";
  }
  if (!facts.hasResolvedRedemption) {
    return "DEX liquidity unavailable. Redemption route is configured but currently unrated";
  }
  if (facts.redemptionExclusionReason) {
    return `DEX liquidity unavailable. Redemption route is configured but not used for Safety Score liquidity (${facts.redemptionExclusionReason})`;
  }
  return "DEX liquidity unavailable. Redemption route is configured but currently unrated";
}

export function scoreLiquidity(
  liq:
    | (Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount"> &
        Omit<ReportCardDexEvidenceInput, "liquidityScore">)
    | undefined,
  redemption?: RedemptionLiquidityInput,
  options?: { activeDepegBps?: number | null },
): ReportCardDimension {
  const facts = buildLiquidityScoringFacts(liq, redemption, options);

  if (facts.effectiveScore === null) {
    const detail = describeUnavailableLiquidity(facts);
    return {
      grade: "NR",
      score: null,
      detail,
      detailItems: [{ label: "Liquidity", value: detail }],
    };
  }

  const score = roundScore(facts.effectiveScore);
  const parts: string[] = [];
  parts.push(`Effective exit score: ${score}/100`);
  if (facts.dexScore !== null) {
    parts.push(`DEX liquidity ${roundScore(facts.dexScore)}/100`);
    if (
      facts.dexEvidencePolicy.observedScore != null &&
      facts.dexEvidencePolicy.observedScore !== facts.dexScore
    ) {
      parts.push(
        `observed DEX score ${roundScore(facts.dexEvidencePolicy.observedScore)}/100 capped by ${facts.dexEvidencePolicy.evidenceKind ?? "weak"} evidence`,
      );
    } else if (facts.dexEvidencePolicy.evidenceKind != null) {
      parts.push(`DEX evidence: ${facts.dexEvidencePolicy.evidenceKind}`);
    }
  } else {
    parts.push("DEX liquidity unavailable");
  }
  if (liq) {
    parts.push(
      `${plural(liq.poolCount, "pool")} across ${plural(liq.chainCount, "chain")}`,
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
      parts.push(`immediate capacity ${formatCompactUsdShort(redemption.immediateCapacityUsd)}`);
    }
  } else if (facts.hasConfiguredRedemption && facts.hasImpairedRedemption) {
    parts.push("Redemption route configured but currently impaired");
    if (redemption?.routeStatusReason) parts.push(redemption.routeStatusReason);
  } else if (facts.hasConfiguredRedemption && !facts.hasResolvedRedemption) {
    parts.push("Redemption route configured but currently unrated");
  }

  const detailItems = detailItemsFromParts(parts);

  return { grade: scoreToGrade(score), score, detail: joinReportCardDetail(detailItems), detailItems };
}
