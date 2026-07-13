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
import type { ExitRouteObservation, ExitRouteOutput } from "../types/market";
import { roundScore } from "./math";
import { validateExitRouteCapacityCurve } from "./p4-exit-route-capacity";

export const REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS = {
  access: 0.2,
  settlement: 0.15,
  executionCertainty: 0.15,
  capacity: 0.25,
  outputAssetQuality: 0.15,
  cost: 0.1,
} as const;

const EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR = 0.1;

const REDEMPTION_EFFECTIVE_EXIT_MODELED_EXIT_SIZE = {
  supplyRatio: 0.05,
  floorUsd: 100_000,
  capUsd: 25_000_000,
} as const;

const REDEMPTION_EFFECTIVE_EXIT_CONFIDENCE_FACTORS = {
  high: 1,
  medium: 0.75,
  low: 0.35,
} as const satisfies Record<RedemptionModelConfidence, number>;

const EXIT_ROUTE_OBSERVATION_CONFIDENCE_FACTORS = {
  high: 1,
  medium: 0.85,
  low: 0.6,
  unknown: 0.35,
} as const satisfies Record<ExitRouteObservation["confidence"], number>;

const DEX_SCOREABLE_EXIT_EVIDENCE = new Set<ExitRouteObservation["evidenceKind"]>([
  "measured-executable-depth",
  "reserve-based-amm-simulation",
  "direct-orderbook-depth",
]);

const REDEMPTION_SCOREABLE_EXIT_EVIDENCE = new Set<ExitRouteObservation["evidenceKind"]>([
  "documented-terms",
  "live-reserve-state",
  "onchain-contract-state",
]);

/**
 * Shadow P4 common-request policy. Both producers must encode this requested
 * bound and horizon; actual route fees/delays belong in route evidence and do
 * not redefine the comparison request.
 */
export const SAME_NOTIONAL_EXIT_REQUEST_POLICY = {
  maxCostBps: 200,
  settlementHorizonSec: 300,
} as const;

export type SameNotionalExitScoringMode = "legacy" | "active";

export interface EffectiveExitScoreOptions {
  circulatingSupplyUsd?: number | null;
  modeledExitSizeUsd?: number | null;
  currentExecutableCapacityUsd?: number | null;
  routeExitCorrelation?: RedemptionRouteExitCorrelation;
  modelConfidence?: RedemptionModelConfidence;
  dexExitRouteObservations?: readonly ExitRouteObservation[] | null;
  redemptionExitRouteObservations?: readonly ExitRouteObservation[] | null;
  sameNotionalScoringMode?: SameNotionalExitScoringMode;
  /** Fixed scoring clock. Required before route observations can be consumed. */
  exitObservationAsOfSec?: number | null;
  maxExitObservationAgeSec?: number | null;
  impairedOutputAssetIds?: readonly string[];
}

export interface EffectiveExitScoreDiagnostics {
  score: number | null;
  scoringMode: SameNotionalExitScoringMode;
  modeledExitSizeUsd: number | null;
  dexRouteScore: number | null;
  redemptionRouteScore: number | null;
  comparedRouteIds: { dex: string; redemption: string } | null;
  diversificationBonusApplied: boolean;
  correlationReason: string | null;
}

interface EvaluatedExitRoute {
  observation: ExitRouteObservation;
  score: number;
}

/**
 * `missingCapacityBehavior: "unbounded"` is intentional and load-bearing:
 * eventual-only routes (null scoring capacity) rely on it for the DEX-gated
 * documented offchain-issuer primary-market bonus, and bounded
 * (`immediate-bounded`) worker rows can never reach the blend with a non-null
 * redemption score and unknown capacity because every capacity resolver either
 * sets `scoringCapacityUsd` or fails the row to `missing-capacity` /
 * `missing-cache` before scoring. Do not gate unknown capacity here without
 * threading `capacitySemantics` through both blend callers.
 */
