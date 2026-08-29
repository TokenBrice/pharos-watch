import { ACTIVE_IDS, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { bucketUnixMillisecondsToUtcDay } from "@shared/lib/time-buckets";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { batchExecute, executeAtomicBatch } from "../../lib/db";
import { toErrorMessage } from "@shared/lib/error-utils";
import { logWorkerEventArgs } from "../../lib/structured-log";

/** Limit the lifetime of prepared statements carrying serialized price/depth data. */
export const DEX_LIQUIDITY_SCORING_BATCH_SIZE = 25;

const DEX_LIQUIDITY_EXPECTED_GENERATION_ROWS = ACTIVE_STABLECOINS.length + 1;
const DEX_PRICE_STAGE_RETENTION_SEC = 3 * 60 * 60;
export const DEX_PRICE_STAGE_RETENTION_GENERATIONS_PER_RUN = 8;

interface DexScoringGenerationCoverage {
  state: string;
  expected_row_count: number;
  current_row_count: number | null;
  staged_row_count: number;
  public_row_count: number;
}

export async function loadCurrentDexScoringGenerationId(
  db: D1Database,
  signal?: AbortSignal,
): Promise<string | null> {
  throwIfAborted(signal);
  const row = await db
    .prepare(
      `SELECT generation_id
       FROM dex_liquidity_publication_generations
       WHERE state = 'published'
       ORDER BY published_at DESC, started_at DESC
       LIMIT 1`,
    )
    .first<{ generation_id: string }>();
  throwIfAborted(signal);
  return row?.generation_id?.trim() || null;
}

export async function assertCurrentDexScoringGeneration(
  db: D1Database,
  generationId: string,
  signal?: AbortSignal,
  options?: {
    /**
     * Publish-path callers authored the generation's rows under the running
     * bundle's roster in this same run, so they additionally pin the
     * generation's expectation to the build-time roster count. Reuse-path
     * callers omit this: a published generation from a pre-roster-change
     * deploy stays valid until the next publication slot replaces it.
     */
    requireRosterExpectation?: boolean;
  },
): Promise<void> {
  throwIfAborted(signal);
  const coverage = await db
    .prepare(
      `/* pharos:dex-scoring:current-generation */
       SELECT generation.state,
              generation.expected_row_count,
              generation.current_row_count,
              (SELECT COUNT(*)
               FROM dex_liquidity_run_rows staged
               WHERE staged.generation_id = generation.generation_id) AS staged_row_count,
              (SELECT COUNT(*)
               FROM dex_liquidity current
               WHERE current.publication_generation_id = generation.generation_id
                 AND current.publication_state = 'published') AS public_row_count
       FROM dex_liquidity_publication_generations generation
       WHERE generation.generation_id = ?`,
    )
    .bind(generationId)
    .first<DexScoringGenerationCoverage>();
  throwIfAborted(signal);

  if (
    coverage?.state !== "published" ||
    coverage.expected_row_count <= 0 ||
    coverage.current_row_count !== coverage.expected_row_count ||
    coverage.staged_row_count !== coverage.expected_row_count ||
    coverage.public_row_count !== coverage.expected_row_count ||
    (options?.requireRosterExpectation === true &&
      coverage.expected_row_count !== DEX_LIQUIDITY_EXPECTED_GENERATION_ROWS)
  ) {
    throw new Error(
      `DEX scoring generation ${generationId} is not the complete current publication` +
        ` (state=${coverage?.state ?? "missing"}, expected=${coverage?.expected_row_count ?? 0},` +
        ` current=${coverage?.current_row_count ?? 0}, staged=${coverage?.staged_row_count ?? 0},` +
        ` public=${coverage?.public_row_count ?? 0},` +
        ` rosterExpected=${DEX_LIQUIDITY_EXPECTED_GENERATION_ROWS})`,
    );
  }
}

/** @internal Exported for focused retention tests. */
export interface DexPriceStageRetentionResult {
  cutoff: number;
  deletedRows: number;
  oldestRemainingAt: number | null;
  durationMs: number;
  error: string | null;
}

export async function pruneExpiredDexPriceStages(
  db: D1Database,
  protectedGenerationId: string,
  nowSec: number,
  signal?: AbortSignal,
): Promise<DexPriceStageRetentionResult> {
  const startedAtMs = Date.now();
  const cutoff = Math.max(0, Math.floor(nowSec) - DEX_PRICE_STAGE_RETENTION_SEC);
  const result: DexPriceStageRetentionResult = {
    cutoff,
    deletedRows: 0,
    oldestRemainingAt: null,
    durationMs: 0,
    error: null,
  };
  try {
    throwIfAborted(signal);
    const deleted = await runWithOverloadRetry(
      () => db
        .prepare(
          `/* pharos:dex-scoring:price-stage-retention */
           DELETE FROM dex_price_run_rows
           WHERE generation_id IN (
             SELECT candidate.generation_id
             FROM dex_price_run_rows candidate
             WHERE candidate.generation_id != ?
               AND NOT EXISTS (
                 SELECT 1
                 FROM dex_liquidity current_global
                 WHERE current_global.stablecoin_id = '__global__'
                   AND current_global.publication_state = 'published'
                   AND current_global.publication_generation_id = candidate.generation_id
               )
               AND NOT EXISTS (
                 SELECT 1
                   FROM dex_liquidity_publication_generations active
                  WHERE active.generation_id = candidate.generation_id
                    AND active.state = 'staged'
               )
             GROUP BY candidate.generation_id
             HAVING MAX(candidate.updated_at) < ?
             ORDER BY MIN(candidate.updated_at), candidate.generation_id
             LIMIT ?
           )`,
        )
        .bind(
          protectedGenerationId,
          cutoff,
          DEX_PRICE_STAGE_RETENTION_GENERATIONS_PER_RUN,
        )
        .run(),
      3,
      signal,
    );
    result.deletedRows = Number(deleted.meta?.changes ?? 0);
    const oldest = await runWithOverloadRetry(
      () => db
        .prepare("SELECT MIN(updated_at) AS oldest_remaining_at FROM dex_price_run_rows")
        .first<{ oldest_remaining_at: number | null }>(),
      3,
      signal,
    );
    result.oldestRemainingAt = oldest?.oldest_remaining_at ?? null;
  } catch (error) {
    rethrowIfAborted(error, signal);
    result.error = toErrorMessage(error).slice(0, 500);
  }
  result.durationMs = Math.max(0, Date.now() - startedAtMs);
  return result;
}

export async function flushScoringStatements(
  db: D1Database,
  statements: D1PreparedStatement[],
  signal?: AbortSignal,
): Promise<void> {
  if (statements.length === 0) return;
  let batch: D1PreparedStatement[] | null = statements.splice(0, statements.length);
  try {
    await batchExecute(db, batch, {
      chunkSize: DEX_LIQUIDITY_SCORING_BATCH_SIZE,
      signal,
    });
  } finally {
    batch = null;
  }
}

const HISTORY_CONFIDENCE_MIN = 0.75;
const MIN_STABILITY_SAMPLES = 7;
const HISTORY_STABILITY_BATCH_SIZE = 512;

/** @internal Exported for testing only. */
export function computeSeriesStability(values: number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < MIN_STABILITY_SAMPLES) return null;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  if (mean <= 0) return null;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
  const cv = Math.sqrt(Math.max(0, variance)) / mean;
  return Math.round((1 - Math.min(1, cv)) * 10000) / 10000;
}

