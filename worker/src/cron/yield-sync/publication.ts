import { DAY_SECONDS, HOUR_SECONDS } from "@shared/lib/time-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { ACTIVE_STABLECOINS, FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { YIELD_HISTORY_MAX_DAYS, YIELD_HISTORY_RAW_DAYS } from "@shared/lib/yield-history-policy";
import { deleteOrphanYieldRows, deleteStaleYieldRows, purgeYieldHistoryOwnershipHandoffs } from "./history";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { logWorkerEvent } from "../../lib/structured-log";

export {
  derivePreviousYieldRankingsCount,
  loadPreviousYieldPublicationSnapshot,
  persistEvaluatedYieldSources,
  validateYieldRankingsPayloadForPublish,
} from "./publication-decision-persistence";
export type {
  PreviousYieldPublicationRanking,
  PreviousYieldPublicationSnapshot,
  PreviousYieldPublicationSnapshotStatus,
} from "./publication-decision-persistence";
export {
  attachYieldPublicationMetadata,
  buildYieldPublicationGenerationId,
  finalizeYieldPublicationGeneration,
  repairPublishedYieldGenerationFromCache,
  stageYieldPublicationGeneration,
} from "./publication-lifecycle";
export { buildYieldRankingsPayloadFromEvaluatedSources } from "./publication-ranking-payload";
export { buildYieldPublicationViews } from "./publication-view";
export type {
  YieldCoinPublicationView,
  YieldPublicationViews,
} from "./publication-view";

/** Days to retain audit-only yield_source_decisions rows. Trend-tagged rows
 *  (source switches, anomalies, rejected higher-confidence sources) are
 *  preserved beyond this window for long-running analytics. */
const AUDIT_DECISION_RETENTION_DAYS = 30;

const DECISION_RETENTION_DELETE_PREDICATE = `(
             retention_reason = 'audit'
             OR (
               retention_reason IS NULL
               AND COALESCE(source_switch, 0) != 1
               AND NOT EXISTS (
                 SELECT 1
                 FROM json_each(
                   CASE
                     WHEN json_valid(yield_source_decisions.alternatives_json)
                     THEN yield_source_decisions.alternatives_json
                     ELSE '[]'
                   END
                 ) AS alternative
                 WHERE CASE
                   WHEN json_valid(alternative.value) AND json_type(alternative.value, '$.anomalies') = 'array'
                   THEN COALESCE(json_array_length(json_extract(alternative.value, '$.anomalies')), 0)
                   ELSE 0
                 END > 0
                   OR (
                     json_valid(alternative.value)
                     AND
                     json_extract(alternative.value, '$.rejected') = 1
                     AND CASE json_extract(alternative.value, '$.confidenceTier')
                       WHEN 'deterministic' THEN 4
                       WHEN 'curated' THEN 3
                       WHEN 'discovered' THEN 2
                       ELSE 1
                     END > CASE selected_confidence_tier
                       WHEN 'deterministic' THEN 4
                       WHEN 'curated' THEN 3
                       WHEN 'discovered' THEN 2
                       ELSE 1
                     END
                   )
               )
             )
           )`;
/**
 * Keep a 90-day completed-generation history for operational incident review.
 * publication-contract.ts only reads the newest attempted, published, and
 * failed generations (and derives candidate age from the newest attempt); the
 * prune protects those rows explicitly, including the current staged/published
 * generation, so this window does not change the contract's lookback.
 */
const YIELD_PUBLICATION_GENERATION_RETENTION_DAYS = 90;

