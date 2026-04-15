import type {
  RedemptionBackstopEntry,
  RedemptionBackstopMap,
  RedemptionBackstopsResponse,
  RedemptionRouteFamily,
  RedemptionAccessModel,
  RedemptionSettlementModel,
  RedemptionExecutionModel,
  RedemptionOutputAssetType,
  RedemptionSourceMode,
  RedemptionResolutionState,
  RedemptionCapacityConfidence,
  RedemptionCapacitySemantics,
  RedemptionFeeConfidence,
  RedemptionFeeModelKind,
  RedemptionModelConfidence,
  RedemptionRouteStatus,
  RedemptionRouteStatusSource,
  RedemptionHolderEligibility,
} from "@shared/types/redemption";
import { batchExecute } from "./db";
import {
  REDEMPTION_BACKSTOP_METHODOLOGY_PATH,
  REDEMPTION_BACKSTOP_VERSION,
  REDEMPTION_BACKSTOP_VERSION_LABEL,
  getRedemptionBackstopVersionAt,
  toRedemptionBackstopVersionLabel,
} from "@shared/lib/redemption-backstop-version";
import {
  EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR,
  REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS,
  REDEMPTION_ROUTE_FAMILY_CAPS,
} from "@shared/lib/redemption-backstop-scoring";
import {
  deriveModelConfidence,
  inferStoredCapacityConfidence,
  inferStoredCapacitySemantics,
  inferStoredFeeConfidence,
  inferStoredFeeModelKind,
} from "@shared/lib/redemption-backstop-confidence";
import { buildMethodologyEnvelope } from "./api-utils";
import { decodeJsonString } from "./cache-json";
import { DAY_SECONDS } from "@shared/lib/time-constants";

interface RedemptionBackstopRow {
  stablecoin_id: string;
  score: number | null;
  effective_exit_score: number | null;
  dex_liquidity_score: number | null;
  access_score: number | null;
  settlement_score: number | null;
  execution_certainty_score: number | null;
  capacity_score: number | null;
  output_asset_quality_score: number | null;
  cost_score: number | null;
  route_family: RedemptionRouteFamily;
  access_model: RedemptionAccessModel;
  settlement_model: RedemptionSettlementModel;
  execution_model: RedemptionExecutionModel;
  output_asset_type: RedemptionOutputAssetType;
  provider: string;
  source_mode: RedemptionSourceMode;
  immediate_capacity_usd: number | null;
  immediate_capacity_ratio: number | null;
  fee_bps: number | null;
  queue_enabled: number;
  updated_at: number;
  methodology_version: string;
  details_json: string | null;
  snapshot_run_id?: string | null;
}

export type RedemptionBackstopSnapshotRecord = RedemptionBackstopEntry;
export interface RedemptionBackstopLoadResult {
  map: RedemptionBackstopMap;
  latestUpdatedAt: number | null;
  runId?: string | null;
}

interface RedemptionBackstopRunRow {
  run_id: string;
  completed_at: number | null;
  expected_count: number;
  written_count: number;
  min_updated_at: number | null;
  max_updated_at: number | null;
  methodology_version: string;
}

export class RedemptionBackstopSnapshotUnavailableError extends Error {
  cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "RedemptionBackstopSnapshotUnavailableError";
    this.cause = options?.cause;
  }
}

type RedemptionBackstopDetails = Partial<
  Pick<
    RedemptionBackstopEntry,
    | "docs"
    | "notes"
    | "capsApplied"
    | "feeDescription"
    | "capacityBasis"
    | "resolutionState"
    | "capacityConfidence"
    | "capacitySemantics"
    | "feeConfidence"
    | "feeModelKind"
    | "modelConfidence"
    | "routeStatus"
    | "routeStatusSource"
    | "routeStatusReason"
    | "routeStatusReviewedAt"
    | "holderEligibility"
  >
>;

function pickValidDetails(raw: Record<string, unknown>): RedemptionBackstopDetails {
  const result: RedemptionBackstopDetails = {};
  if (raw.docs) result.docs = raw.docs as RedemptionBackstopEntry["docs"];
  if (Array.isArray(raw.notes)) result.notes = raw.notes;
  if (Array.isArray(raw.capsApplied)) result.capsApplied = raw.capsApplied;
  if (typeof raw.feeDescription === "string") result.feeDescription = raw.feeDescription;
  if (typeof raw.capacityBasis === "string") result.capacityBasis = raw.capacityBasis as RedemptionBackstopEntry["capacityBasis"];
  if (typeof raw.resolutionState === "string") result.resolutionState = raw.resolutionState as RedemptionResolutionState;
  if (typeof raw.capacityConfidence === "string") result.capacityConfidence = raw.capacityConfidence as RedemptionCapacityConfidence;
  if (typeof raw.capacitySemantics === "string") result.capacitySemantics = raw.capacitySemantics as RedemptionCapacitySemantics;
  if (typeof raw.feeConfidence === "string") result.feeConfidence = raw.feeConfidence as RedemptionFeeConfidence;
  if (typeof raw.feeModelKind === "string") result.feeModelKind = raw.feeModelKind as RedemptionFeeModelKind;
  if (typeof raw.modelConfidence === "string") result.modelConfidence = raw.modelConfidence as RedemptionModelConfidence;
  if (typeof raw.routeStatus === "string") result.routeStatus = raw.routeStatus as RedemptionRouteStatus;
  if (typeof raw.routeStatusSource === "string") result.routeStatusSource = raw.routeStatusSource as RedemptionRouteStatusSource;
  if (typeof raw.routeStatusReason === "string") result.routeStatusReason = raw.routeStatusReason;
  if (typeof raw.routeStatusReviewedAt === "string") result.routeStatusReviewedAt = raw.routeStatusReviewedAt;
  if (typeof raw.holderEligibility === "string") result.holderEligibility = raw.holderEligibility as RedemptionHolderEligibility;
  return result;
}

