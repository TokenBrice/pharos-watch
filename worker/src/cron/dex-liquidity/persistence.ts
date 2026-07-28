import { ACTIVE_IDS, ACTIVE_STABLECOINS, TRACKED_IDS } from "@shared/lib/stablecoins/registry";
import { LIQUIDITY_METHODOLOGY_VERSION } from "@shared/lib/liquidity-score-version";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import type { ExitRouteObservation, ExitRouteObservationCoverage } from "@shared/types/market";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { batchExecute, executeAtomicBatch, prepareMultiRowInsertStatements } from "../../lib/db";
import { writeFreshnessSentinel } from "../../lib/db-cache";
import { runWithOverloadRetry } from "../../lib/cron-lease";
import { logWorkerEvent } from "../../lib/structured-log";
import type { LiquidityMetrics, FullScoreResult, GlobalAgg } from "./types";
import { toErrorMessage } from "../../lib/error-utils";

const DEX_AGGREGATE_PRESERVE_IDS = new Set(["__global__"]);
/** Retain one complete scoring window plus one missed half-hour producer cycle. */
const DEX_LIQUIDITY_GENERATION_RETENTION_SEC = 3 * 60 * 60;
/** Bound each prune pass so a retention shortening drains gradually instead of one oversized D1 delete in the cron tail. */
const DEX_LIQUIDITY_PRUNE_MAX_GENERATIONS_PER_RUN = 16;
const DEX_LIQUIDITY_HISTORY_RETENTION_SEC = 365 * DAY_SECONDS;
/** Keep large bound JSON payloads from accumulating across a full generation. */
export const DEX_LIQUIDITY_PERSISTENCE_BATCH_SIZE = 25;
const DEX_LIQUIDITY_HISTORY_INSERT_SQL = `INSERT INTO dex_liquidity_history
  (stablecoin_id, total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date,
   coverage_class, coverage_confidence, source_mix_json, methodology_version,
   exit_route_summary_json)`;

const DEX_LIQUIDITY_ROW_COLUMNS = [
  "stablecoin_id",
  "symbol",
  "total_tvl_usd",
  "total_volume_24h_usd",
  "total_volume_7d_usd",
  "pool_count",
  "pair_count",
  "chain_count",
  "protocol_tvl_json",
  "chain_tvl_json",
  "top_pools_json",
  "liquidity_score",
  "concentration_hhi",
  "avg_pool_stress",
  "weighted_balance_ratio",
  "organic_fraction",
  "effective_tvl_usd",
  "durability_score",
  "score_components_json",
  "locked_liquidity_pct",
  "coverage_class",
  "coverage_confidence",
  "source_mix_json",
  "balance_measured_tvl_usd",
  "organic_measured_tvl_usd",
  "methodology_version",
  "updated_at",
] as const;

const DEX_LIQUIDITY_ROW_COLUMN_SQL = DEX_LIQUIDITY_ROW_COLUMNS.join(", ");
const DEX_LIQUIDITY_ROW_VALUE_PLACEHOLDERS = DEX_LIQUIDITY_ROW_COLUMNS.map(() => "?").join(", ");
const DEX_LIQUIDITY_PUBLISH_CURRENT_SET_SQL = DEX_LIQUIDITY_ROW_COLUMNS.filter((column) => column !== "stablecoin_id")
  .map((column) => `${column} = excluded.${column}`)
  .join(",\n  ");
const DEX_LIQUIDITY_CURRENT_PUBLISHED_FILTER =
  "(publication_generation_id IS NULL OR publication_generation_id IN (SELECT generation_id FROM dex_liquidity_publication_generations WHERE state = 'published'))";

type P4aFullScoreResult = FullScoreResult & {
  exitRouteObservations?: ExitRouteObservation[];
  exitRouteObservationCoverage?: ExitRouteObservationCoverage;
};

/** @internal Exported for focused persistence tests. */
export function buildDexScoreDetailsJson(scoreResult: FullScoreResult): string {
  const p4aResult = scoreResult as P4aFullScoreResult;
  return JSON.stringify({
    ...scoreResult.components,
    ...(p4aResult.exitRouteObservations != null ? { exitRouteObservations: p4aResult.exitRouteObservations } : {}),
    ...(p4aResult.exitRouteObservationCoverage != null
      ? { exitRouteObservationCoverage: p4aResult.exitRouteObservationCoverage }
      : {}),
  });
}

