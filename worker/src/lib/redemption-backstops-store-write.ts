import { RedemptionBackstopDetailsSchema, type RedemptionBackstopEntry } from "@shared/types/redemption";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { batchExecute } from "./db";
import { toErrorMessage } from "./error-utils";

export type RedemptionBackstopSnapshotRecord = RedemptionBackstopEntry;

export interface RedemptionBackstopRunRetentionResult {
  cutoff: number;
  runRowsDeletedCount: number;
  runsDeletedCount: number;
  historyCutoff: number;
  historyRowsDeletedCount: number;
  warnings: string[];
}

const REDEMPTION_BACKSTOP_RUN_RETENTION_SEC = 14 * DAY_SECONDS;
const REDEMPTION_BACKSTOP_RUN_RETENTION_BATCH_SIZE = 100;
/** Daily history has no current reader; retained 90 days for future track-record use (owner ruling 2026-07-22). */
const REDEMPTION_BACKSTOP_HISTORY_RETENTION_SEC = 90 * DAY_SECONDS;
const REDEMPTION_BACKSTOP_HISTORY_RETENTION_BATCH_SIZE = 500;

export const SNAPSHOT_ROW_COLUMNS = [
  "stablecoin_id",
  "score",
  "dex_liquidity_score",
  "access_score",
  "settlement_score",
  "execution_certainty_score",
  "capacity_score",
  "output_asset_quality_score",
  "cost_score",
  "route_family",
  "access_model",
  "settlement_model",
  "execution_model",
  "output_asset_type",
  "provider",
  "source_mode",
  "immediate_capacity_usd",
  "immediate_capacity_ratio",
  "fee_bps",
  "queue_enabled",
  "updated_at",
  "methodology_version",
  "details_json",
] as const;

const SNAPSHOT_ROW_UPDATE_COLUMNS = SNAPSHOT_ROW_COLUMNS.filter((column) => column !== "stablecoin_id");

function formatColumnList(columns: readonly string[]): string {
  return columns.map((column) => `         ${column}`).join(",\n");
}

function formatUpdateAssignments(columns: readonly string[]): string {
  return columns.map((column) => `         ${column} = excluded.${column}`).join(",\n");
}

