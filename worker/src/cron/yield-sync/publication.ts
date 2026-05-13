import { YieldRankingsResponseSchema, type AltYieldSource, type YieldBenchmarkMeta, type YieldBenchmarkRegistry, type YieldPublicationMetadata, type YieldSafetySnapshotMeta, type YieldSourceInputMeta } from "@shared/types/yield";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { ACTIVE_STABLECOINS, FROZEN_IDS, TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { batchExecute } from "../../lib/db";
import { getCache, setCacheIfNewer, type CacheWriteResult } from "../../lib/db-cache";
import { readCachedJson, validatePayloadWithSchema } from "../../lib/api-utils";
import { PYS_SCALING_FACTOR } from "../../lib/constants";
import { resolveYieldSourceUrl } from "../../lib/yield-source-links";
import { detectWarningSignals, getRankingStaleThresholdMs } from "../yield-helpers";
import { deleteOrphanYieldRows, deleteStaleYieldRows } from "./history";
import { buildHistoryKey, type EvaluatedYieldSource } from "./evaluation";
import { compareCandidates, getConfidencePriority } from "./evaluation-arbitration";
import { buildYieldSourceProvenance } from "./provenance";
import { buildYieldSourceRisk } from "./source-risk";

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
    ? rankingsPayload.rankings.filter((ranking) => typeof ranking.id === "string" && options.allowedIds?.has(ranking.id))
    : rankingsPayload.rankings.filter((ranking) => typeof ranking.id === "string");
  return { count: rankings.length, malformed: false };
}

