import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import type { CacheWriteResult } from "../../lib/db-cache";
import { logWorkerEvent } from "../../lib/structured-log";

/**
 * D1 rejects a statement whose bound value exceeds 2,000,000 bytes, and the
 * published generation is one batch: crossing the cap fails every statement in
 * it. The published cache value is the largest bound payload (~800 KB at 157
 * rows), so the guard warns at 1.2M characters — measured in UTF-16 code units,
 * which under-counts multi-byte characters by a few percent and still leaves
 * >600 KB of headroom before the hard cap.
 */
export const YIELD_PUBLICATION_PAYLOAD_OVERSIZE_CHARS = 1_200_000;

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

export type YieldRowsWriteResult = CacheWriteResult & { publicationStats: YieldRowsWriteStats };

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
  const largestPayloadChars = Math.max(
    cacheValue.length,
    yieldDataRowsJson.length,
    historyRowsJson.length,
    decisionRowsJson.length,
    decisionAlternativeRowsJson.length,
  );
  const oversize = largestPayloadChars > YIELD_PUBLICATION_PAYLOAD_OVERSIZE_CHARS;
  // The replay-evidence column is null exactly for rows whose safety evidence
  // was unavailable, so its null rate is the run's evidence-loss signal. A
  // skipped write persists nothing and reports zero for both counters.
  let pysInputsPersistedCount = 0;
  for (const row of input.historyRows) {
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
    pysInputsNullCount: written ? input.historyRows.length - pysInputsPersistedCount : 0,
  });
  const cacheFreshGuard = "(SELECT updated_at FROM cache WHERE key = 'yield-rankings') = ?";
  const buildStatements = (): D1PreparedStatement[] => [
    db
      .prepare(
        `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
           WHERE cache.updated_at <= excluded.updated_at`,
      )
      .bind("yield-rankings", cacheValue, input.startSec),
    db
      .prepare(
        `INSERT OR REPLACE INTO yield_data (
            stablecoin_id, source_key, symbol, current_apy, apy_base, apy_reward, apy_7d, apy_30d,
            yield_source, yield_type, source_pool, source_tvl_usd, data_source,
            safety_score, safety_grade, pharos_yield_score, yield_to_risk, excess_yield, yield_stability,
            apy_variance_30d, apy_min_30d, apy_max_30d, exchange_rate, exchange_rate_prev, warning_signals, is_best,
            updated_at, publication_generation_id, publication_state
          )
          SELECT
            json_extract(value, '$.stablecoin_id'),
            json_extract(value, '$.source_key'),
            json_extract(value, '$.symbol'),
            json_extract(value, '$.current_apy'),
            json_extract(value, '$.apy_base'),
            json_extract(value, '$.apy_reward'),
            json_extract(value, '$.apy_7d'),
            json_extract(value, '$.apy_30d'),
            json_extract(value, '$.yield_source'),
            json_extract(value, '$.yield_type'),
            json_extract(value, '$.source_pool'),
            json_extract(value, '$.source_tvl_usd'),
            json_extract(value, '$.data_source'),
            json_extract(value, '$.safety_score'),
            json_extract(value, '$.safety_grade'),
            json_extract(value, '$.pharos_yield_score'),
            json_extract(value, '$.yield_to_risk'),
            json_extract(value, '$.excess_yield'),
            json_extract(value, '$.yield_stability'),
            json_extract(value, '$.apy_variance_30d'),
            json_extract(value, '$.apy_min_30d'),
            json_extract(value, '$.apy_max_30d'),
            json_extract(value, '$.exchange_rate'),
            json_extract(value, '$.exchange_rate_prev'),
            json_extract(value, '$.warning_signals'),
            json_extract(value, '$.is_best'),
            json_extract(value, '$.updated_at'),
            json_extract(value, '$.publication_generation_id'),
            json_extract(value, '$.publication_state')
          FROM json_each(?)
          WHERE ${cacheFreshGuard}`,
      )
      .bind(yieldDataRowsJson, input.startSec),
    db
      .prepare(
        `INSERT OR IGNORE INTO yield_history (
              stablecoin_id, source_key, recorded_at, is_best, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd,
              data_source, warning_signals, yield_source, yield_type, publication_generation_id, publication_state,
              pys_at_publish, safety_at_publish, variance_at_publish, pys_inputs_at_publish
            )
            SELECT
              json_extract(value, '$.stablecoin_id'),
              json_extract(value, '$.source_key'),
              json_extract(value, '$.recorded_at'),
              json_extract(value, '$.is_best'),
              json_extract(value, '$.apy'),
              json_extract(value, '$.apy_base'),
              json_extract(value, '$.apy_reward'),
              json_extract(value, '$.exchange_rate'),
              json_extract(value, '$.source_tvl_usd'),
              json_extract(value, '$.data_source'),
              json_extract(value, '$.warning_signals'),
              json_extract(value, '$.yield_source'),
              json_extract(value, '$.yield_type'),
              json_extract(value, '$.publication_generation_id'),
              json_extract(value, '$.publication_state'),
              json_extract(value, '$.pys_at_publish'),
              json_extract(value, '$.safety_at_publish'),
              json_extract(value, '$.variance_at_publish'),
              json_extract(value, '$.pys_inputs_at_publish')
            FROM json_each(?)
            WHERE ${cacheFreshGuard}`,
      )
      .bind(historyRowsJson, input.startSec),
    db
      .prepare(
        `INSERT OR REPLACE INTO yield_source_decisions (
              generation_id, stablecoin_id, selected_source_key, selected_confidence_tier,
              selected_data_source, selected_apy_30d, selected_score, selected_reason,
              previous_best_source_key, source_switch, rejected_count, alternatives_json, created_at,
              retention_reason, trend_fingerprint
            )
            SELECT
              json_extract(value, '$.generation_id'),
              json_extract(value, '$.stablecoin_id'),
              json_extract(value, '$.selected_source_key'),
              json_extract(value, '$.selected_confidence_tier'),
              json_extract(value, '$.selected_data_source'),
              json_extract(value, '$.selected_apy_30d'),
              json_extract(value, '$.selected_score'),
              json_extract(value, '$.selected_reason'),
              json_extract(value, '$.previous_best_source_key'),
              json_extract(value, '$.source_switch'),
              json_extract(value, '$.rejected_count'),
              json_extract(value, '$.alternatives_json'),
              json_extract(value, '$.created_at'),
              CASE
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
              END,
              json_extract(value, '$.trend_fingerprint')
            FROM json_each(?)
            WHERE ${cacheFreshGuard}`,
      )
      .bind(decisionRowsJson, input.startSec),
    db
      .prepare(
              `INSERT OR REPLACE INTO yield_source_decision_alternatives (
                generation_id, stablecoin_id, alt_source_key, alt_yield_source,
                alt_apy30d_delta, rejection_reason_code, recorded_at
              )
              SELECT
                json_extract(value, '$.generation_id'),
                json_extract(value, '$.stablecoin_id'),
                json_extract(value, '$.alt_source_key'),
                json_extract(value, '$.alt_yield_source'),
                json_extract(value, '$.alt_apy30d_delta'),
                json_extract(value, '$.rejection_reason_code'),
                json_extract(value, '$.recorded_at')
              FROM json_each(?)
              WHERE ${cacheFreshGuard}`,
      )
      .bind(decisionAlternativeRowsJson, input.startSec),
    db
      .prepare(
        `UPDATE yield_publication_generations
           SET state = 'published', published_at = ?, failed_at = NULL, failure_reason = NULL
           WHERE generation_id = ?
             AND ${cacheFreshGuard}`,
      )
      .bind(input.startSec, input.generationId, input.startSec),
  ];

  const results = await runWithOverloadRetry(() => db.batch(buildStatements()), 3, input.signal);
  const written = Number(results[0]?.meta?.changes ?? 0) > 0;
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
  return { written, skippedBecauseNewer: !written, publicationStats: buildStats(written) };
}
