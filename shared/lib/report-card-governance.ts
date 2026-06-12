import type {
  GovernanceQuality,
  GovernanceType,
  OracleRiskTier,
  ReportCardDimension,
  ReportCardDetailItem,
  StablecoinMeta,
  VariantKind,
} from "../types";
import { scoreToGrade } from "./report-card-core";
import { joinReportCardDetail } from "./report-card-detail";
import { inferGovernanceQuality } from "./report-card-policy";
import { chainInfraLabel, chainInfraScore, resolveResilienceFactors } from "./report-card-resilience";
import { wrapperPenaltyForVariant } from "./report-card-wrapper-penalty";
import { MINT_AUTHORITY_SCORE_BANDS, resolveMintAuthorityScoreBand } from "./mint-authority-scoring";

/**
 * Safety Score v8: weight of the Mint Authority Score in the penalty-only
 * decentralization blend.
 */
const MAS_BLEND_WEIGHT = 0.35;
const ORACLE_RISK_BLEND_WEIGHT = 0.25;

export const GOVERNANCE_QUALITY_SCORE: Record<GovernanceQuality, number> = {
  "immutable-code": 100,
  "dao-governance": 85,
  multisig: 55,
  "regulated-entity": 40,
  "single-entity": 20,
  wrapper: 10,
};

const GOVERNANCE_QUALITY_LABEL: Record<GovernanceQuality, string> = {
  "immutable-code": "Immutable code (no governance)",
  "dao-governance": "DAO governance",
  multisig: "Multisig governance",
  "regulated-entity": "Regulated entity",
  "single-entity": "Single-entity governance",
  wrapper: "Wrapper (inherits upstream)",
};

const ORACLE_RISK_SCORE: Record<OracleRiskTier, number> = {
  "oracleless-or-internal": 100,
  "redundant-with-failover": 95,
  "medianized-with-delay": 85,
  "standard-external": 75,
  "single-source-or-laggy": 45,
  "opaque-or-unknown": 20,
};

const ORACLE_RISK_LABEL: Record<OracleRiskTier, string> = {
  "oracleless-or-internal": "No external liquidation oracle",
  "redundant-with-failover": "Redundant feeds with failover",
  "medianized-with-delay": "Medianized feeds with delay",
  "standard-external": "Standard external feeds",
  "single-source-or-laggy": "Single-source or laggy feeds",
  "opaque-or-unknown": "Opaque or unknown setup",
};

export interface ScoreDecentralizationOptions {
  /**
   * Parent's PRE-blend decentralization score. Wrapper inheritance works on
   * pre-blend values so each coin's mint-authority drag applies exactly once
   * (the wrapper's own MAS already folds the parent's mint risk).
   */
  wrappedAssetDecentralizationScore?: number | null;
  wrappedAssetId?: string | null;
  variantKind?: VariantKind | null;
  /**
   * Mint Authority Score (0-100) for the penalty-only blend: a weak privileged
   * mint path can drag the dimension down but never lift it. `null`/absent
   * (review missing or unresolved) leaves the dimension unchanged.
   */
  mintAuthorityScore?: number | null;
  /**
   * Parent's final (post-blend) decentralization score, used as a ceiling for
   * inherited wrappers so a wrapper with an unrated MAS can never out-score
   * its blended parent.
   */
  wrappedAssetBlendedDecentralizationScore?: number | null;
}

export interface ResolvedOracleRiskScore {
  tier: OracleRiskTier;
  score: number;
  label: string;
}

function isOracleRiskApplicable(meta: StablecoinMeta): boolean {
  return meta.flags.backing === "crypto-backed" && meta.mechanismArchetype === "cdp";
}

export function resolveOracleRiskScore(meta?: StablecoinMeta): ResolvedOracleRiskScore | null {
  if (!meta?.oracleRisk || !isOracleRiskApplicable(meta)) return null;
  const tier = meta.oracleRisk.tier;
  return {
    tier,
    score: ORACLE_RISK_SCORE[tier],
    label: ORACLE_RISK_LABEL[tier],
  };
}

export function resolveGovernanceQuality(governance: GovernanceType, meta?: StablecoinMeta): GovernanceQuality {
  if (meta?.governanceQuality) return meta.governanceQuality;
  const base = inferGovernanceQuality(governance);
  if (base === "single-entity" && meta) {
    const jurisdiction = meta.jurisdiction;
    const proofOfReserves = meta.proofOfReserves;
    if (jurisdiction?.regulator && jurisdiction?.license && proofOfReserves?.type === "independent-audit") {
      return "regulated-entity";
    }
  }
  return base;
}

