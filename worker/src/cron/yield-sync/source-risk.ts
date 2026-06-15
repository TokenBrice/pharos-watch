import type { YieldDeploymentPlace, YieldSourceRisk } from "@shared/types/yield";
import {
  computePysRewardShare,
  computeSourceRiskScoreFromPenalty,
  computeVenueRiskWeighted,
  deriveVenueRiskTier,
} from "@shared/lib/yield-scoring";
import {
  resolveReviewedYieldRiskConfig,
  venueRiskWeightedOf,
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
  VENUE_RISK_SCORE_MAX_AGE_DAYS,
} from "@shared/lib/yield-source-risk-registry";
import type { EvaluatedYieldSource } from "./evaluation-types";
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

export function inferVenueProtocol(source: {
  sourceKey: string;
  yieldType?: EvaluatedYieldSource["yieldType"] | null;
  dataSource: EvaluatedYieldSource["dataSource"];
}): string | null {
  if (source.sourceKey.startsWith("protocol-api:morpho-vault:")) return "morpho-blue";
  if (source.sourceKey.startsWith("protocol-api:pendle:")) return "pendle";
  if (source.sourceKey.startsWith("protocol-api:yearn:")) return "yearn";
  if (source.sourceKey.startsWith("protocol-api:kong:")) return "kong";
  if (source.sourceKey.startsWith("protocol-api:k3:")) return "k3";
  if (source.sourceKey.startsWith("protocol-api:beefy:")) return "beefy";
  if (source.sourceKey.startsWith("protocol-api:compound-v3-supply:")) return "compound-v3";
  if (source.sourceKey.startsWith("aave-v3-onchain:")) return "aave-v3";
  if (source.sourceKey.startsWith("royco-dawn:")) return "royco-dawn";
  return source.dataSource === "rate-derived" || source.dataSource === "price-derived"
    ? source.dataSource
    : null;
}

function inferVenueChain(sourceKey: string): string | null {
  const parts = sourceKey.split(":");
  if (sourceKey.startsWith("protocol-api:morpho-vault:")) return parts[2] ?? null;
  if (sourceKey.startsWith("protocol-api:pendle:")) return parts[2] ?? null;
  if (
    sourceKey.startsWith("protocol-api:yearn:") ||
    sourceKey.startsWith("protocol-api:kong:") ||
    sourceKey.startsWith("protocol-api:k3:") ||
    sourceKey.startsWith("protocol-api:beefy:") ||
    sourceKey.startsWith("protocol-api:compound-v3-supply:")
  ) {
    return parts[2] ?? null;
  }
  if (sourceKey.startsWith("aave-v3-onchain:")) return parts[1] ?? null;
  if (sourceKey.startsWith("royco-dawn:")) return parts[1] ?? null;
  return null;
}

function optionalSourceRiskFields(existing: YieldSourceRisk): Partial<YieldSourceRisk> {
  return {
    ...(existing.trancheSide !== undefined ? { trancheSide: existing.trancheSide } : {}),
    ...(existing.trancheSafetyScore !== undefined ? { trancheSafetyScore: existing.trancheSafetyScore } : {}),
    ...(existing.trancheSafetyPenalty !== undefined ? { trancheSafetyPenalty: existing.trancheSafetyPenalty } : {}),
    ...(existing.underlyingSafetyScore !== undefined ? { underlyingSafetyScore: existing.underlyingSafetyScore } : {}),
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
  const venueProtocol =
    existing.venueProtocol ??
    params.source.venueProtocol ??
    inferVenueProtocol(params.source);
  const reviewedConfig = resolveReviewedYieldRiskConfig(venueProtocol);
  const reviewedWeighted = reviewedConfig ? computeVenueRiskWeighted(reviewedConfig.scores) : null;

  return {
    sourceRiskScore:
      existing.sourceRiskScore ?? computeSourceRiskScoreFromPenalty(params.source.sourceRiskPenalty),
    sourceRiskPenalty: params.source.sourceRiskPenalty,
    sourceDepthRatio: params.source.sourceDepthRatio ?? existing.sourceDepthRatio ?? null,
    rewardShare: computePysRewardShare(params.source.apyReward, params.source.currentApy) ?? existing.rewardShare ?? null,
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
