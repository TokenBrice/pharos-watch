import type {
  YieldDeploymentPlace,
  YieldSourceRisk,
  YieldVenueRiskTier,
} from "@shared/types/yield";
import { computePysRewardShare } from "@shared/lib/yield-scoring";
import type { EvaluatedYieldSource } from "./evaluation-types";

export const YIELD_RISK_CONFIG_REVIEW_CADENCE = "monthly-yield-coverage-audit";

export const YIELD_RISK_CONFIG_PROTOCOLS = [
  "aave-v3",
  "compound-v3",
  "sparklend",
  "spark-savings",
  "maple",
  "yearn",
  "yearn-finance",
  "morpho",
  "morpho-v1",
  "morpho-blue",
  "pendle",
  "beefy",
] as const;

export type YieldRiskConfigProtocol = (typeof YIELD_RISK_CONFIG_PROTOCOLS)[number];

export interface YieldRiskConfigEntry {
  venueRiskTier: YieldVenueRiskTier;
  rationale: string;
  evidence: string[];
  reviewedAt: string;
  reviewCadence: typeof YIELD_RISK_CONFIG_REVIEW_CADENCE;
}

const NEUTRAL_PENDING_REVIEW_RATIONALE =
  "Tracked as a reviewed yield venue candidate, but no approved methodology evidence assigns a non-unknown tier yet; unknown remains neutral.";

function neutralPendingReviewConfig(): YieldRiskConfigEntry {
  return {
    venueRiskTier: "unknown",
    rationale: NEUTRAL_PENDING_REVIEW_RATIONALE,
    evidence: [],
    reviewedAt: "2026-05-13",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  };
}

export const YIELD_RISK_CONFIG = {
  "aave-v3": neutralPendingReviewConfig(),
  "compound-v3": neutralPendingReviewConfig(),
  sparklend: neutralPendingReviewConfig(),
  "spark-savings": neutralPendingReviewConfig(),
  maple: neutralPendingReviewConfig(),
  yearn: neutralPendingReviewConfig(),
  "yearn-finance": neutralPendingReviewConfig(),
  morpho: neutralPendingReviewConfig(),
  "morpho-v1": neutralPendingReviewConfig(),
  "morpho-blue": neutralPendingReviewConfig(),
  pendle: neutralPendingReviewConfig(),
  beefy: neutralPendingReviewConfig(),
} satisfies Record<YieldRiskConfigProtocol, YieldRiskConfigEntry>;

const YIELD_RISK_CONFIG_PROTOCOL_ALIASES: Record<string, YieldRiskConfigProtocol> = {
  aave: "aave-v3",
  compound: "compound-v3",
  spark: "sparklend",
  sparklend: "sparklend",
  "spark-lend": "sparklend",
  yearn: "yearn",
  "yearn-finance": "yearn-finance",
  morpho: "morpho",
  "morpho-blue": "morpho-blue",
  pendle: "pendle",
  beefy: "beefy",
};

function isYieldRiskConfigProtocol(value: string): value is YieldRiskConfigProtocol {
  return Object.prototype.hasOwnProperty.call(YIELD_RISK_CONFIG, value);
}

function normalizeYieldRiskConfigProtocol(
  venueProtocol: string | null | undefined,
): YieldRiskConfigProtocol | null {
  if (typeof venueProtocol !== "string") return null;
  const normalized = venueProtocol.trim().toLowerCase();
  if (!normalized) return null;
  if (isYieldRiskConfigProtocol(normalized)) return normalized;
  return YIELD_RISK_CONFIG_PROTOCOL_ALIASES[normalized] ?? null;
}

export function resolveReviewedYieldRiskConfig(
  venueProtocol: string | null | undefined,
): YieldRiskConfigEntry | null {
  const protocol = normalizeYieldRiskConfigProtocol(venueProtocol);
  return protocol == null ? null : YIELD_RISK_CONFIG[protocol];
}

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
  const venueProtocol =
    existing.venueProtocol ??
    params.source.venueProtocol ??
    inferVenueProtocol(params.source);
  const reviewedConfig = resolveReviewedYieldRiskConfig(venueProtocol);

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
    venueProtocol,
    venueChain: existing.venueChain ?? params.source.venueChain ?? inferVenueChain(params.source.sourceKey),
    venueRiskTier: existing.venueRiskTier ?? reviewedConfig?.venueRiskTier ?? "unknown",
    investabilityFlags: existing.investabilityFlags ?? [],
  };
}
