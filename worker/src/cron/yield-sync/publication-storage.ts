import {
  getCache,
  type CacheWriteResult,
} from "../../lib/db-cache";
import {
  logWorkerEvent,
} from "../../lib/structured-log";
import {
  runWithOverloadRetry,
} from "../../lib/d1-overload-retry";
import {
  getFreshnessSentinelCacheKey,
  getFreshnessSentinelProducerJob,
} from "../../lib/freshness-sentinels";
import {
  YIELD_D1_IDLE_RATIO,
} from "./history-repository";
import {
  sleepWithSignal,
} from "../../lib/abort";
import {
  parsePublishedYieldPublicationMetadata,
} from "./publication-generation";

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

  let batchMs = 0;
  const results = await runWithOverloadRetry(async () => {
    const attemptStartedMs = Date.now();
    const batch = await db.batch(buildStatements());
    batchMs = Date.now() - attemptStartedMs;
    return batch;
  }, 3, input.signal, { waitOutResourceWindow: true });
  // The atomic batch writes every history row across all its indexes in one
  // burst; the prune and terminal accounting that follow must not land in the
  // same spent D1 window (2026-11-04 16:56Z). The batch has committed, so an
  // abort must not turn this idle into a misreported failed publication.
  await sleepWithSignal(Math.round(batchMs * YIELD_D1_IDLE_RATIO));
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