/**
 * Compute the set of stablecoin ids whose DEX rows should be deleted.
 * Preserves rows for any tracked coin (active OR frozen) plus the
 * `__global__` aggregate sentinel. Only orphaned ids that no longer
 * exist in the registry get pruned.
 */
export function computeDexPruneSet(allDbIds: Set<string>, trackedIds: ReadonlySet<string> = TRACKED_IDS): Set<string> {
  const prune = new Set<string>();
  for (const id of allDbIds) {
    if (trackedIds.has(id)) continue;
    if (DEX_AGGREGATE_PRESERVE_IDS.has(id)) continue;
    prune.add(id);
  }
  return prune;
}

const DEX_LIQUIDITY_RUN_ROW_UPSERT_SQL = `INSERT OR REPLACE INTO dex_liquidity_run_rows
  (generation_id, ${DEX_LIQUIDITY_ROW_COLUMN_SQL})
VALUES (?, ${DEX_LIQUIDITY_ROW_VALUE_PLACEHOLDERS})`;

const DEX_LIQUIDITY_PUBLISH_CURRENT_SQL = `INSERT INTO dex_liquidity
  (${DEX_LIQUIDITY_ROW_COLUMN_SQL}, publication_generation_id, publication_state)
SELECT ${DEX_LIQUIDITY_ROW_COLUMN_SQL}, generation_id, 'published'
FROM dex_liquidity_run_rows
WHERE generation_id = ?
ON CONFLICT(stablecoin_id) DO UPDATE SET
  ${DEX_LIQUIDITY_PUBLISH_CURRENT_SET_SQL},
  publication_generation_id = excluded.publication_generation_id,
  publication_state = excluded.publication_state
WHERE dex_liquidity.updated_at <= excluded.updated_at`;

export function buildDexLiquidityPublicationGenerationId(startSec: number): string {
  return `dex-liquidity-${startSec}`;
}

export interface PersistScoresResult {
  generationId?: string | null;
  expectedRowCount?: number;
  candidateRowsWritten?: number;
  currentGenerationRows?: number;
  placeholderCount: number;
  inactiveMetricRowsSkipped: number;
  inactiveMetricIdsSkipped?: string[];
  orphanRowsDeleted: number;
  orphanCleanupFailed: boolean;
  retention?: DexLiquidityGenerationRetentionResult;
  skipped?: boolean;
  skippedReason?: string | null;
}

export interface DexLiquidityGenerationRetentionResult {
  cutoff: number;
  deletedRows: number;
  deletedRunRows: number;
  deletedGenerationRows: number;
  oldestRemainingAt: number | null;
  durationMs: number;
  error: string | null;
}

export interface HistoricalSnapshotWriteResult {
  snapshotRowsWritten: number;
  skipped: boolean;
  writeFailed: boolean;
  historyRowsPruned: number;
  retentionPruneFailed: boolean;
}

interface CandidateGenerationCoverage {
  rowCount: number;
  activeAssetRows: number;
  globalRows: number;
}

interface HistoricalSnapshotRow {
  id: number;
  stablecoin_id: string;
  total_tvl_usd: number;
  total_volume_24h_usd: number;
  liquidity_score: number | null;
  snapshot_date: number;
  coverage_class: string;
  coverage_confidence: number;
  source_mix_json: string | null;
  methodology_version: string;
  exit_route_summary_json: string | null;
}

