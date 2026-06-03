import type {
  YieldDeploymentPlace,
  YieldSourceRisk,
  YieldVenueRiskTier,
} from "@shared/types/yield";
import {
  computePysRewardShare,
  computeSourceRiskScoreFromPenalty,
} from "@shared/lib/yield-scoring";
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
  // Battle-tested money market since Aave V1 (2020) / V3 (2022); multi-billion-USD TVL
  // across 10+ chains; multiple independent audits and formal verification; mature
  // governance with safety-module stake. Low venue risk.
  "aave-v3": {
    venueRiskTier: "low",
    rationale:
      "Aave V3 is a mature, multi-billion-USD lending venue with repeated independent audits, formal verification, and an active governance + safety-module stake.",
    evidence: [
      "Trail of Bits audit (Aave V3, 2022)",
      "OpenZeppelin audit (Aave V3 core + periphery, 2022)",
      "Certora formal verification of core invariants",
      "Live since V1 in Jan 2020 and V3 since March 2022 across 10+ chains",
      "Multi-billion-USD TVL throughout 2024-2026",
    ],
    reviewedAt: "2026-05-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  // Established Compound product line; isolated-asset V3 design has matured since 2022
  // with multiple audits and active COMP governance. Low venue risk.
  "compound-v3": {
    venueRiskTier: "low",
    rationale:
      "Compound III (Comet) is an isolated-asset lending market with a multi-year audit history, billions in TVL, and active COMP governance; the Comet codebase narrowed the protocol surface area relative to V2.",
    evidence: [
      "OpenZeppelin audit (Compound III, 2022)",
      "ChainSecurity audit (Compound III, 2022)",
      "Compound V1 in production since 2018; V3 since August 2022",
      "Sustained multi-billion-USD TVL across deployments",
    ],
    reviewedAt: "2026-05-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  // SparkLend is an Aave V3 fork deployed by Sky / former MakerDAO; benefits from
  // upstream audit inheritance, has a billion-plus TVL, and is operated through Sky
  // governance. Low venue risk.
  sparklend: {
    venueRiskTier: "low",
    rationale:
      "SparkLend is an Aave V3 fork operated by the Sky (formerly MakerDAO) ecosystem; it inherits the upstream Aave V3 audit surface, runs significant TVL, and is governed through the Sky framework.",
    evidence: [
      "Aave V3 upstream audits (Trail of Bits, OpenZeppelin, Certora) cover the shared codebase",
      "ChainSecurity audit (SparkLend customizations, 2023)",
      "Live since May 2023 with multi-hundred-million-USD to billion-USD TVL",
      "Operated through Sky / MakerDAO governance and the SubDAO framework",
    ],
    reviewedAt: "2026-05-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "spark-savings": neutralPendingReviewConfig(),
  maple: neutralPendingReviewConfig(),
  yearn: neutralPendingReviewConfig(),
  "yearn-finance": neutralPendingReviewConfig(),
  morpho: neutralPendingReviewConfig(),
  "morpho-v1": neutralPendingReviewConfig(),
  // Morpho Blue is the modern immutable lending primitive (January 2024). Audited
  // family but younger TVL cohort vs Aave/Compound. Medium venue risk reflects the
  // shorter live track record and the immutable design limiting remediation paths.
  "morpho-blue": {
    venueRiskTier: "medium",
    rationale:
      "Morpho Blue is an immutable singleton lending primitive launched in January 2024 with multiple audits; design choices reduce ongoing governance surface but limit remediation, and the product is still in its younger TVL cohort versus Aave/Compound.",
    evidence: [
      "Spearbit / Cantina audit (Morpho Blue, late 2023)",
      "OpenZeppelin audit (Morpho Blue, late 2023)",
      "Runtime Verification formal review (Morpho Blue, 2024)",
      "Live since January 2024; growing TVL but younger than Aave/Compound cohort",
      "Immutable singleton; market-creator-permissioned vaults inherit issuer risk",
    ],
    reviewedAt: "2026-05-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
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
  if (source.yieldType === "structured-tranche") return "structured-tranche";
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
    venueRiskTier: existing.venueRiskTier ?? reviewedConfig?.venueRiskTier ?? "unknown",
    ...optionalSourceRiskFields(existing),
    investabilityFlags: existing.investabilityFlags ?? [],
  };
}
