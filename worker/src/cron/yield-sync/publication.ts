import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import {
  buildMethodologyEnvelope,
} from "../../lib/api-methodology";
import {
  type YieldPublicationMetadata,
  type YieldDecisionReasonCode,
  type YieldDecisionRejectionReasonCode,
  type YieldPublicDecisionAlternative,
  type YieldPublicDecisionLedger,
  type YieldSourceRole,
  type YieldSourceInputMeta,
  type AltYieldSource,
  type YieldAlternateSummary,
  type YieldAlternateSourceSummary,
  type YieldBenchmarkMeta,
  type YieldBenchmarkRegistry,
  type YieldRankChangeAttribution,
  type YieldRanking,
  type YieldSafetySnapshotMeta,
  YIELD_BENCHMARK_KEY_VALUES,
  YieldRankingsResponseSchema,
  YIELD_PYS_INPUTS_AT_PUBLISH_SCHEMA_VERSION,
} from "@shared/types/yield";
import {
  batchExecute,
} from "../../lib/db";
import {
  getCache,
  type CacheWriteResult,
} from "../../lib/db-cache";
import {
  logWorkerEvent,
  logWorkerEventArgs,
} from "../../lib/structured-log";
import {
  runWithOverloadRetry,
} from "../../lib/d1-overload-retry";
import {
  getFreshnessSentinelCacheKey,
  getFreshnessSentinelProducerJob,
} from "../../lib/freshness-sentinels";
import {
  numberValue as finiteNumber,
} from "@shared/lib/type-guards";
import {
  getConfidencePriority,
  type EvaluatedYieldSource,
  buildSelectionReason,
  compareCandidates,
  buildYieldSourceRisk,
} from "./evaluation";
import type { ResolvedYieldEntry } from "./types";
import {
  getRankingStaleThresholdMs,
  getComparisonAnchorStaleThresholdMs,
} from "../../lib/yield-ranking-helpers";
import {
  isRealSourceSwitch,
  LEGACY_BEST_YIELD_SOURCE_KEY,
} from "../../lib/yield-history-ownership-handoffs";
import {
  buildHistoryKey,
  pruneYieldTables,
} from "./history";
import {
  TRACKED_META_BY_ID,
} from "@shared/lib/stablecoins/registry";
import {
  EVIDENCE_FIELD_COUNT,
} from "@shared/lib/yield-evidence";
import {
  buildYieldRankBaseline,
  buildYieldRankChangeAttribution,
  compareYieldRankRows,
} from "../../lib/yield-rank-attribution";
import {
  PYS_SCALING_FACTOR,
} from "../../lib/constants";
import {
  resolveYieldSourceUrl,
} from "../../lib/yield-source-links";
import {
  benchmarkRecordAgeSeconds,
  classifyYieldBenchmarkFreshness,
  YIELD_BENCHMARK_RECORD_MAX_AGE_SEC,
} from "@shared/lib/yield-benchmark-freshness";
import {
  YIELD_BENCHMARK_SCORE_TTL_SEC,
  toYieldBenchmarkRegistry,
  type ParsedYieldBenchmarkRegistry,
} from "./benchmarks";
import {
  readCachedJson,
} from "../../lib/api-cache-read";
import {
  validatePayloadWithSchema,
} from "../../lib/api-schema";
import {
  toErrorMessage,
} from "@shared/lib/error-utils";
import type {
  CronResult,
} from "../../lib/cron-logger";
import {
  createCronResult,
} from "../../lib/cron-result";
import {
  rethrowIfAborted,
  throwIfAborted,
} from "../../lib/abort";

export function buildYieldMethodology(asOf: number) {
  return buildMethodologyEnvelope({
    version: YIELD_METHODOLOGY_VERSION,
    versionLabel: YIELD_METHODOLOGY_VERSION_LABEL,
    currentVersion: YIELD_METHODOLOGY_VERSION,
    currentVersionLabel: YIELD_METHODOLOGY_VERSION_LABEL,
    changelogPath: YIELD_METHODOLOGY_CHANGELOG_PATH,
    asOf,
  });
}

export function buildYieldPublicationGenerationId(startSec: number): string {
  return `yield-${startSec}-${crypto.randomUUID()}`;
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
    updatedAt?: number;
    methodology?: unknown;
  },
>(
  payload: T,
  params: {
    generationId: string;
    startSec: number;
    status: YieldPublicationMetadata["status"];
  },
): T & { publication: YieldPublicationMetadata } {
  const updatedAt = typeof payload.updatedAt === "number" && Number.isFinite(payload.updatedAt)
    ? payload.updatedAt
    : params.startSec;
  return {
    ...payload,
    methodology: payload.methodology ?? buildYieldMethodology(updatedAt),
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
      `INSERT INTO yield_publication_generations (
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
             WHERE generation_id = ?
               AND EXISTS (SELECT 1 FROM cache WHERE key = 'yield-rankings'
                 AND json_extract(value, '$.publication.generationId') = generation_id)`,
          )
          .bind(params.timestamp, params.generationId)
      : db
          .prepare(
            `UPDATE yield_publication_generations
             SET state = 'failed', failed_at = ?, failure_reason = ?
             WHERE generation_id = ? AND state = 'staged'
               AND NOT EXISTS (SELECT 1 FROM cache WHERE key = 'yield-rankings'
                 AND json_extract(value, '$.publication.generationId') = generation_id)`,
          )
          .bind(params.timestamp, params.reason ?? "publication-failed", params.generationId);

  await batchExecute(db, [
    generationStmt,
    db
      .prepare(`UPDATE yield_data SET publication_state = ? WHERE publication_generation_id = ?
        AND EXISTS (SELECT 1 FROM yield_publication_generations g
          WHERE g.generation_id = yield_data.publication_generation_id AND g.state = ?)`)
      .bind(rowState, params.generationId, rowState),
    db
      .prepare(`UPDATE yield_history SET publication_state = ? WHERE publication_generation_id = ?
        AND EXISTS (SELECT 1 FROM yield_publication_generations g
          WHERE g.generation_id = yield_history.publication_generation_id AND g.state = ?)`)
      .bind(rowState, params.generationId, rowState),
  ]);
}

function parsePublishedYieldPublicationMetadata(
  cached: { value: string; updatedAt: number } | null,
): YieldPublicationMetadata | null {
  if (!cached) return null;
  try {
    const payload = JSON.parse(cached.value) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const publication = (payload as { publication?: unknown }).publication;
    if (!publication || typeof publication !== "object" || Array.isArray(publication)) return null;
    const generationId = (publication as { generationId?: unknown }).generationId;
    const status = (publication as { status?: unknown }).status;
    if (typeof generationId !== "string" || generationId.length === 0 || status !== "published") return null;
    const updatedAt = (publication as { updatedAt?: unknown }).updatedAt;
    const cutoffAt = (publication as { cutoffAt?: unknown }).cutoffAt;
    return {
      generationId,
      status: "published",
      updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : cached.updatedAt,
      cutoffAt: typeof cutoffAt === "number" && Number.isFinite(cutoffAt) ? cutoffAt : cached.updatedAt,
      schemaVersion: 1,
    };
  } catch {
    return null;
  }
}