/** @internal Exported for focused prospective-history tests. */
export function buildDexExitRouteHistoryJson(scoreResult: FullScoreResult): string | null {
  const p4aResult = scoreResult as P4aFullScoreResult;
  if (p4aResult.exitRouteObservations == null && p4aResult.exitRouteObservationCoverage == null) {
    return null;
  }
  return JSON.stringify({
    observations: p4aResult.exitRouteObservations ?? [],
    coverage: p4aResult.exitRouteObservationCoverage ?? null,
  });
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function canReuseHistoricalSnapshot(
  rows: readonly HistoricalSnapshotRow[],
  expectedActiveIds: ReadonlySet<string>,
  expectedScoredIds: ReadonlySet<string>,
  incomingRouteHistoryIds: ReadonlySet<string>,
): boolean {
  const activeIds = new Set(rows.map((row) => row.stablecoin_id));
  if (activeIds.size !== rows.length || !setsEqual(activeIds, expectedActiveIds)) return false;

  const scoredIds = new Set(rows.filter((row) => row.liquidity_score != null).map((row) => row.stablecoin_id));
  if (!setsEqual(scoredIds, expectedScoredIds)) return false;

  const existingRouteHistoryIds = new Set(
    rows.filter((row) => row.exit_route_summary_json != null).map((row) => row.stablecoin_id),
  );
  for (const id of incomingRouteHistoryIds) {
    if (!existingRouteHistoryIds.has(id)) return false;
  }
  return true;
}

async function stageDexLiquidityPublicationGeneration(
  db: D1Database,
  params: {
    generationId: string;
    nowSec: number;
    expectedRowCount: number;
    metricsCount: number;
    scoredCount: number;
    activeMetricsCount: number;
    activeScoredCount: number;
    inactiveMetricRowsSkipped: number;
    inactiveMetricIdsSkipped: string[];
    signal?: AbortSignal;
  },
): Promise<void> {
  throwIfAborted(params.signal);
  await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `INSERT INTO dex_liquidity_publication_generations (
             generation_id, started_at, state, expected_row_count, written_row_count,
             current_row_count, metadata_json, created_at, published_at, failed_at, failure_reason
           ) VALUES (?, ?, 'staged', ?, 0, NULL, ?, ?, NULL, NULL, NULL)
           ON CONFLICT(generation_id) DO UPDATE SET
             started_at = excluded.started_at,
             state = CASE
               WHEN dex_liquidity_publication_generations.state = 'published' THEN dex_liquidity_publication_generations.state
               ELSE 'staged'
             END,
             expected_row_count = excluded.expected_row_count,
             written_row_count = CASE
               WHEN dex_liquidity_publication_generations.state = 'published' THEN dex_liquidity_publication_generations.written_row_count
               ELSE 0
             END,
             current_row_count = CASE
               WHEN dex_liquidity_publication_generations.state = 'published' THEN dex_liquidity_publication_generations.current_row_count
               ELSE NULL
             END,
             metadata_json = excluded.metadata_json,
             created_at = CASE
               WHEN dex_liquidity_publication_generations.state = 'published' THEN dex_liquidity_publication_generations.created_at
               ELSE excluded.created_at
             END,
             published_at = CASE
               WHEN dex_liquidity_publication_generations.state = 'published' THEN dex_liquidity_publication_generations.published_at
               ELSE NULL
             END,
             failed_at = CASE
               WHEN dex_liquidity_publication_generations.state = 'published' THEN dex_liquidity_publication_generations.failed_at
               ELSE NULL
             END,
             failure_reason = CASE
               WHEN dex_liquidity_publication_generations.state = 'published' THEN dex_liquidity_publication_generations.failure_reason
               ELSE NULL
             END`,
        )
        .bind(
          params.generationId,
          params.nowSec,
          params.expectedRowCount,
          JSON.stringify({
            methodologyVersion: LIQUIDITY_METHODOLOGY_VERSION,
            activeStablecoinCount: ACTIVE_STABLECOINS.length,
            metricsCount: params.metricsCount,
            scoredCount: params.scoredCount,
            activeMetricsCount: params.activeMetricsCount,
            activeScoredCount: params.activeScoredCount,
            inactiveMetricRowsSkipped: params.inactiveMetricRowsSkipped,
            inactiveMetricIdsSkipped: params.inactiveMetricIdsSkipped.slice(0, 25),
          }),
          params.nowSec,
        )
        .run(),
    3,
    params.signal,
  );
}

