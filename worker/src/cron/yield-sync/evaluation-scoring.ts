import {
  computePYSFromComponents,
  computePysComponents,
} from "@shared/lib/yield-scoring";
import type { YieldPysNullReason } from "@shared/types/yield";
import { PYS_SCALING_FACTOR } from "../../lib/constants";
import { derivePysNullReasonFromComponents, type YieldSourceFreshness } from "../../lib/yield-ranking-helpers";
import type { YieldBenchmarkFreshness } from "./benchmarks";
import type { EvaluatedYieldSource } from "./evaluation-types";

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

export function resolveEvidenceNullReason(params: {
  sourceFreshness: YieldSourceFreshness;
  benchmarkFreshness: YieldBenchmarkFreshness;
  referenceBenchmarkFreshness: YieldBenchmarkFreshness;
  opportunityEvidenceComplete?: boolean;
}): YieldPysNullReason | null {
  if (params.sourceFreshness === "stale") return "source-stale";
  if (params.sourceFreshness === "unknown") return "source-freshness-unknown";
  if (params.benchmarkFreshness === "stale") return "benchmark-stale";
  if (params.referenceBenchmarkFreshness === "stale") return "benchmark-stale";
  if (params.opportunityEvidenceComplete === false) return "opportunity-evidence-missing";
  return null;
}

function computePenaltyComponents(params: PenaltyFieldsInput) {
  return computePysComponents({
    apy30d: params.apy30d,
    safetyScore: params.safetyScore,
    apyVarianceScore: params.apyVarianceScore,
    benchmarkRate: params.benchmarkRate,
    benchmarkCurrency: params.benchmarkCurrency,
    usdBenchmarkRate: params.usdBenchmarkRate,
    sourceRiskPenalty: params.sourceRiskPenalty,
  });
}

/** Ordering needs utility and penalty provenance, but not a PYS value. */
export function resolvePenaltyOrderingFields(params: PenaltyFieldsInput): PenaltyDerivedFields {
  const components = computePenaltyComponents(params);
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
  const components = computePenaltyComponents(params);
  const computedPharosYieldScore = computePYSFromComponents(params.apy30d, PYS_SCALING_FACTOR, components);
  // One ladder decides both fields: a published reason always means no score,
  // while a legitimately rounded-zero score keeps a null reason.
  const pysNullReason = params.safetySnapshotUnavailable
    ? "safety-unrated"
    : params.evidenceNullReason
      ?? derivePysNullReasonFromComponents(params.apy30d, PYS_SCALING_FACTOR, components);
  return {
    sourceRiskPenalty: components.sourceRiskPenalty,
    sourceRiskPenaltyReason: components.sourceRiskPenaltyReason,
    sourceRiskPenaltyProvided: components.sourceRiskPenaltyProvided,
    sourceRiskAdjustedUtility: components.rowUtility,
    hurdleRebase: components.hurdleRebase,
    pharosYieldScore: pysNullReason == null && Number.isFinite(computedPharosYieldScore)
      ? computedPharosYieldScore
      : null,
    pysNullReason,
  };
}
