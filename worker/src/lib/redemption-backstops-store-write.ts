import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { batchExecute } from "./db";

export type RedemptionBackstopSnapshotRecord = RedemptionBackstopEntry;

function buildDetailsJson(record: RedemptionBackstopSnapshotRecord): string {
  return JSON.stringify({
    resolutionState: record.resolutionState,
    capacityConfidence: record.capacityConfidence,
    ...(record.capacityBasis ? { capacityBasis: record.capacityBasis } : {}),
    capacitySemantics: record.capacitySemantics,
    feeConfidence: record.feeConfidence,
    feeModelKind: record.feeModelKind,
    modelConfidence: record.modelConfidence,
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
    feeBps: record.feeBps,
    ...(record.docs ? { docs: record.docs } : {}),
    ...(record.notes ? { notes: record.notes } : {}),
    ...(record.capsApplied ? { capsApplied: record.capsApplied } : {}),
    ...(record.feeDescription ? { feeDescription: record.feeDescription } : {}),
  });
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

export async function upsertRedemptionBackstopSnapshots(
  db: D1Database,
  records: RedemptionBackstopSnapshotRecord[],
  options?: {
    expectedCount?: number;
    metadata?: Record<string, unknown>;
    runId?: string;
  },
): Promise<void> {
  if (records.length === 0) return;

  const runId = options?.runId ?? createRedemptionBackstopRunId();
  const startedAt = Math.floor(Date.now() / 1000);
  const snapshotDate = Math.floor(Date.now() / 1000 / DAY_SECONDS) * DAY_SECONDS;
  await buildRunStartInsert(db, {
    runId,
    startedAt,
    expectedCount: options?.expectedCount ?? records.length,
    methodologyVersion: records[0].methodologyVersion,
    metadata: options?.metadata,
  }).run();

  const stmts: D1PreparedStatement[] = [];
  for (const record of records) {
    stmts.push(buildCurrentUpsert(db, record, runId));
    stmts.push(buildHistoryUpsert(db, record, snapshotDate, runId));
  }

  // Each coin produces 2 statements (current: 25 params, history: 9 params = 34 total).
  // D1 limits total bound params per batch (~1000), so chunk at 20 (20×34=680).
  await batchExecute(db, stmts, 20);

  const { minUpdatedAt, maxUpdatedAt } = resolveRunBounds(records);
  await buildRunCompleteUpdate(db, {
    runId,
    completedAt: Math.floor(Date.now() / 1000),
    writtenCount: records.length,
    minUpdatedAt,
    maxUpdatedAt,
    metadata: options?.metadata,
  }).run();
}
