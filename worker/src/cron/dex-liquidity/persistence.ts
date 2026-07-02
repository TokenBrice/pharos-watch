import { ACTIVE_IDS, ACTIVE_STABLECOINS, TRACKED_IDS } from "@shared/lib/stablecoins/registry";
import { LIQUIDITY_METHODOLOGY_VERSION } from "@shared/lib/liquidity-score-version";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { batchExecute } from "../../lib/db";
import { writeFreshnessSentinel } from "../../lib/db-cache";
import { runWithOverloadRetry } from "../../lib/cron-lease";
import type { LiquidityMetrics, FullScoreResult, GlobalAgg } from "./types";
import { toErrorMessage } from "../../lib/error-utils";

const DEX_AGGREGATE_PRESERVE_IDS = new Set(["__global__"]);
const DEX_LIQUIDITY_GENERATION_RETENTION_SEC = 7 * 86_400;

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
const DEX_LIQUIDITY_PUBLISH_CURRENT_SET_SQL = DEX_LIQUIDITY_ROW_COLUMNS
  .filter((column) => column !== "stablecoin_id")
  .map((column) => `${column} = excluded.${column}`)
  .join(",\n  ");
const DEX_LIQUIDITY_CURRENT_PUBLISHED_FILTER =
  "(publication_generation_id IS NULL OR publication_generation_id IN (SELECT generation_id FROM dex_liquidity_publication_generations WHERE state = 'published'))";

/**
 * Compute the set of stablecoin ids whose DEX rows should be deleted.
 * Preserves rows for any tracked coin (active OR frozen) plus the
 * `__global__` aggregate sentinel. Only orphaned ids that no longer
 * exist in the registry get pruned.
 */
export function computeDexPruneSet(
  allDbIds: Set<string>,
  trackedIds: Set<string> = TRACKED_IDS,
): Set<string> {
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
  skipped?: boolean;
  skippedReason?: string | null;
}

export interface HistoricalSnapshotWriteResult {
  snapshotRowsWritten: number;
  skipped: boolean;
  writeFailed: boolean;
}