function parseDetails(value: string | null): RedemptionBackstopDetails {
  if (!value) return {};
  const decoded = decodeJsonString<RedemptionBackstopDetails, "json-parse-failed">(value, {
    mode: "best-effort",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => ({ ok: true, payload: pickValidDetails(parsed as Record<string, unknown>) }),
  });
  return decoded.payload ?? {};
}

function toEntry(row: RedemptionBackstopRow): RedemptionBackstopEntry {
  const details = parseDetails(row.details_json);
  const resolutionState = details.resolutionState ?? (row.score != null ? "resolved" : "missing-capacity");
  const capacityConfidence =
    details.capacityConfidence ??
    inferStoredCapacityConfidence({
      provider: row.provider,
      sourceMode: row.source_mode,
    });
  const capacitySemantics =
    details.capacitySemantics ??
    inferStoredCapacitySemantics({
      provider: row.provider,
    });
  const feeConfidence =
    details.feeConfidence ??
    inferStoredFeeConfidence({
      feeBps: row.fee_bps,
    });
  const feeModelKind =
    details.feeModelKind ??
    inferStoredFeeModelKind({
      feeBps: row.fee_bps,
      feeConfidence,
      feeDescription: details.feeDescription,
    });
  const modelConfidence =
    details.modelConfidence ??
    deriveModelConfidence({
      resolutionState,
      capacityConfidence,
      feeConfidence,
    });
  const routeStatus = details.routeStatus ?? "unknown";
  const routeStatusSource = details.routeStatusSource ?? "static-config";
  const holderEligibility = details.holderEligibility ?? "unknown";
  return {
    stablecoinId: row.stablecoin_id,
    ...details,
    score: row.score,
    effectiveExitScore: row.effective_exit_score,
    dexLiquidityScore: row.dex_liquidity_score,
    accessScore: row.access_score,
    settlementScore: row.settlement_score,
    executionCertaintyScore: row.execution_certainty_score,
    capacityScore: row.capacity_score,
    outputAssetQualityScore: row.output_asset_quality_score,
    costScore: row.cost_score,
    routeFamily: row.route_family,
    accessModel: row.access_model,
    settlementModel: row.settlement_model,
    executionModel: row.execution_model,
    outputAssetType: row.output_asset_type,
    provider: row.provider,
    sourceMode: row.source_mode,
    resolutionState,
    routeStatus,
    routeStatusSource,
    ...(details.routeStatusReason ? { routeStatusReason: details.routeStatusReason } : {}),
    ...(details.routeStatusReviewedAt ? { routeStatusReviewedAt: details.routeStatusReviewedAt } : {}),
    holderEligibility,
    capacityConfidence,
    capacitySemantics,
    feeConfidence,
    feeModelKind,
    modelConfidence,
    immediateCapacityUsd: row.immediate_capacity_usd,
    immediateCapacityRatio: row.immediate_capacity_ratio,
    feeBps: row.fee_bps,
    queueEnabled: row.queue_enabled === 1,
    methodologyVersion: row.methodology_version,
    updatedAt: row.updated_at,
  };
}

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

function resolveSnapshotMethodologyVersion(
  coins: RedemptionBackstopMap,
  updatedAt: number,
): { version: string; versionLabel: string } {
  if (updatedAt > 0) {
    const latestEntry = Object.values(coins).find((entry) => entry.updatedAt === updatedAt);
    if (latestEntry?.methodologyVersion) {
      return {
        version: latestEntry.methodologyVersion,
        versionLabel: toRedemptionBackstopVersionLabel(latestEntry.methodologyVersion),
      };
    }
  }

  const version = getRedemptionBackstopVersionAt(updatedAt);
  return {
    version,
    versionLabel: toRedemptionBackstopVersionLabel(version),
  };
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

async function getLatestCompletedRedemptionBackstopRun(
  db: D1Database,
): Promise<RedemptionBackstopRunRow | null> {
  try {
    const row = await db
      .prepare(
        `SELECT run_id, completed_at, expected_count, written_count, min_updated_at,
                max_updated_at, methodology_version
           FROM redemption_backstop_runs
          WHERE status = 'completed'
          ORDER BY completed_at DESC
          LIMIT 1`,
      )
      .first<RedemptionBackstopRunRow>();
    return typeof row?.run_id === "string" && row.run_id.length > 0 ? row : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("no such table")) return null;
    throw error;
  }
}

