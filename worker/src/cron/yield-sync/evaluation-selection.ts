import {
  derivePysSourceRiskPenalty,
  PYS_MAX_SOURCE_RISK_PENALTY,
} from "@shared/lib/yield-scoring";
import type { PysSourceRiskPenaltyInput } from "@shared/lib/yield-scoring";
import { isRealSourceSwitch } from "../../lib/yield-history-ownership-handoffs";
import { countSourceSwitchesWithTail } from "./coordinator-history";
import {
  compareCandidates,
  getConfidencePriority,
  relativeDivergence,
} from "./evaluation-arbitration";
import {
  resolveEvidenceNullReason,
  resolvePenaltyDerivedFields,
  resolvePenaltyOrderingFields,
} from "./evaluation-scoring";
import type { EvaluatedYieldSource } from "./evaluation-types";
import type { YieldHistorySnapshotRow } from "./history";
import type { YieldBenchmarkFreshness } from "./benchmarks";

const CROSS_SOURCE_DIVERGENCE_THRESHOLD = 0.35;
const PYS_SWITCH_ARBITRATION_MARGIN = 0.1;

export interface YieldSourceGroupSelectionResult {
  evaluatedSources: EvaluatedYieldSource[];
  bestSourceKey: string;
  rowsRejected: number;
  divergenceFlags: number;
  sourceSwitches: number;
}

