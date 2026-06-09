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
  "spark-savings": {
    venueRiskTier: "low",
    rationale:
      "Spark Savings wrappers route yield through the Sky/Spark savings stack rather than an external credit venue; the reviewed surface inherits Sky governance, issuer-level rate setting, and Spark operational controls.",
    evidence: [
      "Sky / Maker governance controls the savings-rate policy and Spark Savings wrapper parameters",
      "Spark Savings yield is issuer/governance-set rather than borrower-market or strategy-vault yield",
      "SparkLend and Sky integrations share the mature Spark/Maker operational stack",
    ],
    reviewedAt: "2026-06-09",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  maple: {
    venueRiskTier: "medium",
    rationale:
      "Maple is an institutional credit venue whose lender pools depend on delegate underwriting, borrower performance, and loan recovery mechanics; that credit-underwriting surface is materially broader than low-risk money-market venues.",
    evidence: [
      "Maple pools expose lenders to borrower and pool-delegate credit underwriting risk",
      "The protocol has a post-2022 recovery and redesign history after credit-market defaults",
      "Stablecoin yield can vary by pool mandate, borrower concentration, and withdrawal queue conditions",
    ],
    reviewedAt: "2026-06-09",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  yearn: {
    venueRiskTier: "low",
    rationale:
      "Yearn is a mature strategy-vault venue with long production history and repeated audits; vault strategy risk remains, but the reviewed stablecoin vault surface is operationally established.",
    evidence: [
      "Yearn vaults have operated across multiple market cycles since 2020",
      "Yearn strategy and vault code has repeated independent audit coverage",
      "Stablecoin vault yields are strategy-vault yields with visible vault-level accounting",
    ],
    reviewedAt: "2026-06-09",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "yearn-finance": {
    venueRiskTier: "low",
    rationale:
      "Yearn Finance maps to the same mature strategy-vault family as Yearn; stablecoin vault risk is reviewed as low after accounting for its production history, audit cadence, and vault-level accounting.",
    evidence: [
      "Yearn Finance is the DeFiLlama project slug for the Yearn vault family",
      "Yearn vaults have operated across multiple market cycles since 2020",
      "Stablecoin vault yields are strategy-vault yields with visible vault-level accounting",
    ],
    reviewedAt: "2026-06-09",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  morpho: {
    venueRiskTier: "medium",
    rationale:
      "Morpho sources are reviewed as medium to align with Morpho Blue where vault and market parameters shift risk to market creators and allocators despite the audited lending primitive.",
    evidence: [
      "Morpho Blue is the canonical reviewed medium-risk Morpho lending primitive",
      "Morpho vault and market exposure depends on market-creator parameters and allocator controls",
      "Immutable or semi-immutable market design can limit emergency remediation paths",
    ],
    reviewedAt: "2026-06-09",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "morpho-v1": {
    venueRiskTier: "medium",
    rationale:
      "Morpho v1 belongs to the reviewed Morpho lending venue family and inherits allocator, market-parameter, and integration risk that is broader than mature canonical money markets.",
    evidence: [
      "Morpho v1 and Morpho Blue share the same venue family for Pharos source-risk attribution",
      "Morpho exposure depends on market-level and allocator-level controls",
      "Morpho Blue is already reviewed as medium because the venue is younger than Aave/Compound and has limited remediation paths",
    ],
    reviewedAt: "2026-06-09",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
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
  pendle: {
    venueRiskTier: "low",
    rationale:
      "Pendle is a mature yield-tokenization venue with isolated markets and a long audit trail; reviewed stablecoin principal/yield markets are low venue risk when market and maturity data remain observable.",
    evidence: [
      "Pendle has operated yield-tokenization markets across multiple market cycles",
      "Pendle markets isolate principal/yield-token exposure by asset and maturity",
      "Pendle deployments have repeated independent audit coverage",
    ],
    reviewedAt: "2026-06-09",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  beefy: {
    venueRiskTier: "medium",
    rationale:
      "Beefy is a multi-chain strategy-vault aggregator; reviewed yield rows inherit additional strategy, chain, bridge, and integration risk beyond canonical lending venues.",
    evidence: [
      "Beefy vaults aggregate external strategies rather than originating a single canonical money market",
      "Multi-chain vault deployment increases bridge, chain, and integration exposure",
      "Strategy-specific vault accounting and harvest mechanics can vary materially by source",
    ],
    reviewedAt: "2026-06-09",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
} satisfies Record<YieldRiskConfigProtocol, YieldRiskConfigEntry>;

const YIELD_RISK_CONFIG_PROTOCOL_ALIASES: Record<string, YieldRiskConfigProtocol> = {
  aave: "aave-v3",
  compound: "compound-v3",
  spark: "sparklend",
  "spark-savings": "spark-savings",
  sparklend: "sparklend",
  "spark-lend": "sparklend",
  maple: "maple",
  yearn: "yearn",
  "yearn-finance": "yearn-finance",
  morpho: "morpho",
  "morpho-v1": "morpho-v1",
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