export async function materializeYieldHistoryDaily(
  db: D1Database,
  startSec: number,
): Promise<number> {
  const snapshotDate = bucketUnixSecondsToUtcDay(startSec - (YIELD_HISTORY_RAW_DAYS + 1) * DAY_SECONDS);
  const result = await db
    .prepare(
      `/* pharos:yield-sync:daily-history-materialize */
       INSERT INTO yield_history_daily (
         stablecoin_id, source_key, snapshot_date, recorded_at, is_best,
         apy, apy_base, apy_reward, exchange_rate, source_tvl_usd,
         data_source, warning_signals, yield_source, yield_type,
         publication_generation_id, publication_state, pys_at_publish,
         safety_at_publish, variance_at_publish, pys_inputs_at_publish
       )
       SELECT stablecoin_id, source_key, ?, recorded_at, is_best,
              apy, apy_base, apy_reward, exchange_rate, source_tvl_usd,
              data_source, warning_signals, yield_source, yield_type,
              publication_generation_id, publication_state, pys_at_publish,
              safety_at_publish, variance_at_publish, pys_inputs_at_publish
         FROM (
           SELECT h.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY h.stablecoin_id, h.source_key
                    ORDER BY h.recorded_at DESC, h.rowid DESC
                  ) AS row_rank
             FROM yield_history h
            WHERE h.recorded_at >= ?
              AND h.recorded_at < ?
              AND (h.publication_state IS NULL OR h.publication_state = 'published')
         ) ranked
        WHERE row_rank = 1
       ON CONFLICT(stablecoin_id, source_key, snapshot_date) DO UPDATE SET
         recorded_at = excluded.recorded_at,
         is_best = excluded.is_best,
         apy = excluded.apy,
         apy_base = excluded.apy_base,
         apy_reward = excluded.apy_reward,
         exchange_rate = excluded.exchange_rate,
         source_tvl_usd = excluded.source_tvl_usd,
         data_source = excluded.data_source,
         warning_signals = excluded.warning_signals,
         yield_source = excluded.yield_source,
         yield_type = excluded.yield_type,
         publication_generation_id = excluded.publication_generation_id,
         publication_state = excluded.publication_state,
         pys_at_publish = excluded.pys_at_publish,
         safety_at_publish = excluded.safety_at_publish,
         variance_at_publish = excluded.variance_at_publish,
         pys_inputs_at_publish = excluded.pys_inputs_at_publish
       WHERE excluded.recorded_at > yield_history_daily.recorded_at`,
    )
    .bind(snapshotDate, snapshotDate, snapshotDate + DAY_SECONDS)
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * Reclassify the historical linked-variant false-switch pattern only after the
 * same coin has published the linked identity cleanly in two consecutive
 * generations. This prevents a one-off winner change from rewriting evidence.
 */
export async function cleanupFalseLinkedVariantSourceSwitches(
  db: D1Database,
  startSec = 0,
): Promise<number> {
  const result = await db
    .prepare(
        `WITH ranked_linked_generations AS (
           SELECT d.stablecoin_id, d.generation_id, d.source_switch,
                  ROW_NUMBER() OVER (
                    PARTITION BY d.stablecoin_id
                    ORDER BY d.created_at DESC, d.generation_id DESC
                  ) AS generation_rank
             FROM yield_source_decisions d
             JOIN yield_publication_generations g
               ON g.generation_id = d.generation_id
              AND g.state = 'published'
            WHERE d.selected_source_key LIKE 'linked-variant:%'
              AND d.created_at >= ?
         ), verified_clean_identities AS (
           SELECT stablecoin_id
             FROM ranked_linked_generations
            WHERE generation_rank <= 2
            GROUP BY stablecoin_id
           HAVING COUNT(*) = 2
              AND SUM(CASE WHEN source_switch = 0 THEN 1 ELSE 0 END) = 2
         )
         UPDATE yield_source_decisions
            SET source_switch = 0,
                retention_reason = 'audit'
          WHERE source_switch = 1
            AND selected_source_key LIKE 'linked-variant:%'
            AND previous_best_source_key = 'onchain:' || stablecoin_id
            AND stablecoin_id IN (SELECT stablecoin_id FROM verified_clean_identities)`,
    )
    .bind(startSec - 7 * DAY_SECONDS)
    .run();
  return result.meta?.changes ?? 0;
}

export async function pruneYieldTables(
  db: D1Database,
  startSec: number,
  options?: {
    allowDestructiveCleanup?: boolean;
    signal?: AbortSignal;
  },
): Promise<void> {
  // Cleanup is idempotent; retry transient overload without replaying publication.
  await runWithOverloadRetry(() => pruneYieldTablesOnce(db, startSec, options), 3, options?.signal);
}

/**
 * Rows removed per statement. Small enough that a single statement stays far
 * inside the D1 per-query CPU budget even on a wide index scan.
 */
const RETENTION_DELETE_CHUNK_ROWS = 5_000;
/**
 * Ceiling on rows removed per run. A retention-boundary change can put millions
 * of rows in scope at once; draining them in one invocation would exceed the D1
 * CPU limit and fail the whole publication run, so each run removes a bounded
 * slice and the next run continues. Exceeding this budget is expected after a
 * boundary change and is reported by the log line below.
 */
const RETENTION_DELETE_MAX_ROWS_PER_RUN = 250_000;

/**
 * Delete every row of `table` older than `cutoffSec` (by `timeColumn`), in
 * bounded statements, so a large backlog drains across runs instead of failing
 * one. `rowid` is used for the chunk selection because every retention table is
 * a plain rowid table; each retention table indexes its time column, so each
 * bounded statement is an index range scan rather than a full scan.
 *
 * `eligibilityClause` adds a static predicate to the bounded selection for
 * tables whose rows need additional retention guards.
 *
 * Exported with an explicit `maxRows` budget: the production default is
 * {@link RETENTION_DELETE_MAX_ROWS_PER_RUN}, and a smaller budget exercises the
 * resumable path in tests.
 */
export async function drainRowsBeforeCutoff(params: {
  db: D1Database;
  table: "yield_history" | "yield_history_daily" | "yield_source_decision_alternatives";
  statementTag: string;
  timeColumn: "recorded_at" | "snapshot_date";
  cutoffSec: number;
  frozenIdsList: number[] | string[];
  frozenClause: string;
  eligibilityClause?: string;
  maxRows?: number;
}): Promise<{ deleted: number; budgetExhausted: boolean }> {
  const {
    db,
    table,
    statementTag,
    timeColumn,
    cutoffSec,
    frozenIdsList,
    frozenClause,
    eligibilityClause = "",
  } = params;
  const perRunBudget = Math.max(
    RETENTION_DELETE_CHUNK_ROWS,
    params.maxRows ?? RETENTION_DELETE_MAX_ROWS_PER_RUN,
  );
  let remainingBudget = perRunBudget;
  let deleted = 0;

  while (remainingBudget > 0) {
    const chunkRows = Math.min(RETENTION_DELETE_CHUNK_ROWS, remainingBudget);
    const result = await db
      .prepare(
        `/* pharos:yield-sync:${statementTag} */
         DELETE FROM ${table}
          WHERE rowid IN (
            SELECT rowid FROM ${table}
             WHERE ${timeColumn} < ? ${frozenClause}${eligibilityClause}
             ORDER BY ${timeColumn} ASC
             LIMIT ?
          )`,
      )
      .bind(cutoffSec, ...frozenIdsList, chunkRows)
      .run();
    const changed = Number(result.meta?.changes ?? 0);
    if (!Number.isFinite(changed) || changed <= 0) break;
    deleted += changed;
    remainingBudget -= changed;
    // A short statement means the backlog is exhausted.
    if (changed < chunkRows) break;
  }

  const budgetExhausted = remainingBudget <= 0 && deleted >= perRunBudget;
  if (budgetExhausted) {
    logWorkerEvent({
      scope: "handler",
      level: "info",
      event: "yield-history-retention-drain-continues",
      message: `Retention drain for ${table} hit its per-run row budget; the remainder continues on the next publication run.`,
      metadata: { table, deleted, budget: perRunBudget },
    });
  }
  return { deleted, budgetExhausted };
}

/**
 * Delete audit-only decision rows in bounded, predicate-first chunks. The
 * candidate query must apply the full retention predicate before LIMIT so
 * trend-tagged keeper rows cannot consume the chunk and make progress appear
 * short.
 */
export async function drainDecisionRowsBeforeCutoff(params: {
  db: D1Database;
  cutoffSec: number;
  maxRows?: number;
}): Promise<{ deleted: number; budgetExhausted: boolean }> {
  const { db, cutoffSec } = params;
  const perRunBudget = Math.max(
    RETENTION_DELETE_CHUNK_ROWS,
    params.maxRows ?? RETENTION_DELETE_MAX_ROWS_PER_RUN,
  );
  let remainingBudget = perRunBudget;
  let deleted = 0;
  let cursorCreatedAt: number | null = null;
  let cursorRowId: number | null = null;

  while (remainingBudget > 0) {
    const chunkRows = Math.min(RETENTION_DELETE_CHUNK_ROWS, remainingBudget);
    const cursorClause: string =
      cursorCreatedAt == null
        ? ""
        : "AND (created_at > ? OR (created_at = ? AND rowid > ?))";
    const cursorBinds: number[] =
      cursorCreatedAt == null ? [] : [cursorCreatedAt, cursorCreatedAt, cursorRowId as number];
    const candidates: D1Result<{ rowid: number; created_at: number }> = await db
      .prepare(
        `/* pharos:yield-sync:decision-retention-delete-candidates */
         SELECT rowid, created_at
           FROM yield_source_decisions
          WHERE created_at < ?
            AND ${DECISION_RETENTION_DELETE_PREDICATE}
            ${cursorClause}
          ORDER BY created_at ASC, rowid ASC
          LIMIT ?`,
      )
      .bind(cutoffSec, ...cursorBinds, chunkRows)
      .all<{ rowid: number; created_at: number }>();
    const candidateRows: Array<{ rowid: number; created_at: number }> = candidates.results ?? [];
    if (candidateRows.length === 0) break;

    const lastCandidate: { rowid: number; created_at: number } =
      candidateRows[candidateRows.length - 1]!;
    const lastCreatedAt: number = Number(lastCandidate.created_at);
    const lastRowId: number = Number(lastCandidate.rowid);
    if (!Number.isFinite(lastCreatedAt) || !Number.isFinite(lastRowId)) break;

    const result = await db
      .prepare(
        `/* pharos:yield-sync:decision-retention-delete */
         DELETE FROM yield_source_decisions
          WHERE rowid IN (
            SELECT rowid
              FROM yield_source_decisions
             WHERE created_at < ?
               AND ${DECISION_RETENTION_DELETE_PREDICATE}
               ${cursorClause}
             ORDER BY created_at ASC, rowid ASC
             LIMIT ?
          )`,
      )
      .bind(cutoffSec, ...cursorBinds, chunkRows)
      .run();
    const changed = Number(result.meta?.changes ?? 0);
    if (!Number.isFinite(changed) || changed <= 0) break;
    deleted += changed;
    remainingBudget -= changed;
    cursorCreatedAt = lastCreatedAt;
    cursorRowId = lastRowId;
  }

  const budgetExhausted = remainingBudget <= 0 && deleted >= perRunBudget;
  if (budgetExhausted) {
    logWorkerEvent({
      scope: "handler",
      level: "info",
      event: "yield-history-retention-drain-continues",
      message:
        "Retention drain for yield_source_decisions hit its per-run row budget; the remainder continues on the next publication run.",
      metadata: { table: "yield_source_decisions", deleted, budget: perRunBudget },
    });
  }
  return { deleted, budgetExhausted };
}

async function pruneYieldTablesOnce(
  db: D1Database,
  startSec: number,
  options?: { allowDestructiveCleanup?: boolean },
): Promise<void> {
  const allowDestructiveCleanup = options?.allowDestructiveCleanup ?? true;
  const managedYieldIds = ACTIVE_STABLECOINS.map((meta) => meta.id);
  if (allowDestructiveCleanup && managedYieldIds.length > 0) {
    await deleteStaleYieldRows(db, managedYieldIds, startSec);
    await deleteOrphanYieldRows(db, managedYieldIds);
  }

  // A generation only stays `staged` while its own run is publishing, and that
  // run now finalizes the row on abort. Anything left staged past one cron
  // interval was abandoned by an isolate that never came back; the publication
  // surface maps `staged` to a live candidate, so it must not linger.
  await db
    .prepare(
      `/* pharos:yield-sync:abandoned-staged-generation-finalize */
       UPDATE yield_publication_generations
          SET state = 'failed', failed_at = ?, failure_reason = 'abandoned-staged'
        WHERE state = 'staged'
          AND started_at < ?`,
    )
    .bind(startSec, startSec - HOUR_SECONDS)
    .run();

  await materializeYieldHistoryDaily(db, startSec);

  // yield_history_daily now carries the year-long public window, so raw hourly
  // rows only need the 30-day full-fidelity policy; the daily tier keeps the
  // 365-day cutoff. Materialization above ran first, so the trailing raw day
  // was already closed into the daily tier before it leaves the raw window.
  //
  // Both deletes are drained in bounded statements. A retention boundary change
  // (v8.43 moved the raw cutoff from 365d to 30d) leaves the whole backlog
  // eligible at once, and one unbounded DELETE over millions of rows exceeds the
  // D1 per-query CPU limit — which failed the entire run with
  // `D1_ERROR: D1 DB exceeded its CPU time limit`, every hour, forever. A chunk
  // that cannot commit leaves the table unchanged, so the drain must be bounded
  // and resumable rather than atomic.
  const rawPruneCutoff = startSec - YIELD_HISTORY_RAW_DAYS * DAY_SECONDS;
  const pruneCutoff = startSec - YIELD_HISTORY_MAX_DAYS * DAY_SECONDS;
  const frozenIdsList = [...FROZEN_IDS];
  const frozenClause =
    frozenIdsList.length > 0
      ? `AND stablecoin_id NOT IN (${frozenIdsList.map(() => "?").join(",")})`
      : "";
  await drainRowsBeforeCutoff({
    db,
    table: "yield_history",
    statementTag: "history-retention-delete",
    timeColumn: "recorded_at",
    cutoffSec: rawPruneCutoff,
    frozenIdsList,
    frozenClause,
  });
  await drainRowsBeforeCutoff({
    db,
    table: "yield_history_daily",
    statementTag: "daily-history-retention-delete",
    timeColumn: "snapshot_date",
    cutoffSec: pruneCutoff,
    frozenIdsList,
    frozenClause,
  });

  if (allowDestructiveCleanup) {
    await cleanupFalseLinkedVariantSourceSwitches(db, startSec);
    const auditCutoffSec = startSec - AUDIT_DECISION_RETENTION_DAYS * DAY_SECONDS;
    await drainDecisionRowsBeforeCutoff({ db, cutoffSec: auditCutoffSec });
    await drainRowsBeforeCutoff({
      db,
      table: "yield_source_decision_alternatives",
      statementTag: "decision-alternatives-retention-delete",
      timeColumn: "recorded_at",
      cutoffSec: auditCutoffSec,
      frozenIdsList: [],
      frozenClause: "",
      eligibilityClause: `
        AND NOT EXISTS (
          SELECT 1 FROM yield_source_decisions d
          WHERE d.generation_id = yield_source_decision_alternatives.generation_id
            AND d.stablecoin_id = yield_source_decision_alternatives.stablecoin_id
        )`,
    });
    const generationCutoffSec =
      startSec - YIELD_PUBLICATION_GENERATION_RETENTION_DAYS * DAY_SECONDS;
    await db
      .prepare(
        `/* pharos:yield-sync:publication-generation-retention-delete */
         WITH protected_generations AS (
           SELECT generation_id
             FROM (
               SELECT generation_id
                 FROM yield_publication_generations
                ORDER BY started_at DESC
                LIMIT 1
             )
           UNION
           SELECT generation_id
             FROM (
               SELECT generation_id
                 FROM yield_publication_generations
                WHERE state = 'published'
                ORDER BY COALESCE(published_at, started_at) DESC, started_at DESC
                LIMIT 1
             )
           UNION
           SELECT generation_id
             FROM (
               SELECT generation_id
                 FROM yield_publication_generations
                WHERE state = 'failed'
                ORDER BY COALESCE(failed_at, started_at) DESC, started_at DESC
                LIMIT 1
             )
         )
         DELETE FROM yield_publication_generations
          WHERE state IN ('published', 'failed')
            AND COALESCE(published_at, failed_at, started_at) < ?
            AND generation_id NOT IN (SELECT generation_id FROM protected_generations)`,
      )
      .bind(generationCutoffSec)
      .run();
    await purgeYieldHistoryOwnershipHandoffs(db);
  }
}
