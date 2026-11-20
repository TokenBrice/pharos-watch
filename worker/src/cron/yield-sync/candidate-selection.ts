import type { YieldEvidenceClass } from "@shared/types/yield";
import { MORPHO_NET_YIELD_SOURCES } from "@shared/lib/yield-source-cadence";
import { isMorphoNetYieldSourceKey } from "@shared/lib/yield-source-history";
import {
  derivePysSourceRiskPenalty,
  PYS_MAX_SOURCE_RISK_PENALTY,
  type PysSourceRiskPenaltyInput,
} from "@shared/lib/yield-scoring";
import { EXPLICIT_YIELD_SOURCE_POOL_MAP } from "../../lib/yield-config/yield-config-explicit-pools";
import { isRealSourceSwitch } from "../../lib/yield-history-ownership-handoffs";
import { countSourceSwitchesWithTail } from "./history-evidence";
import { type YieldHistorySnapshotRow } from "./history-repository";
import type { ConfidenceTier, EvaluatedYieldSource } from "./evaluation";
import { resolvePenaltyOrderingFields, resolvePenaltyDerivedFields } from "./candidate-scoring";

export function getConfidencePriority(tier: ConfidenceTier): number {
  switch (tier) {
    case "deterministic":
      return 4;
    case "curated":
      return 3;
    case "discovered":
      return 2;
    case "fallback":
    default:
      return 1;
  }
}

function getEvidencePriority(evidenceClass: YieldEvidenceClass): number {
  switch (evidenceClass) {
    case "direct-first-party":
    case "direct-onchain":
      return 6;
    case "curated-observation":
      return 5;
    case "discovered-observation":
      return 4;
    case "modeled-proxy":
      return 2;
    case "fallback":
    default:
      return 1;
  }
}

function relativeDivergence(a: number, b: number): number {
  const maxValue = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / maxValue;
}

export function compareCandidates(a: EvaluatedYieldSource, b: EvaluatedYieldSource): number {
  if (a.rejected !== b.rejected) return a.rejected ? 1 : -1;

  const aHasPositiveApy = a.currentApy > 0;
  const bHasPositiveApy = b.currentApy > 0;
  if (aHasPositiveApy !== bHasPositiveApy) return aHasPositiveApy ? -1 : 1;

  const aFixedYield = a.yieldType === "fixed-yield";
  const bFixedYield = b.yieldType === "fixed-yield";
  if (aFixedYield !== bFixedYield) return aFixedYield ? 1 : -1;

  const evidenceDiff = getEvidencePriority(b.evidenceClass) - getEvidencePriority(a.evidenceClass);
  if (evidenceDiff !== 0) return evidenceDiff;

  const confidenceDiff = getConfidencePriority(b.confidenceTier) - getConfidencePriority(a.confidenceTier);
  if (confidenceDiff !== 0) return confidenceDiff;

  if (a.sourceRiskPenaltyProvided || b.sourceRiskPenaltyProvided) {
    const utilityDiff = b.sourceRiskAdjustedUtility - a.sourceRiskAdjustedUtility;
    if (utilityDiff !== 0) return utilityDiff;
  }

  if (a.currentApy !== b.currentApy) return b.currentApy - a.currentApy;

  const tvlDiff = (b.sourceTvlUsd ?? 0) - (a.sourceTvlUsd ?? 0);
  if (tvlDiff !== 0) return tvlDiff;

  // B30: fully-tied distinct candidates must not be decided by provider array
  // order; the source key is the last, stable discriminator (and never 0 for two
  // distinct keys, so the arbitration is antisymmetric).
  return a.sourceKey.localeCompare(b.sourceKey);
}

export function buildSelectionReason(source: EvaluatedYieldSource, rejectedPeers: number): string {
  if (source.rejected) {
    return "Selected as the least-bad remaining source after arbitration penalties";
  }
  if (source.yieldType === "lending-vault" && isMorphoNetYieldSourceKey(source.sourceKey)) {
    return "Selected Morpho's observed net vault APY";
  }

  const confidenceLabel =
    source.evidenceClass === "modeled-proxy"
      ? "modeled proxy"
      : source.confidenceTier === "deterministic"
      ? "deterministic"
      : source.confidenceTier === "curated"
        ? "curated canonical"
        : source.confidenceTier === "discovered"
          ? "discovered opportunity"
          : "fallback-derived";

  if (source.usedLegacyHistory) {
    return `${confidenceLabel} source selected by confidence-weighted arbitration using legacy history carry-forward`;
  }

  if (rejectedPeers > 0) {
    return `${confidenceLabel} source selected by confidence-weighted arbitration after rejecting ${rejectedPeers} conflicting candidate${rejectedPeers > 1 ? "s" : ""}`;
  }

  return `${confidenceLabel} source selected by confidence-weighted arbitration`;
}

