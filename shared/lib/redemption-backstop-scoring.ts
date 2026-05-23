import type {
  RedemptionAccessModel,
  RedemptionCapacityConfidence,
  RedemptionExecutionModel,
  RedemptionHolderEligibility,
  RedemptionLiveCapacityKind,
  RedemptionModelConfidence,
  RedemptionOutputAssetType,
  RedemptionRouteExitCorrelation,
  RedemptionRouteFamily,
  RedemptionSettlementModel,
  RedemptionSourceMode,
} from "../types";

export const REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS = {
  access: 0.2,
  settlement: 0.15,
  executionCertainty: 0.15,
  capacity: 0.25,
  outputAssetQuality: 0.15,
  cost: 0.1,
} as const;

export const EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR = 0.1;

export const REDEMPTION_EFFECTIVE_EXIT_MODELED_EXIT_SIZE = {
  supplyRatio: 0.05,
  floorUsd: 100_000,
  capUsd: 25_000_000,
} as const;

export const REDEMPTION_EFFECTIVE_EXIT_CONFIDENCE_FACTORS = {
  high: 1,
  medium: 0.75,
  low: 0.35,
} as const satisfies Record<RedemptionModelConfidence, number>;

export const REDEMPTION_EFFECTIVE_EXIT_CAPACITY_FACTOR = {
  formula: "min(1, currentExecutableCapacityUsd / modeledExitSizeUsd)",
  missingCapacityBehavior: "unbounded",
} as const;

export const REDEMPTION_EFFECTIVE_EXIT_MODEL = {
  model: "best-path",
  diversificationFactor: EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR,
  modeledExitSize: REDEMPTION_EFFECTIVE_EXIT_MODELED_EXIT_SIZE,
  capacityFactor: REDEMPTION_EFFECTIVE_EXIT_CAPACITY_FACTOR,
  confidenceFactors: REDEMPTION_EFFECTIVE_EXIT_CONFIDENCE_FACTORS,
  diversificationPolicy:
    "Only independent issuer rails receive the secondary-path diversification bonus in v4 snapshots.",
} as const;

/**
 * Route-family score ceilings applied after the weighted component score.
 *
 * - `queueRedeem` (70): queued redemption inherently involves multi-hour or
 *   multi-day settlement friction plus FIFO processing. Even a perfect
 *   component mix stays below 70/100 so queued rails never match permissionless
 *   atomic rails in the effective-exit blend. See v3.7 methodology changelog.
 *
 * - `offchainIssuer` (65): offchain institutional redemption is gated by KYC,
 *   primary-market access, and banking-hour settlement. The 65 ceiling reflects
 *   the residual par-exit guarantee that CeFi-issued coins carry for retail
 *   holders even without a live instant buffer. See v3.7 methodology changelog.
 */
export const REDEMPTION_ROUTE_FAMILY_CAPS = {
  queueRedeem: 70,
  offchainIssuer: 65,
} as const;

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

export const REDEMPTION_ACCESS_SCORES: Record<RedemptionAccessModel, number> = {
  "permissionless-onchain": 100,
  "whitelisted-onchain": 75,
  "issuer-api": 40,
  manual: 20,
};

export const REDEMPTION_SETTLEMENT_SCORES: Record<RedemptionSettlementModel, number> = {
  atomic: 100,
  immediate: 90,
  "same-day": 65,
  days: 35,
  queued: 20,
};

export const REDEMPTION_EXECUTION_SCORES: Record<RedemptionExecutionModel, number> = {
  "deterministic-onchain": 100,
  "deterministic-basket": 80,
  "rules-based-nav": 60,
  opaque: 30,
};

export const REDEMPTION_OUTPUT_ASSET_SCORES: Record<RedemptionOutputAssetType, number> = {
  "stable-single": 100,
  "stable-basket": 80,
  "bluechip-collateral": 65,
  "mixed-collateral": 45,
  nav: 20,
};

