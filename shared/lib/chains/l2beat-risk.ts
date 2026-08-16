import {
  L2BEAT_CHAIN_ALIASES,
  L2BEAT_CHAIN_RISK_FIELDS,
  L2BEAT_CHAIN_RISK_SNAPSHOT,
  type L2BeatChainRiskSnapshot,
  type L2BeatRiskField,
  type L2BeatRiskSentiment,
  type L2BeatRiskValue,
  type L2BeatStage,
} from "./l2beat-risk-snapshot";

export * from "./l2beat-risk-snapshot";

export const L2BEAT_STAGE_SCORES: Record<L2BeatStage, number> = {
  "Stage 2": 100,
  "Stage 1": 80,
  "Stage 0": 55,
  "Not applicable": 50,
  // L2BEAT can publish projects before a stage verdict has settled; keep this neutral.
  "Under review": 50,
};

export const L2BEAT_RISK_SENTIMENT_SCORES: Record<L2BeatRiskSentiment, number> = {
  good: 100,
  warning: 60,
  bad: 20,
  // Forward-compatible L2BEAT ingestion guard: provisional/unknown sentiments are neutral, not bad.
  UnderReview: 50,
  neutral: 50,
};

export const L2BEAT_STAGE_WEIGHT = 0.4;
export const L2BEAT_RISK_WEIGHT = 0.6;

export interface L2BeatChainEnvironmentAssessment {
  source: "l2beat";
  chainId: string;
  projectId: string;
  slug: string;
  name: string;
  stage: L2BeatStage;
  isUnderReview: boolean;
  stageScore: number;
  riskScore: number;
  score: number;
  risks: Record<L2BeatRiskField, L2BeatRiskValue>;
}

export function resolveL2BeatProjectId(chainId: string): keyof typeof L2BEAT_CHAIN_RISK_SNAPSHOT | null {
  if (chainId in L2BEAT_CHAIN_RISK_SNAPSHOT) {
    return chainId as keyof typeof L2BEAT_CHAIN_RISK_SNAPSHOT;
  }
  return (L2BEAT_CHAIN_ALIASES as Partial<Record<string, keyof typeof L2BEAT_CHAIN_RISK_SNAPSHOT>>)[chainId] ?? null;
}

function resolveL2BeatSnapshot(
  chainId: string,
): { projectId: keyof typeof L2BEAT_CHAIN_RISK_SNAPSHOT; snapshot: L2BeatChainRiskSnapshot } | null {
  const projectId = resolveL2BeatProjectId(chainId);
  if (!projectId) return null;
  return { projectId, snapshot: L2BEAT_CHAIN_RISK_SNAPSHOT[projectId] };
}

export function computeL2BeatRiskScore(snapshot: L2BeatChainRiskSnapshot): number {
  const total = L2BEAT_CHAIN_RISK_FIELDS.reduce((sum, field) => {
    return sum + L2BEAT_RISK_SENTIMENT_SCORES[snapshot.risks[field].sentiment];
  }, 0);
  return Math.round(total / L2BEAT_CHAIN_RISK_FIELDS.length);
}

export function computeL2BeatChainEnvironmentScore(snapshot: L2BeatChainRiskSnapshot): number {
  const stageScore = L2BEAT_STAGE_SCORES[snapshot.stage];
  const riskScore = computeL2BeatRiskScore(snapshot);
  return Math.round(stageScore * L2BEAT_STAGE_WEIGHT + riskScore * L2BEAT_RISK_WEIGHT);
}

export function getL2BeatChainEnvironmentAssessment(chainId: string): L2BeatChainEnvironmentAssessment | null {
  const resolved = resolveL2BeatSnapshot(chainId);
  if (!resolved) return null;

  const { projectId, snapshot } = resolved;
  const stageScore = L2BEAT_STAGE_SCORES[snapshot.stage];
  const riskScore = computeL2BeatRiskScore(snapshot);
  const score = computeL2BeatChainEnvironmentScore(snapshot);

  return {
    source: "l2beat",
    chainId,
    projectId,
    slug: snapshot.slug,
    name: snapshot.name,
    stage: snapshot.stage,
    isUnderReview: snapshot.isUnderReview,
    stageScore,
    riskScore,
    score,
    risks: snapshot.risks,
  };
}
