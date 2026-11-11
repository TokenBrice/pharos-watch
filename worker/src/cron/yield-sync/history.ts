import {
  DAY_SECONDS,
  HOUR_SECONDS,
} from "@shared/lib/time-constants";
import {
  FROZEN_IDS,
  ACTIVE_STABLECOINS,
} from "@shared/lib/stablecoins/registry";
import {
  buildInClause,
  D1_MAX_BOUND_PARAMETERS,
} from "../../lib/db";
import {
  chunkArray,
} from "../../lib/collections";
import {
  bucketUnixSecondsToUtcDay,
} from "@shared/lib/time-buckets";
import {
  YIELD_HISTORY_MAX_DAYS,
  YIELD_HISTORY_RAW_DAYS,
} from "@shared/lib/yield-history-policy";
import {
  runWithOverloadRetry,
} from "../../lib/d1-overload-retry";
import {
  logWorkerEvent,
} from "../../lib/structured-log";
import {
  D1_SAFE_SQL_IN_CHUNK_SIZE,
} from "./history-repository";
import {
  purgeYieldHistoryOwnershipHandoffs,
  cleanupFalseLinkedVariantSourceSwitches,
} from "./history-repair";

const STALE_YIELD_DELETE_FIXED_BIND_COUNT = 1;

function getStaleYieldDeleteChunkSize(frozenIdCount: number): number {
  return Math.max(
    1,
    Math.min(
      D1_SAFE_SQL_IN_CHUNK_SIZE,
      D1_MAX_BOUND_PARAMETERS - STALE_YIELD_DELETE_FIXED_BIND_COUNT - frozenIdCount,
    ),
  );
}

async function deleteStaleYieldRows(db: D1Database, managedYieldIds: string[], startSec: number): Promise<void> {
  const frozenIdsList = [...FROZEN_IDS];
  const frozenClause =
    frozenIdsList.length > 0 ? `AND stablecoin_id NOT IN (${frozenIdsList.map(() => "?").join(",")})` : "";
  const chunkSize = getStaleYieldDeleteChunkSize(frozenIdsList.length);
  for (const idChunk of chunkArray(managedYieldIds, chunkSize)) {
    const staleRowInClause = buildInClause(idChunk);
    await db
      .prepare(
        `/* pharos:yield-sync:stale-yield-data-delete */
         DELETE FROM yield_data
         WHERE stablecoin_id IN (${staleRowInClause.sql}) AND updated_at < ? ${frozenClause}`,
      )
      .bind(...staleRowInClause.binds, startSec, ...frozenIdsList)
      .run();
  }
}

async function deleteOrphanYieldRows(db: D1Database, managedYieldIds: string[]): Promise<void> {
  const managedYieldIdSet = new Set(managedYieldIds);
  const existingIds = await db
    .prepare("SELECT /* pharos:yield-sync:yield-data-existing-ids */ DISTINCT stablecoin_id FROM yield_data")
    .all<{ stablecoin_id: string }>();
  const orphanIds = (existingIds.results ?? [])
    .map((row) => row.stablecoin_id)
    .filter((id) => !managedYieldIdSet.has(id) && !FROZEN_IDS.has(id));

  for (const idChunk of chunkArray(orphanIds, D1_SAFE_SQL_IN_CHUNK_SIZE)) {
    const orphanInClause = buildInClause(idChunk);
    await db
      .prepare(
        `/* pharos:yield-sync:orphan-yield-data-delete */
         DELETE FROM yield_data
         WHERE stablecoin_id IN (${orphanInClause.sql})`,
      )
      .bind(...orphanInClause.binds)
      .run();
  }
}

/** Days to retain audit-only yield_source_decisions rows. Trend-tagged rows
 *  (source switches, anomalies, rejected higher-confidence sources) are
 *  preserved beyond this window for long-running analytics. */
const AUDIT_DECISION_RETENTION_DAYS = 30;

const DECISION_RETENTION_DELETE_PREDICATE =
  "retention_reason = 'audit' AND COALESCE(source_switch, 0) != 1";

/**
 * Keep a 90-day completed-generation history for operational incident review.
 * publication-contract.ts only reads the newest attempted, published, and
 * failed generations (and derives candidate age from the newest attempt); the
 * prune protects those rows explicitly, including the current staged/published
 * generation, so this window does not change the contract's lookback.
 */
const YIELD_PUBLICATION_GENERATION_RETENTION_DAYS = 90;

const YIELD_DAILY_MATERIALIZATION_MAX_ROWS_PER_RUN = 1_000;