/** @internal Exported for testing only. */
export async function loadConfidentHistoryStability(db: D1Database): Promise<{
  tvlStabilityMap: Map<string, number>;
  volumeStabilityMap: Map<string, number>;
}> {
  const todayMidnight = bucketUnixMillisecondsToUtcDay(Date.now()) / 1000;
  const thirtyDaysAgo = todayMidnight - 30 * 86_400;
  const tvlStabilityMap = new Map<string, number>();
  const volumeStabilityMap = new Map<string, number>();

  const tvlByCoin = new Map<string, number[]>();
  const volumeByCoin = new Map<string, number[]>();
  let cursorStablecoinId = "";
  let cursorSnapshotDate = -1;

  while (true) {
    const historyResult = await db
      .prepare(
        `SELECT stablecoin_id, snapshot_date, total_tvl_usd, total_volume_24h_usd, coverage_confidence
         FROM dex_liquidity_history
         WHERE snapshot_date >= ?
           AND (stablecoin_id > ? OR (stablecoin_id = ? AND snapshot_date > ?))
         ORDER BY stablecoin_id, snapshot_date
         LIMIT ?`,
      )
      .bind(
        thirtyDaysAgo,
        cursorStablecoinId,
        cursorStablecoinId,
        cursorSnapshotDate,
        HISTORY_STABILITY_BATCH_SIZE,
      )
      .all<{
        stablecoin_id: string;
        snapshot_date: number;
        total_tvl_usd: number;
        total_volume_24h_usd: number;
        coverage_confidence: number | null;
      }>();
    const rows: Array<
      | {
          stablecoin_id: string;
          snapshot_date: number;
          total_tvl_usd: number;
          total_volume_24h_usd: number;
          coverage_confidence: number | null;
        }
      | undefined
    > = historyResult.results ?? [];
    const rowCount = rows.length;
    if (rowCount === 0) break;

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      rows[rowIndex] = undefined;
      if (!row) continue;
      cursorStablecoinId = row.stablecoin_id;
      cursorSnapshotDate = row.snapshot_date;

      const confidence = row.coverage_confidence ?? 0;
      if (confidence < HISTORY_CONFIDENCE_MIN) continue;

      const tvlSeries = tvlByCoin.get(row.stablecoin_id) ?? [];
      tvlSeries.push(row.total_tvl_usd);
      tvlByCoin.set(row.stablecoin_id, tvlSeries);

      const volumeSeries = volumeByCoin.get(row.stablecoin_id) ?? [];
      volumeSeries.push(row.total_volume_24h_usd);
      volumeByCoin.set(row.stablecoin_id, volumeSeries);
    }
    rows.length = 0;
    if (rowCount < HISTORY_STABILITY_BATCH_SIZE) break;
  }

  for (const [coinId, tvls] of tvlByCoin) {
    const stability = computeSeriesStability(tvls);
    if (stability != null) {
      tvlStabilityMap.set(coinId, stability);
    }
  }
  for (const [coinId, volumes] of volumeByCoin) {
    const stability = computeSeriesStability(volumes);
    if (stability != null) {
      volumeStabilityMap.set(coinId, stability);
    }
  }

  return { tvlStabilityMap, volumeStabilityMap };
}

