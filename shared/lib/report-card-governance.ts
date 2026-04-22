import type {
  GovernanceQuality,
  GovernanceType,
  ReportCardDimension,
  StablecoinMeta,
} from "../types";
import { scoreToGrade } from "./report-card-core";
import { inferGovernanceQuality } from "./report-card-policy";
import { chainInfraLabel, chainInfraScore, resolveResilienceFactors } from "./report-card-resilience";

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

export function resolveGovernanceQuality(
  governance: GovernanceType,
  meta?: StablecoinMeta,
): GovernanceQuality {
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
): ReportCardDimension {
  const quality = resolveGovernanceQuality(governance, meta);
  let score = GOVERNANCE_QUALITY_SCORE[quality];

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

  const governanceScore = GOVERNANCE_QUALITY_SCORE[quality];
  const penaltyApplied =
    penalty < 0 &&
    quality !== "immutable-code" &&
    quality !== "single-entity" &&
    quality !== "regulated-entity" &&
    quality !== "wrapper";

  const detail = factors && penaltyApplied
    ? `Governance: ${GOVERNANCE_QUALITY_LABEL[quality]} (${governanceScore}). Chain: ${chainInfraLabel(factors.chainTier, factors.deploymentModel)} (${penalty})`
    : `Governance: ${GOVERNANCE_QUALITY_LABEL[quality]} (${governanceScore})`;

  return { grade: scoreToGrade(score), score, detail };
}
