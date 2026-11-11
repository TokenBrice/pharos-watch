import type { YieldPysNullReason } from "@shared/types/yield";
import { computePysComponents } from "@shared/lib/yield-scoring";
import { scoreYieldPys } from "../../lib/yield/yield-ranking-helpers";
import { PYS_SCALING_FACTOR } from "../../lib/yield-config/policy";
import type { EvaluatedYieldSource } from "./evaluation";

interface PenaltyFieldsInput {
  apy30d: number;
  safetyScore: number;
  apyVarianceScore: number | null;
  benchmarkRate: number;
  benchmarkCurrency: string;
  usdBenchmarkRate: number | null;
  sourceRiskPenalty: number;
  safetySnapshotUnavailable: boolean;
  evidenceNullReason: YieldPysNullReason | null;
}

type PenaltyDerivedFields = Pick<
  EvaluatedYieldSource,
  | "sourceRiskPenalty"
  | "sourceRiskPenaltyReason"
  | "sourceRiskPenaltyProvided"
  | "sourceRiskAdjustedUtility"
  | "hurdleRebase"
  | "pharosYieldScore"
  | "pysNullReason"
>;

/** Ordering needs utility and penalty provenance, but not a PYS value. */
export function resolvePenaltyOrderingFields(params: PenaltyFieldsInput): PenaltyDerivedFields {
  const components = computePysComponents(params);
  return {
    sourceRiskPenalty: components.sourceRiskPenalty,
    sourceRiskPenaltyReason: components.sourceRiskPenaltyReason,
    sourceRiskPenaltyProvided: components.sourceRiskPenaltyProvided,
    sourceRiskAdjustedUtility: components.rowUtility,
    hurdleRebase: components.hurdleRebase,
    pharosYieldScore: null,
    pysNullReason: params.safetySnapshotUnavailable
      ? "safety-unrated"
      : params.evidenceNullReason,
  };
}

/** Full score computation is reserved for the final published candidate shape. */
export function resolvePenaltyDerivedFields(params: PenaltyFieldsInput): PenaltyDerivedFields {
  const { components, pharosYieldScore, pysNullReason } = scoreYieldPys({
    ...params,
    scalingFactor: PYS_SCALING_FACTOR,
    nullReason: params.safetySnapshotUnavailable ? "safety-unrated" : params.evidenceNullReason,
  });
  return {
    sourceRiskPenalty: components.sourceRiskPenalty,
    sourceRiskPenaltyReason: components.sourceRiskPenaltyReason,
    sourceRiskPenaltyProvided: components.sourceRiskPenaltyProvided,
    sourceRiskAdjustedUtility: components.rowUtility,
    hurdleRebase: components.hurdleRebase,
    pharosYieldScore,
    pysNullReason,
  };
}