export async function repairPublishedYieldGenerationFromCache(
  db: D1Database,
  timestamp: number,
): Promise<boolean> {
  const cached = await getCache(db, "yield-rankings");
  const publication = parsePublishedYieldPublicationMetadata(cached);
  if (!publication?.generationId) return false;
  const existingGeneration = await db
    .prepare("SELECT state FROM yield_publication_generations WHERE generation_id = ?")
    .bind(publication.generationId)
    .first<{ state: string }>();
  // Publication writes the cache value and the generation state in one atomic
  // batch, so a row that already reads published needs no repair. Re-running the
  // published finalize would only restamp `published_at` with this run's clock,
  // making the admin ledger disagree with the published ranking age.
  if (existingGeneration?.state === "published") return true;
  logWorkerEvent({
    scope: "lib",
    level: "warn",
    event: "yield-generation-repaired",
    job: "sync-yield-data",
    message: "Cache holds a published yield generation whose row was not published; repairing state",
    metadata: { generationId: publication.generationId, previousState: existingGeneration?.state ?? null },
  });
  await finalizeYieldPublicationGeneration(db, {
    generationId: publication.generationId,
    state: "published",
    timestamp,
  });
  return true;
}

/**
 * D1 rejects a statement whose bound value exceeds 2,000,000 bytes, and the
 * published generation is one batch: crossing the cap fails every statement in
 * it. The published cache value is the largest bound payload (~800 KB at 157
 * rows), so the guard warns at 1.2M characters — measured in UTF-16 code units,
 * which under-counts multi-byte characters by a few percent and still leaves
 * >600 KB of headroom before the hard cap.
 */
const YIELD_PUBLICATION_PAYLOAD_OVERSIZE_CHARS = 1_200_000;

export interface YieldRowsWriteStats {
  cacheValueChars: number;
  yieldDataRowsChars: number;
  historyRowsChars: number;
  decisionRowsChars: number;
  decisionAlternativeRowsChars: number;
  largestPayloadChars: number;
  oversize: boolean;
  pysInputsPersistedCount: number;
  pysInputsNullCount: number;
}

export type YieldRowsWriteResult = CacheWriteResult & {
  publicationStats: YieldRowsWriteStats;
  /** The retried batch was already committed by a prior ambiguous attempt (R2). */
  appliedByPriorAttempt: boolean;
};

// Fixed local identifiers only; build projections once, never per row or retry.
const cacheFreshGuard = "(SELECT json_extract(value, '$.publication.generationId') FROM cache WHERE key = 'yield-rankings') = ?";
const YIELD_DATA_COLUMNS = [
  "stablecoin_id", "source_key", "symbol", "current_apy", "apy_base", "apy_reward", "apy_7d", "apy_30d",
  "yield_source", "yield_type", "source_pool", "source_tvl_usd", "data_source",
  "safety_score", "safety_grade", "pharos_yield_score", "yield_to_risk", "excess_yield", "yield_stability",
  "apy_variance_30d", "apy_min_30d", "apy_max_30d", "exchange_rate", "exchange_rate_prev", "warning_signals", "is_best",
  "updated_at", "publication_generation_id", "publication_state",
] as const;
const YIELD_HISTORY_COLUMNS = [
  "stablecoin_id", "source_key", "recorded_at", "is_best", "apy", "apy_base", "apy_reward", "exchange_rate", "source_tvl_usd",
  "data_source", "warning_signals", "yield_source", "yield_type", "publication_generation_id", "publication_state",
  "pys_at_publish", "safety_at_publish", "variance_at_publish", "pys_inputs_at_publish", "source_observed_at",
] as const;
const DECISION_RETENTION_EXPRESSION = `CASE
  WHEN json_extract(value, '$.retention_reason') = 'trend' THEN 'trend'
  WHEN json_extract(value, '$.retention_reason') = 'episode'
   AND COALESCE((
     SELECT previous.trend_fingerprint
       FROM yield_source_decisions previous
      WHERE previous.stablecoin_id = json_extract(value, '$.stablecoin_id')
        AND previous.created_at < json_extract(value, '$.created_at')
      ORDER BY previous.created_at DESC, previous.generation_id DESC
      LIMIT 1
   ), '') != COALESCE(json_extract(value, '$.trend_fingerprint'), '')
  THEN 'trend'
  ELSE 'audit'
END`;
const YIELD_DECISION_COLUMNS = [
  "generation_id", "stablecoin_id", "selected_source_key", "selected_confidence_tier",
  "selected_data_source", "selected_apy_30d", "selected_score", "selected_reason",
  "previous_best_source_key", "source_switch", "rejected_count", "alternatives_json", "created_at",
  ["retention_reason", DECISION_RETENTION_EXPRESSION], "trend_fingerprint",
] as const;
const YIELD_DECISION_ALTERNATIVE_COLUMNS = [
  "generation_id", "stablecoin_id", "alt_source_key", "alt_yield_source",
  "alt_apy30d_delta", "rejection_reason_code", "recorded_at",
] as const;

function yieldJsonProjection(columns: readonly (string | readonly [string, string])[]): string {
  return `(${columns.map((column) => typeof column === "string" ? column : column[0]).join(", ")})
    SELECT ${columns.map((column) => typeof column === "string"
      ? `json_extract(value, '$.${column}')`
      : column[1]).join(", ")}
    FROM json_each(?)
    WHERE ${cacheFreshGuard}`;
}

const YIELD_DATA_INSERT_SQL = `INSERT INTO yield_data ${yieldJsonProjection(YIELD_DATA_COLUMNS)}
  ON CONFLICT(stablecoin_id, source_key) DO UPDATE SET
    ${YIELD_DATA_COLUMNS.filter((column) => column !== "stablecoin_id" && column !== "source_key")
      .map((column) => `${column} = excluded.${column}`).join(", ")}`;
const YIELD_HISTORY_INSERT_SQL = `INSERT INTO yield_history ${yieldJsonProjection(YIELD_HISTORY_COLUMNS)}
  ON CONFLICT(stablecoin_id, source_key, recorded_at) DO NOTHING`;
const YIELD_DECISION_INSERT_SQL = `INSERT OR REPLACE INTO yield_source_decisions ${yieldJsonProjection(YIELD_DECISION_COLUMNS)}`;
const YIELD_DECISION_ALTERNATIVE_INSERT_SQL = `INSERT OR REPLACE INTO yield_source_decision_alternatives ${yieldJsonProjection(YIELD_DECISION_ALTERNATIVE_COLUMNS)}`;

