import {
  EXTERNAL_OPPORTUNITY_YIELD_TYPES,
} from "@shared/lib/yield-opportunity-risk";
import {
  type YieldDecisionReasonCode,
  type YieldDecisionRejectionReasonCode,
  type YieldPublicDecisionAlternative,
  type YieldPublicDecisionLedger,
  type YieldSourceRole,
  type YieldSourceInputMeta,
} from "@shared/types/yield";
import {
  numberValue as finiteNumber,
} from "@shared/lib/type-guards";
import { getConfidencePriority, buildSelectionReason, compareCandidates } from "./candidate-selection";
import { type EvaluatedYieldSource } from "./evaluation";
import {
  getRankingStaleThresholdMs,
} from "../../lib/yield/yield-ranking-helpers";
import {
  isRealSourceSwitch,
  LEGACY_BEST_YIELD_SOURCE_KEY,
} from "../../lib/yield/yield-history-ownership-handoffs";
import {
  buildHistoryKey,
} from "./history-evidence";

const MAX_PUBLIC_ALTERNATIVES = 2;

const THINNER_RATIO = 5;

const STALE_RATIO = 2;

const REWARDS_ONLY_SHARE = 0.5;

const SMALLER_TVL_RATIO = 5;

function isExternalOpportunitySource(source: EvaluatedYieldSource): boolean {
  return EXTERNAL_OPPORTUNITY_YIELD_TYPES.has(source.yieldType);
}