const CROSS_SOURCE_DIVERGENCE_THRESHOLD = 0.35;

const PYS_SWITCH_ARBITRATION_MARGIN = 0.1;

export interface YieldSourceGroupSelectionResult {
  evaluatedSources: EvaluatedYieldSource[];
  bestSourceKey: string | null;
  rowsRejected: number;
  divergenceFlags: number;
  sourceSwitches: number;
}

export function selectYieldSourceGroup(params: {
  stablecoinId: string;
  provisional: EvaluatedYieldSource[];
  finalizedProjections: EvaluatedYieldSource[];
  previousBestSourceKey: string | null;
  priorSwitches30d: number;
  derivedPenaltyInputByKey: Map<string, PysSourceRiskPenaltyInput>;
  bestRowsByCoin?: Map<string, YieldHistorySnapshotRow[]>;
  safetySnapshotUnavailable: boolean;
  usdBenchmarkRate: number | null;
}): YieldSourceGroupSelectionResult {
  const morphoSource = Object.values(MORPHO_NET_YIELD_SOURCES).find((source) => source.stablecoinId === params.stablecoinId);
  let canonicalReference: EvaluatedYieldSource | undefined;
  for (const candidate of params.provisional) {
    if (candidate.rejected || candidate.confidenceTier === "discovered" || candidate.sourceKey === morphoSource?.corroboratingPoolId) continue;
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
      canonicalReference.returnDenomination === candidate.returnDenomination &&
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
      canonicalReference.returnDenomination === candidate.returnDenomination &&
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

  // Projected quotes enter with their vault's final eligibility.
  candidates.push(...params.finalizedProjections);

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
            evidenceNullReason: candidate.pysNullReason,
          }),
        };
      });

  const sortedCandidates = [...arbitratedCandidates].sort(compareCandidates);
  // Curated venue ownership outranks discovery of the same instrument/type,
  // including an incumbent's switch margin. Keep discovered rows as alternatives.
  const explicitPools = EXPLICIT_YIELD_SOURCE_POOL_MAP[params.stablecoinId] ?? [];
  const curatedTypes = new Set(sortedCandidates
    .filter((candidate) => !candidate.rejected && explicitPools.some((config) =>
      config.poolId === candidate.sourceKey && config.yieldType === candidate.yieldType,
    ))
    .map((candidate) => candidate.yieldType));
  const preferred = morphoSource && sortedCandidates.find((candidate) =>
    !candidate.rejected && candidate.sourceKey === morphoSource.sourceKey,
  );
  const winner = preferred ?? sortedCandidates.find((candidate) =>
    !candidate.rejected
    && candidate.sourceKey !== morphoSource?.corroboratingPoolId
    && !(candidate.dataSource === "defillama-auto" && curatedTypes.has(candidate.yieldType)
      && !explicitPools.some((config) => config.poolId === candidate.sourceKey)),
  ) ?? (morphoSource ? undefined : sortedCandidates[0]);
  const bestSourceKey = winner?.sourceKey ?? null;

  const winnerWouldChangeSource = bestSourceKey != null && isRealSourceSwitch(params.previousBestSourceKey, bestSourceKey);
  const sourceSwitchCount30d = bestSourceKey != null && params.bestRowsByCoin != null
    ? countSourceSwitchesWithTail(params.bestRowsByCoin.get(params.stablecoinId) ?? [], bestSourceKey)
    : params.priorSwitches30d + (winnerWouldChangeSource && previousWinnerStillCandidate ? 1 : 0);
  const sourceSwitches = sourceSwitchCount30d > params.priorSwitches30d ? 1 : 0;

  const evaluatedSources = candidates.map((candidate) => {
    const isBest = candidate.sourceKey === bestSourceKey;
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
        evidenceNullReason: candidate.pysNullReason,
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
    bestSourceKey,
    rowsRejected: sortedCandidates.filter((candidate) => candidate.rejected).length,
    divergenceFlags,
    sourceSwitches,
  };
}
