import type {
  RedemptionAccessModel,
  RedemptionCapacityConfidence,
  RedemptionExecutionModel,
  RedemptionHolderEligibility,
  RedemptionLiveCapacityKind,
  RedemptionOutputAssetType,
  RedemptionRouteFamily,
  RedemptionSettlementModel,
  RedemptionSourceMode,
} from "../types";
import {
  EXIT_ROUTE_SCORING_TABLES,
  blendExitCapacityComponent,
  composeExitComponentScore,
  hasMaterialExitCapacity,
  interpolateExitBreakpointScore,
  resolveExitDelayBandMultiplier,
  resolveExitRequestSupplyNotionalUsd,
  resolveExitThresholdBandMultiplier,
} from "./exit-route-scoring";
import { roundScore } from "./math";

export const REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS = EXIT_ROUTE_SCORING_TABLES.componentWeights;

/**
 * The redemption view's supply-denominator request. Named after the modeled
 * exit size it produces, which the capacity profile publishes so a route's
 * capacity can be read against the notional it was measured for.
 */
const REDEMPTION_MODELED_EXIT_SIZE_REQUEST = {
  supplyRatio: EXIT_ROUTE_SCORING_TABLES.request.supplyRatio,
  floorUsd: EXIT_ROUTE_SCORING_TABLES.request.floorUsd,
  capUsd: EXIT_ROUTE_SCORING_TABLES.request.capUsd,
} as const;

/**
 * Common-request policy for the exit-route observations both producers emit.
 * Both must encode this requested bound and horizon; actual route fees and
 * delays belong in route evidence and do not redefine the comparison request.
 */
export const SAME_NOTIONAL_EXIT_REQUEST_POLICY = {
  maxCostBps: EXIT_ROUTE_SCORING_TABLES.request.maxCostBps,
  settlementHorizonSec: EXIT_ROUTE_SCORING_TABLES.request.settlementHorizonSec,
} as const;

export const SAME_NOTIONAL_EXIT_OBSERVATION_FRESHNESS_POLICY = {
  documentedTermsMaxAgeSec: EXIT_ROUTE_SCORING_TABLES.documentedTermsMaxAgeSec,
} as const;

/**
 * Route-family score ceilings applied after the weighted component score.
 *
 * - `queueRedeem` (70): queued redemption inherently involves multi-hour or
 *   multi-day settlement friction plus FIFO processing. Even a perfect
 *   component mix stays below 70/100 so queued rails never match permissionless
 *   atomic rails. See v3.7 methodology changelog.
 *
 * - `offchainIssuer` (65): offchain institutional redemption is gated by KYC,
 *   primary-market access, and banking-hour settlement. The 65 ceiling reflects
 *   the residual par-exit guarantee that CeFi-issued coins carry for retail
 *   holders even without a live instant buffer. See v3.7 methodology changelog.
 */
export const REDEMPTION_ROUTE_FAMILY_CAPS = EXIT_ROUTE_SCORING_TABLES.routeFamilyCaps;

/**
 * Input shape for {@link isStrongLiveDirectRoute}.
 *
 * A route qualifies as a "strong live-direct" route when its current redemption
 * evidence is fresh direct on-chain telemetry AND the route itself is
 * permissionless + atomic/immediate. Only these routes remain scoreable during a
 * severe active depeg because only they provide current direct exercisability
 * evidence.
 * See redemption backstop methodology v3.8.
 */
export interface StrongLiveDirectRouteInput {
  capacityConfidence: RedemptionCapacityConfidence;
  capacityKind?: RedemptionLiveCapacityKind;
  sourceMode: RedemptionSourceMode;
  accessModel: RedemptionAccessModel;
  settlementModel: RedemptionSettlementModel;
}