function hasCanonicalDegradation(source: EvaluatedYieldSource): boolean {
  return (
    source.rejected ||
    source.anomalies.includes("source-zero-vs-history") ||
    source.anomalies.includes("canonical-zero-vs-positive") ||
    source.anomalies.includes("anchor-stale") ||
    source.warnings.includes("zero-yield") ||
    source.warnings.includes("data-stale") ||
    source.warnings.includes("benchmark-degraded") ||
    source.warnings.includes("benchmark-stale")
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
  if (
    candidate.rejected &&
    (candidate.anomalies.includes("source-stale") || candidate.anomalies.includes("benchmark-stale"))
  ) {
    return "stale";
  }
  const altDepth = finiteNumber(candidate.sourceDepthRatio);
  const selDepth = finiteNumber(selected.sourceDepthRatio);
  if (altDepth != null && selDepth != null && altDepth > 0 && selDepth >= altDepth * THINNER_RATIO) {
    return "thinner";
  }

  // Missing canonical source age cannot justify a stale rejection.
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
  const selectionRankBySourceKey = buildSelectionRankBySourceKey(params.candidates);
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
      calculationMode: candidate.calculationMode,
      evidenceClass: candidate.evidenceClass,
      evidenceCompleteness: candidate.evidenceCompleteness,
      scoreQualification: candidate.scoreQualification,
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

/**
 * First-occurrence selection rank (1-based) over a coin's ordered candidate
 * list. Shared by the public decision ledger and the ranking payload's
 * alt-source projections.
 */
export function buildSelectionRankBySourceKey(
  candidates: EvaluatedYieldSource[],
): Map<string, number> {
  const selectionRankBySourceKey = new Map<string, number>();
  candidates.forEach((candidate, index) => {
    if (!selectionRankBySourceKey.has(candidate.sourceKey)) {
      selectionRankBySourceKey.set(candidate.sourceKey, index + 1);
    }
  });
  return selectionRankBySourceKey;
}

export function buildYieldSourceProvenance(params: {
  source: EvaluatedYieldSource;
  isBest: boolean;
  evaluatedSources: EvaluatedYieldSource[];
  startSec: number;
  dlPoolsMeta: YieldSourceInputMeta;
}): Record<string, unknown> {
  const { source, isBest, evaluatedSources, startSec, dlPoolsMeta } = params;

  const sourceObservedAt =
    source.sourceObservedAt
    ?? (source.dataSource === "defillama" || source.dataSource === "defillama-auto"
      ? (dlPoolsMeta.updatedAt ?? (dlPoolsMeta.ageSeconds != null ? startSec - dlPoolsMeta.ageSeconds : null))
      : source.dataSource === "rate-derived"
        ? null
        : startSec);
  // A source-local market print is authoritative over a family fetch age.
  const sourceAgeSeconds = sourceObservedAt != null ? Math.max(0, startSec - sourceObservedAt) : null;
  const comparisonAnchorObservedAt = source.comparisonAnchorObservedAt ?? null;
  const comparisonAnchorAgeSeconds =
    comparisonAnchorObservedAt != null ? Math.max(0, startSec - comparisonAnchorObservedAt) : null;
  const rejectedPeers = evaluatedSources.filter((candidate) => candidate.id === source.id && candidate.rejected).length;

  return {
    sourceKey: source.sourceKey,
    sourceObservedAt,
    sourceAgeSeconds,
    sourceMaxAgeSeconds: getRankingStaleThresholdMs(source.dataSource, source.sourceKey) / 1000,
    comparisonAnchorObservedAt,
    comparisonAnchorAgeSeconds,
    confidenceTier: source.confidenceTier,
    calculationMode: source.calculationMode,
    evidenceClass: source.evidenceClass,
    evidenceCompleteness: source.evidenceCompleteness,
    scoreQualification: source.scoreQualification,
    selectionMethod: "confidence-weighted",
    selectionReason: isBest
      ? buildSelectionReason(source, rejectedPeers)
      : "Alternative source retained for comparison",
    sourceSwitch: isBest && isRealSourceSwitch(source.previousBestSourceKey, source.sourceKey),
    previousBestSourceKey:
      source.previousBestSourceKey != null &&
      source.previousBestSourceKey !== LEGACY_BEST_YIELD_SOURCE_KEY
        ? source.previousBestSourceKey
        : null,
    usedLegacyHistory: source.usedLegacyHistory,
    usedDefaultSafety: source.usedDefaultSafety,
    safetyReason: source.safetyReason,
    safetyScoreIdentity: source.safetyScoreIdentity ?? null,
    benchmarkKey: source.benchmarkKey,
    benchmarkLabel: source.benchmarkLabel,
    benchmarkCurrency: source.benchmarkCurrency,
    benchmarkRate: source.benchmarkRate,
    benchmarkRecordDate: source.benchmarkRecordDate,
    benchmarkIsFallback: source.benchmarkIsFallback,
    benchmarkFallbackMode: source.benchmarkFallbackMode,
    benchmarkSelectionMode: source.benchmarkSelectionMode,
    benchmarkIsProxy: source.benchmarkIsProxy,
    sourceFreshness: source.sourceFreshness,
    benchmarkFreshness: source.benchmarkFreshness,
    scoreQualified: source.scoreQualified,
    anomalies: source.anomalies,
  };
}

export interface YieldCoinPublicationView {
  selected: EvaluatedYieldSource;
  /** Coin candidates ordered by confidence-weighted arbitration. */
  candidates: EvaluatedYieldSource[];
  rejectedCount: number;
  selectedReason: string;
  previousBestSourceKey: string | null;
  sourceSwitch: boolean;
  apy30dDeltaFromPrevious: number | null;
  decisionLedger: YieldPublicDecisionLedger;
}

export interface YieldPublicationViews {
  /** Per-source provenance keyed by history key, for every evaluated source. */
  provenanceByKey: Map<string, Record<string, unknown>>;
  /** Per-coin decision evidence keyed by stablecoin id, for best sources. */
  viewsByCoinId: Map<string, YieldCoinPublicationView>;
}

function resolveApy30dDeltaFromPrevious(input: {
  selected: EvaluatedYieldSource;
  candidates: EvaluatedYieldSource[];
  previousBestSourceKey: string | null;
}): number | null {
  if (!isRealSourceSwitch(input.previousBestSourceKey, input.selected.sourceKey)) {
    return null;
  }

  const previous = input.candidates.find(
    (candidate) => candidate.sourceKey === input.previousBestSourceKey,
  );
  if (!previous || !Number.isFinite(previous.apy30d) || !Number.isFinite(input.selected.apy30d)) {
    return null;
  }
  return input.selected.apy30d - previous.apy30d;
}

export function buildYieldPublicationViews(input: {
  evaluatedSources: EvaluatedYieldSource[];
  bestSourceKeyByCoin: Map<string, string>;
  startSec: number;
  dlPoolsMeta: YieldSourceInputMeta;
}): YieldPublicationViews {
  const provenanceByKey = new Map<string, Record<string, unknown>>();
  for (const source of input.evaluatedSources) {
    provenanceByKey.set(
      buildHistoryKey(source.id, source.sourceKey),
      buildYieldSourceProvenance({
        source,
        isBest: input.bestSourceKeyByCoin.get(source.id) === source.sourceKey,
        evaluatedSources: input.evaluatedSources,
        startSec: input.startSec,
        dlPoolsMeta: input.dlPoolsMeta,
      }),
    );
  }

  const viewsByCoinId = new Map<string, YieldCoinPublicationView>();
  for (const source of input.evaluatedSources) {
    if (input.bestSourceKeyByCoin.get(source.id) !== source.sourceKey) {
      continue;
    }
    // B13: when every candidate was rejected the winner is only the least-bad
    // rejected row. Publishing a view (and therefore a ranking row) for it would
    // present a rejected source as the coin's best yield. Tradeoff: the coin is
    // omitted from the rankings payload for that publication instead, its rows
    // persist with `is_best = 0`, and no decision row is written — the ledger
    // keeps the rejection context for the next publication that resolves it.
    if (source.rejected) {
      continue;
    }
    const candidates = input.evaluatedSources
      .filter((candidate) => candidate.id === source.id)
      .sort(compareCandidates);
    const rejectedCount = candidates.filter((candidate) => candidate.rejected).length;
    const provenance = provenanceByKey.get(buildHistoryKey(source.id, source.sourceKey)) ?? {};
    const previousBestSourceKey =
      typeof provenance.previousBestSourceKey === "string" ? provenance.previousBestSourceKey : null;
    const sourceSwitch = provenance.sourceSwitch === true;
    const apy30dDeltaFromPrevious = resolveApy30dDeltaFromPrevious({
      selected: source,
      candidates,
      previousBestSourceKey,
    });

    viewsByCoinId.set(source.id, {
      selected: source,
      candidates,
      rejectedCount,
      selectedReason:
        typeof provenance.selectionReason === "string" ? provenance.selectionReason : "Selected source",
      previousBestSourceKey,
      sourceSwitch,
      apy30dDeltaFromPrevious,
      decisionLedger: buildPublicDecisionLedger({
        selected: source,
        candidates,
        rejectedCount,
        previousBestSourceKey,
        sourceSwitch,
        apy30dDeltaFromPrevious,
      }),
    });
  }

  return { provenanceByKey, viewsByCoinId };
}

const MAX_SOURCE_DECISION_ALTERNATIVES = 4;

const MAX_SOURCE_DECISION_ANOMALIES = 6;

const MAX_SOURCE_DECISION_TEXT_LENGTH = 160;

const MAX_SOURCE_DECISION_ALTERNATIVES_JSON_BYTES = 4_096;

function truncateDecisionText(value: string, maxLength = MAX_SOURCE_DECISION_TEXT_LENGTH): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function getJsonByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function buildAlternativeDecisionReason(selected: EvaluatedYieldSource, candidate: EvaluatedYieldSource): string {
  if (candidate.rejected) {
    if (candidate.anomalies.includes("source-stale")) {
      return "rejected: source observation exceeded its eligibility TTL";
    }
    if (candidate.anomalies.includes("benchmark-stale")) {
      return "rejected: selected benchmark exceeded its eligibility TTL";
    }
    if (candidate.anomalies.includes("source-zero-vs-history")) {
      return "rejected: zero current APY versus source history";
    }
    if (candidate.anomalies.includes("diverges-from-canonical")) {
      return "rejected: divergent lower-confidence source";
    }
    return "rejected by arbitration";
  }

  const selectedPriority = getConfidencePriority(selected.confidenceTier);
  const candidatePriority = getConfidencePriority(candidate.confidenceTier);
  if (candidatePriority < selectedPriority) {
    return "retained alternative: lower confidence tier";
  }
  if (candidate.currentApy < selected.currentApy) {
    return "retained alternative: lower APY";
  }
  if (
    (candidate.pharosYieldScore ?? Number.NEGATIVE_INFINITY) < (selected.pharosYieldScore ?? Number.NEGATIVE_INFINITY)
  ) {
    return "retained alternative: lower PYS";
  }
  if ((candidate.sourceTvlUsd ?? 0) < (selected.sourceTvlUsd ?? 0)) {
    return "retained alternative: lower source TVL";
  }
  return "retained alternative: ranked behind selected source";
}

export function serializeBoundedDecisionAlternatives(
  selected: EvaluatedYieldSource,
  candidates: EvaluatedYieldSource[],
): string {
  const alternativeCandidates = candidates.filter((candidate) => candidate.sourceKey !== selected.sourceKey);

  for (
    let maxAlternatives = Math.min(MAX_SOURCE_DECISION_ALTERNATIVES, alternativeCandidates.length);
    maxAlternatives >= 0;
    maxAlternatives--
  ) {
    for (let maxAnomalies = MAX_SOURCE_DECISION_ANOMALIES; maxAnomalies >= 0; maxAnomalies--) {
      const alternatives = alternativeCandidates.slice(0, maxAlternatives).map((candidate) => ({
        sourceKey: truncateDecisionText(candidate.sourceKey),
        selectionRank: candidates.findIndex((entry) => entry.sourceKey === candidate.sourceKey) + 1,
        confidenceTier: candidate.confidenceTier,
        sourceRole: deriveYieldSourceRole(candidate, { isSelected: false }),
        dataSource: truncateDecisionText(candidate.dataSource, 80),
        apy30d: candidate.apy30d,
        pharosYieldScore: candidate.pharosYieldScore,
        sourceTvlUsd: candidate.sourceTvlUsd,
        sourceRiskPenalty: candidate.sourceRiskPenalty,
        rejected: candidate.rejected,
        rejectionReasonCode: deriveRejectionReasonCode(selected, candidate),
        reason: buildAlternativeDecisionReason(selected, candidate),
        anomalies: candidate.anomalies.slice(0, maxAnomalies).map((anomaly) => truncateDecisionText(anomaly, 80)),
      }));
      const json = JSON.stringify(alternatives);
      if (getJsonByteLength(json) <= MAX_SOURCE_DECISION_ALTERNATIVES_JSON_BYTES) {
        return json;
      }
    }
  }

  return "[]";
}

export function classifyDecisionRetention(input: {
  sourceSwitch: boolean;
  source: EvaluatedYieldSource;
  candidates: EvaluatedYieldSource[];
}): { retentionReason: "trend" | "episode" | "audit"; trendFingerprint: string | null } {
  if (input.sourceSwitch) return { retentionReason: "trend", trendFingerprint: null };
  const selectedConfidence = getConfidencePriority(input.source.confidenceTier);
  const episodeEvidence = input.candidates
    .filter(
      (candidate) =>
        candidate.anomalies.length > 0 ||
        (candidate.sourceKey !== input.source.sourceKey &&
          candidate.rejected &&
          getConfidencePriority(candidate.confidenceTier) > selectedConfidence
        ),
    )
    .map((candidate) => ({
      sourceKey: candidate.sourceKey,
      confidenceTier: candidate.confidenceTier,
      anomalies: [...candidate.anomalies].sort(),
      rejectedHigherConfidence:
        candidate.sourceKey !== input.source.sourceKey &&
        candidate.rejected &&
        getConfidencePriority(candidate.confidenceTier) > selectedConfidence,
      rejectionReasonCode: candidate.rejected
        ? deriveRejectionReasonCode(input.source, candidate)
        : null,
    }));
  if (episodeEvidence.length === 0) return { retentionReason: "audit", trendFingerprint: null };
  return {
    retentionReason: "episode",
    trendFingerprint: JSON.stringify({
      selectedSourceKey: input.source.sourceKey,
      selectedConfidenceTier: input.source.confidenceTier,
      evidence: episodeEvidence,
    }),
  };
}