export async function publishYieldRowsAtomically(
  db: D1Database,
  input: {
    signal?: AbortSignal;
    rankingsPayload: unknown;
    startSec: number;
    generationId: string;
    yieldDataRows: Array<Record<string, unknown>>;
    historyRows: Array<Record<string, unknown>>;
    decisionRows: Array<Record<string, unknown>>;
    decisionAlternativeRows: Array<Record<string, unknown>>;
  },
): Promise<YieldRowsWriteResult> {
  const cacheValue = JSON.stringify(input.rankingsPayload);
  const yieldDataRowsJson = JSON.stringify(input.yieldDataRows);
  const historyRowsJson = JSON.stringify(input.historyRows);
  const decisionRowsJson = JSON.stringify(input.decisionRows);
  const decisionAlternativeRowsJson = JSON.stringify(input.decisionAlternativeRows);
  const sentinelValue = JSON.stringify({
    updatedAt: input.startSec,
    source: getFreshnessSentinelProducerJob("yield-data"),
    publishStatus: "ok",
    generationId: input.generationId,
  });
  const largestPayloadChars = Math.max(
    cacheValue.length,
    yieldDataRowsJson.length,
    historyRowsJson.length,
    decisionRowsJson.length,
    decisionAlternativeRowsJson.length,
  );
  const oversize = largestPayloadChars > YIELD_PUBLICATION_PAYLOAD_OVERSIZE_CHARS;
  // The replay-evidence column is null exactly for PYS-eligible rows whose
  // safety evidence was unavailable, so its null rate is the run's evidence-loss
  // signal. Anchor-only seeds are separate persistence inputs (excluded from
  // measured coverage) and are never PYS-eligible. A skipped write persists
  // nothing and reports zero for both counters.
  let pysEvidenceRowCount = 0;
  let pysInputsPersistedCount = 0;
  for (const row of input.historyRows) {
    if (row.observation_kind === "anchor-only") continue;
    pysEvidenceRowCount += 1;
    if (row.pys_inputs_at_publish != null) pysInputsPersistedCount += 1;
  }
  const buildStats = (written: boolean): YieldRowsWriteStats => ({
    cacheValueChars: cacheValue.length,
    yieldDataRowsChars: yieldDataRowsJson.length,
    historyRowsChars: historyRowsJson.length,
    decisionRowsChars: decisionRowsJson.length,
    decisionAlternativeRowsChars: decisionAlternativeRowsJson.length,
    largestPayloadChars,
    oversize,
    pysInputsPersistedCount: written ? pysInputsPersistedCount : 0,
    pysInputsNullCount: written ? pysEvidenceRowCount - pysInputsPersistedCount : 0,
  });
  const buildStatements = (): D1PreparedStatement[] => [
    db
      .prepare(
        `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
           WHERE cache.updated_at < excluded.updated_at`,
      )
      .bind("yield-rankings", cacheValue, input.startSec),
    db
      .prepare(YIELD_DATA_INSERT_SQL)
      .bind(yieldDataRowsJson, input.generationId),
    db
      .prepare(YIELD_HISTORY_INSERT_SQL)
      .bind(historyRowsJson, input.generationId),
    db
      .prepare(YIELD_DECISION_INSERT_SQL)
      .bind(decisionRowsJson, input.generationId),
    db
      .prepare(YIELD_DECISION_ALTERNATIVE_INSERT_SQL)
      .bind(decisionAlternativeRowsJson, input.generationId),
    db
      .prepare(
        `UPDATE yield_publication_generations
           SET state = 'published', published_at = ?, failed_at = NULL, failure_reason = NULL
           WHERE generation_id = ?
             AND ${cacheFreshGuard}`,
      )
      .bind(input.startSec, input.generationId, input.generationId),
    db
      .prepare(
        `INSERT INTO cache (key, value, updated_at)
           SELECT ?, ?, ? WHERE ${cacheFreshGuard}
           ON CONFLICT(key) DO UPDATE
           SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(getFreshnessSentinelCacheKey("yield-data"), sentinelValue, input.startSec, input.generationId),
  ];

  const results = await runWithOverloadRetry(() => db.batch(buildStatements()), 3, input.signal);
  let written = Number(results[0]?.meta?.changes ?? 0) > 0;
  let appliedByPriorAttempt = false;
  if (!written) {
    // "Network connection lost" is transport-ambiguous: the batch may have
    // committed before the retry replayed it. The replayed CAS then compares
    // equal and reports zero changes. If D1 already serves this exact
    // generation, the publication applied and must not be reported as skipped.
    const published = parsePublishedYieldPublicationMetadata(await getCache(db, "yield-rankings"));
    if (published?.generationId === input.generationId) {
      written = true;
      appliedByPriorAttempt = true;
    }
  }
  if (oversize) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "yield-publication-payload-oversize",
      job: "sync-yield-data",
      message: `Published yield payload is approaching D1's per-statement value cap (${largestPayloadChars} chars, warn above ${YIELD_PUBLICATION_PAYLOAD_OVERSIZE_CHARS})`,
      metadata: { generationId: input.generationId, written, largestPayloadChars },
    });
  }
  return {
    written,
    skippedBecauseNewer: !written,
    appliedByPriorAttempt,
    publicationStats: buildStats(written),
  };
}

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

/**
 * B23: a non-finite measurement serializes to `null`, and the row schema accepts
 * null only where "no measurement" is a meaningful value. `benchmarkRate` is
 * optional but *not* nullable, so one NaN there fails publish validation for the
 * whole generation — every row is skipped behind a generic
 * `schema-validation-failed`. Non-finite values are therefore named in the log
 * and either omitted or published as null, degrading the one row that lost its
 * measurement.
 */
function logNonFiniteBaseValue(field: string, rowId: string, disposition: string): void {
  logWorkerEventArgs(
    "handler",
    "warn",
    `[sync-yield-data] Non-finite ${field} on ${rowId}: ${disposition}`,
  );
}

function finiteBaseValue(value: number | null | undefined, field: string, rowId: string): number | null {
  if (value == null) return null;
  if (Number.isFinite(value)) return value;
  logNonFiniteBaseValue(field, rowId, "published as null");
  return null;
}

const YieldRankingSchema = YieldRankingsResponseSchema.shape.rankings.element;

export function hasFiniteCandidateValues(
  candidate: EvaluatedYieldSource,
  selected?: EvaluatedYieldSource,
  onInvalid?: (field: string) => void,
): boolean {
  const rowId = `${candidate.id}:${candidate.sourceKey}`;
  for (const [field, value] of [
    ["currentApy", candidate.currentApy],
    ["apy7d", candidate.apy7d],
    ["apy30d", candidate.apy30d],
  ] as const) {
    if (Number.isFinite(value)) continue;
    logNonFiniteBaseValue(field, rowId, "candidate rejected");
    onInvalid?.(field);
    return false;
  }
  if (
    selected &&
    candidate.sourceKey !== selected.sourceKey &&
    candidate.sourceTvlUsd != null &&
    !Number.isFinite(candidate.sourceTvlUsd)
  ) {
    logNonFiniteBaseValue("sourceTvlUsd", rowId, "candidate rejected");
    onInvalid?.("sourceTvlUsd");
    return false;
  }
  if (
    selected &&
    candidate.sourceKey !== selected.sourceKey &&
    !Number.isFinite(candidate.apy30d - selected.apy30d)
  ) {
    logNonFiniteBaseValue("apy30dDelta", rowId, "candidate rejected");
    onInvalid?.("apy30dDelta");
    return false;
  }
  return true;
}