export function isStrongLiveDirectRoute(input: StrongLiveDirectRouteInput): boolean {
  const hasDirectCapacityKind = input.capacityKind === "live-direct" || input.capacityKind === "live-direct-bounded";
  return (
    hasDirectCapacityKind &&
    input.capacityConfidence === "live-direct" &&
    input.sourceMode === "dynamic" &&
    input.accessModel === "permissionless-onchain" &&
    (input.settlementModel === "atomic" || input.settlementModel === "immediate")
  );
}

export const REDEMPTION_ACCESS_SCORES: Record<RedemptionAccessModel, number> = EXIT_ROUTE_SCORING_TABLES.accessScores;

export const REDEMPTION_SETTLEMENT_SCORES: Record<RedemptionSettlementModel, number> =
  EXIT_ROUTE_SCORING_TABLES.settlementScores;

export const REDEMPTION_EXECUTION_SCORES: Record<RedemptionExecutionModel, number> =
  EXIT_ROUTE_SCORING_TABLES.executionScores;

export const REDEMPTION_OUTPUT_ASSET_SCORES: Record<RedemptionOutputAssetType, number> =
  EXIT_ROUTE_SCORING_TABLES.outputAssetScores;

const COVERAGE_RATIO_BREAKPOINTS = EXIT_ROUTE_SCORING_TABLES.coverageRatioBreakpoints;

const ABSOLUTE_CAPACITY_BREAKPOINTS = EXIT_ROUTE_SCORING_TABLES.absoluteCapacityBreakpoints;

const SETTLEMENT_DELAY_PENALTY_TIERS = EXIT_ROUTE_SCORING_TABLES.settlementDelayBands;

const QUEUE_BACKLOG_PENALTY_TIERS = EXIT_ROUTE_SCORING_TABLES.queueBacklogBands;

const MIN_REDEEM_PENALTY_TIERS = EXIT_ROUTE_SCORING_TABLES.minimumRedeemBands;

const LIVE_HOLDER_ELIGIBILITY_MULTIPLIERS: Record<RedemptionHolderEligibility, number> =
  EXIT_ROUTE_SCORING_TABLES.holderEligibilityMultipliers;

/**
 * The domain view rounds each interpolated component to a whole score before it
 * enters the weighted ladder; the V9 pillar carries the fractional value. Both
 * read the same breakpoint tables through the shared interpolator.
 */
function interpolateScore(
  value: number | null | undefined,
  breakpoints: readonly { value: number; score: number }[],
): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  if (breakpoints.length === 0) return null;
  return Math.round(interpolateExitBreakpointScore(value, breakpoints));
}

export function computeCapacityScore(args: {
  immediateCapacityUsd: number | null;
  immediateCapacityRatio: number | null;
  absoluteOnlyMode?: "interpolated" | "tier-floor";
}): {
  score: number | null;
  coverageRatioScore: number | null;
  absoluteCapacityScore: number | null;
} {
  const coverageRatioScore = interpolateScore(args.immediateCapacityRatio, COVERAGE_RATIO_BREAKPOINTS);
  const absoluteCapacityScore =
    args.absoluteOnlyMode === "tier-floor"
      ? scoreAbsoluteCapacityTierFloor(args.immediateCapacityUsd)
      : interpolateScore(args.immediateCapacityUsd, ABSOLUTE_CAPACITY_BREAKPOINTS);

  if (coverageRatioScore == null && absoluteCapacityScore == null) {
    return {
      score: null,
      coverageRatioScore,
      absoluteCapacityScore,
    };
  }

  const coverage = coverageRatioScore ?? absoluteCapacityScore ?? 0;
  const absolute = absoluteCapacityScore ?? coverageRatioScore ?? 0;

  return {
    score: Math.round(blendExitCapacityComponent(coverage, absolute)),
    coverageRatioScore,
    absoluteCapacityScore,
  };
}