const REDEMPTION_EFFECTIVE_EXIT_CAPACITY_FACTOR = {
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

const SETTLEMENT_DELAY_PENALTY_TIERS = [
  { maxSec: 3_600, multiplier: 1 },
  { maxSec: 86_400, multiplier: 0.9 },
  { maxSec: 604_800, multiplier: 0.75 },
  { maxSec: Number.POSITIVE_INFINITY, multiplier: 0.6 },
] as const;

const QUEUE_BACKLOG_PENALTY_TIERS = [
  { minRatio: 1, multiplier: 0.65 },
  { minRatio: 0.5, multiplier: 0.8 },
  { minRatio: 0, multiplier: 0.9 },
] as const;

const MIN_REDEEM_PENALTY_TIERS = [
  { minUsd: 1_000_000, multiplier: 0.75 },
  { minUsd: 10_000, multiplier: 0.9 },
] as const;

const LIVE_HOLDER_ELIGIBILITY_MULTIPLIERS: Record<RedemptionHolderEligibility, number> = {
  "any-holder": 1,
  "verified-customer": 0.9,
  "whitelisted-primary": 0.85,
  "pre-incident-holder": 0.85,
  "issuer-discretionary": 0.6,
  // Unknown live holder eligibility stays only mildly capacity-penalized here;
  // model-confidence cohort breadth separately treats unknown as weak evidence.
  unknown: 0.85,
};

function interpolateScore(
  value: number | null | undefined,
  breakpoints: readonly { value: number; score: number }[],
): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  if (breakpoints.length === 0) return null;
  if (value <= breakpoints[0].value) return breakpoints[0].score;
  const top = breakpoints[breakpoints.length - 1];
  if (value >= top.value) return top.score;

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

  return breakpoints[breakpoints.length - 1].score; // unreachable: loop always returns once value < top.value
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
  for (const tier of SETTLEMENT_DELAY_PENALTY_TIERS) {
    if (settlementDelaySec <= tier.maxSec) return tier.multiplier;
  }
  return 1; // NaN-input fall-through: no penalty
}

function resolveQueueBacklogMultiplier(backlogRatio: number): number {
  for (const tier of QUEUE_BACKLOG_PENALTY_TIERS) {
    if (backlogRatio >= tier.minRatio) return tier.multiplier;
  }
  return 1; // NaN-input fall-through: no penalty
}

function resolveMinRedeemMultiplier(minRedeemUsd: number): number {
  for (const tier of MIN_REDEEM_PENALTY_TIERS) {
    if (minRedeemUsd > tier.minUsd) return tier.multiplier;
  }
  return 1;
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
    score: roundScore(score),
    capsApplied,
  };
}

export function computeEffectiveExitScore(
  liquidityScore: number | null | undefined,
  redemptionBackstopScore: number | null | undefined,
  options?: EffectiveExitScoreOptions,
): number | null {
  return computeEffectiveExitScoreDiagnostics(liquidityScore, redemptionBackstopScore, options).score;
}

export function computeEffectiveExitScoreDiagnostics(
  liquidityScore: number | null | undefined,
  redemptionBackstopScore: number | null | undefined,
  options?: EffectiveExitScoreOptions,
): EffectiveExitScoreDiagnostics {
  const liquidity =
    liquidityScore != null && Number.isFinite(liquidityScore) ? Math.max(0, Math.min(100, liquidityScore)) : null;
  const rawRedemption =
    redemptionBackstopScore != null && Number.isFinite(redemptionBackstopScore)
      ? Math.max(0, Math.min(100, redemptionBackstopScore))
      : null;

  const modeledExitSizeUsd = resolveModeledExitSizeUsd(options);
  const hasRouteObservations =
    (options?.dexExitRouteObservations?.length ?? 0) > 0 || (options?.redemptionExitRouteObservations?.length ?? 0) > 0;
  if (options?.sameNotionalScoringMode === "active" && modeledExitSizeUsd != null && hasRouteObservations) {
    return computeSameNotionalEffectiveExitScore({
      liquidity,
      rawRedemption,
      modeledExitSizeUsd,
      options,
    });
  }

  const redemption =
    rawRedemption != null && options
      ? rawRedemption *
        resolveEffectiveExitCapacityFactor(options) *
        resolveEffectiveExitConfidenceFactor(options.modelConfidence)
      : rawRedemption;
  const roundedRedemption = redemption != null ? roundScore(redemption) : null;

  if (liquidity != null && roundedRedemption != null) {
    const bestPath = Math.max(liquidity, roundedRedemption);
    const applyDiversificationBonus = !options || options.routeExitCorrelation === "independent-issuer-rail";
    const bonus = applyDiversificationBonus
      ? Math.min(liquidity, roundedRedemption) * EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR
      : 0;
    return {
      score: Math.round(Math.min(100, bestPath + bonus)),
      scoringMode: "legacy",
      modeledExitSizeUsd,
      dexRouteScore: Math.round(liquidity),
      redemptionRouteScore: roundedRedemption,
      comparedRouteIds: null,
      diversificationBonusApplied: bonus > 0,
      correlationReason: bonus > 0 ? "legacy-independent-issuer-rail" : "legacy-correlation-not-independent",
    };
  }

  const score = liquidity != null ? Math.round(liquidity) : roundedRedemption;
  return {
    score,
    scoringMode: "legacy",
    modeledExitSizeUsd,
    dexRouteScore: liquidity != null ? Math.round(liquidity) : null,
    redemptionRouteScore: roundedRedemption,
    comparedRouteIds: null,
    diversificationBonusApplied: false,
    correlationReason: null,
  };
}

