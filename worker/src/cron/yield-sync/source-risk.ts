import type { YieldDeploymentPlace, YieldSourceRisk } from "@shared/types/yield";
import {
  computePysRewardShare,
  computeSourceRiskScoreFromPenalty,
  deriveVenueRiskTier,
} from "@shared/lib/yield-scoring";
import {
  resolveReviewedYieldRiskConfig,
  venueRiskWeightedOf,
  YIELD_VARIANT_CHILD_VENUE_PROTOCOLS,
} from "@shared/lib/yield-source-risk-registry";
export {
  findStaleVenueRiskScores,
  resolveDependencyConcentration,
  resolveReviewedYieldRiskConfig,
  venueRiskTierOf,
  venueRiskWeightedOf,
  YIELD_RISK_CONFIG,
  YIELD_RISK_CONFIG_PROTOCOLS,
  YIELD_RISK_CONFIG_REVIEW_CADENCE,
} from "@shared/lib/yield-source-risk-registry";
import { numberValue as finiteNumber } from "@shared/lib/type-guards";
import type { EvaluatedYieldSource } from "./evaluation-types";
import { resolveYieldSourceKeyRoute } from "./yield-source-key-routing";

/**
 * Derivation methods are a property of the row's calculation lane, not a venue.
 * A stored `sourceRisk.venueProtocol` from an earlier publication must not
 * re-enter the published payload as if it named an operator (A8).
 */
const DERIVATION_LANE_TOKENS: Readonly<Record<string, true>> = {
  "price-derived": true,
  "rate-derived": true,
};

/**
 * The single venue resolver (A8), used by both the scoring path
 * (`evaluation.ts`) and the publisher (`buildYieldSourceRisk`) so a row can no
 * longer be scored against one venue and labelled with another.
 *
 * Order: explicit `venueProtocol` → tracked variant child-id map → DeFiLlama
 * project slug → `sourceKey` route. Returns `null` when no venue is known —
 * never the row's derivation method.
 */
export function resolveYieldVenueProtocol(input: {
  venueProtocol?: string | null;
  sourceKey: string;
  project?: string | null;
  stablecoinId?: string | null;
}): string | null {
  const candidates = [
    input.venueProtocol,
    input.stablecoinId ? YIELD_VARIANT_CHILD_VENUE_PROTOCOLS[input.stablecoinId] : null,
    input.project,
    resolveYieldSourceKeyRoute(input.sourceKey)?.venueProtocol,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed && DERIVATION_LANE_TOKENS[trimmed] !== true) return trimmed;
  }
  return null;
}

/**
 * The one reward-share resolution (A9) shared by the penalty input and the
 * published field. `computePysRewardShare` returns `null` whenever the payload
 * omits `apyReward`, but a base-only payload — `apyBase` finite and already
 * equal to the current APY — proves the reward share is zero rather than
 * unknown. A value stored by an earlier publication is never reused, so the
 * published evidence always reproduces the penalty that was actually scored.
 */
export function resolveYieldRewardShare(params: {
  apyReward: number | null | undefined;
  apyBase: number | null | undefined;
  currentApy: number | null | undefined;
}): number | null {
  const derived = computePysRewardShare(params.apyReward, params.currentApy);
  if (derived != null) return derived;
  if (
    params.apyReward == null &&
    params.apyBase != null &&
    params.currentApy != null &&
    params.apyBase >= params.currentApy - 1e-9
  ) {
    return 0;
  }
  return null;
}

function inferDeploymentPlace(source: EvaluatedYieldSource): YieldDeploymentPlace | null {
  if (source.dataSource === "rate-derived") return "rate-derived";
  if (source.dataSource === "price-derived") return "price-derived";
  if (source.yieldType === "lp-receipt") return "lp-or-dex";
  if (source.yieldType === "structured-tranche") return "structured-tranche";
  if (source.yieldType === "fixed-yield") return "lending-market";
  if (source.yieldType === "lending-opportunity") return "lending-market";
  if (source.yieldType === "lending-vault") return "strategy-vault";
  if (source.yieldType === "nav-appreciation" || source.yieldType === "rebase") return "native-wrapper";
  if (source.yieldType === "governance-set" || source.yieldType === "fee-sharing") return "issuer-savings";
  return null;
}

function inferVenueChain(sourceKey: string): string | null {
  const route = resolveYieldSourceKeyRoute(sourceKey);
  if (!route || route.chainSegmentIndex == null) return null;
  return sourceKey.split(":")[route.chainSegmentIndex] ?? null;
}