function placeholderList(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function buildDetailsJson(record: RedemptionBackstopSnapshotRecord): string {
  return JSON.stringify(
    RedemptionBackstopDetailsSchema.parse({
      resolutionState: record.resolutionState,
      capacityConfidence: record.capacityConfidence,
      ...(record.capacityBasis ? { capacityBasis: record.capacityBasis } : {}),
      capacitySemantics: record.capacitySemantics,
      ...(record.capacityProfile ? { capacityProfile: record.capacityProfile } : {}),
      feeConfidence: record.feeConfidence,
      feeModelKind: record.feeModelKind,
      modelConfidence: record.modelConfidence,
      ...(record.confidenceDetails ? { confidenceDetails: record.confidenceDetails } : {}),
      routeStatus: record.routeStatus,
      routeStatusSource: record.routeStatusSource,
      ...(record.routeStatusReason ? { routeStatusReason: record.routeStatusReason } : {}),
      ...(record.routeStatusReviewedAt ? { routeStatusReviewedAt: record.routeStatusReviewedAt } : {}),
      holderEligibility: record.holderEligibility,
      routeFamily: record.routeFamily,
      provider: record.provider,
      sourceMode: record.sourceMode,
      immediateCapacityUsd: record.immediateCapacityUsd,
      immediateCapacityRatio: record.immediateCapacityRatio,
      ...(record.eventualRedeemabilityScore != null
        ? { eventualRedeemabilityScore: record.eventualRedeemabilityScore }
        : {}),
      ...(record.capacityKind ? { capacityKind: record.capacityKind } : {}),
      ...(record.freshnessKind ? { freshnessKind: record.freshnessKind } : {}),
      ...(record.sourceTimestamp != null ? { sourceTimestamp: record.sourceTimestamp } : {}),
      ...(record.sourceUrls ? { sourceUrls: record.sourceUrls } : {}),
      ...(record.settlementDelaySec != null ? { settlementDelaySec: record.settlementDelaySec } : {}),
      ...(record.queueDepthUsd != null ? { queueDepthUsd: record.queueDepthUsd } : {}),
      ...(record.dailyLimitUsd != null ? { dailyLimitUsd: record.dailyLimitUsd } : {}),
      ...(record.minRedeemUsd != null ? { minRedeemUsd: record.minRedeemUsd } : {}),
      ...(record.liveHolderEligibility ? { liveHolderEligibility: record.liveHolderEligibility } : {}),
      feeBps: record.feeBps,
      ...(record.costScenarioScores ? { costScenarioScores: record.costScenarioScores } : {}),
      ...(record.routeExitCorrelation ? { routeExitCorrelation: record.routeExitCorrelation } : {}),
      ...(record.docs ? { docs: record.docs } : {}),
      ...(record.notes ? { notes: record.notes } : {}),
      ...(record.capsApplied ? { capsApplied: record.capsApplied } : {}),
      ...(record.feeDescription ? { feeDescription: record.feeDescription } : {}),
    }),
  );
}

function buildSnapshotRowValues(record: RedemptionBackstopSnapshotRecord): unknown[] {
  return [
    record.stablecoinId,
    record.score,
    record.dexLiquidityScore,
    record.accessScore,
    record.settlementScore,
    record.executionCertaintyScore,
    record.capacityScore,
    record.outputAssetQualityScore,
    record.costScore,
    record.routeFamily,
    record.accessModel,
    record.settlementModel,
    record.executionModel,
    record.outputAssetType,
    record.provider,
    record.sourceMode,
    record.immediateCapacityUsd,
    record.immediateCapacityRatio,
    record.feeBps,
    record.queueEnabled ? 1 : 0,
    record.updatedAt,
    record.methodologyVersion,
    buildDetailsJson(record),
  ];
}

function buildRunRowUpsert(
  db: D1Database,
  record: RedemptionBackstopSnapshotRecord,
  runId: string,
): D1PreparedStatement {
  const columns = ["snapshot_run_id", ...SNAPSHOT_ROW_COLUMNS];
  return db
    .prepare(
      `INSERT INTO redemption_backstop_run_rows (
${formatColumnList(columns)}
       ) VALUES (${placeholderList(columns.length)})
       ON CONFLICT(snapshot_run_id, stablecoin_id) DO UPDATE SET
${formatUpdateAssignments(SNAPSHOT_ROW_UPDATE_COLUMNS)}`,
    )
    .bind(runId, ...buildSnapshotRowValues(record));
}

function buildHistoryUpsert(
  db: D1Database,
  record: RedemptionBackstopSnapshotRecord,
  snapshotDate: number,
  runId?: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR REPLACE INTO redemption_backstop_history (
         stablecoin_id,
         snapshot_date,
         score,
         dex_liquidity_score,
         updated_at,
         methodology_version,
         details_json,
         snapshot_run_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.stablecoinId,
      snapshotDate,
      record.score,
      record.dexLiquidityScore,
      record.updatedAt,
      record.methodologyVersion,
      buildDetailsJson(record),
      runId ?? null,
    );
}

function createRedemptionBackstopRunId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return `redemption:${cryptoObj.randomUUID()}`;
  return `redemption:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

function buildRunStartInsert(
  db: D1Database,
  args: {
    runId: string;
    startedAt: number;
    expectedCount: number;
    methodologyVersion: string;
    metadata?: Record<string, unknown>;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO redemption_backstop_runs (
         run_id,
         started_at,
         completed_at,
         status,
         expected_count,
         written_count,
         methodology_version,
         min_updated_at,
         max_updated_at,
         metadata_json
       ) VALUES (?, ?, NULL, 'running', ?, 0, ?, NULL, NULL, ?)`,
    )
    .bind(
      args.runId,
      args.startedAt,
      args.expectedCount,
      args.methodologyVersion,
      args.metadata ? JSON.stringify(args.metadata) : null,
    );
}