export function selectYieldSourceGroup(params: {
  stablecoinId: string;
  provisional: EvaluatedYieldSource[];
  previousBestSourceKey: string | null;
  priorSwitches30d: number;
  derivedPenaltyInputByKey: Map<string, PysSourceRiskPenaltyInput>;
  bestRowsByCoin?: Map<string, YieldHistorySnapshotRow[]>;
  safetySnapshotUnavailable: boolean;
  referenceBenchmarkFreshness: YieldBenchmarkFreshness;
  usdBenchmarkRate: number | null;
}): YieldSourceGroupSelectionResult | null {
  let canonicalReference: EvaluatedYieldSource | undefined;
  for (const candidate of params.provisional) {
    if (candidate.confidenceTier === "discovered") continue;
    if (!canonicalReference || compareCandidates(candidate, canonicalReference) < 0) {
      canonicalReference = candidate;
    }
  }

  let divergenceFlags = 0;
  const candidates = params.provisional.map((candidate) => {
    const anomalies = [...candidate.anomalies];
    let rejected = candidate.rejected;

    if (
      canonicalReference &&
      canonicalReference.sourceKey !== candidate.sourceKey &&
      getConfidencePriority(candidate.confidenceTier) < getConfidencePriority(canonicalReference.confidenceTier)
    ) {
      const divergence = relativeDivergence(candidate.currentApy, canonicalReference.currentApy);
      if (
        canonicalReference.currentApy > 0 &&
        candidate.currentApy > 0 &&
        divergence > CROSS_SOURCE_DIVERGENCE_THRESHOLD
      ) {
        anomalies.push("diverges-from-canonical");
        divergenceFlags++;
        if (candidate.dataSource === "defillama-auto" || candidate.dataSource === "price-derived") {
          rejected = true;
        }
      }
    }

    if (
      canonicalReference &&
      canonicalReference.currentApy === 0 &&
      candidate.currentApy > 1 &&
      canonicalReference.sourceKey !== candidate.sourceKey &&
      getConfidencePriority(canonicalReference.confidenceTier) > getConfidencePriority(candidate.confidenceTier)
    ) {
      anomalies.push("canonical-zero-vs-positive");
    }
    if (anomalies.includes("source-zero-vs-history")) rejected = true;
    return { ...candidate, anomalies, rejected };
  });

  const previousWinnerStillCandidate =
    params.previousBestSourceKey != null &&
    candidates.some(
      (candidate) => candidate.sourceKey === params.previousBestSourceKey && !candidate.rejected,
    );
  const arbitratedCandidates = !previousWinnerStillCandidate
    ? candidates
    : candidates.map((candidate) => {
        const derivedPenaltyInput = params.derivedPenaltyInputByKey.get(candidate.sourceKey);
        if (
          derivedPenaltyInput == null ||
          !isRealSourceSwitch(params.previousBestSourceKey, candidate.sourceKey)
        ) {
          return candidate;
        }
        return {
          ...candidate,
          ...resolvePenaltyOrderingFields({
            apy30d: candidate.apy30d,
            safetyScore: candidate.safetyScore,
            apyVarianceScore: candidate.apyVarianceScore,
            benchmarkRate: candidate.benchmarkRate,
            benchmarkCurrency: candidate.benchmarkCurrency,
            usdBenchmarkRate: params.usdBenchmarkRate,
            sourceRiskPenalty: Math.min(
              PYS_MAX_SOURCE_RISK_PENALTY,
              candidate.sourceRiskPenalty + PYS_SWITCH_ARBITRATION_MARGIN,
            ),
            safetySnapshotUnavailable: params.safetySnapshotUnavailable,
            evidenceNullReason: resolveEvidenceNullReason({
              sourceFreshness: candidate.sourceFreshness,
              benchmarkFreshness: candidate.benchmarkFreshness,
              referenceBenchmarkFreshness:
                candidate.benchmarkCurrency === "USD" ? "healthy" : params.referenceBenchmarkFreshness,
            }),
          }),
        };
      });

  const sortedCandidates = [...arbitratedCandidates].sort(compareCandidates);
  const winner = sortedCandidates.find((candidate) => !candidate.rejected) ?? sortedCandidates[0];
  if (!winner) return null;

  const winnerWouldChangeSource = isRealSourceSwitch(params.previousBestSourceKey, winner.sourceKey);
  const sourceSwitchCount30d = params.bestRowsByCoin != null
    ? countSourceSwitchesWithTail(params.bestRowsByCoin.get(params.stablecoinId) ?? [], winner.sourceKey)
    : winnerWouldChangeSource && previousWinnerStillCandidate
      ? params.priorSwitches30d + 1
      : params.priorSwitches30d;
  const sourceSwitches = sourceSwitchCount30d > params.priorSwitches30d ? 1 : 0;

  const evaluatedSources = candidates.map((candidate) => {
    const isBest = candidate.sourceKey === winner.sourceKey;
    const publishedSwitchCount = isBest ? sourceSwitchCount30d : null;
    const derivedPenaltyInput = params.derivedPenaltyInputByKey.get(candidate.sourceKey);
    return {
      ...candidate,
      ...resolvePenaltyDerivedFields({
        apy30d: candidate.apy30d,
        safetyScore: candidate.safetyScore,
        apyVarianceScore: candidate.apyVarianceScore,
        benchmarkRate: candidate.benchmarkRate,
        benchmarkCurrency: candidate.benchmarkCurrency,
        usdBenchmarkRate: params.usdBenchmarkRate,
        sourceRiskPenalty: derivedPenaltyInput
          ? derivePysSourceRiskPenalty({
              ...derivedPenaltyInput,
              sourceSwitchCount30d: publishedSwitchCount,
            })
          : candidate.sourceRiskPenalty,
        safetySnapshotUnavailable: params.safetySnapshotUnavailable,
        evidenceNullReason: resolveEvidenceNullReason({
          sourceFreshness: candidate.sourceFreshness,
          benchmarkFreshness: candidate.benchmarkFreshness,
          referenceBenchmarkFreshness:
            candidate.benchmarkCurrency === "USD" ? "healthy" : params.referenceBenchmarkFreshness,
        }),
      }),
      sourceSwitchCount30d: publishedSwitchCount,
      anomalies:
        isBest && winnerWouldChangeSource && !previousWinnerStillCandidate
          ? [...candidate.anomalies, "previous-source-transiently-missing"]
          : candidate.anomalies,
    };
  });

  return {
    evaluatedSources,
    bestSourceKey: winner.sourceKey,
    rowsRejected: sortedCandidates.filter((candidate) => candidate.rejected).length,
    divergenceFlags,
    sourceSwitches,
  };
}