function evaluatedSourceToRanking(
  source: EvaluatedYieldSource,
  provenance: Record<string, unknown> | null,
  publicationGenerationId?: string | null,
  publishedRank?: number,
  decisionLedger?: YieldPublicDecisionLedger | null,
) {
  const meta = TRACKED_META_BY_ID.get(source.id);
  const benchmarkRate = finiteBaseValue(source.benchmarkRate, "benchmarkRate", source.id);
  return {
    id: source.id,
    symbol: source.symbol,
    name: meta?.name ?? source.symbol,
    currentApy: source.currentApy,
    apy7d: source.apy7d,
    apy30d: source.apy30d,
    apyBase: finiteBaseValue(source.apyBase, "apyBase", source.id),
    apyReward: finiteBaseValue(source.apyReward, "apyReward", source.id),
    yieldSource: source.yieldSource,
    yieldSourceUrl: resolveYieldSourceUrl({
      stablecoinId: source.id,
      sourceKey: source.sourceKey,
      yieldSource: source.yieldSource,
    }),
    yieldType: source.yieldType,
    dataSource: source.dataSource,
    sourceTvlUsd: finiteBaseValue(source.sourceTvlUsd, "sourceTvlUsd", source.id),
    pharosYieldScore: finiteBaseValue(source.pharosYieldScore, "pharosYieldScore", source.id),
    pysNullReason: source.pysNullReason,
    safetyScore: source.safetyProvenance === "safety-snapshot-unavailable"
      ? null
      : finiteBaseValue(source.safetyScore, "safetyScore", source.id),
    safetyGrade: source.safetyGrade,
    safetyReason: source.safetyReason,
    yieldToRisk: finiteBaseValue(source.yieldToRisk, "yieldToRisk", source.id),
    excessYield: finiteBaseValue(source.excessYield, "excessYield", source.id),
    benchmarkKey: source.benchmarkKey,
    benchmarkLabel: source.benchmarkLabel,
    benchmarkCurrency: source.benchmarkCurrency,
    // Optional, not nullable: omitted rather than nulled when it is not a number.
    ...(benchmarkRate != null ? { benchmarkRate } : {}),
    benchmarkRecordDate: source.benchmarkRecordDate,
    benchmarkIsFallback: source.benchmarkIsFallback,
    benchmarkFallbackMode: source.benchmarkFallbackMode,
    benchmarkSelectionMode: source.benchmarkSelectionMode,
    benchmarkIsProxy: source.benchmarkIsProxy,
    yieldStability: finiteBaseValue(source.yieldStability, "yieldStability", source.id),
    apyVariance30d: finiteBaseValue(source.stdDev30d, "apyVariance30d", source.id),
    apyMin30d: finiteBaseValue(source.apyMin30d, "apyMin30d", source.id),
    apyMax30d: finiteBaseValue(source.apyMax30d, "apyMax30d", source.id),
    warningSignals: [...source.warnings],
    altSources: [] as AltYieldSource[],
    alternateSummary: undefined as YieldAlternateSummary | null | undefined,
    rankChangeAttribution: undefined as YieldRankChangeAttribution | null | undefined,
    sourceRisk: buildYieldSourceRisk({ source, provenance, isBest: true }),
    sourceRole: deriveYieldSourceRole(source, { isSelected: true }),
    ...(publicationGenerationId ? { publicationGenerationId } : {}),
    ...(publishedRank ? { publishedRank } : {}),
    ...(decisionLedger ? { decisionLedger } : {}),
    provenance: provenance
      ? {
          ...provenance,
          safetyProvenance: source.safetyProvenance,
          safetyReason: source.safetyReason,
          safetyScoreIdentity: source.safetyScoreIdentity ?? null,
          sourceFreshness: source.sourceFreshness,
          benchmarkFreshness: source.benchmarkFreshness,
          calculationMode: source.calculationMode,
          evidenceClass: source.evidenceClass,
          evidenceCompleteness: source.evidenceCompleteness,
          scoreQualification: source.scoreQualification,
          scoreQualified: source.scoreQualified,
        }
      : null,
  };
}

function buildAltYieldSource(params: {
  selected: EvaluatedYieldSource;
  candidate: EvaluatedYieldSource;
  provenance: Record<string, unknown> | null;
  selectionRank: number | undefined;
}): AltYieldSource {
  return {
    sourceKey: params.candidate.sourceKey,
    yieldSource: params.candidate.yieldSource,
    yieldSourceUrl: resolveYieldSourceUrl({
      stablecoinId: params.candidate.id,
      sourceKey: params.candidate.sourceKey,
      yieldSource: params.candidate.yieldSource,
    }),
    yieldType: params.candidate.yieldType as AltYieldSource["yieldType"],
    currentApy: params.candidate.currentApy,
    apy30d: params.candidate.apy30d,
    sourceTvlUsd: params.candidate.sourceTvlUsd,
    dataSource: params.candidate.dataSource,
    sourceRisk: buildYieldSourceRisk({
      source: params.candidate,
      provenance: params.provenance,
      isBest: false,
    }),
    sourceRole: deriveYieldSourceRole(params.candidate, { isSelected: false }),
    confidenceTier: params.candidate.confidenceTier,
    calculationMode: params.candidate.calculationMode,
    evidenceClass: params.candidate.evidenceClass,
    evidenceCompleteness: params.candidate.evidenceCompleteness,
    scoreQualification: params.candidate.scoreQualification,
    selectionRank: params.selectionRank,
    rejectionReasonCode: deriveRejectionReasonCode(params.selected, params.candidate),
  };
}

function buildAltSourcesForRanking(params: {
  selected: EvaluatedYieldSource;
  candidates: EvaluatedYieldSource[];
  rankingProvenanceByKey: Map<string, Record<string, unknown>>;
}): AltYieldSource[] {
  const selectionRankBySourceKey = buildSelectionRankBySourceKey(params.candidates);
  const alts: AltYieldSource[] = [];
  for (const candidate of buildUniqueAltCandidates(params.selected, params.candidates)) {
    const key = buildHistoryKey(candidate.id, candidate.sourceKey);
    const provenance = params.rankingProvenanceByKey.get(key) ?? null;
    alts.push(
      buildAltYieldSource({
        selected: params.selected,
        candidate,
        provenance,
        selectionRank: selectionRankBySourceKey.get(candidate.sourceKey),
      }),
    );
  }
  return alts;
}

function buildUniqueAltCandidates(
  selected: EvaluatedYieldSource,
  candidates: EvaluatedYieldSource[],
): EvaluatedYieldSource[] {
  const bySourceKey = new Map<string, EvaluatedYieldSource>();
  for (const candidate of candidates) {
    if (candidate.sourceKey === selected.sourceKey) {
      continue;
    }
    const existing = bySourceKey.get(candidate.sourceKey);
    if (!existing || candidate.currentApy > existing.currentApy) {
      bySourceKey.set(candidate.sourceKey, candidate);
    }
  }
  return [...bySourceKey.values()];
}

function toAlternateSourceSummary(
  selected: EvaluatedYieldSource,
  candidate: EvaluatedYieldSource,
): YieldAlternateSourceSummary {
  const sourceRiskPenalty = Number.isFinite(candidate.sourceRiskPenalty)
    ? candidate.sourceRiskPenalty
    : null;
  const riskAdjustedUtility = Number.isFinite(candidate.sourceRiskAdjustedUtility)
    ? candidate.sourceRiskAdjustedUtility
    : null;
  return {
    sourceKey: candidate.sourceKey,
    yieldSource: candidate.yieldSource,
    yieldType: candidate.yieldType,
    dataSource: candidate.dataSource,
    currentApy: candidate.currentApy,
    apy30d: candidate.apy30d,
    apy30dDelta: candidate.apy30d - selected.apy30d,
    sourceTvlUsd: candidate.sourceTvlUsd,
    confidenceTier: candidate.confidenceTier,
    sourceRole: deriveYieldSourceRole(candidate, { isSelected: false }),
    sourceRiskPenalty,
    riskAdjustedUtility,
  };
}

function buildAlternateSummary(
  selected: EvaluatedYieldSource,
  altCandidates: EvaluatedYieldSource[],
): YieldAlternateSummary | null {
  if (altCandidates.length === 0) return null;
  const bestAlternateByApy = [...altCandidates].sort((a, b) => {
    if (b.apy30d !== a.apy30d) return b.apy30d - a.apy30d;
    return compareCandidates(a, b);
  })[0];
  const bestRiskAdjustedAlternate = [...altCandidates].sort((a, b) => {
    const utilityDiff = b.sourceRiskAdjustedUtility - a.sourceRiskAdjustedUtility;
    if (utilityDiff !== 0) return utilityDiff;
    return compareCandidates(a, b);
  })[0];
  return {
    count: altCandidates.length,
    bestAlternateByApy: bestAlternateByApy
      ? toAlternateSourceSummary(selected, bestAlternateByApy)
      : null,
    bestRiskAdjustedAlternate: bestRiskAdjustedAlternate
      ? toAlternateSourceSummary(selected, bestRiskAdjustedAlternate)
      : null,
    alternateApySpread: bestAlternateByApy ? bestAlternateByApy.apy30d - selected.apy30d : null,
  };
}


/** Previous publication rows, loose because they are read back off the cache. */
export interface PreviousPublicationForAttribution {
  rankings: readonly unknown[];
  methodologyVersion?: string | null;
}

