import type { YieldSourceRisk } from "@shared/types/yield";
import type { EvaluatedYieldSource } from "./evaluation-types";

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function computeRewardShare(source: EvaluatedYieldSource): number | null {
  if (
    source.apyReward == null ||
    !Number.isFinite(source.apyReward) ||
    source.apyReward < 0 ||
    !Number.isFinite(source.currentApy) ||
    source.currentApy <= 0 ||
    source.apyReward > source.currentApy
  ) {
    return null;
  }

  return source.apyReward / source.currentApy;
}

export function buildYieldSourceRisk(params: {
  source: EvaluatedYieldSource;
  provenance: Record<string, unknown> | null;
  isBest: boolean;
}): YieldSourceRisk {
  const existing = params.source.sourceRisk ?? {};
  const sourceAgeSeconds = finiteNumber(params.provenance?.sourceAgeSeconds);

  return {
    sourceRiskScore: existing.sourceRiskScore ?? null,
    sourceRiskPenalty: params.source.sourceRiskPenalty,
    sourceDepthRatio: params.source.sourceDepthRatio ?? existing.sourceDepthRatio ?? null,
    rewardShare: computeRewardShare(params.source) ?? existing.rewardShare ?? null,
    sourceAgeSeconds:
      sourceAgeSeconds == null
        ? (existing.sourceAgeSeconds ?? null)
        : Math.trunc(sourceAgeSeconds),
    observationCount30d: params.source.observationCount30d ?? existing.observationCount30d ?? null,
    sourceSwitchCount30d: params.isBest ? params.source.sourceSwitchCount30d : null,
    deploymentPlace: existing.deploymentPlace ?? null,
    venueProtocol: existing.venueProtocol ?? null,
    venueChain: existing.venueChain ?? null,
    venueRiskTier: existing.venueRiskTier ?? "unknown",
    investabilityFlags: existing.investabilityFlags ?? [],
  };
}