function optionalSourceRiskFields(existing: YieldSourceRisk): Partial<YieldSourceRisk> {
  return {
    ...(existing.trancheSide !== undefined ? { trancheSide: existing.trancheSide } : {}),
    ...(existing.trancheSafetyScore !== undefined ? { trancheSafetyScore: existing.trancheSafetyScore } : {}),
    ...(existing.trancheSafetyPenalty !== undefined ? { trancheSafetyPenalty: existing.trancheSafetyPenalty } : {}),
    ...(existing.underlyingSafetyScore !== undefined ? { underlyingSafetyScore: existing.underlyingSafetyScore } : {}),
    ...(existing.opportunityRisk !== undefined ? { opportunityRisk: existing.opportunityRisk } : {}),
    ...(existing.marketCoverageRatio !== undefined ? { marketCoverageRatio: existing.marketCoverageRatio } : {}),
    ...(existing.marketMinCoverageRatio !== undefined ? { marketMinCoverageRatio: existing.marketMinCoverageRatio } : {}),
    ...(existing.marketUtilizationRatio !== undefined ? { marketUtilizationRatio: existing.marketUtilizationRatio } : {}),
    ...(existing.marketUtilizationLimitRatio !== undefined ? { marketUtilizationLimitRatio: existing.marketUtilizationLimitRatio } : {}),
    ...(existing.marketDrawdownRatio !== undefined ? { marketDrawdownRatio: existing.marketDrawdownRatio } : {}),
    ...(existing.marketTotalDrawdowns !== undefined ? { marketTotalDrawdowns: existing.marketTotalDrawdowns } : {}),
    ...(existing.marketStatus !== undefined ? { marketStatus: existing.marketStatus } : {}),
    ...(existing.marketTvlUsd !== undefined ? { marketTvlUsd: existing.marketTvlUsd } : {}),
    ...(existing.trancheTvlUsd !== undefined ? { trancheTvlUsd: existing.trancheTvlUsd } : {}),
    ...(existing.trancheShareTokenAddress !== undefined ? { trancheShareTokenAddress: existing.trancheShareTokenAddress } : {}),
    ...(existing.trancheDepositTokenAddress !== undefined ? { trancheDepositTokenAddress: existing.trancheDepositTokenAddress } : {}),
    ...(existing.withdrawalDelaySeconds !== undefined ? { withdrawalDelaySeconds: existing.withdrawalDelaySeconds } : {}),
    ...(existing.kycRequired !== undefined ? { kycRequired: existing.kycRequired } : {}),
    ...(existing.accessRestricted !== undefined ? { accessRestricted: existing.accessRestricted } : {}),
  };
}

export function buildYieldSourceRisk(params: {
  source: EvaluatedYieldSource;
  provenance: Record<string, unknown> | null;
  isBest: boolean;
}): YieldSourceRisk {
  const existing = params.source.sourceRisk ?? {};
  const sourceAgeSeconds = finiteNumber(params.provenance?.sourceAgeSeconds);
  // A8: the publisher resolves the venue through the same resolver the scoring
  // path uses, so the published label and the scored tier can no longer diverge.
  const venueProtocol = resolveYieldVenueProtocol({
    venueProtocol: existing.venueProtocol ?? params.source.venueProtocol,
    sourceKey: params.source.sourceKey,
    stablecoinId: params.source.id,
  });
  const reviewedConfig = resolveReviewedYieldRiskConfig(venueProtocol);
  const reviewedWeighted = reviewedConfig ? venueRiskWeightedOf(reviewedConfig) : null;

  return {
    sourceRiskScore:
      existing.sourceRiskScore ?? computeSourceRiskScoreFromPenalty(params.source.sourceRiskPenalty),
    sourceRiskPenalty: params.source.sourceRiskPenalty,
    sourceDepthRatio: params.source.sourceDepthRatio ?? existing.sourceDepthRatio ?? null,
    // A9: re-derived every publication. A base-only payload proves the reward
    // share is zero; an earlier publication's stored value is never reused.
    rewardShare: resolveYieldRewardShare(params.source),
    sourceAgeSeconds:
      sourceAgeSeconds == null
        ? (existing.sourceAgeSeconds ?? null)
        : Math.trunc(sourceAgeSeconds),
    observationCount30d: params.source.observationCount30d ?? existing.observationCount30d ?? null,
    sourceSwitchCount30d: params.isBest ? params.source.sourceSwitchCount30d : null,
    deploymentPlace: existing.deploymentPlace ?? inferDeploymentPlace(params.source),
    venueProtocol,
    venueChain: existing.venueChain ?? params.source.venueChain ?? inferVenueChain(params.source.sourceKey),
    venueRiskTier:
      existing.venueRiskTier ?? (reviewedConfig ? deriveVenueRiskTier(reviewedWeighted) : "unknown"),
    venueRiskScores: existing.venueRiskScores ?? reviewedConfig?.scores ?? null,
    venueRiskWeighted: existing.venueRiskWeighted ?? reviewedWeighted,
    venueRiskConfidence: existing.venueRiskConfidence ?? reviewedConfig?.confidence ?? null,
    ...(existing.dependencyConcentration
      ? { dependencyConcentration: existing.dependencyConcentration }
      : {}),
    ...optionalSourceRiskFields(existing),
    investabilityFlags: existing.investabilityFlags ?? [],
  };
}