/**
 * A cached row is usable as an attribution baseline only when it carries the
 * three fields the served comparator reads; anything else would make the
 * baseline order (and so every reported rank delta) undefined.
 */
function toBaselineRow(value: unknown): YieldRanking | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<YieldRanking>;
  if (typeof row.id !== "string" || typeof row.name !== "string") return null;
  if (typeof row.currentApy !== "number" || !Number.isFinite(row.currentApy)) return null;
  return row as YieldRanking;
}

/** The published row fields publish-time attribution reads and writes. */
interface AttributableRankingRow {
  id: string;
  name: string;
  currentApy: number;
  pharosYieldScore: number | null;
  safetyScore: number | null;
  rankChangeAttribution?: YieldRankChangeAttribution | null;
}

/**
 * B7/B31: attribution used to exist only in the read path, so the cached
 * payload DEWS hydrates never carried it and both rank branches were dead. It
 * is built here instead, generation over generation: the baseline rank is the
 * previous publication re-ranked with the served comparator, the new rank is
 * this publication under the same comparator, and only a comparator-consistent
 * move is attributed.
 */
function attachRankChangeAttribution(
  rankings: AttributableRankingRow[],
  previous: PreviousPublicationForAttribution | null | undefined,
): void {
  if (previous == null) return;
  const baselineRows: YieldRanking[] = [];
  for (const row of previous.rankings) {
    const baselineRow = toBaselineRow(row);
    if (baselineRow) baselineRows.push(baselineRow);
  }
  if (baselineRows.length === 0) return;

  const previousRankById = buildYieldRankBaseline(baselineRows);
  const previousRowById = new Map(baselineRows.map((row) => [row.id, row]));
  const methodologyChanged =
    previous.methodologyVersion != null && previous.methodologyVersion !== YIELD_METHODOLOGY_VERSION;

  const liveRankById = new Map<string, number>();
  [...rankings]
    .sort((a, b) => compareYieldRankRows(a as unknown as YieldRanking, b as unknown as YieldRanking))
    .forEach((row, index) => liveRankById.set(row.id, index + 1));

  for (const ranking of rankings) {
    const originalRow = previousRowById.get(ranking.id);
    if (originalRow == null) continue;
    const attribution = buildYieldRankChangeAttribution({
      originalRow,
      hydratedRow: {
        ...(ranking as unknown as YieldRanking),
        liveRank: liveRankById.get(ranking.id) ?? null,
      },
      previousRank: previousRankById.get(ranking.id) ?? null,
      safetyChanged: (originalRow.safetyScore ?? null) !== (ranking.safetyScore ?? null),
      methodologyChanged,
      comparison: "publication",
    });
    if (!methodologyChanged && originalRow.publishedRank != null) {
      // Explicit null means measured unchanged; absent means no comparison.
      ranking.rankChangeAttribution = attribution;
    }
  }
}

/**
 * A2/E9: publish each registry entry with its own observation bound and the
 * observation age at publication time. Without them every consumer measures
 * every key against one fallback bound, which amber-tints a healthy 3-day-old
 * USD observation on the 5-day daily series — and would equally mask CAD's
 * monthly Bank rate (45d) drifting across a daily cadence.
 */
function publishBenchmarkRecordBounds(
  registry: YieldBenchmarkRegistry | undefined,
  publishedAtSec: number,
): YieldBenchmarkRegistry | undefined {
  if (registry == null) return undefined;
  return Object.fromEntries(
    YIELD_BENCHMARK_KEY_VALUES.map((key) => {
      const meta = registry[key];
      return [
        key,
        meta == null
          ? meta
          : {
            ...meta,
            maxFetchAgeSec: YIELD_BENCHMARK_SCORE_TTL_SEC,
            maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC[key],
            recordAgeSec: benchmarkRecordAgeSeconds(meta.recordDate, publishedAtSec),
          },
      ];
    }),
  ) as YieldBenchmarkRegistry;
}

