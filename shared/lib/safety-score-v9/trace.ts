import type { V9Grade, V9QualityPillar, V9ReasonCode } from "../../types/safety-score-v9";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import type { V9ProductionScoreTrace } from "./score";

const V9_RESULT_DIGEST_DOMAIN = "safety-score-v9.result.v1";

export interface V9CompactScoreTrace {
  assetId: string;
  score: number | null;
  grade: V9Grade;
  pillars: Readonly<Record<V9QualityPillar, number | null>>;
  weakestPillar: { pillar: V9QualityPillar; score: number } | null;
  bindingCap: { kind: string; limit: number; source: string } | null;
  reasonCodes: readonly V9ReasonCode[];
  factSetDigest: string;
  policyId: string;
  policyDigest: string;
  evaluationBuildDigest: string;
  asOfSec: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function projectCompactV9ScoreTrace(trace: V9ProductionScoreTrace): V9CompactScoreTrace {
  const contributions = new Map(trace.pillarContributions.map((item) => [item.pillar, item.score]));
  return {
    assetId: trace.assetId,
    score: trace.finalScore,
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
  return sha256Hex(stableJsonStringifyV1({ domain: V9_RESULT_DIGEST_DOMAIN, results: compact }));
}