export async function readPreviousYieldRankingsCount(
  db: D1Database,
  options?: { allowedIds?: Set<string> },
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
    if (options?.allowedIds) {
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

function evaluatedSourceToRanking(
  source: EvaluatedYieldSource,
  provenance: Record<string, unknown> | null,
  publicationGenerationId?: string | null,
  publishedRank?: number,
) {
  const meta = TRACKED_META_BY_ID.get(source.id);
  return {
    id: source.id,
    symbol: source.symbol,
    name: meta?.name ?? source.symbol,
    currentApy: source.currentApy,
    apy7d: source.apy7d,
    apy30d: source.apy30d,
    apyBase: source.apyBase,
    apyReward: source.apyReward,
    yieldSource: source.yieldSource,
    yieldSourceUrl: resolveYieldSourceUrl({
      stablecoinId: source.id,
      sourceKey: source.sourceKey,
      yieldSource: source.yieldSource,
    }),
    yieldType: source.yieldType,
    dataSource: source.dataSource,
    sourceTvlUsd: source.sourceTvlUsd,
    pharosYieldScore: source.pharosYieldScore,
    safetyScore: source.safetyScore,
    safetyGrade: source.safetyGrade,
    yieldToRisk: source.yieldToRisk,
    excessYield: source.excessYield,
    benchmarkKey: source.benchmarkKey,
    benchmarkLabel: source.benchmarkLabel,
    benchmarkCurrency: source.benchmarkCurrency,
    benchmarkRate: source.benchmarkRate,
    benchmarkRecordDate: source.benchmarkRecordDate,
    benchmarkIsFallback: source.benchmarkIsFallback,
    benchmarkFallbackMode: source.benchmarkFallbackMode,
    benchmarkSelectionMode: source.benchmarkSelectionMode,
    benchmarkIsProxy: source.benchmarkIsProxy,
    yieldStability: source.yieldStability,
    apyVariance30d: source.stdDev30d,
    apyMin30d: source.apyMin30d,
    apyMax30d: source.apyMax30d,
    warningSignals: [...source.warnings],
    altSources: [] as AltYieldSource[],
    sourceRisk: buildYieldSourceRisk({ source, provenance, isBest: true }),
    ...(publicationGenerationId ? { publicationGenerationId } : {}),
    ...(publishedRank ? { publishedRank } : {}),
    provenance: provenance
      ? {
          ...provenance,
          safetyProvenance: source.usedDefaultSafety ? "default-safety" : "cached-publish",
        }
      : null,
  };
}

export function buildYieldRankingsPayloadFromEvaluatedSources(
  input: {
    evaluatedSources: EvaluatedYieldSource[];
    bestSourceKeyByCoin: Map<string, string>;
    rankingProvenanceByKey: Map<string, Record<string, unknown>>;
    riskFreeRate: number;
    riskFreeRateMeta: YieldBenchmarkMeta;
    riskFreeRateRegistry?: YieldBenchmarkRegistry;
    dlPoolsMeta: YieldSourceInputMeta;
    safetySnapshot: YieldSafetySnapshotMeta;
    medianApy: number;
    startSec: number;
    publication?: YieldPublicationMetadata | null;
  },
) {
  const bestRows = input.evaluatedSources
    .filter((source) => input.bestSourceKeyByCoin.get(source.id) === source.sourceKey)
    .sort((a, b) => b.pharosYieldScore - a.pharosYieldScore);

  const altSourcesByCoin = new Map<string, AltYieldSource[]>();
  for (const source of input.evaluatedSources) {
    if (input.bestSourceKeyByCoin.get(source.id) === source.sourceKey) continue;

    const alts = altSourcesByCoin.get(source.id) ?? [];
    const existingIdx = alts.findIndex((a) => a.sourceKey === source.sourceKey);
    const key = buildHistoryKey(source.id, source.sourceKey);
    const provenance = input.rankingProvenanceByKey.get(key) ?? null;
    const alt: AltYieldSource = {
      sourceKey: source.sourceKey,
      yieldSource: source.yieldSource,
      yieldSourceUrl: resolveYieldSourceUrl({
        stablecoinId: source.id,
        sourceKey: source.sourceKey,
        yieldSource: source.yieldSource,
      }),
      yieldType: source.yieldType as AltYieldSource["yieldType"],
      currentApy: source.currentApy,
      apy30d: source.apy30d,
      sourceTvlUsd: source.sourceTvlUsd,
      dataSource: source.dataSource,
      sourceRisk: buildYieldSourceRisk({ source, provenance, isBest: false }),
    };
    if (existingIdx >= 0) {
      if ((source.currentApy ?? 0) > (alts[existingIdx].currentApy ?? 0)) {
        alts[existingIdx] = alt;
      }
    } else {
      alts.push(alt);
    }
    altSourcesByCoin.set(source.id, alts);
  }

  const publicationGenerationId = input.publication?.generationId ?? null;
  const rankings = bestRows.map((source, index) => {
    const key = buildHistoryKey(source.id, source.sourceKey);
    const provenance = input.rankingProvenanceByKey.get(key) ?? null;
    const ranking = evaluatedSourceToRanking(source, provenance, publicationGenerationId, index + 1);
    ranking.altSources = altSourcesByCoin.get(source.id) ?? [];

    const sourceObservedAt =
      provenance != null && typeof provenance.sourceObservedAt === "number"
        ? provenance.sourceObservedAt
        : input.startSec;
    const updatedAtMs = sourceObservedAt * 1000;
    const staleThresholdMs = getRankingStaleThresholdMs(source.dataSource, source.sourceKey);
    if (updatedAtMs > 0 && updatedAtMs < Date.now() - staleThresholdMs) {
      if (!ranking.warningSignals.includes("data-stale")) {
        ranking.warningSignals = [...ranking.warningSignals, "data-stale"];
      }
    }

    return ranking;
  });

  return {
    rankings,
    riskFreeRate: input.riskFreeRate,
    benchmarks: input.riskFreeRateRegistry,
    scalingFactor: PYS_SCALING_FACTOR,
    medianApy: input.medianApy,
    updatedAt: input.startSec,
    ...(input.publication ? { publication: input.publication } : {}),
    provenance: {
      selectionMethod: "confidence-weighted" as const,
      benchmark: input.riskFreeRateMeta,
      benchmarks: input.riskFreeRateRegistry,
      dlPools: input.dlPoolsMeta,
      safetySnapshot: input.safetySnapshot,
    },
  };
}

export function buildYieldPublicationGenerationId(startSec: number): string {
  return `yield-${startSec}`;
}

function buildYieldPublicationMetadata(params: {
  generationId: string;
  startSec: number;
  status: YieldPublicationMetadata["status"];
}): YieldPublicationMetadata {
  return {
    generationId: params.generationId,
    updatedAt: params.startSec,
    cutoffAt: params.startSec,
    schemaVersion: 1,
    status: params.status,
  };
}

export function attachYieldPublicationMetadata<
  T extends {
    rankings?: Array<Record<string, unknown>>;
  },
>(
  payload: T,
  params: {
    generationId: string;
    startSec: number;
    status: YieldPublicationMetadata["status"];
  },
): T & { publication: YieldPublicationMetadata } {
  return {
    ...payload,
    publication: buildYieldPublicationMetadata(params),
    rankings: Array.isArray(payload.rankings)
      ? payload.rankings.map((ranking, index) => ({
          ...ranking,
          publicationGenerationId: params.generationId,
          publishedRank: index + 1,
        }))
      : payload.rankings,
  };
}

function truncateDecisionText(value: string, maxLength = MAX_SOURCE_DECISION_TEXT_LENGTH): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function getJsonByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function buildAlternativeDecisionReason(selected: EvaluatedYieldSource, candidate: EvaluatedYieldSource): string {
  if (candidate.rejected) {
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
  if (candidate.pharosYieldScore < selected.pharosYieldScore) {
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
      const alternatives = alternativeCandidates
        .slice(0, maxAlternatives)
        .map((candidate) => ({
          sourceKey: truncateDecisionText(candidate.sourceKey),
          confidenceTier: candidate.confidenceTier,
          dataSource: truncateDecisionText(candidate.dataSource, 80),
          apy30d: candidate.apy30d,
          pharosYieldScore: candidate.pharosYieldScore,
          sourceTvlUsd: candidate.sourceTvlUsd,
          sourceRiskPenalty: candidate.sourceRiskPenalty,
          rejected: candidate.rejected,
          reason: buildAlternativeDecisionReason(selected, candidate),
          anomalies: candidate.anomalies
            .slice(0, maxAnomalies)
            .map((anomaly) => truncateDecisionText(anomaly, 80)),
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

  return {
    selectedReason: typeof provenance.selectionReason === "string" ? provenance.selectionReason : "Selected source",
    sourceSwitch: provenance.sourceSwitch === true,
    previousBestSourceKey: typeof provenance.previousBestSourceKey === "string" ? provenance.previousBestSourceKey : null,
    rejectedCount,
    alternativesJson: serializeBoundedDecisionAlternatives(params.source, candidates),
  };
}

export async function stageYieldPublicationGeneration(
  db: D1Database,
  params: {
    generationId: string;
    startSec: number;
    rankingCount: number;
    sourceRowCount: number;
    bestRowCount: number;
    rowsRejected: number;
    divergenceFlags: number;
    sourceSwitches: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO yield_publication_generations (
        generation_id, started_at, state, cache_key, ranking_updated_at, ranking_count,
        source_row_count, best_row_count, decision_count, metadata_json, created_at
      ) VALUES (?, ?, 'staged', 'yield-rankings', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      params.generationId,
      params.startSec,
      params.startSec,
      params.rankingCount,
      params.sourceRowCount,
      params.bestRowCount,
      params.bestRowCount,
      JSON.stringify({
        rowsRejected: params.rowsRejected,
        divergenceFlags: params.divergenceFlags,
        sourceSwitches: params.sourceSwitches,
      }),
      params.startSec,
    )
    .run();
}

export async function finalizeYieldPublicationGeneration(
  db: D1Database,
  params: {
    generationId: string;
    state: "published" | "failed";
    timestamp: number;
    reason?: string;
  },
): Promise<void> {
  const rowState = params.state;
  const generationStmt =
    params.state === "published"
      ? db
          .prepare(
            `UPDATE yield_publication_generations
             SET state = 'published', published_at = ?, failed_at = NULL, failure_reason = NULL
             WHERE generation_id = ?`,
          )
          .bind(params.timestamp, params.generationId)
      : db
          .prepare(
            `UPDATE yield_publication_generations
             SET state = 'failed', failed_at = ?, failure_reason = ?
             WHERE generation_id = ?`,
          )
          .bind(params.timestamp, params.reason ?? "publication-failed", params.generationId);

  await batchExecute(db, [
    generationStmt,
    db
      .prepare("UPDATE yield_data SET publication_state = ? WHERE publication_generation_id = ?")
      .bind(rowState, params.generationId),
    db
      .prepare("UPDATE yield_history SET publication_state = ? WHERE publication_generation_id = ?")
      .bind(rowState, params.generationId),
  ]);
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
    console.warn("[sync-yield-data] Skipped yield-rankings cache write due to schema validation failure");
    return { ok: false, validationFailures: 1, reason: "schema-validation-failed" };
  }

  const currentRankings = validation.data.rankings.length;
  if (hasDuplicateRankingIds(validation.data.rankings)) {
    console.warn("[sync-yield-data] Skipped yield-rankings cache write due to duplicate ranking IDs");
    return { ok: false, validationFailures: 1, reason: "duplicate-ranking-ids" };
  }

  const previousRankingsState = await readPreviousYieldRankingsCount(db);
  if (previousRankingsState.malformed && currentRankings === 0) {
    console.warn("[sync-yield-data] Skipped yield-rankings cache write because malformed previous cache recovery payload is empty");
    return {
      ok: false,
      validationFailures: 1,
      reason: "empty-rankings-payload",
    };
  }
  const previousRankings = previousRankingsState.count;
  const severeShrink =
    previousRankings >= 5 &&
    currentRankings < Math.ceil(previousRankings * 0.4);
  if (previousRankings > 0 && (currentRankings === 0 || severeShrink)) {
    console.warn("[sync-yield-data] Skipped yield-rankings cache write due to publish guard");
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
    evaluatedSources: EvaluatedYieldSource[];
    bestSourceKeyByCoin: Map<string, string>;
    startSec: number;
    medianApy: number;
    dlPoolsMeta: YieldSourceInputMeta;
    generationId: string;
  },
): Promise<{
  updatedCount: number;
  rankingProvenanceByKey: Map<string, Record<string, unknown>>;
}> {
  const yieldDataStmts: D1PreparedStatement[] = [];
  const historyStmts: D1PreparedStatement[] = [];
  const decisionStmts: D1PreparedStatement[] = [];
  const rankingProvenanceByKey = new Map<string, Record<string, unknown>>();
  let updatedCount = 0;

  for (const source of input.evaluatedSources) {
    const isBest = input.bestSourceKeyByCoin.get(source.id) === source.sourceKey ? 1 : 0;
    const warningSignals = detectWarningSignals({
      currentApy: source.currentApy,
      apy30d: source.apy30d,
      apyReward: source.apyReward,
      medianApy: input.medianApy,
      sourceTvlUsd: source.sourceTvlUsd,
      prevTvlUsd: source.prevTvlUsd,
    });
    source.warnings = warningSignals;
    const warningSignalsJson = warningSignals.length > 0 ? JSON.stringify(warningSignals) : null;
    const safeVariance30d = source.stdDev30d != null && Number.isFinite(source.stdDev30d) ? source.stdDev30d : null;
    const safeStability =
      source.yieldStability != null && Number.isFinite(source.yieldStability) ? source.yieldStability : null;

    yieldDataStmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO yield_data (
            stablecoin_id, source_key, symbol, current_apy, apy_base, apy_reward, apy_7d, apy_30d,
            yield_source, yield_type, source_pool, source_tvl_usd, data_source,
            safety_score, safety_grade, pharos_yield_score, yield_to_risk, excess_yield, yield_stability,
            apy_variance_30d, apy_min_30d, apy_max_30d, exchange_rate, exchange_rate_prev, warning_signals, is_best,
            updated_at, publication_generation_id, publication_state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          source.id,
          source.sourceKey,
          source.symbol,
          source.currentApy,
          source.apyBase,
          source.apyReward,
          source.apy7d,
          source.apy30d,
          source.yieldSource,
          source.yieldType,
          source.sourcePool,
          source.sourceTvlUsd,
          source.dataSource,
          source.safetyScore,
          source.safetyGrade,
          source.pharosYieldScore,
          source.yieldToRisk,
          source.excessYield,
          safeStability,
          safeVariance30d,
          source.apyMin30d,
          source.apyMax30d,
          source.exchangeRate,
          source.prevExchangeRate,
          warningSignalsJson,
          isBest,
          input.startSec,
          input.generationId,
          "staged",
        ),
    );

    historyStmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO yield_history (
            stablecoin_id, source_key, recorded_at, is_best, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd,
            data_source, warning_signals, yield_source, yield_type, publication_generation_id, publication_state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          source.id,
          source.sourceKey,
          input.startSec,
          isBest,
          source.currentApy,
          source.apyBase,
          source.apyReward,
          source.exchangeRate,
          source.sourceTvlUsd,
          source.dataSource,
          warningSignalsJson,
          source.yieldSource,
          source.yieldType,
          input.generationId,
          "staged",
        ),
    );

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
      decisionStmts.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO yield_source_decisions (
              generation_id, stablecoin_id, selected_source_key, selected_confidence_tier,
              selected_data_source, selected_apy_30d, selected_score, selected_reason,
              previous_best_source_key, source_switch, rejected_count, alternatives_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            input.generationId,
            source.id,
            source.sourceKey,
            source.confidenceTier,
            source.dataSource,
            source.apy30d,
            source.pharosYieldScore,
            decisionEvidence.selectedReason,
            decisionEvidence.previousBestSourceKey,
            decisionEvidence.sourceSwitch ? 1 : 0,
            decisionEvidence.rejectedCount,
            decisionEvidence.alternativesJson,
            input.startSec,
          ),
      );
    }

    updatedCount++;
  }

  const writeStmts = [...yieldDataStmts, ...historyStmts, ...decisionStmts];
  if (writeStmts.length > 0) {
    await batchExecute(db, writeStmts);
  }

  return { updatedCount, rankingProvenanceByKey };
}

export async function pruneYieldTables(
  db: D1Database,
  startSec: number,
  options?: {
    allowDestructiveCleanup?: boolean;
  },
): Promise<void> {
  const managedYieldIds = ACTIVE_STABLECOINS.map((meta) => meta.id);
  if ((options?.allowDestructiveCleanup ?? true) && managedYieldIds.length > 0) {
    await deleteStaleYieldRows(db, managedYieldIds, startSec);
    await deleteOrphanYieldRows(db, managedYieldIds);
  }

  const pruneCutoff = startSec - 365 * DAY_SECONDS;
  const frozenIdsList = [...FROZEN_IDS];
  const frozenClause =
    frozenIdsList.length > 0
      ? `AND stablecoin_id NOT IN (${frozenIdsList.map(() => "?").join(",")})`
      : "";
  await db
    .prepare(`DELETE FROM yield_history WHERE recorded_at < ? ${frozenClause}`)
    .bind(pruneCutoff, ...frozenIdsList)
    .run();
}

export async function writeYieldRankingsCache(
  db: D1Database,
  rankingsPayload: unknown,
  syncStartSec: number,
): Promise<{
  ok: boolean;
  validationFailures: number;
  reason?: string;
  cacheWrite?: CacheWriteResult;
}> {
  const publishability = await validateYieldRankingsPayloadForPublish(db, rankingsPayload);
  if (!publishability.ok) {
    return publishability;
  }

  const cacheWrite = await setCacheIfNewer(db, "yield-rankings", JSON.stringify(rankingsPayload), syncStartSec);
  if (!cacheWrite.written) {
    return {
      ok: false,
      validationFailures: 0,
      reason: "cache-write-skipped-newer",
      cacheWrite,
    };
  }
  return { ...publishability, cacheWrite };
}