function scoreAbsoluteCapacityTierFloor(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  let floor: number = ABSOLUTE_CAPACITY_BREAKPOINTS[0].score;
  for (const breakpoint of ABSOLUTE_CAPACITY_BREAKPOINTS) {
    if (value < breakpoint.value) break;
    floor = breakpoint.score;
  }
  return floor;
}

export function applyCapacityConstraintScoreEffects(args: {
  capacityScore: number | null;
  scoringCapacityUsd: number | null;
  settlementDelaySec?: number;
  queueDepthUsd?: number;
  minRedeemUsd?: number;
  liveHolderEligibility?: RedemptionHolderEligibility;
}): {
  score: number | null;
  capsApplied: string[];
} {
  if (args.capacityScore == null) return { score: null, capsApplied: [] };

  let score = args.capacityScore;
  const capsApplied: string[] = [];

  if (args.settlementDelaySec != null) {
    const delayMultiplier = resolveSettlementDelayMultiplier(args.settlementDelaySec);
    if (delayMultiplier < 1) {
      score *= delayMultiplier;
      capsApplied.push("settlement-delay-penalty");
    }
  }

  if (
    args.queueDepthUsd != null &&
    args.queueDepthUsd > 0 &&
    args.scoringCapacityUsd != null &&
    args.scoringCapacityUsd > 0
  ) {
    const backlogRatio = args.queueDepthUsd / args.scoringCapacityUsd;
    const queueMultiplier = resolveQueueBacklogMultiplier(backlogRatio);
    score *= queueMultiplier;
    capsApplied.push("queue-depth-penalty");
  }

  if (args.minRedeemUsd != null) {
    const minRedeemMultiplier = resolveMinRedeemMultiplier(args.minRedeemUsd);
    if (minRedeemMultiplier < 1) {
      score *= minRedeemMultiplier;
      capsApplied.push("minimum-size-penalty");
    }
  }

  if (args.liveHolderEligibility != null) {
    const holderMultiplier = resolveLiveHolderEligibilityMultiplier(args.liveHolderEligibility);
    if (holderMultiplier < 1) {
      score *= holderMultiplier;
      capsApplied.push("live-holder-eligibility-penalty");
    }
  }

  return {
    score: roundScore(score),
    capsApplied,
  };
}

function resolveSettlementDelayMultiplier(settlementDelaySec: number): number {
  // NaN-input fall-through: no penalty.
  return resolveExitDelayBandMultiplier(settlementDelaySec, SETTLEMENT_DELAY_PENALTY_TIERS) ?? 1;
}

function resolveQueueBacklogMultiplier(backlogRatio: number): number {
  // NaN-input fall-through: no penalty.
  return resolveExitThresholdBandMultiplier(backlogRatio, QUEUE_BACKLOG_PENALTY_TIERS) ?? 1;
}

function resolveMinRedeemMultiplier(minRedeemUsd: number): number {
  // At-or-above matching, unified with the queue ladder above: a minimum on a
  // threshold takes that band. NaN-input fall-through: no penalty.
  return resolveExitThresholdBandMultiplier(minRedeemUsd, MIN_REDEEM_PENALTY_TIERS) ?? 1;
}

function resolveLiveHolderEligibilityMultiplier(holderEligibility: RedemptionHolderEligibility): number {
  return LIVE_HOLDER_ELIGIBILITY_MULTIPLIERS[holderEligibility];
}

