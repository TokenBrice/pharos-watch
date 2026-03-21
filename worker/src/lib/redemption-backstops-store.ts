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
} from "@shared/types";
import { batchExecute } from "./db";
import {
  REDEMPTION_BACKSTOP_METHODOLOGY_PATH,
  REDEMPTION_BACKSTOP_VERSION,
  REDEMPTION_BACKSTOP_VERSION_LABEL,
} from "@shared/lib/redemption-backstop-version";
import {
  EFFECTIVE_EXIT_WEIGHTS,
  REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS,
  REDEMPTION_ROUTE_FAMILY_CAPS,
} from "@shared/lib/redemption-backstop-scoring";
import { decodeJsonString } from "./cache-json";

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
}

export type RedemptionBackstopSnapshotRecord = RedemptionBackstopEntry;

function parseDetails(
  value: string | null,
): Pick<
  RedemptionBackstopEntry,
  "docs" | "notes" | "capsApplied" | "feeDescription"
> {
  if (!value) return {};
  const decoded = decodeJsonString<
    Pick<RedemptionBackstopEntry, "docs" | "notes" | "capsApplied" | "feeDescription">,
    "json-parse-failed"
  >(value, {
    mode: "best-effort",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => {
      const record = parsed as {
        docs?: RedemptionBackstopEntry["docs"];
        notes?: string[];
        capsApplied?: string[];
        feeDescription?: string;
      };
      return {
        ok: true,
        payload: {
          ...(record?.docs ? { docs: record.docs } : {}),
          ...(Array.isArray(record?.notes) ? { notes: record.notes } : {}),
          ...(Array.isArray(record?.capsApplied)
            ? { capsApplied: record.capsApplied }
            : {}),
          ...(typeof record?.feeDescription === "string"
            ? { feeDescription: record.feeDescription }
            : {}),
        },
      };
    },
  });
  return decoded.payload ?? {};
}

function toEntry(row: RedemptionBackstopRow): RedemptionBackstopEntry {
  return {
    stablecoinId: row.stablecoin_id,
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
    immediateCapacityUsd: row.immediate_capacity_usd,
    immediateCapacityRatio: row.immediate_capacity_ratio,
    feeBps: row.fee_bps,
    queueEnabled: row.queue_enabled === 1,
    methodologyVersion: row.methodology_version,
    updatedAt: row.updated_at,
    ...parseDetails(row.details_json),
  };
}

function buildCurrentUpsert(
  db: D1Database,
  record: RedemptionBackstopSnapshotRecord,
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
         details_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         details_json = excluded.details_json`,
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
      JSON.stringify({
        ...(record.docs ? { docs: record.docs } : {}),
        ...(record.notes ? { notes: record.notes } : {}),
        ...(record.capsApplied ? { capsApplied: record.capsApplied } : {}),
        ...(record.feeDescription
          ? { feeDescription: record.feeDescription }
          : {}),
      }),
    );
}

function buildHistoryUpsert(
  db: D1Database,
  record: RedemptionBackstopSnapshotRecord,
  snapshotDate: number,
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
         details_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.stablecoinId,
      snapshotDate,
      record.score,
      record.effectiveExitScore,
      record.dexLiquidityScore,
      record.updatedAt,
      record.methodologyVersion,
      JSON.stringify({
        ...(record.docs ? { docs: record.docs } : {}),
        ...(record.notes ? { notes: record.notes } : {}),
        ...(record.capsApplied ? { capsApplied: record.capsApplied } : {}),
        ...(record.feeDescription
          ? { feeDescription: record.feeDescription }
          : {}),
      }),
    );
}

export async function upsertRedemptionBackstopSnapshots(
  db: D1Database,
  records: RedemptionBackstopSnapshotRecord[],
): Promise<void> {
  if (records.length === 0) return;

  const snapshotDate = Math.floor(Date.now() / 1000 / 86400) * 86400;
  const stmts: D1PreparedStatement[] = [];
  for (const record of records) {
    stmts.push(buildCurrentUpsert(db, record));
    stmts.push(buildHistoryUpsert(db, record, snapshotDate));
  }

  await batchExecute(db, stmts);
}

export async function loadRedemptionBackstopMap(
  db: D1Database,
): Promise<RedemptionBackstopMap> {
  let rows: D1Result<RedemptionBackstopRow>;
  try {
    rows = await db
      .prepare(
        `SELECT stablecoin_id, score, effective_exit_score, dex_liquidity_score,
                access_score, settlement_score, execution_certainty_score,
                capacity_score, output_asset_quality_score, cost_score,
                route_family, access_model, settlement_model, execution_model,
                output_asset_type, provider, source_mode, immediate_capacity_usd,
                immediate_capacity_ratio, fee_bps, queue_enabled, updated_at,
                methodology_version, details_json
           FROM redemption_backstop`,
      )
      .all<RedemptionBackstopRow>();
  } catch (error) {
    console.warn("[redemption-backstops] Failed to load current map:", error);
    return {};
  }

  return Object.fromEntries(
    (rows.results ?? []).map((row) => [row.stablecoin_id, toEntry(row)]),
  );
}

export async function buildRedemptionBackstopsSnapshot(
  db: D1Database,
): Promise<RedemptionBackstopsResponse> {
  const [coins, latest] = await Promise.all([
    loadRedemptionBackstopMap(db),
    db
      .prepare("SELECT MAX(updated_at) AS updated_at FROM redemption_backstop")
      .first<{ updated_at: number | null }>()
      .catch(() => ({ updated_at: null })),
  ]);

  const updatedAt = latest?.updated_at ?? 0;

  return {
    coins,
    methodology: {
      version: REDEMPTION_BACKSTOP_VERSION,
      versionLabel: REDEMPTION_BACKSTOP_VERSION_LABEL,
      currentVersion: REDEMPTION_BACKSTOP_VERSION,
      currentVersionLabel: REDEMPTION_BACKSTOP_VERSION_LABEL,
      changelogPath: REDEMPTION_BACKSTOP_METHODOLOGY_PATH,
      asOf: updatedAt,
      isCurrent: true,
      componentWeights: {
        access: REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.access,
        settlement: REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.settlement,
        executionCertainty:
          REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.executionCertainty,
        capacity: REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.capacity,
        outputAssetQuality:
          REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.outputAssetQuality,
        cost: REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS.cost,
      },
      effectiveExitWeights: {
        liquidity: EFFECTIVE_EXIT_WEIGHTS.liquidity,
        redemption: EFFECTIVE_EXIT_WEIGHTS.redemption,
      },
      routeFamilyCaps: {
        queueRedeem: REDEMPTION_ROUTE_FAMILY_CAPS.queueRedeem,
        offchainIssuer: REDEMPTION_ROUTE_FAMILY_CAPS.offchainIssuer,
      },
    },
    updatedAt,
  };
}