export async function materializeYieldHistoryDaily(
  db: D1Database,
  startSec: number,
): Promise<number> {
  const rawPruneCutoff = bucketUnixSecondsToUtcDay(
    startSec - YIELD_HISTORY_RAW_DAYS * DAY_SECONDS,
  );
  const result = await db
    .prepare(
      `/* pharos:yield-sync:daily-history-materialize */
       INSERT INTO yield_history_daily (
         stablecoin_id, source_key, snapshot_date, recorded_at, is_best,
         apy, apy_base, apy_reward, exchange_rate, source_tvl_usd,
         data_source, warning_signals, yield_source, yield_type,
         publication_generation_id, publication_state, pys_at_publish,
         safety_at_publish, variance_at_publish, pys_inputs_at_publish, source_observed_at
       )
       WITH pending AS (
         SELECT h.stablecoin_id, h.source_key,
                CAST(h.recorded_at / ${DAY_SECONDS} AS INTEGER) * ${DAY_SECONDS} AS snapshot_date,
                MAX(h.recorded_at) AS recorded_at
           -- Seek the out-of-retention range; without the hint the planner
           -- full-scans idx_yield_hist_coin_source every run (~208k rows).
           FROM yield_history h INDEXED BY idx_yield_history_recorded_coin
          WHERE h.recorded_at < ?
            AND (h.publication_state IS NULL OR h.publication_state = 'published')
            AND NOT EXISTS (
              SELECT 1 FROM yield_history_daily d
               WHERE d.stablecoin_id = h.stablecoin_id AND d.source_key = h.source_key
                 AND d.snapshot_date = CAST(h.recorded_at / ${DAY_SECONDS} AS INTEGER) * ${DAY_SECONDS}
                 AND d.recorded_at >= h.recorded_at
            )
          GROUP BY h.stablecoin_id, h.source_key, snapshot_date
          ORDER BY snapshot_date, h.stablecoin_id, h.source_key
          LIMIT ${YIELD_DAILY_MATERIALIZATION_MAX_ROWS_PER_RUN}
       ), ranked AS (
         SELECT h.*, pending.snapshot_date
           FROM pending JOIN yield_history h
             ON h.stablecoin_id = pending.stablecoin_id
            AND h.source_key = pending.source_key
            AND h.recorded_at = pending.recorded_at
       )
       SELECT stablecoin_id, source_key, snapshot_date, recorded_at, is_best,
              apy, apy_base, apy_reward, exchange_rate, source_tvl_usd,
              data_source, warning_signals, yield_source, yield_type,
              publication_generation_id, publication_state, pys_at_publish,
              safety_at_publish, variance_at_publish, pys_inputs_at_publish, source_observed_at
         FROM ranked
        WHERE true
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
         pys_inputs_at_publish = excluded.pys_inputs_at_publish,
         source_observed_at = excluded.source_observed_at
       WHERE excluded.recorded_at > yield_history_daily.recorded_at
       RETURNING snapshot_date`,
    )
    .bind(rawPruneCutoff)
    .all<{ snapshot_date: number }>();
  return result.meta?.changes ?? result.results?.length ?? 0;
}

export async function pruneYieldTables(
  db: D1Database,
  startSec: number,
  options?: {
    allowDestructiveCleanup?: boolean;
    signal?: AbortSignal;
  },
): Promise<void> {
  // Cleanup is idempotent; outlast one spent D1 window without replaying publication.
  await runWithOverloadRetry(() => pruneYieldTablesOnce(db, startSec, options), 3, options?.signal,
    { waitOutResourceWindow: true });
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

  // Raw rows are deletable only when their source/day has a daily close at
  // least as new. A bounded backfill never authorizes deleting its remainder.
  //
  // Both deletes are drained in bounded statements. A retention boundary change
  // (v8.43 moved the raw cutoff from 365d to 30d) leaves the whole backlog
  // eligible at once, and one unbounded DELETE over millions of rows exceeds the
  // D1 per-query CPU limit — which failed the entire run with
  // `D1_ERROR: D1 DB exceeded its CPU time limit`, every hour, forever. A chunk
  // that cannot commit leaves the table unchanged, so the drain must be bounded
  // and resumable rather than atomic.
  const desiredRawPruneCutoff = bucketUnixSecondsToUtcDay(
    startSec - YIELD_HISTORY_RAW_DAYS * DAY_SECONDS,
  );
  const rawPruneCutoff = desiredRawPruneCutoff;
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
    eligibilityClause: `AND EXISTS (
      SELECT 1 FROM yield_history_daily d
       WHERE d.stablecoin_id = yield_history.stablecoin_id
         AND d.source_key = yield_history.source_key
         AND d.snapshot_date = CAST(yield_history.recorded_at / ${DAY_SECONDS} AS INTEGER) * ${DAY_SECONDS}
         AND d.recorded_at >= yield_history.recorded_at
    )`,
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
