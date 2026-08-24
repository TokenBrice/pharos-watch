import type { V9Grade, V9QualityPillar, V9ReasonCode } from "../../types/safety-score-v9";
import { sha256HexFromUtf8Chunks } from "../sha256";
import { stableJsonStringifyChunksV1 } from "../stable-json";
import type { V9ScoreAdjustmentTrace } from "./formula";
import type { V9ProductionScoreTrace } from "./score";
import { compareText } from "./primitives";

const V9_RESULT_DIGEST_DOMAIN = "safety-score-v9.result.v2";

export interface V9CompactScoreTrace {
  assetId: string;
  score: number | null;
  inheritableScore: number | null;
  grade: V9Grade;
  pillars: Readonly<Record<V9QualityPillar, number | null>>;
  weakestPillar: { pillar: V9QualityPillar; score: number } | null;
  bindingCap: { kind: string; limit: number; source: string } | null;
  scoreAdjustments: readonly V9ScoreAdjustmentTrace[];
  reasonCodes: readonly V9ReasonCode[];
  factSetDigest: string;
  policyId: string;
  policyDigest: string;
  evaluationBuildDigest: string;
  asOfSec: number;
}

export function projectCompactV9ScoreTrace(trace: V9ProductionScoreTrace): V9CompactScoreTrace {
  const contributions = new Map(trace.pillarContributions.map((item) => [item.pillar, item.score]));
  return {
    assetId: trace.assetId,
    score: trace.finalScore,
    inheritableScore: trace.inheritableScore,
    grade: trace.finalGrade,
    pillars: {
      backing: contributions.get("backing") ?? null,
      exit: contributions.get("exit") ?? null,
      control: contributions.get("control") ?? null,
    },
    weakestPillar: trace.weakestPillar,
    bindingCap: trace.bindingCap
      ? { kind: trace.bindingCap.kind, limit: trace.bindingCap.limit, source: trace.bindingCap.source }
      : null,
    scoreAdjustments: trace.scoreAdjustments.map((adjustment) => ({
      ...adjustment,
      capRelief: { ...adjustment.capRelief },
    })),
    reasonCodes: [...new Set(trace.nrReasons.map((reason) => reason.code))].sort(compareText),
    factSetDigest: trace.factSetDigest,
    policyId: trace.policyId,
    policyDigest: trace.policyDigest,
    evaluationBuildDigest: trace.evaluationBuildDigest,
    asOfSec: trace.asOfSec,
  };
}

export function computeV9ResultDigest(traces: readonly V9ProductionScoreTrace[]): string {
  const compact = [...traces]
    .sort((left, right) => compareText(left.assetId, right.assetId))
    .map(projectCompactV9ScoreTrace);
  return sha256HexFromUtf8Chunks(
    stableJsonStringifyChunksV1({ domain: V9_RESULT_DIGEST_DOMAIN, results: compact }),
  );
}