export function scoreDecentralization(
  governance: GovernanceType,
  meta?: StablecoinMeta,
  options: ScoreDecentralizationOptions = {},
): ReportCardDimension {
  const quality = resolveGovernanceQuality(governance, meta);
  let score = GOVERNANCE_QUALITY_SCORE[quality];
  const inheritedWrapperScore =
    quality === "wrapper" && typeof options.wrappedAssetDecentralizationScore === "number"
      ? Math.max(
          0,
          Math.min(
            100,
            Math.round(options.wrappedAssetDecentralizationScore - wrapperPenaltyForVariant(options.variantKind)),
          ),
        )
      : null;
  if (inheritedWrapperScore != null) {
    score = inheritedWrapperScore;
  }

  const factors = meta ? resolveResilienceFactors(meta) : undefined;
  const infraScore = factors ? chainInfraScore(factors.chainTier, factors.deploymentModel) : 100;

  let penalty = 0;
  if (infraScore >= 80) penalty = 0;
  else if (infraScore >= 60) penalty = -10;
  else if (infraScore >= 40) penalty = -25;
  else if (infraScore >= 20) penalty = -40;
  else penalty = -60;

  if (
    quality !== "immutable-code" &&
    quality !== "single-entity" &&
    quality !== "regulated-entity" &&
    quality !== "wrapper" &&
    penalty < 0
  ) {
    score = Math.max(0, score + penalty);
  }

  // Penalty-only oracle-risk blend for crypto-backed CDPs:
  // liquidation and redemption logic depends on the price-feed setup, so weak
  // or opaque feeds can undercut decentralization, but robust feeds never lift it.
  const oracleRisk = meta ? resolveOracleRiskScore(meta) : null;
  let oracleRiskDrag = 0;
  if (oracleRisk != null) {
    const blended = Math.round(score * (1 - ORACLE_RISK_BLEND_WEIGHT) + oracleRisk.score * ORACLE_RISK_BLEND_WEIGHT);
    if (blended < score) {
      oracleRiskDrag = blended - score;
      score = blended;
    }
  }

  // Penalty-only Mint Authority blend:
  // privileged-mint risk can undermine a decentralization claim, never improve it.
  const mintAuthorityScore =
    typeof options.mintAuthorityScore === "number" && Number.isFinite(options.mintAuthorityScore)
      ? Math.max(0, Math.min(100, Math.round(options.mintAuthorityScore)))
      : null;
  let mintAuthorityDrag = 0;
  if (mintAuthorityScore != null) {
    const blended = Math.round(score * (1 - MAS_BLEND_WEIGHT) + mintAuthorityScore * MAS_BLEND_WEIGHT);
    if (blended < score) {
      mintAuthorityDrag = blended - score;
      score = blended;
    }
  }
  if (
    inheritedWrapperScore != null &&
    typeof options.wrappedAssetBlendedDecentralizationScore === "number" &&
    Number.isFinite(options.wrappedAssetBlendedDecentralizationScore)
  ) {
    score = Math.min(score, Math.max(0, Math.round(options.wrappedAssetBlendedDecentralizationScore)));
  }

  const governanceScore = inheritedWrapperScore ?? GOVERNANCE_QUALITY_SCORE[quality];
  const penaltyApplied =
    penalty < 0 &&
    quality !== "immutable-code" &&
    quality !== "single-entity" &&
    quality !== "regulated-entity" &&
    quality !== "wrapper";

  const detailItems: ReportCardDetailItem[] = [
    { label: "Governance", value: GOVERNANCE_QUALITY_LABEL[quality], detail: `${governanceScore}` },
  ];
  if (inheritedWrapperScore != null) {
    const wrapperPenalty = wrapperPenaltyForVariant(options.variantKind);
    detailItems.push({
      label: "Wrapped asset",
      value: options.wrappedAssetId ?? "Tracked parent",
      detail: `parent ${Math.round(options.wrappedAssetDecentralizationScore ?? 0)} - ${wrapperPenalty}`,
    });
  }
  if (factors && penaltyApplied) {
    detailItems.push({
      label: "Chain",
      value: chainInfraLabel(factors.chainTier, factors.deploymentModel),
      detail: `${penalty}`,
    });
  }
  if (oracleRisk != null) {
    detailItems.push({
      label: "Oracle setup",
      value: `${oracleRisk.label} (${oracleRisk.score}/100)`,
      detail: oracleRiskDrag < 0 ? `${oracleRiskDrag}` : `${oracleRisk.score}`,
    });
  }
  if (mintAuthorityDrag < 0 && mintAuthorityScore != null) {
    const band = resolveMintAuthorityScoreBand(mintAuthorityScore);
    detailItems.push({
      label: "Mint authority",
      value: `${mintAuthorityScore}/100${band ? ` (${MINT_AUTHORITY_SCORE_BANDS[band].label})` : ""}`,
      detail: `${mintAuthorityDrag}`,
    });
  }

  return { grade: scoreToGrade(score), score, detail: joinReportCardDetail(detailItems), detailItems };
}