const COVERAGE_RATIO_BREAKPOINTS = [
  { value: 0, score: 0 },
  { value: 0.01, score: 20 },
  { value: 0.05, score: 40 },
  { value: 0.1, score: 60 },
  { value: 0.25, score: 80 },
  { value: 0.5, score: 100 },
] as const;

const ABSOLUTE_CAPACITY_BREAKPOINTS = [
  { value: 0, score: 0 },
  { value: 100_000, score: 20 },
  { value: 1_000_000, score: 40 },
  { value: 10_000_000, score: 60 },
  { value: 50_000_000, score: 80 },
  { value: 250_000_000, score: 100 },
] as const;

function interpolateScore(
  value: number | null | undefined,
  breakpoints: readonly { value: number; score: number }[],
): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  if (value <= breakpoints[0].value) return breakpoints[0].score;

  for (let index = 1; index < breakpoints.length; index++) {
    const prev = breakpoints[index - 1];
    const next = breakpoints[index];
    if (value <= next.value) {
      const span = next.value - prev.value;
      if (span <= 0) return next.score;
      const progress = (value - prev.value) / span;
      return Math.round(prev.score + (next.score - prev.score) * progress);
    }
  }

  return breakpoints[breakpoints.length - 1].score;
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
    score: Math.round(coverage * 0.6 + absolute * 0.4),
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
    const delayMultiplier =
      args.settlementDelaySec <= 3_600
        ? 1
        : args.settlementDelaySec <= 86_400
          ? 0.9
          : args.settlementDelaySec <= 604_800
            ? 0.75
            : 0.6;
    if (delayMultiplier < 1) {
      score *= delayMultiplier;
      capsApplied.push("settlement-delay-penalty");
    }
  }

  if (args.queueDepthUsd != null && args.queueDepthUsd > 0 && args.scoringCapacityUsd != null && args.scoringCapacityUsd > 0) {
    const backlogRatio = args.queueDepthUsd / args.scoringCapacityUsd;
    const queueMultiplier = backlogRatio >= 1 ? 0.65 : backlogRatio >= 0.5 ? 0.8 : 0.9;
    score *= queueMultiplier;
    capsApplied.push("queue-depth-penalty");
  }

  if (args.minRedeemUsd != null) {
    const minRedeemMultiplier = args.minRedeemUsd > 1_000_000 ? 0.75 : args.minRedeemUsd > 10_000 ? 0.9 : 1;
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
    score: Math.round(Math.max(0, Math.min(100, score))),
    capsApplied,
  };
}

function resolveLiveHolderEligibilityMultiplier(holderEligibility: RedemptionHolderEligibility): number {
  switch (holderEligibility) {
    case "any-holder":
      return 1;
    case "verified-customer":
      return 0.9;
    case "whitelisted-primary":
    case "pre-incident-holder":
      return 0.85;
    case "issuer-discretionary":
      return 0.6;
    case "unknown":
      return 0.85;
  }
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
}): { score: number | null; capsApplied: string[] } {
  if (args.capacityScore == null) {
    return {
      score: null,
      capsApplied: [],
    };
  }

  let score =
    args.accessScore * REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.access +
    args.settlementScore * REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.settlement +
    args.executionCertaintyScore * REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.executionCertainty +
    args.capacityScore * REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.capacity +
    args.outputAssetQualityScore * REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.outputAssetQuality +
    args.costScore * REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.cost;

  const capsApplied: string[] = [];

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
    score: Math.round(Math.max(0, Math.min(100, score))),
    capsApplied,
  };
}