function buildRunCompleteUpdate(
  db: D1Database,
  args: {
    runId: string;
    completedAt: number;
    writtenCount: number;
    minUpdatedAt: number | null;
    maxUpdatedAt: number | null;
    metadata?: Record<string, unknown>;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE redemption_backstop_runs
          SET completed_at = ?,
              status = 'completed',
              written_count = ?,
              min_updated_at = ?,
              max_updated_at = ?,
              metadata_json = COALESCE(?, metadata_json)
        WHERE run_id = ?
          AND status = 'running'`,
    )
    .bind(
      args.completedAt,
      args.writtenCount,
      args.minUpdatedAt,
      args.maxUpdatedAt,
      args.metadata ? JSON.stringify(args.metadata) : null,
      args.runId,
    );
}

async function updateRedemptionBackstopRunMetadata(
  db: D1Database,
  runId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `UPDATE redemption_backstop_runs
            SET metadata_json = ?
          WHERE run_id = ?`,
      )
      .bind(JSON.stringify(metadata), runId)
      .run(),
  );
}

function buildRunFailedUpdate(
  db: D1Database,
  args: {
    runId: string;
    completedAt: number;
    writtenCount: number;
    metadata: Record<string, unknown>;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE redemption_backstop_runs
          SET completed_at = ?,
              status = 'failed',
              written_count = ?,
              metadata_json = ?
        WHERE run_id = ?
          AND status = 'running'`,
    )
    .bind(args.completedAt, args.writtenCount, JSON.stringify(args.metadata), args.runId);
}

function resolveRunBounds(records: RedemptionBackstopSnapshotRecord[]): {
  minUpdatedAt: number | null;
  maxUpdatedAt: number | null;
} {
  if (records.length === 0) return { minUpdatedAt: null, maxUpdatedAt: null };
  let minUpdatedAt = records[0].updatedAt;
  let maxUpdatedAt = records[0].updatedAt;
  for (const record of records) {
    minUpdatedAt = Math.min(minUpdatedAt, record.updatedAt);
    maxUpdatedAt = Math.max(maxUpdatedAt, record.updatedAt);
  }
  return { minUpdatedAt, maxUpdatedAt };
}

function buildWriteMetadata(
  baseMetadata: Record<string, unknown> | undefined,
  facts: {
    runId: string;
    attemptedCount: number;
    expectedCount: number;
    runRowsWrittenCount: number;
    historyWrittenCount: number;
    retentionCutoff?: number | null;
    retentionRunRowsDeletedCount?: number;
    retentionRunsDeletedCount?: number;
    warnings?: string[];
    writeStatus?: string;
    writePhase?: string;
    failure?: Record<string, unknown>;
  },
): Record<string, unknown> {
  return {
    ...(baseMetadata ?? {}),
    snapshotRunId: facts.runId,
    attemptedCount: facts.attemptedCount,
    expectedCount: facts.expectedCount,
    runRowsWrittenCount: facts.runRowsWrittenCount,
    historyWrittenCount: facts.historyWrittenCount,
    failedWriteCount: Math.max(0, facts.attemptedCount - facts.runRowsWrittenCount),
    ...(facts.retentionCutoff != null ? { retentionCutoff: facts.retentionCutoff } : {}),
    ...(facts.retentionRunRowsDeletedCount != null
      ? { retentionRunRowsDeletedCount: facts.retentionRunRowsDeletedCount }
      : {}),
    ...(facts.retentionRunsDeletedCount != null ? { retentionRunsDeletedCount: facts.retentionRunsDeletedCount } : {}),
    ...(facts.writeStatus ? { writeStatus: facts.writeStatus } : {}),
    ...(facts.writePhase ? { writePhase: facts.writePhase } : {}),
    ...(facts.warnings && facts.warnings.length > 0 ? { writeWarnings: facts.warnings } : {}),
    ...(facts.failure ? { failure: facts.failure } : {}),
  };
}