export function buildYieldRankingsPayloadFromEvaluatedSources(
  input: {
    evaluatedSources: EvaluatedYieldSource[];
    publicationViews: Map<string, YieldCoinPublicationView>;
    rankingProvenanceByKey: Map<string, Record<string, unknown>>;
    riskFreeRate: number;
    riskFreeRateMeta: YieldBenchmarkMeta;
    riskFreeRateRegistry?: YieldBenchmarkRegistry;
    dlPoolsMeta: YieldSourceInputMeta;
    safetySnapshot: YieldSafetySnapshotMeta;
    medianApy: number | null;
    startSec: number;
    publication?: YieldPublicationMetadata | null;
    /**
     * Previous publication, as loaded from the `yield-rankings` cache. Present
     * only when the caller can supply it; without it the payload publishes no
     * rank-change attribution (B7/B31).
     */
    previousPublication?: PreviousPublicationForAttribution | null;
  },
) {
  // The publication views are the sole owner of the selection decision: each
  // view froze the winning source key when it was built, so rankings cannot
  // mix a different best-source map with the frozen decision evidence.
  const bestRows = input.evaluatedSources
    .filter((source) =>
      input.publicationViews.get(source.id)?.selected.sourceKey === source.sourceKey
    )
    .sort((a, b) =>
      (b.pharosYieldScore ?? Number.NEGATIVE_INFINITY) -
      (a.pharosYieldScore ?? Number.NEGATIVE_INFINITY)
    );
  const publicationGenerationId = input.publication?.generationId ?? null;
  const rankings: YieldRanking[] = [];
  for (const source of bestRows) {
    const key = buildHistoryKey(source.id, source.sourceKey);
    const provenance = input.rankingProvenanceByKey.get(key) ?? null;
    const view = input.publicationViews.get(source.id);
    if (view == null) {
      throw new Error(
        `yield-publication view missing for selected source ${source.id}:${source.sourceKey}`,
      );
    }
    const candidates = view.candidates;
    const previousCandidateRetained =
      view.previousBestSourceKey == null ||
      candidates.some((candidate) => candidate.sourceKey === view.previousBestSourceKey);
    const decisionLedger = buildPublicDecisionLedger({
      selected: source,
      candidates,
      rejectedCount: candidates.filter((candidate) => candidate.rejected).length,
      previousBestSourceKey: previousCandidateRetained ? view.previousBestSourceKey : null,
      sourceSwitch: previousCandidateRetained ? view.sourceSwitch : false,
      apy30dDeltaFromPrevious: previousCandidateRetained ? view.apy30dDeltaFromPrevious : null,
    });
    const ranking = evaluatedSourceToRanking(
      source,
      provenance,
      publicationGenerationId,
      rankings.length + 1,
      decisionLedger,
    );
    const altCandidates = buildUniqueAltCandidates(source, candidates);
    ranking.altSources = buildAltSourcesForRanking({
      selected: source,
      candidates,
      rankingProvenanceByKey: input.rankingProvenanceByKey,
    });
    const alternateSummary = buildAlternateSummary(source, altCandidates);
    if (alternateSummary) {
      ranking.alternateSummary = alternateSummary;
    }

    const sourceObservedAt =
      provenance != null && typeof provenance.sourceObservedAt === "number"
        ? provenance.sourceObservedAt
        : input.startSec;
    const updatedAtMs = sourceObservedAt * 1000;
    const staleThresholdMs = getRankingStaleThresholdMs(source.dataSource, source.sourceKey);
    const comparisonAnchorAgeSeconds =
      provenance != null && typeof provenance.comparisonAnchorAgeSeconds === "number"
        ? provenance.comparisonAnchorAgeSeconds
        : null;
    const staleComparisonAnchor =
      comparisonAnchorAgeSeconds != null &&
      comparisonAnchorAgeSeconds * 1000 > getComparisonAnchorStaleThresholdMs(source.dataSource, source.sourceKey);
    const staleSource =
      (updatedAtMs > 0 && updatedAtMs < input.startSec * 1000 - staleThresholdMs) ||
      staleComparisonAnchor;
    const benchmarkFreshness =
      source.benchmarkFreshness ??
      classifyYieldBenchmarkFreshness(source.benchmarkMeta, {
        recordDate: source.benchmarkMeta.recordDate,
        maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC[source.benchmarkKey],
      });
    if (staleSource) {
      if (!ranking.warningSignals.includes("data-stale")) {
        ranking.warningSignals = [...ranking.warningSignals, "data-stale"];
      }
      ranking.pharosYieldScore = null;
      ranking.pysNullReason = "source-stale";
    }
    if (benchmarkFreshness === "degraded" && !ranking.warningSignals.includes("benchmark-degraded")) {
      ranking.warningSignals = [...ranking.warningSignals, "benchmark-degraded"];
    }
    if (benchmarkFreshness === "stale") {
      if (!ranking.warningSignals.includes("benchmark-stale")) {
        ranking.warningSignals = [...ranking.warningSignals, "benchmark-stale"];
      }
      ranking.pharosYieldScore = null;
      ranking.pysNullReason = ranking.pysNullReason === "source-stale"
        ? ranking.pysNullReason
        : "benchmark-stale";
    }
    if (ranking.provenance) {
      const effectiveSourceFreshness = staleSource ? "stale" : (source.sourceFreshness ?? "unknown");
      const qualificationInvalidated = staleSource || benchmarkFreshness === "stale";
      const newlyMissingEvidenceFields =
        (staleSource && source.sourceFreshness === "fresh" ? 1 : 0) +
        (benchmarkFreshness === "stale" && source.benchmarkFreshness !== "stale" ? 1 : 0);
      ranking.provenance = {
        ...ranking.provenance,
        sourceFreshness: effectiveSourceFreshness,
        benchmarkFreshness,
        evidenceCompleteness: Math.max(
          0,
          Number(
            (source.evidenceCompleteness - newlyMissingEvidenceFields / EVIDENCE_FIELD_COUNT).toFixed(4),
          ),
        ),
        scoreQualification: qualificationInvalidated ? "NR" : source.scoreQualification,
        scoreQualified: ranking.pharosYieldScore != null,
      };
    }
    ranking.sourceRole = deriveYieldSourceRole(
      { ...source, warnings: ranking.warningSignals },
      { isSelected: true },
    );

    const validation = YieldRankingSchema.safeParse(ranking);
    if (!validation.success) {
      const paths = validation.error.issues.map((issue) => issue.path.join(".")).join(",");
      logWorkerEventArgs(
        "handler",
        "warn",
        `[sync-yield-data] Rejected invalid ranking ${source.id}:${source.sourceKey}: ${paths}`,
      );
      continue;
    }
    rankings.push(validation.data);
  }
  attachRankChangeAttribution(rankings, input.previousPublication);

  const benchmarks = publishBenchmarkRecordBounds(input.riskFreeRateRegistry, input.startSec);

  return {
    rankings,
    riskFreeRate: input.riskFreeRate,
    benchmarks,
    scalingFactor: PYS_SCALING_FACTOR,
    medianApy: input.medianApy,
    updatedAt: input.startSec,
    methodology: buildYieldMethodology(input.startSec),
    ...(input.publication ? { publication: input.publication } : {}),
    provenance: {
      selectionMethod: "confidence-weighted" as const,
      benchmark: {
        ...input.riskFreeRateMeta,
        maxFetchAgeSec: YIELD_BENCHMARK_SCORE_TTL_SEC,
        maxRecordAgeSec: YIELD_BENCHMARK_RECORD_MAX_AGE_SEC[input.riskFreeRateMeta.key ?? "USD"],
        recordAgeSec: benchmarkRecordAgeSeconds(input.riskFreeRateMeta.recordDate, input.startSec),
      },
      benchmarks,
      dlPools: input.dlPoolsMeta,
      safetySnapshot: input.safetySnapshot,
    },
  };
}

const MAX_SOURCE_DECISION_ALTERNATIVES = 4;
const MAX_SOURCE_DECISION_ANOMALIES = 6;
const MAX_SOURCE_DECISION_TEXT_LENGTH = 160;
const MAX_SOURCE_DECISION_ALTERNATIVES_JSON_BYTES = 4_096;

export interface PreviousYieldPublicationRanking {
  id?: unknown;
  dataSource?: unknown;
  provenance?: unknown;
}

export type PreviousYieldPublicationSnapshotStatus =
  | "missing"
  | "malformed-json"
  | "malformed-payload"
  | "ok";

export interface PreviousYieldPublicationSnapshot {
  status: PreviousYieldPublicationSnapshotStatus;
  rankings: readonly PreviousYieldPublicationRanking[];
  malformed: boolean;
  /**
   * B7/B31: `methodology.version` of the cached payload. Publish-time rank
   * attribution needs it to tell a genuine move from a methodology re-base.
   * Null when the cache predates the envelope or cannot be read.
   */
  methodologyVersion?: string | null;
}

/** `methodology.version` off a cached payload, when it is a usable string. */
function readCachedMethodologyVersion(methodology: unknown): string | null {
  if (methodology == null || typeof methodology !== "object" || Array.isArray(methodology)) return null;
  if (!("version" in methodology)) return null;
  const version = methodology.version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

export async function loadPreviousYieldPublicationSnapshot(
  db: D1Database,
): Promise<PreviousYieldPublicationSnapshot> {
  const previousCache = await getCache(db, "yield-rankings");
  const previousRankings = readCachedJson<{ rankings?: unknown; methodology?: unknown }>(
    "yield-sync",
    "yield-rankings",
    previousCache,
  );
  if (previousRankings.status === "missing") {
    return { status: "missing", rankings: [], malformed: false, methodologyVersion: null };
  }
  if (previousRankings.status === "malformed") {
    return { status: "malformed-json", rankings: [], malformed: true, methodologyVersion: null };
  }
  const data = previousRankings.data;
  if (data == null || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.rankings)) {
    return { status: "malformed-payload", rankings: [], malformed: true, methodologyVersion: null };
  }
  if (data.rankings.some((ranking) => ranking == null || typeof ranking !== "object" || Array.isArray(ranking))) {
    return { status: "malformed-payload", rankings: [], malformed: true, methodologyVersion: null };
  }
  return {
    status: "ok",
    rankings: data.rankings as PreviousYieldPublicationRanking[],
    malformed: false,
    methodologyVersion: readCachedMethodologyVersion(data.methodology),
  };
}

function countYieldRankings(
  rankings: readonly PreviousYieldPublicationRanking[],
  options?: { allowedIds?: Set<string> },
): { count: number; malformed: boolean } {
  const countedRankings = options?.allowedIds
    ? rankings.filter(
        (ranking) => typeof ranking.id === "string" && options.allowedIds?.has(ranking.id),
      )
    : rankings.filter((ranking) => typeof ranking.id === "string");
  return { count: countedRankings.length, malformed: false };
}

