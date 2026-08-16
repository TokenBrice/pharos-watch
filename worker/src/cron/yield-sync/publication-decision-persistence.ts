import { logWorkerEventArgs } from "../../lib/structured-log";
import {
  YieldRankingsResponseSchema,
  type YieldPublicDecisionLedger,
  type YieldSourceInputMeta,
} from "@shared/types/yield";
import { YIELD_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/yield-methodology";
import { getCache, type CacheWriteResult } from "../../lib/db-cache";
import { readCachedJson, validatePayloadWithSchema } from "../../lib/api-utils";
import { buildHistoryKey, type EvaluatedYieldSource } from "./evaluation";
import { compareCandidates, getConfidencePriority } from "./evaluation-arbitration";
import { publishYieldRowsAtomically } from "./publication-atomic-batch";
import { buildYieldSourceProvenance } from "./provenance";
import { buildPublicDecisionLedger, deriveRejectionReasonCode, deriveYieldSourceRole } from "./decision-public";
import { resolveApy30dDeltaFromPrevious } from "./publication-ranking-payload";
import { PYS_SCALING_FACTOR } from "../../lib/constants";

const MAX_SOURCE_DECISION_ALTERNATIVES = 4;
const MAX_SOURCE_DECISION_ANOMALIES = 6;
const MAX_SOURCE_DECISION_TEXT_LENGTH = 160;
const MAX_SOURCE_DECISION_ALTERNATIVES_JSON_BYTES = 4_096;

function countYieldRankings(
  rankingsPayload: { rankings?: Array<{ id?: string }> },
  options?: { allowedIds?: Set<string> },
): { count: number; malformed: boolean } {
  if (!Array.isArray(rankingsPayload.rankings)) {
    return { count: 0, malformed: true };
  }

  const rankings = options?.allowedIds
    ? rankingsPayload.rankings.filter(
        (ranking) => typeof ranking.id === "string" && options.allowedIds?.has(ranking.id),
      )
    : rankingsPayload.rankings.filter((ranking) => typeof ranking.id === "string");
  return { count: rankings.length, malformed: false };
}

export async function readPreviousYieldRankingsCount(
  db: D1Database,
  options?: { allowedIds?: Set<string>; allowMalformedRecovery?: boolean },
): Promise<{ count: number; malformed: boolean }> {
  const previousCache = await getCache(db, "yield-rankings");
  const previousRankings = readCachedJson<{ rankings?: Array<{ id?: string }> }>(
    "yield-sync",
    "yield-rankings",
    previousCache,
  );
  if (previousRankings.status === "missing") {
    return { count: 0, malformed: false };
  }
  if (previousRankings.status === "malformed") {
    if (options?.allowedIds || options?.allowMalformedRecovery) {
      // Let the later schema and absolute-coverage publish guards decide whether
      // a valid replacement can recover a malformed public cache.
      return { count: 0, malformed: false };
    }
    return { count: 0, malformed: true };
  }
  return countYieldRankings(previousRankings.data, options);
}

function hasDuplicateRankingIds(rankings: Array<{ id: string }>): boolean {
  const seen = new Set<string>();
  for (const ranking of rankings) {
    if (seen.has(ranking.id)) return true;
    seen.add(ranking.id);
  }
  return false;
}

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

function serializeBoundedDecisionAlternatives(
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

function buildYieldSourceDecisionEvidence(params: {
  source: EvaluatedYieldSource;
  evaluatedSources: EvaluatedYieldSource[];
  bestSourceKeyByCoin: Map<string, string>;
  startSec: number;
  dlPoolsMeta: YieldSourceInputMeta;
}): {
  selectedReason: string;
  sourceSwitch: boolean;
  previousBestSourceKey: string | null;
  rejectedCount: number;
  alternativesJson: string;
  publicDecisionLedger: YieldPublicDecisionLedger;
} {
  const candidates = params.evaluatedSources
    .filter((candidate) => candidate.id === params.source.id)
    .sort(compareCandidates);
  const rejectedCount = candidates.filter((candidate) => candidate.rejected).length;
  const provenance = buildYieldSourceProvenance({
    source: params.source,
    isBest: params.bestSourceKeyByCoin.get(params.source.id) === params.source.sourceKey,
    evaluatedSources: params.evaluatedSources,
    startSec: params.startSec,
    dlPoolsMeta: params.dlPoolsMeta,
  });
  const previousBestSourceKey =
    typeof provenance.previousBestSourceKey === "string" ? provenance.previousBestSourceKey : null;
  const apy30dDeltaFromPrevious = resolveApy30dDeltaFromPrevious({
    selected: params.source,
    candidates,
    previousBestSourceKey,
  });

  return {
    selectedReason: typeof provenance.selectionReason === "string" ? provenance.selectionReason : "Selected source",
    sourceSwitch: provenance.sourceSwitch === true,
    previousBestSourceKey,
    rejectedCount,
    alternativesJson: serializeBoundedDecisionAlternatives(params.source, candidates),
    publicDecisionLedger: buildPublicDecisionLedger({
      selected: params.source,
      candidates,
      rejectedCount,
      previousBestSourceKey,
      sourceSwitch: provenance.sourceSwitch === true,
      apy30dDeltaFromPrevious,
    }),
  };
}

function classifyDecisionRetention(input: {
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

export async function validateYieldRankingsPayloadForPublish(
  db: D1Database,
  rankingsPayload: unknown,
): Promise<{ ok: boolean; validationFailures: number; reason?: string }> {
  const validation = validatePayloadWithSchema(
    YieldRankingsResponseSchema,
    rankingsPayload,
    "sync-yield-data:yield-rankings",
  );

  if (!validation.ok) {
    logWorkerEventArgs("handler", "warn", "[sync-yield-data] Skipped yield-rankings cache write due to schema validation failure");
    return { ok: false, validationFailures: 1, reason: "schema-validation-failed" };
  }

  const currentRankings = validation.data.rankings.length;
  if (hasDuplicateRankingIds(validation.data.rankings)) {
    logWorkerEventArgs("handler", "warn", "[sync-yield-data] Skipped yield-rankings cache write due to duplicate ranking IDs");
    return { ok: false, validationFailures: 1, reason: "duplicate-ranking-ids" };
  }

  const previousRankingsState = await readPreviousYieldRankingsCount(db);
  if (previousRankingsState.malformed && currentRankings === 0) {
    logWorkerEventArgs("handler", "warn",
      "[sync-yield-data] Skipped yield-rankings cache write because malformed previous cache recovery payload is empty",
    );
    return {
      ok: false,
      validationFailures: 1,
      reason: "empty-rankings-payload",
    };
  }
  const previousRankings = previousRankingsState.count;
  const severeShrink = previousRankings >= 5 && currentRankings < Math.ceil(previousRankings * 0.4);
  if (previousRankings > 0 && (currentRankings === 0 || severeShrink)) {
    logWorkerEventArgs("handler", "warn", "[sync-yield-data] Skipped yield-rankings cache write due to publish guard");
    return {
      ok: false,
      validationFailures: 1,
      reason: currentRankings === 0 ? "empty-rankings-payload" : "rankings-payload-shrunk",
    };
  }

  return { ok: true, validationFailures: 0 };
}

export async function persistEvaluatedYieldSources(
  db: D1Database,
  input: {
    signal?: AbortSignal;
    evaluatedSources: EvaluatedYieldSource[];
    bestSourceKeyByCoin: Map<string, string>;
    startSec: number;
    medianApy: number;
    dlPoolsMeta: YieldSourceInputMeta;
    generationId: string;
    rankingsPayload: unknown;
  },
): Promise<
  | {
      ok: false;
      updatedCount: number;
      rankingProvenanceByKey: Map<string, Record<string, unknown>>;
      validationFailures: number;
      reason?: string;
      cacheWrite?: CacheWriteResult;
    }
  | {
      ok: true;
      updatedCount: number;
      rankingProvenanceByKey: Map<string, Record<string, unknown>>;
      validationFailures: number;
      cacheWrite: CacheWriteResult;
    }
> {
  const yieldDataRows: Array<Record<string, unknown>> = [];
  const historyRows: Array<Record<string, unknown>> = [];
  const decisionRows: Array<Record<string, unknown>> = [];
  const decisionAlternativeRows: Array<Record<string, unknown>> = [];
  const rankingProvenanceByKey = new Map<string, Record<string, unknown>>();

  for (const source of input.evaluatedSources) {
    const isBest = input.bestSourceKeyByCoin.get(source.id) === source.sourceKey ? 1 : 0;
    const warningSignals = [...source.warnings];
    const warningSignalsJson = warningSignals.length > 0 ? JSON.stringify(warningSignals) : null;
    const safeVariance30d = source.stdDev30d != null && Number.isFinite(source.stdDev30d) ? source.stdDev30d : null;
    const safeStability =
      source.yieldStability != null && Number.isFinite(source.yieldStability) ? source.yieldStability : null;
    const safePharosYieldScore =
      source.pharosYieldScore != null && Number.isFinite(source.pharosYieldScore) ? source.pharosYieldScore : null;
    const safetySnapshotUnavailable = source.safetyProvenance === "safety-snapshot-unavailable";
    const safeSafetyScore =
      !safetySnapshotUnavailable && source.safetyScore != null && Number.isFinite(source.safetyScore)
        ? source.safetyScore
        : null;

    yieldDataRows.push({
      stablecoin_id: source.id,
      source_key: source.sourceKey,
      symbol: source.symbol,
      current_apy: source.currentApy,
      apy_base: source.apyBase,
      apy_reward: source.apyReward,
      apy_7d: source.apy7d,
      apy_30d: source.apy30d,
      yield_source: source.yieldSource,
      yield_type: source.yieldType,
      source_pool: source.sourcePool,
      source_tvl_usd: source.sourceTvlUsd,
      data_source: source.dataSource,
      safety_score: safeSafetyScore,
      safety_grade: source.safetyGrade,
      pharos_yield_score: safePharosYieldScore,
      yield_to_risk: source.yieldToRisk,
      excess_yield: source.excessYield,
      yield_stability: safeStability,
      apy_variance_30d: safeVariance30d,
      apy_min_30d: source.apyMin30d,
      apy_max_30d: source.apyMax30d,
      exchange_rate: source.exchangeRate,
      exchange_rate_prev: source.prevExchangeRate,
      warning_signals: warningSignalsJson,
      is_best: isBest,
      updated_at: input.startSec,
      publication_generation_id: input.generationId,
      publication_state: "published",
    });

    historyRows.push({
      stablecoin_id: source.id,
      source_key: source.sourceKey,
      recorded_at: input.startSec,
      is_best: isBest,
      apy: source.currentApy,
      apy_base: source.apyBase,
      apy_reward: source.apyReward,
      exchange_rate: source.exchangeRate,
      source_tvl_usd: source.sourceTvlUsd,
      data_source: source.dataSource,
      warning_signals: warningSignalsJson,
      yield_source: source.yieldSource,
      yield_type: source.yieldType,
      publication_generation_id: input.generationId,
      publication_state: "published",
      pys_at_publish: safePharosYieldScore,
      safety_at_publish: safeSafetyScore,
      variance_at_publish: safeVariance30d,
      pys_inputs_at_publish: safetySnapshotUnavailable
        ? null
        : JSON.stringify({
            schemaVersion: 1,
            methodologyVersion: YIELD_METHODOLOGY_VERSION,
            apy30d: source.apy30d,
            safetyScore: source.safetyScore,
            varianceScore: source.apyVarianceScore,
            benchmarkRate: source.benchmarkRate,
            sourceRiskPenalty: source.sourceRiskPenalty,
            scalingFactor: PYS_SCALING_FACTOR,
            scoreQualification: source.scoreQualification,
            benchmarkKey: source.benchmarkKey,
            evidenceClass: source.evidenceClass,
          }),
    });

    rankingProvenanceByKey.set(
      buildHistoryKey(source.id, source.sourceKey),
      buildYieldSourceProvenance({
        source,
        isBest: isBest === 1,
        evaluatedSources: input.evaluatedSources,
        startSec: input.startSec,
        dlPoolsMeta: input.dlPoolsMeta,
      }),
    );

    if (isBest === 1) {
      const decisionEvidence = buildYieldSourceDecisionEvidence({
        source,
        evaluatedSources: input.evaluatedSources,
        bestSourceKeyByCoin: input.bestSourceKeyByCoin,
        startSec: input.startSec,
        dlPoolsMeta: input.dlPoolsMeta,
      });
      const candidates = input.evaluatedSources
        .filter((candidate) => candidate.id === source.id)
        .sort(compareCandidates);
      const retention = classifyDecisionRetention({
        sourceSwitch: decisionEvidence.sourceSwitch,
        source,
        candidates,
      });
      decisionRows.push({
        generation_id: input.generationId,
        stablecoin_id: source.id,
        selected_source_key: source.sourceKey,
        selected_confidence_tier: source.confidenceTier,
        selected_data_source: source.dataSource,
        selected_apy_30d: source.apy30d,
        selected_score: source.pharosYieldScore,
        selected_reason: decisionEvidence.selectedReason,
        previous_best_source_key: decisionEvidence.previousBestSourceKey,
        source_switch: decisionEvidence.sourceSwitch ? 1 : 0,
        rejected_count: decisionEvidence.rejectedCount,
        alternatives_json: decisionEvidence.alternativesJson,
        created_at: input.startSec,
        retention_reason: retention.retentionReason,
        trend_fingerprint: retention.trendFingerprint,
      });

      for (const alternative of decisionEvidence.publicDecisionLedger.alternatives) {
        decisionAlternativeRows.push({
          generation_id: input.generationId,
          stablecoin_id: source.id,
          alt_source_key: alternative.sourceKey,
          alt_yield_source: alternative.yieldSource,
          alt_apy30d_delta: Number.isFinite(alternative.apy30dDelta) ? alternative.apy30dDelta : null,
          rejection_reason_code: alternative.rejectionReasonCode,
          recorded_at: input.startSec,
        });
      }
    }
  }

  const publishability = await validateYieldRankingsPayloadForPublish(db, input.rankingsPayload);
  if (!publishability.ok) {
    return {
      ok: false,
      updatedCount: 0,
      rankingProvenanceByKey,
      validationFailures: publishability.validationFailures,
      reason: publishability.reason,
    };
  }

  const cacheWrite = await publishYieldRowsAtomically(db, {
    signal: input.signal,
    rankingsPayload: input.rankingsPayload,
    startSec: input.startSec,
    generationId: input.generationId,
    yieldDataRows,
    historyRows,
    decisionRows,
    decisionAlternativeRows,
  });
  if (!cacheWrite.written) {
    return {
      ok: false,
      updatedCount: 0,
      rankingProvenanceByKey,
      validationFailures: 0,
      reason: "cache-write-skipped-newer",
      cacheWrite,
    };
  }

  return {
    ok: true,
    updatedCount: input.evaluatedSources.length,
    rankingProvenanceByKey,
    validationFailures: publishability.validationFailures,
    cacheWrite,
  };
}