function prunableRedemptionBackstopRunsSubquery(): string {
  return `SELECT run_id
            FROM redemption_backstop_runs
           WHERE COALESCE(completed_at, started_at) < ?
             AND run_id <> ?
             AND run_id NOT IN (
               SELECT run_id
                 FROM redemption_backstop_runs
                WHERE status = 'completed'
                ORDER BY completed_at DESC, started_at DESC, run_id DESC
                LIMIT 1
             )
           LIMIT ?`;
}

async function deleteOrphanRedemptionBackstopRunRowsBatch(
  db: D1Database,
  args: { batchSize: number },
): Promise<number> {
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `DELETE FROM redemption_backstop_run_rows
          WHERE snapshot_run_id IN (
            SELECT snapshot_run_id
              FROM redemption_backstop_run_rows AS rr
             WHERE NOT EXISTS (
               SELECT 1
                 FROM redemption_backstop_runs AS manifest
                WHERE manifest.run_id = rr.snapshot_run_id
             )
             LIMIT ?
          )`,
      )
      .bind(args.batchSize)
      .run(),
  );
  return Number(result.meta?.changes ?? 0);
}

async function deleteRedemptionBackstopHistoryBatch(
  db: D1Database,
  args: { cutoffDate: number; batchSize: number },
): Promise<number> {
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `DELETE FROM redemption_backstop_history
          WHERE rowid IN (
            SELECT rowid
              FROM redemption_backstop_history
             WHERE snapshot_date < ?
             LIMIT ?
          )`,
      )
      .bind(args.cutoffDate, args.batchSize)
      .run(),
  );
  return Number(result.meta?.changes ?? 0);
}

async function deleteRedemptionBackstopRunsBatch(
  db: D1Database,
  args: { cutoff: number; preserveRunId: string; batchSize: number },
): Promise<number> {
  const result = await runWithOverloadRetry(() =>
    db
      .prepare(
        `DELETE FROM redemption_backstop_runs
          WHERE run_id IN (${prunableRedemptionBackstopRunsSubquery()})`,
      )
      .bind(args.cutoff, args.preserveRunId, args.batchSize)
      .run(),
  );
  return Number(result.meta?.changes ?? 0);
}

export async function pruneRedemptionBackstopRunRetention(
  db: D1Database,
  input: {
    nowSec?: number;
    retentionSec?: number;
    historyRetentionSec?: number;
    preserveRunId: string;
    batchSize?: number;
  },
): Promise<RedemptionBackstopRunRetentionResult> {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const retentionSec = input.retentionSec ?? REDEMPTION_BACKSTOP_RUN_RETENTION_SEC;
  const batchSize = input.batchSize ?? REDEMPTION_BACKSTOP_RUN_RETENTION_BATCH_SIZE;
  const cutoff = nowSec - retentionSec;
  let runRowsDeletedCount = 0;
  let runsDeletedCount = 0;
  const warnings: string[] = [];

  try {
    for (;;) {
      const deletedRuns = await deleteRedemptionBackstopRunsBatch(db, {
        cutoff,
        preserveRunId: input.preserveRunId,
        batchSize,
      });
      runsDeletedCount += deletedRuns;
      if (deletedRuns < batchSize) break;
    }
  } catch (error) {
    const message = toErrorMessage(error);
    warnings.push(`Run manifest retention prune failed: ${message}`);
  }

  try {
    for (;;) {
      const deletedRows = await deleteOrphanRedemptionBackstopRunRowsBatch(db, { batchSize });
      runRowsDeletedCount += deletedRows;
      if (deletedRows < batchSize) break;
    }
  } catch (error) {
    const message = toErrorMessage(error);
    warnings.push(`Run-row retention prune failed: ${message}`);
  }

  const historyCutoff = nowSec - (input.historyRetentionSec ?? REDEMPTION_BACKSTOP_HISTORY_RETENTION_SEC);
  let historyRowsDeletedCount = 0;
  try {
    for (;;) {
      const deletedHistory = await deleteRedemptionBackstopHistoryBatch(db, {
        cutoffDate: historyCutoff,
        batchSize: REDEMPTION_BACKSTOP_HISTORY_RETENTION_BATCH_SIZE,
      });
      historyRowsDeletedCount += deletedHistory;
      if (deletedHistory < REDEMPTION_BACKSTOP_HISTORY_RETENTION_BATCH_SIZE) break;
    }
  } catch (error) {
    const message = toErrorMessage(error);
    warnings.push(`Daily-history retention prune failed: ${message}`);
  }

  return {
    cutoff,
    runRowsDeletedCount,
    runsDeletedCount,
    historyCutoff,
    historyRowsDeletedCount,
    warnings,
  };
}