export function derivePreviousYieldRankingsCount(
  snapshot: PreviousYieldPublicationSnapshot,
  options?: { allowedIds?: Set<string>; allowMalformedRecovery?: boolean },
): { count: number; malformed: boolean } {
  if (snapshot.status === "missing") {
    return { count: 0, malformed: false };
  }
  if (snapshot.status === "malformed-json" || snapshot.status === "malformed-payload") {
    if (options?.allowedIds || options?.allowMalformedRecovery) {
      // Let the later schema and absolute-coverage publish guards decide whether
      // a valid replacement can recover a malformed public cache.
      return { count: 0, malformed: false };
    }
    return { count: 0, malformed: true };
  }
  return countYieldRankings(snapshot.rankings, options);
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

export async function validateYieldRankingsPayloadForPublish(
  rankingsPayload: unknown,
  previousYieldPublicationSnapshot: PreviousYieldPublicationSnapshot,
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

  const previousRankingsState = derivePreviousYieldRankingsCount(previousYieldPublicationSnapshot);
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

  return { ok: true, validationFailures: 0 };
}

export type YieldEvaluatedSourcesWriteResult =
  | {
      ok: false;
      updatedCount: number;
      validationFailures: number;
      reason?: string;
      cacheWrite?: YieldRowsWriteResult;
    }
  | {
      ok: true;
      updatedCount: number;
      validationFailures: number;
      cacheWrite: YieldRowsWriteResult;
    };

export async function persistEvaluatedYieldSources(
  db: D1Database,
  input: {
    signal?: AbortSignal;
    evaluatedSources: EvaluatedYieldSource[];
    anchorOnlySources?: ResolvedYieldEntry[];
    publicationViews: Map<string, YieldCoinPublicationView>;
    startSec: number;
    generationId: string;
    rankingsPayload: unknown;
    previousYieldPublicationSnapshot: PreviousYieldPublicationSnapshot;
  },
): Promise<YieldEvaluatedSourcesWriteResult> {
  const yieldDataRows: Array<Record<string, unknown>> = [];
  const historyRows: Array<Record<string, unknown>> = [];
  const decisionRows: Array<Record<string, unknown>> = [];
  const decisionAlternativeRows: Array<Record<string, unknown>> = [];

  // Seeds share the publication's existing atomic CAS fence but are not current
  // yield rows, selected sources, decision evidence or measured coverage.
  for (const entry of input.anchorOnlySources ?? []) {
    const seed = entry.yield;
    if (seed?.observationKind !== "anchor-only") continue;
    historyRows.push({
      stablecoin_id: entry.id,
      source_key: seed.sourceKey,
      observation_kind: "anchor-only",
      recorded_at: input.startSec,
      source_observed_at: seed.sourceObservedAt ?? null,
      is_best: 0,
      apy: 0,
      apy_base: null,
      apy_reward: null,
      exchange_rate: seed.exchangeRate,
      source_tvl_usd: seed.sourceTvlUsd,
      data_source: seed.dataSource,
      warning_signals: null,
      yield_source: seed.yieldSource ?? null,
      yield_type: seed.yieldType ?? null,
      publication_generation_id: input.generationId,
      publication_state: "published",
      pys_at_publish: null,
      safety_at_publish: null,
      variance_at_publish: null,
      pys_inputs_at_publish: null,
    });
  }

  for (const source of input.evaluatedSources) {
    // The publication views are the sole owner of the selection decision; the
    // is-best flag must agree with the frozen view, not a re-read map.
    const view = input.publicationViews.get(source.id);
    const isBest = view != null && view.selected.sourceKey === source.sourceKey ? 1 : 0;
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
      recorded_at: source.sourceKey === "protocol-api:zys-zephyr-protocol"
        && source.sourceObservedAt != null ? source.sourceObservedAt : input.startSec,
      source_observed_at: source.sourceObservedAt,
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
            schemaVersion: YIELD_PYS_INPUTS_AT_PUBLISH_SCHEMA_VERSION,
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
            // The v8.43 hurdle re-base is unrecoverable from the rest of the
            // snapshot: the governing USD rate lives only in the payload's
            // `riskFreeRate`, so a replay without it drifts on every non-USD row.
            ...(source.usdBenchmarkRate != null && Number.isFinite(source.usdBenchmarkRate)
              ? { usdBenchmarkRate: source.usdBenchmarkRate }
              : {}),
            ...(Number.isFinite(source.hurdleRebase) ? { hurdleRebase: source.hurdleRebase } : {}),
          }),
    });

    if (view != null && isBest === 1) {
      const retention = classifyDecisionRetention({
        sourceSwitch: view.sourceSwitch,
        source,
        candidates: view.candidates,
      });
      decisionRows.push({
        generation_id: input.generationId,
        stablecoin_id: source.id,
        selected_source_key: source.sourceKey,
        selected_confidence_tier: source.confidenceTier,
        selected_data_source: source.dataSource,
        selected_apy_30d: source.apy30d,
        selected_score: source.pharosYieldScore,
        selected_reason: view.selectedReason,
        previous_best_source_key: view.previousBestSourceKey,
        source_switch: view.sourceSwitch ? 1 : 0,
        rejected_count: view.rejectedCount,
        alternatives_json: serializeBoundedDecisionAlternatives(source, view.candidates),
        created_at: input.startSec,
        retention_reason: retention.retentionReason,
        trend_fingerprint: retention.trendFingerprint,
      });

      for (const alternative of view.decisionLedger.alternatives) {
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

  const publishability = await validateYieldRankingsPayloadForPublish(
    input.rankingsPayload,
    input.previousYieldPublicationSnapshot,
  );
  if (!publishability.ok) {
    return {
      ok: false,
      updatedCount: 0,
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
      validationFailures: 0,
      reason: "cache-write-skipped-newer",
      cacheWrite,
    };
  }

  return {
    ok: true,
    updatedCount: input.evaluatedSources.length,
    validationFailures: publishability.validationFailures,
    cacheWrite,
  };
}

function getD1FailureReason(prefix: string, error: unknown): string {
  const message = toErrorMessage(error);
  return message ? `${prefix}:${message.slice(0, 120)}` : prefix;
}

export function buildPreviewYieldRankingsArtifacts(params: {
  evaluatedSources: EvaluatedYieldSource[];
  bestSourceKeyByCoin: Map<string, string>;
  riskFreeRate: number;
  riskFreeRateMeta: YieldBenchmarkMeta;
  riskFreeRates: ParsedYieldBenchmarkRegistry;
  dlPoolsMeta: YieldSourceInputMeta;
  safetySnapshot: Parameters<typeof buildYieldRankingsPayloadFromEvaluatedSources>[0]["safetySnapshot"];
  medianApy: number | null;
  startSec: number;
  /**
   * B7/B31: previous publication, so the preview payload carries publish-time
   * rank-change attribution (`rankChangeAttribution`). Absent → no attribution.
   */
  previousPublication?: PreviousPublicationForAttribution | null;
}): {
  previewRankingsPayload: ReturnType<typeof buildYieldRankingsPayloadFromEvaluatedSources>;
  publicationViews: Map<string, YieldCoinPublicationView>;
  acceptedSources: EvaluatedYieldSource[];
  quarantineReasons: string[];
} {
  const selectedByCoin = new Map(params.evaluatedSources
    .filter((source) => params.bestSourceKeyByCoin.get(source.id) === source.sourceKey)
    .map((source) => [source.id, source]));
  const quarantineReasons: string[] = [];
  const acceptedSources = params.evaluatedSources.filter((source) =>
    hasFiniteCandidateValues(source, selectedByCoin.get(source.id), (field) => {
      quarantineReasons.push(`yield-publication:quarantined-source:${source.id}:${field}`);
    }),
  );
  const { provenanceByKey, viewsByCoinId } = buildYieldPublicationViews({
    evaluatedSources: acceptedSources,
    bestSourceKeyByCoin: params.bestSourceKeyByCoin,
    startSec: params.startSec,
    dlPoolsMeta: params.dlPoolsMeta,
  });

  return {
    acceptedSources,
    quarantineReasons,
    publicationViews: viewsByCoinId,
    previewRankingsPayload: buildYieldRankingsPayloadFromEvaluatedSources({
      evaluatedSources: acceptedSources,
      publicationViews: viewsByCoinId,
      rankingProvenanceByKey: provenanceByKey,
      riskFreeRate: params.riskFreeRate,
      riskFreeRateMeta: params.riskFreeRateMeta,
      riskFreeRateRegistry: toYieldBenchmarkRegistry(params.riskFreeRates),
      dlPoolsMeta: params.dlPoolsMeta,
      safetySnapshot: params.safetySnapshot,
      medianApy: params.medianApy,
      startSec: params.startSec,
      previousPublication: params.previousPublication,
    }),
  };
}

export async function publishYieldCoordinatorResults(params: {
  db: D1Database;
  signal?: AbortSignal;
  previewRankingsPayload: ReturnType<typeof buildYieldRankingsPayloadFromEvaluatedSources>;
  evaluatedSources: EvaluatedYieldSource[];
  anchorOnlySources?: ResolvedYieldEntry[];
  publicationViews: Map<string, YieldCoinPublicationView>;
  startSec: number;
  degradationReasons: string[];
  safetySnapshotHeld: boolean;
  resolvedCount: number;
  rowsRejected: number;
  divergenceFlags: number;
  sourceSwitches: number;
  previousYieldPublicationSnapshot: PreviousYieldPublicationSnapshot;
}): Promise<
  | { ok: false; result: CronResult }
  | {
      ok: true;
      /** This attempt's generation, including a failed/CAS-skipped candidate; not publication proof. */
      generationId: string;
      updatedCount: number;
      degradationReasons: string[];
      validationFailures: number;
      cacheWriteSkipped: boolean;
      casSkipped: boolean;
      /** Why the atomic write did not apply, when it did not. */
      skipReason: string | null;
      publicationStats: YieldRowsWriteStats | null;
    }
> {
  throwIfAborted(params.signal);
  const generationId = buildYieldPublicationGenerationId(params.startSec);
  let generationFinalized = false;
  let publicationApplied = false;
  const finalizeFailedGeneration = async (reason: string): Promise<void> => {
    generationFinalized = true;
    await finalizeYieldPublicationGeneration(params.db, {
      generationId,
      state: "failed",
      timestamp: params.startSec,
      reason,
    });
  };
  const stagedRankingsPayload = attachYieldPublicationMetadata(params.previewRankingsPayload, {
    generationId,
    startSec: params.startSec,
    status: "staged",
  });
  await stageYieldPublicationGeneration(params.db, {
    generationId,
    startSec: params.startSec,
    rankingCount: params.previewRankingsPayload.rankings.length,
    sourceRowCount: params.evaluatedSources.length,
    // Views own the selection: one per coin with a selected best row.
    // Equivalent to the construction-time bestSourceKeyByCoin.size because
    // evaluation only records winners drawn from the evaluated rows.
    bestRowCount: params.publicationViews.size,
    rowsRejected: params.rowsRejected,
    divergenceFlags: params.divergenceFlags,
    sourceSwitches: params.sourceSwitches,
  });

  // Every exit from here must leave the generation in a terminal state: a
  // generation left `staged` reads as a live candidate on the publication
  // surface, so an abort mid-publication has to mark it failed (C11).
  try {
    throwIfAborted(params.signal);
    const previewPublishability = await validateYieldRankingsPayloadForPublish(
      stagedRankingsPayload,
      params.previousYieldPublicationSnapshot,
    );
    if (!previewPublishability.ok) {
      params.degradationReasons.push(previewPublishability.reason ?? "schema-validation-failed");
      await finalizeFailedGeneration(previewPublishability.reason ?? "schema-validation-failed");
      return {
        ok: false,
        result: createCronResult({
          status: "degraded",
          itemCount: params.resolvedCount,
          metadata: {
            reason: "yield-rankings-preflight-failed",
            publishFailure: previewPublishability.reason ?? "schema-validation-failed",
            validationFailures: previewPublishability.validationFailures,
            rowsRejected: params.rowsRejected,
            divergenceFlags: params.divergenceFlags,
            sourceSwitches: params.sourceSwitches,
          },
        }),
      };
    }

    let updatedCount = 0;
    const publishedRankingsPayload = attachYieldPublicationMetadata(params.previewRankingsPayload, {
      generationId,
      startSec: params.startSec,
      status: "published",
    });
    let publicationWrite: YieldEvaluatedSourcesWriteResult;
    try {
      throwIfAborted(params.signal);
      publicationWrite = await persistEvaluatedYieldSources(params.db, {
        signal: params.signal,
        evaluatedSources: params.evaluatedSources,
        anchorOnlySources: params.anchorOnlySources,
        publicationViews: params.publicationViews,
        startSec: params.startSec,
        generationId,
        rankingsPayload: publishedRankingsPayload,
        previousYieldPublicationSnapshot: params.previousYieldPublicationSnapshot,
      });
    } catch (error) {
      rethrowIfAborted(error, params.signal);
      const reason = getD1FailureReason("yield-publication-transaction-failed", error);
      params.degradationReasons.push(reason);
      await finalizeFailedGeneration(reason).catch((finalizeError: unknown) => {
        logWorkerEventArgs("handler", "warn", "[sync-yield-data] Failed to mark yield generation failed after publication transaction failure:", finalizeError);
      });
      return {
        ok: false,
        result: createCronResult({
          status: "degraded",
          itemCount: params.resolvedCount,
          metadata: {
            reason: "yield-publication-transaction-failed",
            publishFailure: reason,
            validationFailures: 0,
            rowsRejected: params.rowsRejected,
            divergenceFlags: params.divergenceFlags,
            sourceSwitches: params.sourceSwitches,
          },
        }),
      };
    }
    if (!publicationWrite.ok) {
      const reason = publicationWrite.reason ?? "schema-validation-failed";
      params.degradationReasons.push(reason);
      await finalizeFailedGeneration(reason);
      return {
        ok: true,
        generationId,
        updatedCount,
        degradationReasons: params.degradationReasons,
        validationFailures: publicationWrite.validationFailures,
        cacheWriteSkipped: true,
        casSkipped: publicationWrite.cacheWrite?.skippedBecauseNewer === true,
        skipReason: reason,
        publicationStats: publicationWrite.cacheWrite?.publicationStats ?? null,
      };
    }

    updatedCount = publicationWrite.updatedCount;
    publicationApplied = true;
    const publicationStats = publicationWrite.cacheWrite.publicationStats;
    if (publicationStats?.oversize) {
      params.degradationReasons.push("yield-publication:payload-oversize");
    }
    throwIfAborted(params.signal);
    await pruneYieldTables(params.db, params.startSec, {
      allowDestructiveCleanup: params.degradationReasons.length === 0 && !params.safetySnapshotHeld,
      signal: params.signal,
    });

    return {
      ok: true,
      generationId,
      updatedCount,
      degradationReasons: params.degradationReasons,
      validationFailures: publicationWrite.validationFailures,
      cacheWriteSkipped: false,
      casSkipped: publicationWrite.cacheWrite.skippedBecauseNewer,
      skipReason: null,
      publicationStats,
    };
  } catch (error) {
    if (!publicationApplied && !generationFinalized) {
      const reason = params.signal?.aborted ? "aborted" : getD1FailureReason("yield-publication-failed", error);
      await finalizeFailedGeneration(reason).catch((finalizeError: unknown) => {
        logWorkerEventArgs("handler", "warn", "[sync-yield-data] Failed to mark yield generation failed after an aborted publication step:", finalizeError);
      });
    }
    throw error;
  }
}