export function computeEffectiveExitScore(
  liquidityScore: number | null | undefined,
  redemptionBackstopScore: number | null | undefined,
  options?: {
    circulatingSupplyUsd?: number | null;
    modeledExitSizeUsd?: number | null;
    currentExecutableCapacityUsd?: number | null;
    routeExitCorrelation?: RedemptionRouteExitCorrelation;
    modelConfidence?: RedemptionModelConfidence;
  },
): number | null {
  const liquidity =
    liquidityScore != null && Number.isFinite(liquidityScore) ? Math.max(0, Math.min(100, liquidityScore)) : null;
  const rawRedemption =
    redemptionBackstopScore != null && Number.isFinite(redemptionBackstopScore)
      ? Math.max(0, Math.min(100, redemptionBackstopScore))
      : null;
  const redemption =
    rawRedemption != null && options
      ? rawRedemption * resolveEffectiveExitCapacityFactor(options) * resolveEffectiveExitConfidenceFactor(options.modelConfidence)
      : rawRedemption;
  const roundedRedemption = redemption != null ? Math.round(Math.max(0, Math.min(100, redemption))) : null;

  if (liquidity != null && roundedRedemption != null) {
    const bestPath = Math.max(liquidity, roundedRedemption);
    const bonus =
      options?.routeExitCorrelation === "independent-issuer-rail"
        ? Math.min(liquidity, roundedRedemption) * EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR
        : options
          ? 0
          : Math.min(liquidity, roundedRedemption) * EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR;
    return Math.round(Math.min(100, bestPath + bonus));
  }

  if (liquidity != null) return Math.round(liquidity);
  if (roundedRedemption != null) return roundedRedemption;
  return null;
}

export function computeModeledExitSizeUsd(circulatingSupplyUsd: number | null | undefined): number | null {
  if (circulatingSupplyUsd == null || !Number.isFinite(circulatingSupplyUsd) || circulatingSupplyUsd <= 0) {
    return null;
  }
  return Math.min(
    Math.max(
      circulatingSupplyUsd * REDEMPTION_EFFECTIVE_EXIT_MODELED_EXIT_SIZE.supplyRatio,
      REDEMPTION_EFFECTIVE_EXIT_MODELED_EXIT_SIZE.floorUsd,
    ),
    REDEMPTION_EFFECTIVE_EXIT_MODELED_EXIT_SIZE.capUsd,
  );
}

function resolveEffectiveExitCapacityFactor(options: {
  circulatingSupplyUsd?: number | null;
  modeledExitSizeUsd?: number | null;
  currentExecutableCapacityUsd?: number | null;
}): number {
  const modeledExitSizeUsd =
    options.modeledExitSizeUsd != null && Number.isFinite(options.modeledExitSizeUsd) && options.modeledExitSizeUsd > 0
      ? options.modeledExitSizeUsd
      : computeModeledExitSizeUsd(options.circulatingSupplyUsd);
  if (
    modeledExitSizeUsd == null ||
    options.currentExecutableCapacityUsd == null ||
    !Number.isFinite(options.currentExecutableCapacityUsd)
  ) {
    return 1;
  }
  return Math.max(0, Math.min(1, options.currentExecutableCapacityUsd / modeledExitSizeUsd));
}

function resolveEffectiveExitConfidenceFactor(modelConfidence: RedemptionModelConfidence | undefined): number {
  return modelConfidence ? REDEMPTION_EFFECTIVE_EXIT_CONFIDENCE_FACTORS[modelConfidence] : 1;
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

export const REDEMPTION_SETTLEMENT_LABELS: Record<RedemptionSettlementModel, string> = {
  atomic: "Atomic",
  immediate: "Immediate",
  "same-day": "Same day",
  days: "1-7 days",
  queued: "Queued",
};

export const REDEMPTION_EXECUTION_LABELS: Record<RedemptionExecutionModel, string> = {
  "deterministic-onchain": "Deterministic onchain",
  "deterministic-basket": "Deterministic basket",
  "rules-based-nav": "Rules-based NAV",
  opaque: "Opaque",
};

export const REDEMPTION_OUTPUT_ASSET_LABELS: Record<RedemptionOutputAssetType, string> = {
  "stable-single": "Stable output",
  "stable-basket": "Stable basket",
  "bluechip-collateral": "Blue-chip collateral",
  "mixed-collateral": "Mixed collateral",
  nav: "NAV / non-cash",
};
