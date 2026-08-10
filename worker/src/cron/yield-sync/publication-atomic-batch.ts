import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { isMissingColumnError, isMissingTableError } from "../../lib/db";
import type { CacheWriteResult } from "../../lib/db-cache";

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
): Promise<CacheWriteResult> {
  const cacheValue = JSON.stringify(input.rankingsPayload);
  const cacheFreshGuard = "(SELECT updated_at FROM cache WHERE key = 'yield-rankings') = ?";
  const buildStatements = (legacySchema: boolean, reproducibleHistory: boolean): D1PreparedStatement[] => [
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
      .bind(JSON.stringify(input.yieldDataRows), input.startSec),
    db
      .prepare(
        legacySchema
          ? `INSERT OR IGNORE INTO yield_history (
              stablecoin_id, source_key, recorded_at, is_best, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd,
              data_source, warning_signals, yield_source, yield_type, publication_generation_id, publication_state
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
              json_extract(value, '$.publication_state')
            FROM json_each(?)
            WHERE ${cacheFreshGuard}`
          : `INSERT OR IGNORE INTO yield_history (
              stablecoin_id, source_key, recorded_at, is_best, apy, apy_base, apy_reward, exchange_rate, source_tvl_usd,
              data_source, warning_signals, yield_source, yield_type, publication_generation_id, publication_state,
              pys_at_publish, safety_at_publish, variance_at_publish${reproducibleHistory ? ", pys_inputs_at_publish" : ""}
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
              json_extract(value, '$.variance_at_publish')${reproducibleHistory ? ",\n              json_extract(value, '$.pys_inputs_at_publish')" : ""}
            FROM json_each(?)
            WHERE ${cacheFreshGuard}`,
      )
      .bind(JSON.stringify(input.historyRows), input.startSec),
    db
      .prepare(
        legacySchema
          ? `INSERT OR REPLACE INTO yield_source_decisions (
              generation_id, stablecoin_id, selected_source_key, selected_confidence_tier,
              selected_data_source, selected_apy_30d, selected_score, selected_reason,
              previous_best_source_key, source_switch, rejected_count, alternatives_json, created_at
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
              json_extract(value, '$.created_at')
            FROM json_each(?)
            WHERE ${cacheFreshGuard}`
          : `INSERT OR REPLACE INTO yield_source_decisions (
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
      .bind(JSON.stringify(input.decisionRows), input.startSec),
    ...(legacySchema
      ? []
      : [
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
            .bind(JSON.stringify(input.decisionAlternativeRows), input.startSec),
        ]),
    db
      .prepare(
        `UPDATE yield_publication_generations
           SET state = 'published', published_at = ?, failed_at = NULL, failure_reason = NULL
           WHERE generation_id = ?
             AND ${cacheFreshGuard}`,
      )
      .bind(input.startSec, input.generationId, input.startSec),
  ];

  let results: D1Result<unknown>[];
  try {
    results = await runWithOverloadRetry(() => db.batch(buildStatements(false, true)), 3, input.signal);
  } catch (error) {
    if (!isMissingColumnError(error) && !isMissingTableError(error)) throw error;
    try {
      results = await runWithOverloadRetry(() => db.batch(buildStatements(false, false)), 3, input.signal);
    } catch (fallbackError) {
      if (!isMissingColumnError(fallbackError) && !isMissingTableError(fallbackError)) throw fallbackError;
      results = await runWithOverloadRetry(() => db.batch(buildStatements(true, false)), 3, input.signal);
    }
  }

  return Number(results[0]?.meta?.changes ?? 0) > 0
    ? { written: true, skippedBecauseNewer: false }
    : { written: false, skippedBecauseNewer: true };
}
