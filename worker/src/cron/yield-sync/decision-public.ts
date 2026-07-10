// Public-safe decision ledger projection for /api/yield-rankings.
//
// Produces the bounded subset of yield_source_decisions evidence that is
// safe to surface on the public payload: a stable reason-code enum, the
// previous best source key, sourceSwitch boolean, rejectedCount, and up to
// 2 retained alternates (by absolute APY delta) carrying a coded rejection
// reason. Heuristics mirror the client-side σ3 ladder in
// src/lib/yield-source-explorer-model.ts (kept independent here so the
// wire format does not depend on frontend code).
import type {
  YieldDecisionReasonCode,
  YieldDecisionRejectionReasonCode,
  YieldPublicDecisionAlternative,
  YieldPublicDecisionLedger,
  YieldSourceRole,
} from "@shared/types/yield";
import { numberValue as finiteNumber } from "@shared/lib/type-guards";
import { getConfidencePriority } from "./evaluation-arbitration";
import type { EvaluatedYieldSource } from "./evaluation";

const MAX_PUBLIC_ALTERNATIVES = 2;
const THINNER_RATIO = 5;
const STALE_RATIO = 2;
const REWARDS_ONLY_SHARE = 0.5;
const SMALLER_TVL_RATIO = 5;

function isExternalOpportunitySource(source: EvaluatedYieldSource): boolean {
  return (
    source.yieldType === "lending-opportunity" ||
    source.yieldType === "fixed-yield" ||
    source.yieldType === "structured-tranche"
  );
}

function hasCanonicalDegradation(source: EvaluatedYieldSource): boolean {
  return (
    source.rejected ||
    source.anomalies.includes("source-zero-vs-history") ||
    source.anomalies.includes("canonical-zero-vs-positive") ||
    source.anomalies.includes("anchor-stale") ||
    source.warnings.includes("zero-yield") ||
    source.warnings.includes("data-stale")
  );
}

export function deriveYieldSourceRole(
  source: EvaluatedYieldSource,
  options: { isSelected: boolean },
): YieldSourceRole {
  if (source.sourceKey.startsWith("linked-variant:") && isExternalOpportunitySource(source)) {
    return "external-opportunity";
  }
  if (source.confidenceTier === "fallback" || source.dataSource === "price-derived") {
    return "fallback-proxy";
  }
  if (isExternalOpportunitySource(source)) {
    return "external-opportunity";
  }
  if (hasCanonicalDegradation(source)) {
    return "degraded-canonical";
  }
  if (!options.isSelected) {
    return "audit-alternate";
  }
  return "canonical-holder";
}

export function deriveRejectionReasonCode(
  selected: EvaluatedYieldSource,
  candidate: EvaluatedYieldSource,
): YieldDecisionRejectionReasonCode {
  const altDepth = finiteNumber(candidate.sourceDepthRatio);
  const selDepth = finiteNumber(selected.sourceDepthRatio);
  if (altDepth != null && selDepth != null && altDepth > 0 && selDepth >= altDepth * THINNER_RATIO) {
    return "thinner";
  }

  // sourceRisk.sourceAgeSeconds carries the canonical source-age value; the
  // client σ3 ladder uses it too. Fall back to no-stale-rejection if absent.
  const altAgeSeconds = finiteNumber(candidate.sourceRisk?.sourceAgeSeconds);
  const selAgeSeconds = finiteNumber(selected.sourceRisk?.sourceAgeSeconds);
  if (
    altAgeSeconds != null &&
    selAgeSeconds != null &&
    selAgeSeconds > 0 &&
    altAgeSeconds >= selAgeSeconds * STALE_RATIO
  ) {
    return "stale";
  }

  const candidateConfidence = getConfidencePriority(candidate.confidenceTier);
  const selectedConfidence = getConfidencePriority(selected.confidenceTier);
  if (candidateConfidence < selectedConfidence) {
    return "lower-confidence";
  }

  const candidateApy = finiteNumber(candidate.currentApy);
  const candidateReward = finiteNumber(candidate.apyReward);
  if (candidateApy != null && candidateApy > 0 && candidateReward != null) {
    const rewardShare = candidateReward / candidateApy;
    if (rewardShare > REWARDS_ONLY_SHARE) {
      return "rewards-only";
    }
  }

  const altTvl = finiteNumber(candidate.sourceTvlUsd);
  const selTvl = finiteNumber(selected.sourceTvlUsd);
  if (altTvl != null && selTvl != null && altTvl > 0 && selTvl >= altTvl * SMALLER_TVL_RATIO) {
    return "smaller";
  }

  return "unspecified";
}

