import type {
  RedemptionAccessModel,
  RedemptionCapacityConfidence,
  RedemptionExecutionModel,
  RedemptionOutputAssetType,
  RedemptionRouteFamily,
  RedemptionSettlementModel,
  RedemptionSourceMode,
} from "../types";

export const REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS = {
  access: 0.20,
  settlement: 0.15,
  executionCertainty: 0.15,
  capacity: 0.25,
  outputAssetQuality: 0.15,
  cost: 0.10,
} as const;

export const EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR = 0.10;

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
 * evidence is fresh on-chain telemetry AND the route itself is permissionless +
 * atomic/immediate. Only these routes remain scoreable during a severe active
 * depeg because only they provide current direct exercisability evidence.
 * See redemption backstop methodology v3.8.
 */
export interface StrongLiveDirectRouteInput {
  capacityConfidence: RedemptionCapacityConfidence;
  sourceMode: RedemptionSourceMode;
  accessModel: RedemptionAccessModel;
  settlementModel: RedemptionSettlementModel;
}

export function isStrongLiveDirectRoute(input: StrongLiveDirectRouteInput): boolean {
  return (
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

export const REDEMPTION_SETTLEMENT_SCORES: Record<
  RedemptionSettlementModel,
  number
> = {
  atomic: 100,
  immediate: 90,
  "same-day": 65,
  days: 35,
  queued: 20,
};

export const REDEMPTION_EXECUTION_SCORES: Record<
  RedemptionExecutionModel,
  number
> = {
  "deterministic-onchain": 100,
  "deterministic-basket": 80,
  "rules-based-nav": 60,
  opaque: 30,
};

export const REDEMPTION_OUTPUT_ASSET_SCORES: Record<
  RedemptionOutputAssetType,
  number
> = {
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
  { value: 0.10, score: 60 },
  { value: 0.25, score: 80 },
  { value: 0.50, score: 100 },
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
      return Math.round(prev.score + ((next.score - prev.score) * progress));
    }
  }

  return breakpoints[breakpoints.length - 1].score;
}

export function computeCapacityScore(args: {
  immediateCapacityUsd: number | null;
  immediateCapacityRatio: number | null;
}): {
  score: number | null;
  coverageRatioScore: number | null;
  absoluteCapacityScore: number | null;
} {
  const coverageRatioScore = interpolateScore(
    args.immediateCapacityRatio,
    COVERAGE_RATIO_BREAKPOINTS,
  );
  const absoluteCapacityScore = interpolateScore(
    args.immediateCapacityUsd,
    ABSOLUTE_CAPACITY_BREAKPOINTS,
  );

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
    score: Math.round((coverage * 0.6) + (absolute * 0.4)),
    coverageRatioScore,
    absoluteCapacityScore,
  };
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
    (args.accessScore * REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.access) +
    (args.settlementScore *
      REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.settlement) +
    (args.executionCertaintyScore *
      REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.executionCertainty) +
    (args.capacityScore * REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.capacity) +
    (args.outputAssetQualityScore *
      REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.outputAssetQuality) +
    (args.costScore * REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.cost);

  const capsApplied: string[] = [];

  if (
    args.routeFamily === "queue-redeem" &&
    score > REDEMPTION_ROUTE_FAMILY_CAPS.queueRedeem
  ) {
    score = REDEMPTION_ROUTE_FAMILY_CAPS.queueRedeem;
    capsApplied.push("queue-route-cap");
  }

  if (
    args.routeFamily === "offchain-issuer" &&
    score > REDEMPTION_ROUTE_FAMILY_CAPS.offchainIssuer
  ) {
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
): number | null {
  const liquidity =
    liquidityScore != null && Number.isFinite(liquidityScore)
      ? Math.max(0, Math.min(100, liquidityScore))
      : null;
  const redemption =
    redemptionBackstopScore != null && Number.isFinite(redemptionBackstopScore)
      ? Math.max(0, Math.min(100, redemptionBackstopScore))
      : null;

  if (liquidity != null && redemption != null) {
    const bestPath = Math.max(liquidity, redemption);
    const bonus = Math.min(liquidity, redemption) * EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR;
    return Math.round(Math.min(100, bestPath + bonus));
  }

  if (liquidity != null) return Math.round(liquidity);
  if (redemption != null) return Math.round(redemption);
  return null;
}

export const REDEMPTION_ROUTE_FAMILY_LABELS: Record<
  RedemptionRouteFamily,
  string
> = {
  "stablecoin-redeem": "Stablecoin redeem",
  "basket-redeem": "Basket redeem",
  "collateral-redeem": "Collateral redeem",
  "psm-swap": "PSM / swap floor",
  "queue-redeem": "Queue redeem",
  "offchain-issuer": "Offchain issuer",
};

export const REDEMPTION_ACCESS_LABELS: Record<
  RedemptionAccessModel,
  string
> = {
  "permissionless-onchain": "Permissionless onchain",
  "whitelisted-onchain": "Whitelisted onchain",
  "issuer-api": "Issuer / institutional",
  manual: "Manual / discretionary",
};

export const REDEMPTION_SETTLEMENT_LABELS: Record<
  RedemptionSettlementModel,
  string
> = {
  atomic: "Atomic",
  immediate: "Immediate",
  "same-day": "Same day",
  days: "1-7 days",
  queued: "Queued",
};

export const REDEMPTION_EXECUTION_LABELS: Record<
  RedemptionExecutionModel,
  string
> = {
  "deterministic-onchain": "Deterministic onchain",
  "deterministic-basket": "Deterministic basket",
  "rules-based-nav": "Rules-based NAV",
  opaque: "Opaque",
};

export const REDEMPTION_OUTPUT_ASSET_LABELS: Record<
  RedemptionOutputAssetType,
  string
> = {
  "stable-single": "Stable output",
  "stable-basket": "Stable basket",
  "bluechip-collateral": "Blue-chip collateral",
  "mixed-collateral": "Mixed collateral",
  nav: "NAV / non-cash",
};