async function markDexLiquidityPublicationGenerationFailed(
  db: D1Database,
  generationId: string,
  nowSec: number,
  reason: string,
): Promise<void> {
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE dex_liquidity_publication_generations
         SET state = 'failed', failed_at = ?, failure_reason = ?
         WHERE generation_id = ? AND state != 'published'`,
      )
      .bind(nowSec, reason.slice(0, 240), generationId)
      .run(),
  );
}

async function loadCandidateGenerationCoverage(
  db: D1Database,
  generationId: string,
  signal?: AbortSignal,
): Promise<CandidateGenerationCoverage> {
  throwIfAborted(signal);
  const row = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT
             COUNT(*) AS row_count,
             SUM(CASE WHEN stablecoin_id != '__global__' THEN 1 ELSE 0 END) AS active_asset_rows,
             SUM(CASE WHEN stablecoin_id = '__global__' THEN 1 ELSE 0 END) AS global_rows
           FROM dex_liquidity_run_rows
           WHERE generation_id = ?`,
        )
        .bind(generationId)
        .first<{
          row_count: number | null;
          active_asset_rows: number | null;
          global_rows: number | null;
        }>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return {
    rowCount: row?.row_count ?? 0,
    activeAssetRows: row?.active_asset_rows ?? 0,
    globalRows: row?.global_rows ?? 0,
  };
}

function assertCandidateGenerationComplete(coverage: CandidateGenerationCoverage, expectedRowCount: number): void {
  if (
    coverage.rowCount !== expectedRowCount ||
    coverage.activeAssetRows !== ACTIVE_STABLECOINS.length ||
    coverage.globalRows !== 1
  ) {
    throw new Error(
      `Incomplete DEX liquidity generation: rows=${coverage.rowCount}/${expectedRowCount}, active=${coverage.activeAssetRows}/${ACTIVE_STABLECOINS.length}, global=${coverage.globalRows}`,
    );
  }
}

async function ensureNoNewerCurrentDexRows(
  db: D1Database,
  generationId: string,
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const row = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM dex_liquidity
           WHERE updated_at > ?
             AND stablecoin_id IN (
               SELECT stablecoin_id FROM dex_liquidity_run_rows WHERE generation_id = ?
             )`,
        )
        .bind(nowSec, generationId)
        .first<{ cnt: number | null }>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  if ((row?.cnt ?? 0) > 0) {
    throw new Error(`Refusing to publish stale DEX liquidity generation ${generationId}; newer current rows exist`);
  }
}

async function publishDexLiquidityGeneration(
  db: D1Database,
  params: {
    generationId: string;
    nowSec: number;
    expectedRowCount: number;
    signal?: AbortSignal;
  },
): Promise<number> {
  await ensureNoNewerCurrentDexRows(db, params.generationId, params.nowSec, params.signal);
  throwIfAborted(params.signal);
  await batchExecute(
    db,
    [
      db.prepare(DEX_LIQUIDITY_PUBLISH_CURRENT_SQL).bind(params.generationId),
      db
        .prepare(
          `UPDATE dex_liquidity_publication_generations
         SET state = 'published',
             published_at = ?,
             failed_at = NULL,
             failure_reason = NULL,
             written_row_count = (
               SELECT COUNT(*) FROM dex_liquidity_run_rows WHERE generation_id = ?
             ),
             current_row_count = (
               SELECT COUNT(*) FROM dex_liquidity
               WHERE publication_generation_id = ? AND publication_state = 'published'
             )
         WHERE generation_id = ?`,
        )
        .bind(params.nowSec, params.generationId, params.generationId, params.generationId),
    ],
    { signal: params.signal },
  );
  throwIfAborted(params.signal);

  const current = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT current_row_count
           FROM dex_liquidity_publication_generations
           WHERE generation_id = ? AND state = 'published'`,
        )
        .bind(params.generationId)
        .first<{ current_row_count: number | null }>(),
    3,
    params.signal,
  );
  throwIfAborted(params.signal);
  const currentRows = current?.current_row_count ?? 0;
  if (currentRows !== params.expectedRowCount) {
    throw new Error(
      `DEX liquidity generation ${params.generationId} published ${currentRows}/${params.expectedRowCount} current rows`,
    );
  }
  return currentRows;
}