function computeSameNotionalEffectiveExitScore(args: {
  liquidity: number | null;
  rawRedemption: number | null;
  modeledExitSizeUsd: number;
  options: EffectiveExitScoreOptions;
}): EffectiveExitScoreDiagnostics {
  const dexRoutes = evaluateExitRoutes(
    args.options.dexExitRouteObservations,
    args.modeledExitSizeUsd,
    args.liquidity,
    undefined,
    "dex",
    args.options,
  );
  const redemptionRoutes = evaluateExitRoutes(
    args.options.redemptionExitRouteObservations,
    args.modeledExitSizeUsd,
    args.rawRedemption,
    args.options.modelConfidence,
    "redemption",
    args.options,
  );

  // Old redemption rows remain usable during rollout, but they cannot earn a
  // same-notional diversification bonus because their cost/horizon identity is
  // absent. Capacity is still normalized against the exact modeled request.
  const legacyRedemptionScore =
    redemptionRoutes.length === 0 && args.rawRedemption != null
      ? roundScore(
          args.rawRedemption *
            resolveEffectiveExitCapacityFactor({
              modeledExitSizeUsd: args.modeledExitSizeUsd,
              currentExecutableCapacityUsd: args.options.currentExecutableCapacityUsd,
            }) *
            resolveEffectiveExitConfidenceFactor(args.options.modelConfidence),
        )
      : null;
  const legacyDexScore = dexRoutes.length === 0 ? args.liquidity : null;

  const bestDexRoute = maxRouteByScore(dexRoutes);
  const bestRedemptionRoute = maxRouteByScore(redemptionRoutes);
  let bestScore = Math.max(
    bestDexRoute?.score ?? Number.NEGATIVE_INFINITY,
    bestRedemptionRoute?.score ?? Number.NEGATIVE_INFINITY,
    legacyDexScore ?? Number.NEGATIVE_INFINITY,
    legacyRedemptionScore ?? Number.NEGATIVE_INFINITY,
  );
  let comparedRouteIds: EffectiveExitScoreDiagnostics["comparedRouteIds"] = null;
  let diversificationBonusApplied = false;
  let correlationReason: string | null = null;

  for (const dexRoute of dexRoutes) {
    for (const redemptionRoute of redemptionRoutes) {
      if (!haveIdenticalExitRequest(dexRoute.observation, redemptionRoute.observation)) continue;
      const correlation = classifyExitRouteCorrelation(
        dexRoute.observation,
        redemptionRoute.observation,
        args.options.routeExitCorrelation,
        args.options.impairedOutputAssetIds,
      );
      const bestPath = Math.max(dexRoute.score, redemptionRoute.score);
      const bonus = correlation.independent
        ? Math.min(dexRoute.score, redemptionRoute.score) * EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR
        : 0;
      const combined = Math.min(100, bestPath + bonus);
      if (combined > bestScore || (combined === bestScore && comparedRouteIds == null && bestPath === bestScore)) {
        bestScore = combined;
        comparedRouteIds = {
          dex: dexRoute.observation.routeId,
          redemption: redemptionRoute.observation.routeId,
        };
        diversificationBonusApplied = bonus > 0;
        correlationReason = correlation.reason;
      }
    }
  }

  if (!Number.isFinite(bestScore)) {
    // Observation activation is additive for old payloads. If the only
    // observations are for a different retained notional, preserve the legacy
    // route until the common modeled point is published.
    const legacy = computeEffectiveExitScoreDiagnostics(args.liquidity, args.rawRedemption, {
      ...args.options,
      sameNotionalScoringMode: "legacy",
    });
    return legacy;
  }

  if (comparedRouteIds == null) {
    correlationReason =
      dexRoutes.length > 0 && redemptionRoutes.length > 0
        ? "no-identical-cost-and-horizon-observation"
        : "single-observed-route";
  }

  return {
    score: Math.round(bestScore),
    scoringMode: "active",
    modeledExitSizeUsd: args.modeledExitSizeUsd,
    dexRouteScore: bestDexRoute?.score ?? legacyDexScore,
    redemptionRouteScore: bestRedemptionRoute?.score ?? legacyRedemptionScore,
    comparedRouteIds,
    diversificationBonusApplied,
    correlationReason,
  };
}

