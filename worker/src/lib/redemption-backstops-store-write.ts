import { RedemptionBackstopDetailsSchema, type RedemptionBackstopEntry } from "@shared/types/redemption";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { runWithOverloadRetry } from "./cron-lease";

export type RedemptionBackstopSnapshotRecord = RedemptionBackstopEntry;

export interface RedemptionBackstopSnapshotWriteResult {
  runId: string;
  attemptedCount: number;
  runRowsWrittenCount: number;
  historyWrittenCount: number;
  currentMirroredCount: number;
  warnings: string[];
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

function buildCurrentUpsert(
  db: D1Database,
  record: RedemptionBackstopSnapshotRecord,
  runId?: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO redemption_backstop (
         stablecoin_id,
         score,
         effective_exit_score,
         dex_liquidity_score,
         access_score,
         settlement_score,
         execution_certainty_score,
         capacity_score,
         output_asset_quality_score,
         cost_score,
         route_family,
         access_model,
         settlement_model,
         execution_model,
         output_asset_type,
         provider,
         source_mode,
         immediate_capacity_usd,
         immediate_capacity_ratio,
         fee_bps,
         queue_enabled,
         updated_at,
         methodology_version,
         details_json,
         snapshot_run_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(stablecoin_id) DO UPDATE SET
         score = excluded.score,
         effective_exit_score = excluded.effective_exit_score,
         dex_liquidity_score = excluded.dex_liquidity_score,
         access_score = excluded.access_score,
         settlement_score = excluded.settlement_score,
         execution_certainty_score = excluded.execution_certainty_score,
         capacity_score = excluded.capacity_score,
         output_asset_quality_score = excluded.output_asset_quality_score,
         cost_score = excluded.cost_score,
         route_family = excluded.route_family,
         access_model = excluded.access_model,
         settlement_model = excluded.settlement_model,
         execution_model = excluded.execution_model,
         output_asset_type = excluded.output_asset_type,
         provider = excluded.provider,
         source_mode = excluded.source_mode,
         immediate_capacity_usd = excluded.immediate_capacity_usd,
         immediate_capacity_ratio = excluded.immediate_capacity_ratio,
         fee_bps = excluded.fee_bps,
         queue_enabled = excluded.queue_enabled,
         updated_at = excluded.updated_at,
         methodology_version = excluded.methodology_version,
         details_json = excluded.details_json,
         snapshot_run_id = excluded.snapshot_run_id`,
    )
    .bind(
      record.stablecoinId,
      record.score,
      record.effectiveExitScore,
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
      runId ?? null,
    );
}

function buildRunRowUpsert(
  db: D1Database,
  record: RedemptionBackstopSnapshotRecord,
  runId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO redemption_backstop_run_rows (
         snapshot_run_id,
         stablecoin_id,
         score,
         effective_exit_score,
         dex_liquidity_score,
         access_score,
         settlement_score,
         execution_certainty_score,
         capacity_score,
         output_asset_quality_score,
         cost_score,
         route_family,
         access_model,
         settlement_model,
         execution_model,
         output_asset_type,
         provider,
         source_mode,
         immediate_capacity_usd,
         immediate_capacity_ratio,
         fee_bps,
         queue_enabled,
         updated_at,
         methodology_version,
         details_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(snapshot_run_id, stablecoin_id) DO UPDATE SET
         score = excluded.score,
         effective_exit_score = excluded.effective_exit_score,
         dex_liquidity_score = excluded.dex_liquidity_score,
         access_score = excluded.access_score,
         settlement_score = excluded.settlement_score,
         execution_certainty_score = excluded.execution_certainty_score,
         capacity_score = excluded.capacity_score,
         output_asset_quality_score = excluded.output_asset_quality_score,
         cost_score = excluded.cost_score,
         route_family = excluded.route_family,
         access_model = excluded.access_model,
         settlement_model = excluded.settlement_model,
         execution_model = excluded.execution_model,
         output_asset_type = excluded.output_asset_type,
         provider = excluded.provider,
         source_mode = excluded.source_mode,
         immediate_capacity_usd = excluded.immediate_capacity_usd,
         immediate_capacity_ratio = excluded.immediate_capacity_ratio,
         fee_bps = excluded.fee_bps,
         queue_enabled = excluded.queue_enabled,
         updated_at = excluded.updated_at,
         methodology_version = excluded.methodology_version,
         details_json = excluded.details_json`,
    )
    .bind(
      runId,
      record.stablecoinId,
      record.score,
      record.effectiveExitScore,
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
    );
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
         effective_exit_score,
         dex_liquidity_score,
         updated_at,
         methodology_version,
         details_json,
         snapshot_run_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.stablecoinId,
      snapshotDate,
      record.score,
      record.effectiveExitScore,
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

export async function updateRedemptionBackstopRunMetadata(
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
    currentMirroredCount: number;
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
    currentMirroredCount: facts.currentMirroredCount,
    failedWriteCount: Math.max(0, facts.attemptedCount - facts.runRowsWrittenCount),
    ...(facts.writeStatus ? { writeStatus: facts.writeStatus } : {}),
    ...(facts.writePhase ? { writePhase: facts.writePhase } : {}),
    ...(facts.warnings && facts.warnings.length > 0 ? { writeWarnings: facts.warnings } : {}),
    ...(facts.failure ? { failure: facts.failure } : {}),
  };
}

async function executeStatementChunks(
  db: D1Database,
  statements: D1PreparedStatement[],
  chunkSize: number,
): Promise<number> {
  let changes = 0;
  for (let index = 0; index < statements.length; index += chunkSize) {
    const result = await runWithOverloadRetry(() => db.batch(statements.slice(index, index + chunkSize)));
    for (const row of result) {
      changes += Number(row?.meta?.changes ?? 0);
    }
  }
  return changes;
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
  },
): Promise<RedemptionBackstopSnapshotWriteResult> {
  if (records.length === 0) {
    return {
      runId: options?.runId ?? "",
      attemptedCount: 0,
      runRowsWrittenCount: 0,
      historyWrittenCount: 0,
      currentMirroredCount: 0,
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
  let currentMirroredCount = 0;
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
          currentMirroredCount,
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
    // the run can become readable or any legacy current rows are touched.
    runRowsWrittenCount = await executeStatementChunks(db, runRowStatements, 30);

    const rowCount = await countRunRows(db, runId);
    runRowsWrittenCount = rowCount.rowCount;
    if (rowCount.rowCount !== records.length) {
      throw new Error(
        `Redemption backstop run ${runId} wrote ${rowCount.rowCount}/${records.length} immutable rows`,
      );
    }

    writePhase = "history";
    const historyStatements = records.map((record) => buildHistoryUpsert(db, record, snapshotDate, runId));
    historyWrittenCount = await executeStatementChunks(db, historyStatements, 80);

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
          currentMirroredCount,
          writeStatus: "completed",
          writePhase,
        }),
      }).run(),
    );
    if ((completion.meta?.changes ?? 0) <= 0) {
      throw new Error(`Failed to mark redemption backstop run ${runId} completed`);
    }

    writePhase = "current-mirror";
    const currentStatements = records.map((record) => buildCurrentUpsert(db, record, runId));
    const warnings: string[] = [];
    try {
      currentMirroredCount = await executeStatementChunks(db, currentStatements, 30);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Current mirror update failed after completed run rows were written: ${message}`);
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
            currentMirroredCount,
            warnings,
            writeStatus: "completed-with-warnings",
            writePhase,
          }),
        );
      } catch {
        // Keep the successful immutable snapshot available even if warning
        // metadata cannot be refreshed.
      }
    }
    if (warnings.length === 0) {
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
            currentMirroredCount,
            writeStatus: "completed",
            writePhase,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Completed run metadata refresh failed after current mirror update: ${message}`);
      }
    }

    return {
      runId,
      attemptedCount,
      runRowsWrittenCount: rowCount.rowCount,
      historyWrittenCount,
      currentMirroredCount,
      warnings,
    };
  } catch (error) {
    if (runStarted) {
      const message = error instanceof Error ? error.message : String(error);
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
              currentMirroredCount,
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