async function countRunRows(
  db: D1Database,
  runId: string,
): Promise<{ rowCount: number; minUpdatedAt: number | null; maxUpdatedAt: number | null }> {
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT COUNT(*) AS row_count,
                MIN(updated_at) AS min_updated_at,
                MAX(updated_at) AS max_updated_at
           FROM redemption_backstop_run_rows
          WHERE snapshot_run_id = ?`,
      )
      .bind(runId)
      .first<{ row_count: number | null; min_updated_at: number | null; max_updated_at: number | null }>(),
  );
  return {
    rowCount: Number(row?.row_count ?? 0),
    minUpdatedAt: row?.min_updated_at ?? null,
    maxUpdatedAt: row?.max_updated_at ?? null,
  };
}

export async function upsertRedemptionBackstopSnapshots(
  db: D1Database,
  records: RedemptionBackstopSnapshotRecord[],
  options?: {
    expectedCount?: number;
    metadata?: Record<string, unknown>;
    runId?: string;
    retentionSec?: number;
    nowSec?: number;
  },
) {
  if (records.length === 0) {
    return {
      runId: options?.runId ?? "",
      attemptedCount: 0,
      runRowsWrittenCount: 0,
      historyWrittenCount: 0,
      retentionCutoff: null,
      retentionRunRowsDeletedCount: 0,
      retentionRunsDeletedCount: 0,
      warnings: ["No redemption backstop records were supplied"],
    };
  }

  const uniqueStablecoinIds = new Set(records.map((record) => record.stablecoinId));
  if (uniqueStablecoinIds.size !== records.length) {
    throw new Error("Duplicate stablecoin IDs in redemption backstop snapshot records");
  }

  const runId = options?.runId ?? createRedemptionBackstopRunId();
  const startedAt = Math.floor(Date.now() / 1000);
  const snapshotDate = Math.floor(Date.now() / 1000 / DAY_SECONDS) * DAY_SECONDS;
  const expectedCount = options?.expectedCount ?? records.length;
  const attemptedCount = records.length;
  let runStarted = false;
  let runRowsWrittenCount = 0;
  let historyWrittenCount = 0;
  let retentionRunRowsDeletedCount = 0;
  let retentionRunsDeletedCount = 0;
  let retentionCutoff: number | null = null;
  let writePhase = "starting";

  try {
    await runWithOverloadRetry(() =>
      buildRunStartInsert(db, {
        runId,
        startedAt,
        expectedCount,
        methodologyVersion: records[0].methodologyVersion,
        metadata: buildWriteMetadata(options?.metadata, {
          runId,
          attemptedCount,
          expectedCount,
          runRowsWrittenCount,
          historyWrittenCount,
          retentionRunRowsDeletedCount,
          retentionRunsDeletedCount,
          writeStatus: "running",
          writePhase,
        }),
      }).run(),
    );
    runStarted = true;

    writePhase = "run-rows";
    const runRowStatements: D1PreparedStatement[] = [];
    for (const record of records) {
      runRowStatements.push(buildRunRowUpsert(db, record, runId));
    }
    // Run rows are the immutable snapshot source. They must be complete before
    // the run can become readable.
    runRowsWrittenCount = await batchExecute(db, runRowStatements, 30);

    const rowCount = await countRunRows(db, runId);
    runRowsWrittenCount = rowCount.rowCount;
    if (rowCount.rowCount !== records.length) {
      throw new Error(`Redemption backstop run ${runId} wrote ${rowCount.rowCount}/${records.length} immutable rows`);
    }

    writePhase = "history";
    const historyStatements = records.map((record) => buildHistoryUpsert(db, record, snapshotDate, runId));
    historyWrittenCount = await batchExecute(db, historyStatements, 80);

    const recordBounds = resolveRunBounds(records);
    const minUpdatedAt = rowCount.minUpdatedAt ?? recordBounds.minUpdatedAt;
    const maxUpdatedAt = rowCount.maxUpdatedAt ?? recordBounds.maxUpdatedAt;
    writePhase = "complete-manifest";
    const completion = await runWithOverloadRetry(() =>
      buildRunCompleteUpdate(db, {
        runId,
        completedAt: Math.floor(Date.now() / 1000),
        writtenCount: rowCount.rowCount,
        minUpdatedAt,
        maxUpdatedAt,
        metadata: buildWriteMetadata(options?.metadata, {
          runId,
          attemptedCount,
          expectedCount,
          runRowsWrittenCount: rowCount.rowCount,
          historyWrittenCount,
          retentionRunRowsDeletedCount,
          retentionRunsDeletedCount,
          writeStatus: "completed",
          writePhase,
        }),
      }).run(),
    );
    if ((completion.meta?.changes ?? 0) <= 0) {
      throw new Error(`Failed to mark redemption backstop run ${runId} completed`);
    }

    const warnings: string[] = [];
    writePhase = "retention";
    try {
      const retention = await pruneRedemptionBackstopRunRetention(db, {
        preserveRunId: runId,
        retentionSec: options?.retentionSec,
        nowSec: options?.nowSec,
      });
      retentionCutoff = retention.cutoff;
      retentionRunRowsDeletedCount = retention.runRowsDeletedCount;
      retentionRunsDeletedCount = retention.runsDeletedCount;
      warnings.push(...retention.warnings);
    } catch (error) {
      const message = toErrorMessage(error);
      warnings.push(`Run retention prune failed after completed snapshot write: ${message}`);
    }

    try {
      await updateRedemptionBackstopRunMetadata(
        db,
        runId,
        buildWriteMetadata(options?.metadata, {
          runId,
          attemptedCount,
          expectedCount,
          runRowsWrittenCount: rowCount.rowCount,
          historyWrittenCount,
          retentionCutoff,
          retentionRunRowsDeletedCount,
          retentionRunsDeletedCount,
          warnings,
          writeStatus: warnings.length > 0 ? "completed-with-warnings" : "completed",
          writePhase,
        }),
      );
    } catch (error) {
      const message = toErrorMessage(error);
      warnings.push(`Completed run metadata refresh failed after retention prune: ${message}`);
    }

    return {
      runId,
      attemptedCount,
      runRowsWrittenCount: rowCount.rowCount,
      historyWrittenCount,
      retentionCutoff,
      retentionRunRowsDeletedCount,
      retentionRunsDeletedCount,
      warnings,
    };
  } catch (error) {
    if (runStarted) {
      const message = toErrorMessage(error);
      try {
        await runWithOverloadRetry(() =>
          buildRunFailedUpdate(db, {
            runId,
            completedAt: Math.floor(Date.now() / 1000),
            writtenCount: runRowsWrittenCount,
            metadata: buildWriteMetadata(options?.metadata, {
              runId,
              attemptedCount,
              expectedCount,
              runRowsWrittenCount,
              historyWrittenCount,
              retentionRunRowsDeletedCount,
              retentionRunsDeletedCount,
              writeStatus: "failed",
              writePhase,
              failure: {
                message,
                name: error instanceof Error ? error.name : "Error",
              },
            }),
          }).run(),
        );
      } catch {
        // Preserve the original write failure; a later sync can supersede the stale running manifest.
      }
    }
    throw error;
  }
}