function evaluateExitRoutes(
  observations: readonly ExitRouteObservation[] | null | undefined,
  modeledExitSizeUsd: number,
  baseScore: number | null,
  redemptionModelConfidence: RedemptionModelConfidence | undefined,
  lane: "dex" | "redemption",
  options: EffectiveExitScoreOptions,
): EvaluatedExitRoute[] {
  if (baseScore == null) return [];
  const evaluated: EvaluatedExitRoute[] = [];
  for (const observation of observations ?? []) {
    if (!isExitRouteObservationScoreEligible(observation, lane, options)) continue;
    const point = resolveObservationCapacityPoint(observation, modeledExitSizeUsd);
    if (!point) continue;
    const evidenceFactor = EXIT_ROUTE_OBSERVATION_CONFIDENCE_FACTORS[observation.confidence];
    const confidenceFactor = redemptionModelConfidence
      ? Math.min(evidenceFactor, resolveEffectiveExitConfidenceFactor(redemptionModelConfidence))
      : evidenceFactor;
    const executableRatio = Math.max(
      0,
      Math.min(1, point.completionRatio, point.executableUsd / point.requestedNotionalUsd),
    );
    evaluated.push({
      observation: {
        ...observation,
        requestedNotionalUsd: point.requestedNotionalUsd,
        maxCostBps: point.maxCostBps,
        executableUsd: point.executableUsd,
        completionRatio: point.completionRatio,
      },
      score: roundScore(baseScore * executableRatio * confidenceFactor),
    });
  }
  return evaluated;
}

function isExitRouteObservationScoreEligible(
  observation: ExitRouteObservation,
  lane: "dex" | "redemption",
  options: EffectiveExitScoreOptions,
): boolean {
  if (!observation.scoreEligible) return false;
  if (observation.settlementHorizonSec !== SAME_NOTIONAL_EXIT_REQUEST_POLICY.settlementHorizonSec) return false;
  if (!isCapacityPointConsistent(observation)) return false;
  if (
    observation.capacityCurve &&
    (validateExitRouteCapacityCurve(observation.capacityCurve).length > 0 ||
      observation.capacityCurve.some((point) => !isCapacityPointConsistent(point)))
  ) {
    return false;
  }
  const allowedEvidence = lane === "dex" ? DEX_SCOREABLE_EXIT_EVIDENCE : REDEMPTION_SCOREABLE_EXIT_EVIDENCE;
  if (!allowedEvidence.has(observation.evidenceKind)) return false;
  const asOfSec = options.exitObservationAsOfSec;
  const maxAgeSec = options.maxExitObservationAgeSec;
  if (
    asOfSec == null ||
    !Number.isFinite(asOfSec) ||
    maxAgeSec == null ||
    !Number.isFinite(maxAgeSec) ||
    maxAgeSec < 0
  ) {
    return false;
  }
  const ageSec = Math.max(0, asOfSec - observation.observedAt, observation.freshnessSeconds);
  return ageSec <= maxAgeSec;
}

