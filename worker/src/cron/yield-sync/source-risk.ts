import type { YieldDeploymentPlace, YieldSourceRisk } from "@shared/types/yield";
import { computePysRewardShare } from "@shared/lib/yield-scoring";
import type { EvaluatedYieldSource } from "./evaluation-types";

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function inferDeploymentPlace(source: EvaluatedYieldSource): YieldDeploymentPlace | null {
  if (source.dataSource === "rate-derived") return "rate-derived";
  if (source.dataSource === "price-derived") return "price-derived";
  if (source.yieldType === "lp-receipt") return "lp-or-dex";
  if (source.yieldType === "lending-opportunity") return "lending-market";
  if (source.yieldType === "lending-vault") return "strategy-vault";
  if (source.yieldType === "nav-appreciation" || source.yieldType === "rebase") return "native-wrapper";
  if (source.yieldType === "governance-set" || source.yieldType === "fee-sharing") return "issuer-savings";
  return null;
}

function inferVenueProtocol(source: EvaluatedYieldSource): string | null {
  if (source.sourceKey.startsWith("protocol-api:morpho-vault:")) return "morpho";
  if (source.sourceKey.startsWith("protocol-api:pendle:")) return "pendle";
  if (source.sourceKey.startsWith("protocol-api:yearn:")) return "yearn";
  if (source.sourceKey.startsWith("protocol-api:kong:")) return "kong";
  if (source.sourceKey.startsWith("protocol-api:k3:")) return "k3";
  if (source.sourceKey.startsWith("protocol-api:beefy:")) return "beefy";
  if (source.sourceKey.startsWith("protocol-api:compound-v3-supply:")) return "compound-v3";
  if (source.sourceKey.startsWith("aave-v3-onchain:")) return "aave-v3";
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
  return null;
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
    rewardShare: computePysRewardShare(params.source.apyReward, params.source.currentApy) ?? existing.rewardShare ?? null,
    sourceAgeSeconds:
      sourceAgeSeconds == null
        ? (existing.sourceAgeSeconds ?? null)
        : Math.trunc(sourceAgeSeconds),
    observationCount30d: params.source.observationCount30d ?? existing.observationCount30d ?? null,
    sourceSwitchCount30d: params.isBest ? params.source.sourceSwitchCount30d : null,
    deploymentPlace: existing.deploymentPlace ?? inferDeploymentPlace(params.source),
    venueProtocol: existing.venueProtocol ?? inferVenueProtocol(params.source),
    venueChain: existing.venueChain ?? inferVenueChain(params.source.sourceKey),
    venueRiskTier: existing.venueRiskTier ?? "unknown",
    investabilityFlags: existing.investabilityFlags ?? [],
  };
}