interface CandidateGenerationCoverage {
  rowCount: number;
  activeAssetRows: number;
  globalRows: number;
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

function assertCandidateGenerationComplete(
  coverage: CandidateGenerationCoverage,
  expectedRowCount: number,
): void {
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
  await batchExecute(db, [
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
  ], { signal: params.signal });
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

async function pruneOldDexLiquidityGenerations(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<void> {
  const cutoff = nowSec - DEX_LIQUIDITY_GENERATION_RETENTION_SEC;
  await batchExecute(db, [
    db
      .prepare(
        `DELETE FROM dex_liquidity_run_rows
         WHERE generation_id IN (
           SELECT generation_id
           FROM dex_liquidity_publication_generations
           WHERE started_at < ?
             AND generation_id NOT IN (
               SELECT publication_generation_id
               FROM dex_liquidity
               WHERE publication_generation_id IS NOT NULL
             )
         )`,
      )
      .bind(cutoff),
    db
      .prepare(
        `DELETE FROM dex_liquidity_publication_generations
         WHERE started_at < ?
           AND generation_id NOT IN (
             SELECT publication_generation_id
             FROM dex_liquidity
             WHERE publication_generation_id IS NOT NULL
           )`,
      )
      .bind(cutoff),
  ], { signal });
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
  const stmts: D1PreparedStatement[] = [];
  let placeholderCount = 0;
  let orphanRowsDeleted = 0;
  let orphanCleanupFailed = false;
  const generationId = buildDexLiquidityPublicationGenerationId(nowSec);
  const expectedRowCount = ACTIVE_STABLECOINS.length + 1;
  const activeMetrics = new Map([...metrics].filter(([id]) => ACTIVE_IDS.has(id)));
  const activeScoreResults = new Map([...scoreResults].filter(([id]) => ACTIVE_IDS.has(id)));
  const inactiveMetricIdsSkipped = [...metrics.keys()].filter((id) => !ACTIVE_IDS.has(id)).sort();

  await stageDexLiquidityPublicationGeneration(db, {
    generationId,
    nowSec,
    expectedRowCount,
    metricsCount: metrics.size,
    scoredCount: scoreResults.size,
    activeMetricsCount: activeMetrics.size,
    activeScoredCount: activeScoreResults.size,
    inactiveMetricRowsSkipped: inactiveMetricIdsSkipped.length,
    inactiveMetricIdsSkipped,
    signal,
  });

  for (const [id, m] of activeMetrics) {
    const sr = activeScoreResults.get(id);
    if (!sr) continue;

    stmts.push(
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
          JSON.stringify(sr.components),
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

  // Write placeholder rows for tracked stablecoins with no DEX presence
  // liquidity_score = NULL so report cards treat them as NR (not rated)
  for (const meta of ACTIVE_STABLECOINS) {
    if (!activeMetrics.has(meta.id)) {
      placeholderCount++;
      stmts.push(
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

  // Write __global__ sentinel row with deduped cross-stablecoin aggregates
  stmts.push(
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

  // Clean up orphaned rows from stablecoins no longer in the tracked set.
  // Preserve TRACKED (active + frozen) plus the `__global__` aggregate so
  // frozen coins keep their historical DEX rows.
  const DEX_LIQUIDITY_TABLES = [
    "dex_liquidity",
    "dex_liquidity_history",
    "dex_discovery_meta",
  ] as const;
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
        stmts.push(
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

  let candidateRowsWritten = 0;
  let currentGenerationRows = 0;
  try {
    // D1 batch limit — chunk candidate rows before a single current-table publish.
    await batchExecute(db, stmts, { signal });
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
    await pruneOldDexLiquidityGenerations(db, nowSec, signal);
  } catch (err) {
    if (!signal?.aborted) {
      try {
        await markDexLiquidityPublicationGenerationFailed(
          db,
          generationId,
          nowSec,
          toErrorMessage(err),
        );
      } catch {
        // Best-effort diagnostics only; preserve the original publication error.
      }
    }
    rethrowIfAborted(err, signal);
    throw err;
  }

  console.log(
    `[dex-liquidity] Published ${currentGenerationRows} current rows from ${generationId} (${activeMetrics.size} active with data, ${placeholderCount} zero, ${inactiveMetricIdsSkipped.length} inactive skipped, 1 global)`,
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
  };
}

/** Write daily snapshot rows (first sync invocation after UTC midnight). */
export async function writeHistoricalSnapshots(
  db: D1Database,
  scoreMap: Map<string, FullScoreResult>,
  signal?: AbortSignal,
): Promise<HistoricalSnapshotWriteResult> {
  const todayMidnight = Math.floor(Date.now() / 86_400_000) * 86_400; // epoch seconds at UTC midnight
  const expectedRowCount = ACTIVE_STABLECOINS.length;
  try {
    throwIfAborted(signal);
    const existing = await db
      .prepare(
        `SELECT
           COUNT(*) as cnt,
           SUM(CASE WHEN liquidity_score IS NOT NULL THEN 1 ELSE 0 END) as scored
         FROM dex_liquidity_history
         WHERE snapshot_date = ?`
      )
      .bind(todayMidnight)
      .first<{ cnt: number; scored: number | null }>();
    const existingCount = existing?.cnt ?? 0;
    const existingScored = existing?.scored ?? 0;
    const incomingScored = scoreMap.size;
    throwIfAborted(signal);

    // Keep repairing today's snapshot until coverage and scored-coin count are at least
    // as good as the current run (avoids locking in a degraded first post-midnight run).
    if (existingCount >= expectedRowCount && existingScored >= incomingScored) {
      return {
        snapshotRowsWritten: 0,
        skipped: true,
        writeFailed: false,
      };
    }

    const snapStmts: D1PreparedStatement[] = [];
    for (const [id, data] of scoreMap) {
      snapStmts.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO dex_liquidity_history
              (stablecoin_id, total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date,
               coverage_class, coverage_confidence, source_mix_json, methodology_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            id,
            data.tvl,
            data.vol24h,
            data.score,
            todayMidnight,
            data.coverageClass,
            data.coverageConfidence,
            JSON.stringify(data.sourceMix),
            LIQUIDITY_METHODOLOGY_VERSION,
          )
      );
    }
    // Also insert placeholder rows for coins without DEX presence (NULL score = NR)
    for (const meta of ACTIVE_STABLECOINS) {
      if (!scoreMap.has(meta.id)) {
        snapStmts.push(
          db
            .prepare(
              `INSERT OR REPLACE INTO dex_liquidity_history
                (stablecoin_id, total_tvl_usd, total_volume_24h_usd, liquidity_score, snapshot_date,
                 coverage_class, coverage_confidence, source_mix_json, methodology_version)
              VALUES (?, 0, 0, NULL, ?, 'unobserved', 0, NULL, ?)`
            )
            .bind(meta.id, todayMidnight, LIQUIDITY_METHODOLOGY_VERSION)
        );
      }
    }
    await batchExecute(db, snapStmts, { signal });
    console.log(
      `[dex-liquidity] Reconciled daily snapshot (${existingCount}/${existingScored} -> ${snapStmts.length}/${incomingScored}) for ${new Date(todayMidnight * 1000).toISOString().slice(0, 10)}`,
    );
    return {
      snapshotRowsWritten: snapStmts.length,
      skipped: false,
      writeFailed: false,
    };
  } catch (err) {
    rethrowIfAborted(err, signal);
    console.warn("[dex-liquidity] Daily snapshot failed:", err);
    return {
      snapshotRowsWritten: 0,
      skipped: false,
      writeFailed: true,
    };
  }
}
