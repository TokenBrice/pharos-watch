import type {
  GovernanceQuality,
  GovernanceType,
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
 * Safety Score v8 (pending activation): weight of the Mint Authority Score in
 * the penalty-only decentralization blend. The blend runs only when a caller
 * passes `options.mintAuthorityScore`; no caller does until the v8.0
 * methodology activation wires the worker snapshot builder
 * (see agents/mint-authority-score-in-safety-score.md).
 */
export const MAS_BLEND_WEIGHT = 0.35;

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

export interface ScoreDecentralizationOptions {
  wrappedAssetDecentralizationScore?: number | null;
  wrappedAssetId?: string | null;
  variantKind?: VariantKind | null;
  /**
   * Mint Authority Score (0-100) for the penalty-only blend: a weak privileged
   * mint path can drag the dimension down but never lift it. `null`/absent
   * (review missing or unresolved) leaves the dimension unchanged.
   */
  mintAuthorityScore?: number | null;
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

  // Penalty-only Mint Authority blend (inert until a caller passes the score):
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