export function computeRedemptionBackstopScore(args: {
  routeFamily: RedemptionRouteFamily;
  accessScore: number;
  settlementScore: number;
  executionCertaintyScore: number;
  capacityScore: number | null;
  outputAssetQualityScore: number;
  costScore: number;
  totalScoreCap?: number;
  executableCapacityUsd?: number | null;
  modeledExitSizeUsd?: number | null;
}): { score: number | null; capsApplied: string[] } {
  if (args.capacityScore == null) {
    return {
      score: null,
      capsApplied: [],
    };
  }

  let score = composeExitComponentScore(
    {
      access: args.accessScore,
      settlement: args.settlementScore,
      executionCertainty: args.executionCertaintyScore,
      capacity: args.capacityScore,
      outputAssetQuality: args.outputAssetQualityScore,
      cost: args.costScore,
    },
    REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS,
  );

  const capsApplied: string[] = [];

  if (args.executableCapacityUsd === 0) {
    return { score: 0, capsApplied: ["zero-executable-capacity"] };
  }
  if (
    args.executableCapacityUsd != null &&
    !hasMaterialExitCapacity({
      executableCapacityUsd: args.executableCapacityUsd,
      requestedNotionalUsd: args.modeledExitSizeUsd,
    })
  ) {
    return { score: 0, capsApplied: ["immaterial-executable-capacity"] };
  }

  if (args.routeFamily === "queue-redeem" && score > REDEMPTION_ROUTE_FAMILY_CAPS.queueRedeem) {
    score = REDEMPTION_ROUTE_FAMILY_CAPS.queueRedeem;
    capsApplied.push("queue-route-cap");
  }

  if (args.routeFamily === "offchain-issuer" && score > REDEMPTION_ROUTE_FAMILY_CAPS.offchainIssuer) {
    score = REDEMPTION_ROUTE_FAMILY_CAPS.offchainIssuer;
    capsApplied.push("offchain-route-cap");
  }

  if (args.totalScoreCap != null && score > args.totalScoreCap) {
    score = args.totalScoreCap;
    capsApplied.push("config-cap");
  }

  return {
    score: roundScore(score),
    capsApplied,
  };
}

/**
 * The redemption view's request: the supply-denominator notional, taken
 * straight off the shared clamped supply share without the V9 pillar's
 * notional-grid snap.
 */
export function computeModeledExitSizeUsd(circulatingSupplyUsd: number | null | undefined): number | null {
  return resolveExitRequestSupplyNotionalUsd(circulatingSupplyUsd, REDEMPTION_MODELED_EXIT_SIZE_REQUEST);
}

export const REDEMPTION_ROUTE_FAMILY_LABELS: Record<RedemptionRouteFamily, string> = {
  "stablecoin-redeem": "Stablecoin redeem",
  "basket-redeem": "Basket redeem",
  "collateral-redeem": "Collateral redeem",
  "psm-swap": "PSM / swap floor",
  "queue-redeem": "Queue redeem",
  "offchain-issuer": "Offchain issuer",
};

export const REDEMPTION_ACCESS_LABELS: Record<RedemptionAccessModel, string> = {
  "permissionless-onchain": "Permissionless onchain",
  "whitelisted-onchain": "Whitelisted onchain",
  "issuer-api": "Issuer / institutional",
  manual: "Manual / discretionary",
};

/**
 * Authored-short projection of the access labels, for the fixed-width slots
 * that cannot take the full string: the hero passport strip's one-line budget
 * and the redemption route rail's ACCESS node. Prose surfaces keep the full
 * `REDEMPTION_ACCESS_LABELS` vocabulary.
 */
export const REDEMPTION_ACCESS_PASSPORT_LABELS: Record<RedemptionAccessModel, string> = {
  "permissionless-onchain": "Permissionless",
  "whitelisted-onchain": "Whitelisted",
  "issuer-api": "Institutional",
  manual: "Manual",
};

export const REDEMPTION_SETTLEMENT_LABELS: Record<RedemptionSettlementModel, string> = {
  atomic: "Atomic",
  immediate: "Immediate",
  "same-day": "Same day",
  days: "1-7 days",
  queued: "Queued",
};

export const REDEMPTION_OUTPUT_ASSET_LABELS: Record<RedemptionOutputAssetType, string> = {
  "stable-single": "Stable output",
  "stable-basket": "Stable basket",
  "bluechip-collateral": "Blue-chip collateral",
  "mixed-collateral": "Mixed collateral",
  nav: "NAV / non-cash",
};