export async function pruneOldDexLiquidityGenerations(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<DexLiquidityGenerationRetentionResult> {
  const startedAtMs = Date.now();
  const cutoff = nowSec - DEX_LIQUIDITY_GENERATION_RETENTION_SEC;
  const result: DexLiquidityGenerationRetentionResult = {
    cutoff,
    deletedRows: 0,
    deletedRunRows: 0,
    deletedGenerationRows: 0,
    oldestRemainingAt: null,
    durationMs: 0,
    error: null,
  };
  try {
    const runRows = await runWithOverloadRetry(
      () => db
        .prepare(
          `DELETE FROM dex_liquidity_run_rows
         WHERE generation_id IN (
           SELECT generation_id
           FROM dex_liquidity_publication_generations
           WHERE started_at < ?
             AND state IN ('published', 'failed')
             AND EXISTS (
               SELECT 1 FROM dex_liquidity_run_rows candidate_row
               WHERE candidate_row.generation_id = dex_liquidity_publication_generations.generation_id
             )
             AND generation_id NOT IN (
               SELECT publication_generation_id
               FROM dex_liquidity
               WHERE stablecoin_id = '__global__'
                 AND publication_state = 'published'
                 AND publication_generation_id IS NOT NULL
             )
           ORDER BY started_at ASC LIMIT ?
         )`,
        )
        .bind(cutoff, DEX_LIQUIDITY_PRUNE_MAX_GENERATIONS_PER_RUN)
        .run(),
      3,
      signal,
    );
    result.deletedRunRows = Number(runRows.meta?.changes ?? 0);

    const generations = await runWithOverloadRetry(
      () => db
        .prepare(
          `DELETE FROM dex_liquidity_publication_generations
         WHERE rowid IN (
           SELECT candidate.rowid
             FROM dex_liquidity_publication_generations candidate
            WHERE candidate.started_at < ?
              AND candidate.state IN ('published', 'failed')
              AND candidate.generation_id NOT IN (
                SELECT publication_generation_id
                  FROM dex_liquidity
                 WHERE publication_generation_id IS NOT NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM dex_liquidity_run_rows r
                 WHERE r.generation_id = candidate.generation_id
              )
            ORDER BY candidate.started_at ASC, candidate.generation_id ASC
            LIMIT ?
         )`,
        )
        .bind(cutoff, DEX_LIQUIDITY_PRUNE_MAX_GENERATIONS_PER_RUN)
        .run(),
      3,
      signal,
    );
    result.deletedGenerationRows = Number(generations.meta?.changes ?? 0);

    const oldest = await runWithOverloadRetry(
      () => db
        .prepare(
          `SELECT MIN(generation.started_at) AS oldest_remaining_at
             FROM dex_liquidity_publication_generations generation
            WHERE EXISTS (
              SELECT 1 FROM dex_liquidity_run_rows row
               WHERE row.generation_id = generation.generation_id
            )`,
        )
        .first<{ oldest_remaining_at: number | null }>(),
      3,
      signal,
    );
    result.oldestRemainingAt = oldest?.oldest_remaining_at ?? null;
  } catch (error) {
    rethrowIfAborted(error, signal);
    result.error = toErrorMessage(error).slice(0, 500);
  }
  result.deletedRows = result.deletedRunRows + result.deletedGenerationRows;
  result.durationMs = Math.max(0, Date.now() - startedAtMs);
  return result;
}

async function pruneOldDexLiquidityHistory(db: D1Database, nowSec: number, signal?: AbortSignal): Promise<number> {
  throwIfAborted(signal);
  const cutoff = nowSec - DEX_LIQUIDITY_HISTORY_RETENTION_SEC;
  const result = await runWithOverloadRetry(
    () =>
      db
        .prepare(
          `/* pharos:dex-liquidity:history-retention-delete */
           DELETE FROM dex_liquidity_history
           WHERE snapshot_date < ?`,
        )
        .bind(cutoff)
        .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return Number(result?.meta?.changes ?? 0);
}

/** Persist liquidity scores to D1 (both data rows and zero-score rows). */
export async function persistScores(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
  scoreResults: Map<string, FullScoreResult>,
  globalAgg: GlobalAgg,
  nowSec: number,
  signal?: AbortSignal,
): Promise<PersistScoresResult> {
  let placeholderCount = 0;
  let orphanRowsDeleted = 0;
  let orphanCleanupFailed = false;
  const generationId = buildDexLiquidityPublicationGenerationId(nowSec);
  const expectedRowCount = ACTIVE_STABLECOINS.length + 1;
  const inactiveMetricIdsSkipped = [...metrics.keys()].filter((id) => !ACTIVE_IDS.has(id)).sort();
  let activeMetricsCount = 0;
  let activeScoredCount = 0;
  for (const id of metrics.keys()) {
    if (ACTIVE_IDS.has(id)) activeMetricsCount++;
  }
  for (const id of scoreResults.keys()) {
    if (ACTIVE_IDS.has(id)) activeScoredCount++;
  }

  await stageDexLiquidityPublicationGeneration(db, {
    generationId,
    nowSec,
    expectedRowCount,
    metricsCount: metrics.size,
    scoredCount: scoreResults.size,
    activeMetricsCount,
    activeScoredCount,
    inactiveMetricRowsSkipped: inactiveMetricIdsSkipped.length,
    inactiveMetricIdsSkipped,
    signal,
  });

  const pendingStatements: D1PreparedStatement[] = [];
  const flushPendingStatements = async (): Promise<void> => {
    if (pendingStatements.length === 0) return;
    let batch: D1PreparedStatement[] | null = pendingStatements.splice(0, pendingStatements.length);
    try {
      await batchExecute(db, batch, {
        chunkSize: DEX_LIQUIDITY_PERSISTENCE_BATCH_SIZE,
        signal,
      });
    } finally {
      batch = null;
    }
  };
  const queueStatement = async (statement: D1PreparedStatement): Promise<void> => {
    pendingStatements.push(statement);
    if (pendingStatements.length >= DEX_LIQUIDITY_PERSISTENCE_BATCH_SIZE) {
      await flushPendingStatements();
    }
  };

  let candidateRowsWritten = 0;
  let currentGenerationRows = 0;
  try {
    for (const [id, m] of metrics) {
      throwIfAborted(signal);
      if (!ACTIVE_IDS.has(id)) continue;
      const sr = scoreResults.get(id);
      if (!sr) continue;

      await queueStatement(
        db
          .prepare(DEX_LIQUIDITY_RUN_ROW_UPSERT_SQL)
          .bind(
            generationId,
            id,
            m.symbol,
            m.totalTvlUsd,
            m.totalVolume24hUsd,
            m.totalVolume7dUsd,
            m.poolCount,
            m.pairs.size,
            m.chains.size,
            JSON.stringify(m.protocolTvl),
            JSON.stringify(m.chainTvl),
            JSON.stringify(m.topPools),
            sr.score,
            sr.hhi,
            sr.avgStress,
            sr.weightedBalanceRatio,
            sr.organicFrac,
            Math.round(m.effectiveTvl),
            sr.durability,
            buildDexScoreDetailsJson(sr),
            sr.lockedLiqPct,
            sr.coverageClass,
            sr.coverageConfidence,
            JSON.stringify(sr.sourceMix),
            sr.balanceMeasuredTvlUsd,
            sr.organicMeasuredTvlUsd,
            LIQUIDITY_METHODOLOGY_VERSION,
            nowSec,
          ),
      );
    }

    // Write placeholder rows for tracked stablecoins with no DEX presence.
    // liquidity_score = NULL so report cards treat them as NR (not rated).
    for (const meta of ACTIVE_STABLECOINS) {
      throwIfAborted(signal);
      if (!metrics.has(meta.id)) {
        placeholderCount++;
        await queueStatement(
          db
            .prepare(DEX_LIQUIDITY_RUN_ROW_UPSERT_SQL)
            .bind(
              generationId,
              meta.id,
              meta.symbol,
              0,
              0,
              0,
              0,
              0,
              0,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              null,
              0,
              null,
              null,
              null,
              "unobserved",
              0,
              null,
              0,
              0,
              LIQUIDITY_METHODOLOGY_VERSION,
              nowSec,
            ),
        );
      }
    }

    // Write __global__ sentinel row with deduped cross-stablecoin aggregates.
    await queueStatement(
      db
        .prepare(DEX_LIQUIDITY_RUN_ROW_UPSERT_SQL)
        .bind(
          generationId,
          "__global__",
          "__global__",
          globalAgg.totalTvl,
          globalAgg.totalVol24h,
          globalAgg.totalVol7d,
          globalAgg.poolCount,
          0,
          globalAgg.chainCount,
          JSON.stringify(globalAgg.protocolTvl),
          JSON.stringify(globalAgg.chainTvl),
          null,
          null,
          null,
          null,
          null,
          null,
          0,
          null,
          null,
          null,
          "unobserved",
          0,
          null,
          0,
          0,
          LIQUIDITY_METHODOLOGY_VERSION,
          nowSec,
        ),
    );
    await flushPendingStatements();

    // Preserve historical rows for the complete tracked catalog while pruning orphans.
    const DEX_LIQUIDITY_TABLES = ["dex_liquidity", "dex_liquidity_history", "dex_discovery_meta"] as const;
    try {
      for (const table of DEX_LIQUIDITY_TABLES) {
        throwIfAborted(signal);
        const existingRows = await db
          // SAFETY: validated against DEX_LIQUIDITY_TABLES allowlist above.
          .prepare(
            table === "dex_liquidity"
              ? `SELECT DISTINCT stablecoin_id FROM ${table} WHERE ${DEX_LIQUIDITY_CURRENT_PUBLISHED_FILTER}`
              : `SELECT DISTINCT stablecoin_id FROM ${table}`,
          )
          .all<{ stablecoin_id: string }>();
        throwIfAborted(signal);
        const tableIds = new Set((existingRows.results ?? []).map((row) => row.stablecoin_id));
        const pruneIds = computeDexPruneSet(tableIds);
        for (const id of pruneIds) {
          orphanRowsDeleted++;
          await queueStatement(
            // SAFETY: validated against DEX_LIQUIDITY_TABLES allowlist above.
            db.prepare(`DELETE FROM ${table} WHERE stablecoin_id = ?`).bind(id),
          );
        }
      }
    } catch (err) {
      rethrowIfAborted(err, signal);
      orphanCleanupFailed = true;
      console.warn("[dex-liquidity] Failed to check for orphaned rows:", err);
    }
    await flushPendingStatements();

    throwIfAborted(signal);
    const coverage = await loadCandidateGenerationCoverage(db, generationId, signal);
    assertCandidateGenerationComplete(coverage, expectedRowCount);
    candidateRowsWritten = coverage.rowCount;
    currentGenerationRows = await publishDexLiquidityGeneration(db, {
      generationId,
      nowSec,
      expectedRowCount,
      signal,
    });
    throwIfAborted(signal);
    await writeFreshnessSentinel(db, "dex-liquidity", nowSec, signal);
  } catch (err) {
    if (!signal?.aborted) {
      try {
        await markDexLiquidityPublicationGenerationFailed(db, generationId, nowSec, toErrorMessage(err));
      } catch {
        // Best-effort diagnostics only; preserve the original publication error.
      }
    }
    rethrowIfAborted(err, signal);
    throw err;
  }
  const retention = await pruneOldDexLiquidityGenerations(db, nowSec, signal);

  console.log(
    `[dex-liquidity] Published ${currentGenerationRows} current rows from ${generationId} (${activeMetricsCount} active with data, ${placeholderCount} zero, ${inactiveMetricIdsSkipped.length} inactive skipped, 1 global)`,
  );
  return {
    generationId,
    expectedRowCount,
    candidateRowsWritten,
    currentGenerationRows,
    placeholderCount,
    inactiveMetricRowsSkipped: inactiveMetricIdsSkipped.length,
    inactiveMetricIdsSkipped,
    orphanRowsDeleted,
    orphanCleanupFailed,
    retention,
  };
}

/** Write daily snapshot rows (first sync invocation after UTC midnight). */
export async function writeHistoricalSnapshots(
  db: D1Database,
  scoreMap: Map<string, FullScoreResult>,
  signal?: AbortSignal,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<HistoricalSnapshotWriteResult> {
  const todayMidnight = Math.floor(nowSec / DAY_SECONDS) * DAY_SECONDS; // epoch seconds at UTC midnight
  const expectedActiveIds = new Set(ACTIVE_STABLECOINS.map((coin) => coin.id));
  const activeScoreMap = new Map([...scoreMap].filter(([id]) => expectedActiveIds.has(id)));
  const incomingScoredIds = new Set(activeScoreMap.keys());
  const incomingRouteHistoryIds = new Set(
    [...activeScoreMap]
      .filter(([, scoreResult]) => buildDexExitRouteHistoryJson(scoreResult) != null)
      .map(([id]) => id),
  );
  let historyRowsPruned = 0;
  let retentionPruneFailed = false;
  const pruneHistory = async (): Promise<void> => {
    try {
      historyRowsPruned = await pruneOldDexLiquidityHistory(db, nowSec, signal);
    } catch (err) {
      rethrowIfAborted(err, signal);
      retentionPruneFailed = true;
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "dex_liquidity_history_retention_prune_failed",
        job: "sync-dex-liquidity",
        source: "dex-liquidity-history",
        message: "Daily DEX liquidity snapshot retention prune failed",
        error: err,
      });
    }
  };

  try {
    throwIfAborted(signal);
    const existing = await db
      .prepare(
        `SELECT id, stablecoin_id, total_tvl_usd, total_volume_24h_usd, liquidity_score,
                snapshot_date, coverage_class, coverage_confidence, source_mix_json,
                methodology_version, exit_route_summary_json
         FROM dex_liquidity_history
         WHERE snapshot_date = ?
         ORDER BY stablecoin_id, id`,
      )
      .bind(todayMidnight)
      .all<HistoricalSnapshotRow>();
    const existingRows = existing.results ?? [];
    const existingCount = existingRows.length;
    const existingScored = existingRows.filter((row) => row.liquidity_score != null).length;
    const incomingScored = activeScoreMap.size;
    throwIfAborted(signal);

    const existingScoredRows = new Map<string, HistoricalSnapshotRow>();
    for (const row of existingRows) {
      if (expectedActiveIds.has(row.stablecoin_id) && row.liquidity_score != null) {
        existingScoredRows.set(row.stablecoin_id, row);
      }
    }
    const targetScoredIds = new Set([...existingScoredRows.keys(), ...incomingScoredIds]);

    if (canReuseHistoricalSnapshot(existingRows, expectedActiveIds, targetScoredIds, incomingRouteHistoryIds)) {
      await pruneHistory();
      return {
        snapshotRowsWritten: 0,
        skipped: true,
        writeFailed: false,
        historyRowsPruned,
        retentionPruneFailed,
      };
    }

    const snapshotRows: unknown[][] = [];
    for (const meta of ACTIVE_STABLECOINS) {
      const data = activeScoreMap.get(meta.id);
      const existingData = existingScoredRows.get(meta.id);
      const incomingExitRouteHistoryJson = data ? buildDexExitRouteHistoryJson(data) : null;
      snapshotRows.push(
        data
          ? [
              meta.id,
              data.tvl,
              data.vol24h,
              data.score,
              todayMidnight,
              data.coverageClass,
              data.coverageConfidence,
              JSON.stringify(data.sourceMix),
              LIQUIDITY_METHODOLOGY_VERSION,
              incomingExitRouteHistoryJson ?? existingData?.exit_route_summary_json ?? null,
            ]
          : existingData
            ? [
                meta.id,
                existingData.total_tvl_usd,
                existingData.total_volume_24h_usd,
                existingData.liquidity_score,
                todayMidnight,
                existingData.coverage_class,
                existingData.coverage_confidence,
                existingData.source_mix_json,
                existingData.methodology_version,
                existingData.exit_route_summary_json,
              ]
            : [meta.id, 0, 0, null, todayMidnight, "unobserved", 0, null, LIQUIDITY_METHODOLOGY_VERSION, null],
      );
    }

    const replacementStatements = [
      db
        .prepare(
          `/* pharos:dex-liquidity:history-date-replace */
           DELETE FROM dex_liquidity_history
           WHERE snapshot_date = ?`,
        )
        .bind(todayMidnight),
      ...prepareMultiRowInsertStatements(db, DEX_LIQUIDITY_HISTORY_INSERT_SQL, snapshotRows),
    ];
    await executeAtomicBatch(db, replacementStatements, { signal });
    await pruneHistory();
    console.log(
      `[dex-liquidity] Reconciled daily snapshot (${existingCount}/${existingScored} -> ${snapshotRows.length}/${targetScoredIds.size}, incoming=${incomingScored}) for ${new Date(todayMidnight * 1000).toISOString().slice(0, 10)}`,
    );
    return {
      snapshotRowsWritten: snapshotRows.length,
      skipped: false,
      writeFailed: false,
      historyRowsPruned,
      retentionPruneFailed,
    };
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.warn("[dex-liquidity] Daily snapshot failed:", err);
    return {
      snapshotRowsWritten: 0,
      skipped: false,
      writeFailed: true,
      historyRowsPruned,
      retentionPruneFailed,
    };
  }
}