async function queryRedemptionBackstopMap(
  db: D1Database,
  runId?: string | null,
): Promise<RedemptionBackstopMap> {
  let rows: D1Result<RedemptionBackstopRow>;
  try {
    const statement = runId
      ? db
        .prepare(
          `SELECT stablecoin_id, score, effective_exit_score, dex_liquidity_score,
                  access_score, settlement_score, execution_certainty_score,
                  capacity_score, output_asset_quality_score, cost_score,
                  route_family, access_model, settlement_model, execution_model,
                  output_asset_type, provider, source_mode, immediate_capacity_usd,
                  immediate_capacity_ratio, fee_bps, queue_enabled, updated_at,
                  methodology_version, details_json, snapshot_run_id
             FROM redemption_backstop
            WHERE snapshot_run_id = ?`,
        )
        .bind(runId)
      : db
        .prepare(
          `SELECT stablecoin_id, score, effective_exit_score, dex_liquidity_score,
                access_score, settlement_score, execution_certainty_score,
                capacity_score, output_asset_quality_score, cost_score,
                route_family, access_model, settlement_model, execution_model,
                output_asset_type, provider, source_mode, immediate_capacity_usd,
                immediate_capacity_ratio, fee_bps, queue_enabled, updated_at,
                methodology_version, details_json, snapshot_run_id
           FROM redemption_backstop`,
        );
    rows = await statement.all<RedemptionBackstopRow>();
  } catch (error) {
    throw new RedemptionBackstopSnapshotUnavailableError("Failed to load current redemption backstop snapshot", {
      cause: error,
    });
  }

  return Object.fromEntries((rows.results ?? []).map((row) => [row.stablecoin_id, toEntry(row)]));
}

export async function loadRedemptionBackstopMap(db: D1Database): Promise<RedemptionBackstopMap> {
  return queryRedemptionBackstopMap(db);
}

export async function loadRedemptionBackstopSnapshot(db: D1Database): Promise<RedemptionBackstopLoadResult> {
  try {
    const latestRun = await getLatestCompletedRedemptionBackstopRun(db);
    if (latestRun) {
      const map = await queryRedemptionBackstopMap(db, latestRun.run_id);
      return {
        map,
        latestUpdatedAt: latestRun.max_updated_at,
        runId: latestRun.run_id,
      };
    }

    const [map, latest] = await Promise.all([
      queryRedemptionBackstopMap(db),
      db
        .prepare("SELECT MAX(updated_at) AS updated_at FROM redemption_backstop")
        .first<{ updated_at: number | null }>(),
    ]);
    return { map, latestUpdatedAt: latest?.updated_at ?? null };
  } catch (error) {
    if (error instanceof RedemptionBackstopSnapshotUnavailableError) {
      throw error;
    }
    throw new RedemptionBackstopSnapshotUnavailableError("Failed to load redemption backstop snapshot", {
      cause: error,
    });
  }
}

export async function buildRedemptionBackstopsSnapshot(db: D1Database): Promise<RedemptionBackstopsResponse> {
  let loaded: RedemptionBackstopLoadResult;
  try {
    loaded = await loadRedemptionBackstopSnapshot(db);
  } catch (error) {
    if (error instanceof RedemptionBackstopSnapshotUnavailableError) {
      throw error;
    }
    throw new RedemptionBackstopSnapshotUnavailableError("Failed to build redemption backstop snapshot", {
      cause: error,
    });
  }

  const coins = loaded.map;
  const updatedAt = loaded.latestUpdatedAt ?? 0;
  const snapshotMethodology = resolveSnapshotMethodologyVersion(coins, updatedAt);

  return {
    coins,
    methodology: {
      ...buildMethodologyEnvelope({
        version: snapshotMethodology.version,
        versionLabel: snapshotMethodology.versionLabel,
        currentVersion: REDEMPTION_BACKSTOP_VERSION,
        currentVersionLabel: REDEMPTION_BACKSTOP_VERSION_LABEL,
        changelogPath: REDEMPTION_BACKSTOP_METHODOLOGY_PATH,
        asOf: updatedAt,
      }),
      componentWeights: {
        access: REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.access,
        settlement: REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.settlement,
        executionCertainty: REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.executionCertainty,
        capacity: REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.capacity,
        outputAssetQuality: REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.outputAssetQuality,
        cost: REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.cost,
      },
      effectiveExitModel: {
        model: "best-path",
        diversificationFactor: EFFECTIVE_EXIT_DIVERSIFICATION_FACTOR,
      },
      routeFamilyCaps: {
        queueRedeem: REDEMPTION_ROUTE_FAMILY_CAPS.queueRedeem,
        offchainIssuer: REDEMPTION_ROUTE_FAMILY_CAPS.offchainIssuer,
      },
    },
    updatedAt,
  };
}