function deriveSelectedReasonCode(params: {
  selected: EvaluatedYieldSource;
  candidates: EvaluatedYieldSource[];
  rejectedCount: number;
}): YieldDecisionReasonCode {
  const { selected, candidates, rejectedCount } = params;
  const competitors = candidates.filter((candidate) => candidate.sourceKey !== selected.sourceKey);
  if (competitors.length === 0) {
    return "no-alternatives";
  }

  if (selected.confidenceTier === "deterministic") {
    return "deterministic-preferred";
  }

  const hasDiscoveredAlternative = competitors.some(
    (candidate) => candidate.confidenceTier === "discovered",
  );
  if (selected.confidenceTier === "curated" && hasDiscoveredAlternative) {
    return "curated-over-discovered";
  }

  const selectedConfidence = getConfidencePriority(selected.confidenceTier);
  const hasLowerConfidenceAlternative = competitors.some(
    (candidate) => getConfidencePriority(candidate.confidenceTier) < selectedConfidence,
  );
  if (hasLowerConfidenceAlternative) {
    return "tier-preference";
  }

  if (rejectedCount > 0) {
    const hasTvlOnlyDistinction = competitors.some(
      (candidate) =>
        candidate.apy30d === selected.apy30d &&
        (candidate.sourceTvlUsd ?? 0) < (selected.sourceTvlUsd ?? 0),
    );
    if (hasTvlOnlyDistinction) return "tvl-floor";

    const hasFresherSelection = competitors.some((candidate) => {
      const selAge = finiteNumber(selected.sourceRisk?.sourceAgeSeconds);
      const altAge = finiteNumber(candidate.sourceRisk?.sourceAgeSeconds);
      return selAge != null && altAge != null && selAge < altAge;
    });
    if (hasFresherSelection) return "freshness-tiebreaker";
  }

  if (selected.confidenceTier === "fallback") {
    return "fallback";
  }

  return "best-by-confidence-and-apy";
}

export function buildPublicDecisionLedger(params: {
  selected: EvaluatedYieldSource;
  candidates: EvaluatedYieldSource[];
  rejectedCount: number;
  previousBestSourceKey: string | null;
  sourceSwitch: boolean;
  apy30dDeltaFromPrevious: number | null;
}): YieldPublicDecisionLedger {
  const competitors = params.candidates.filter(
    (candidate) => candidate.sourceKey !== params.selected.sourceKey,
  );
  const selectionRankBySourceKey = new Map<string, number>();
  params.candidates.forEach((candidate, index) => {
    if (!selectionRankBySourceKey.has(candidate.sourceKey)) {
      selectionRankBySourceKey.set(candidate.sourceKey, index + 1);
    }
  });
  const ranked = [...competitors].sort((a, b) => {
    const deltaA = Math.abs(a.apy30d - params.selected.apy30d);
    const deltaB = Math.abs(b.apy30d - params.selected.apy30d);
    return deltaB - deltaA;
  });
  const alternatives: YieldPublicDecisionAlternative[] = ranked
    .slice(0, MAX_PUBLIC_ALTERNATIVES)
    .map((candidate) => ({
      sourceKey: candidate.sourceKey,
      yieldSource: candidate.yieldSource,
      apy30dDelta: candidate.apy30d - params.selected.apy30d,
      rejectionReasonCode: deriveRejectionReasonCode(params.selected, candidate),
      confidenceTier: candidate.confidenceTier,
      sourceRole: deriveYieldSourceRole(candidate, { isSelected: false }),
      selectionRank: selectionRankBySourceKey.get(candidate.sourceKey),
    }));

  return {
    selectedReasonCode: deriveSelectedReasonCode({
      selected: params.selected,
      candidates: params.candidates,
      rejectedCount: params.rejectedCount,
    }),
    previousBestSourceKey: params.previousBestSourceKey,
    sourceSwitch: params.sourceSwitch,
    apy30dDeltaFromPrevious: params.apy30dDeltaFromPrevious,
    rejectedCount: params.rejectedCount,
    alternatives,
  };
}