function isCapacityPointConsistent(point: {
  requestedNotionalUsd: number;
  executableUsd: number;
  completionRatio: number;
}): boolean {
  if (point.executableUsd > point.requestedNotionalUsd + 0.01) return false;
  return Math.abs(point.completionRatio - point.executableUsd / point.requestedNotionalUsd) <= 0.00001;
}

function resolveObservationCapacityPoint(
  observation: ExitRouteObservation,
  modeledExitSizeUsd: number,
): {
  requestedNotionalUsd: number;
  maxCostBps: number;
  executableUsd: number;
  completionRatio: number;
} | null {
  const points = [observation, ...(observation.capacityCurve ?? [])].filter(
    (point) => Math.abs(point.maxCostBps - SAME_NOTIONAL_EXIT_REQUEST_POLICY.maxCostBps) <= 1e-9,
  );
  const byCost = new Map<number, typeof points>();
  for (const point of points) {
    byCost.set(point.maxCostBps, [...(byCost.get(point.maxCostBps) ?? []), point]);
  }

  const derived = [...byCost.entries()].flatMap(([maxCostBps, costPoints]) => {
    const sorted = [...costPoints].sort((left, right) => left.requestedNotionalUsd - right.requestedNotionalUsd);
    const exact = sorted.find((point) => approximatelyEqualNotional(point.requestedNotionalUsd, modeledExitSizeUsd));
    if (exact) return [exact];

    // A validated monotonic curve proves only a lower bound between retained
    // grid points. Reuse the executable amount from the greatest smaller
    // request; for a smaller-than-grid request, cap the first point's capacity
    // at the requested amount. This never invents capacity by interpolation.
    const lower = [...sorted].reverse().find((point) => point.requestedNotionalUsd < modeledExitSizeUsd);
    const capacityLowerBound = lower?.executableUsd ?? Math.min(modeledExitSizeUsd, sorted[0]?.executableUsd ?? 0);
    const executableUsd = Math.min(modeledExitSizeUsd, Math.max(0, capacityLowerBound));
    return [
      {
        requestedNotionalUsd: modeledExitSizeUsd,
        maxCostBps,
        executableUsd,
        completionRatio: executableUsd / modeledExitSizeUsd,
      },
    ];
  });
  if (derived.length === 0) return null;
  return derived.reduce((best, point) => {
    const bestExecutable = Math.min(best.completionRatio, best.executableUsd / best.requestedNotionalUsd);
    const pointExecutable = Math.min(point.completionRatio, point.executableUsd / point.requestedNotionalUsd);
    if (pointExecutable !== bestExecutable) return pointExecutable > bestExecutable ? point : best;
    return point.maxCostBps < best.maxCostBps ? point : best;
  });
}

function maxRouteByScore(routes: readonly EvaluatedExitRoute[]): EvaluatedExitRoute | null {
  return routes.reduce<EvaluatedExitRoute | null>((best, route) => {
    if (!best || route.score > best.score) return route;
    if (route.score < best.score) return best;
    return route.observation.routeId < best.observation.routeId ? route : best;
  }, null);
}

function approximatelyEqualNotional(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(0.01, Math.abs(right) * 1e-9);
}

function haveIdenticalExitRequest(left: ExitRouteObservation, right: ExitRouteObservation): boolean {
  return (
    approximatelyEqualNotional(left.requestedNotionalUsd, right.requestedNotionalUsd) &&
    left.settlementHorizonSec === right.settlementHorizonSec &&
    Math.abs(left.maxCostBps - right.maxCostBps) <= 1e-9
  );
}