/** Compute depth stability (CV-based) and persist to D1. Accepts pre-loaded data to avoid redundant DB scan. */
export async function computeDepthStability(
  db: D1Database,
  preloadedTvlStabilityMap: Map<string, number> | undefined,
  generationId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!generationId.trim()) throw new Error("DEX depth stability requires a publication generation id");
  throwIfAborted(signal);
  const tvlStabilityMap = preloadedTvlStabilityMap ?? (await loadConfidentHistoryStability(db)).tvlStabilityMap;
  await assertCurrentDexScoringGeneration(db, generationId, signal, { requireRosterExpectation: true });

  const stabilityStmts: D1PreparedStatement[] = [];
  const queueStabilityStatement = async (statement: D1PreparedStatement): Promise<void> => {
    stabilityStmts.push(statement);
    if (stabilityStmts.length >= DEX_LIQUIDITY_SCORING_BATCH_SIZE) {
      await flushScoringStatements(db, stabilityStmts, signal);
    }
  };
  await queueStabilityStatement(
    db
      .prepare(
        `UPDATE dex_liquidity_run_rows
         SET depth_stability = NULL
         WHERE generation_id = ? AND stablecoin_id != '__global__'`,
      )
      .bind(generationId),
  );
  let stagedStabilityCount = 0;
  for (const [id, stability] of tvlStabilityMap) {
    throwIfAborted(signal);
    if (!ACTIVE_IDS.has(id)) continue;
    stagedStabilityCount++;
    await queueStabilityStatement(
      db
        .prepare(
          `UPDATE dex_liquidity_run_rows
           SET depth_stability = ?
           WHERE stablecoin_id = ? AND generation_id = ?`,
        )
        .bind(stability, id, generationId),
    );
  }
  await flushScoringStatements(db, stabilityStmts, signal);

  const staged = await db
    .prepare(
      `/* pharos:dex-scoring:depth-stage-coverage */
       SELECT COUNT(*) AS row_count,
              COALESCE(SUM(CASE WHEN depth_stability IS NOT NULL THEN 1 ELSE 0 END), 0) AS stability_count
       FROM dex_liquidity_run_rows
       WHERE generation_id = ? AND stablecoin_id != '__global__'`,
    )
    .bind(generationId)
    .first<{ row_count: number; stability_count: number }>();
  if (staged?.row_count !== ACTIVE_STABLECOINS.length || staged.stability_count !== stagedStabilityCount) {
    throw new Error(
      `Incomplete DEX depth stability stage for ${generationId}` +
        ` (rows=${staged?.row_count ?? 0}/${ACTIVE_STABLECOINS.length},` +
        ` values=${staged?.stability_count ?? 0}/${stagedStabilityCount})`,
    );
  }

  await assertCurrentDexScoringGeneration(db, generationId, signal, { requireRosterExpectation: true });
  const publishedChanges = await executeAtomicBatch(
    db,
    [
      db
        .prepare(
          `UPDATE dex_liquidity
           SET depth_stability = (
             SELECT staged.depth_stability
             FROM dex_liquidity_run_rows staged
             WHERE staged.generation_id = ?
               AND staged.stablecoin_id = dex_liquidity.stablecoin_id
           )
           WHERE publication_generation_id = ?
             AND publication_state = 'published'
             AND stablecoin_id != '__global__'`,
        )
        .bind(generationId, generationId),
    ],
    { signal },
  );
  if (publishedChanges !== ACTIVE_STABLECOINS.length) {
    throw new Error(
      `DEX depth stability publication changed ${publishedChanges}/${ACTIVE_STABLECOINS.length} current rows`,
    );
  }
  logWorkerEventArgs("handler", "info", `[dex-liquidity] Published depth stability for ${stagedStabilityCount} coins from ${generationId}`);
}