export function classifyExitRouteCorrelation(
  dexRoute: ExitRouteObservation,
  redemptionRoute: ExitRouteObservation,
  _legacyCorrelation?: RedemptionRouteExitCorrelation,
  impairedOutputAssetIds: readonly string[] = [],
): { independent: boolean; reason: string } {
  const impairedOutputs = new Set(impairedOutputAssetIds.map(normalizeCorrelationKey));
  const routeOutputIds = [
    ...collectTrackedOutputIds(dexRoute.output),
    ...collectTrackedOutputIds(redemptionRoute.output),
  ].map(normalizeCorrelationKey);
  const impairedRouteOutputs = [...new Set(routeOutputIds.filter((id) => impairedOutputs.has(id)))].sort();
  if (impairedRouteOutputs.length > 0) {
    return { independent: false, reason: `impaired-output:${impairedRouteOutputs.join(",")}` };
  }
  const sharedCommonModeKeys = intersectNormalized(dexRoute.commonModeKeys, redemptionRoute.commonModeKeys);
  if (sharedCommonModeKeys.length > 0) {
    return { independent: false, reason: `shared-common-mode:${sharedCommonModeKeys.join(",")}` };
  }

  const sharedOutputIds = intersectNormalized(
    collectOutputIdentityKeys(dexRoute.output),
    collectOutputIdentityKeys(redemptionRoute.output),
  );
  if (sharedOutputIds.length > 0) {
    return { independent: false, reason: `shared-output:${sharedOutputIds.join(",")}` };
  }

  const hasReviewedRouteKeys =
    hasFailureDomainKey(dexRoute.commonModeKeys) && hasFailureDomainKey(redemptionRoute.commonModeKeys);
  const hasResolvedOutputs =
    hasResolvedOutputIdentity(dexRoute.output) && hasResolvedOutputIdentity(redemptionRoute.output);
  if (hasReviewedRouteKeys && hasResolvedOutputs) {
    return { independent: true, reason: "reviewed-disjoint-failure-domains" };
  }
  if (!hasResolvedOutputs) {
    return { independent: false, reason: "unresolved-output-correlation" };
  }
  return { independent: false, reason: "insufficient-correlation-evidence" };
}

function hasFailureDomainKey(keys: readonly string[]): boolean {
  return keys.some((key) => /^(issuer|parent|protocol|custodian|oracle|chain|bridge):/i.test(key.trim()));
}

function collectTrackedOutputIds(output: ExitRouteOutput): string[] {
  return [
    ...(output.trackedAssetIds ?? []),
    ...(output.basketWeights ?? []).flatMap((slice) => (slice.assetId ? [slice.assetId] : [])),
  ];
}

function collectOutputIdentityKeys(output: ExitRouteOutput): string[] {
  return [
    ...collectTrackedOutputIds(output).map((id) => `asset:${id}`),
    ...(output.currency?.trim() ? [`currency:${output.currency}`] : []),
  ];
}

function hasResolvedOutputIdentity(output: ExitRouteOutput): boolean {
  if (output.kind === "fiat") return !!output.currency?.trim();
  if (output.kind === "tracked-stablecoin") return collectTrackedOutputIds(output).length > 0;
  if (output.kind === "collateral") {
    return collectTrackedOutputIds(output).length > 0 || !!output.currency?.trim();
  }
  return false;
}

function intersectNormalized(left: readonly string[], right: readonly string[]): string[] {
  const rightKeys = new Set(right.map(normalizeCorrelationKey).filter(Boolean));
  return [...new Set(left.map(normalizeCorrelationKey).filter((key) => key && rightKeys.has(key)))].sort();
}

function normalizeCorrelationKey(value: string): string {
  return value.trim().toLowerCase();
}

function resolveModeledExitSizeUsd(options: EffectiveExitScoreOptions | undefined): number | null {
  if (
    options?.modeledExitSizeUsd != null &&
    Number.isFinite(options.modeledExitSizeUsd) &&
    options.modeledExitSizeUsd > 0
  ) {
    return options.modeledExitSizeUsd;
  }
  return computeModeledExitSizeUsd(options?.circulatingSupplyUsd);
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
  // Fail conservative: a v4 blend without model confidence gets the "low"
  // factor instead of full redemption weight. All current runtime callers pass
  // a derived rollup, so this only guards untyped or future call sites.
  return REDEMPTION_EFFECTIVE_EXIT_CONFIDENCE_FACTORS[modelConfidence ?? "low"];
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
 * Hero passport-strip projection of the access labels — authored-short for
 * the strip's one-line width budget. Every other surface (RedemptionBackstopCard
 * and friends) keeps the full `REDEMPTION_ACCESS_LABELS` vocabulary.
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
