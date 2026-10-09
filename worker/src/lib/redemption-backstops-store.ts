import { logWorkerEvent } from "./structured-log";
import { toErrorMessage } from "@shared/lib/error-utils";
import { assessConsumedRedemptionReserves, type ConsumedRedemptionReserveAssessment } from "./accepted-reserve-generation";
import { RedemptionReserveRunMetadataSchema, type RedemptionReserveRunMetadata } from "@shared/types/reserve-input";
import type {  RedemptionBackstopEntry,
  RedemptionBackstopDetails,
  RedemptionBackstopMap,
  RedemptionBackstopsResponse,
  RedemptionRouteFamily,
  RedemptionAccessModel,
  RedemptionSettlementModel,
  RedemptionExecutionModel,
  RedemptionOutputAssetType,
  RedemptionSnapshotSource,
  RedemptionSourceMode,
} from "@shared/types/redemption";
import {
  RedemptionBackstopEntrySchema,
  RedemptionBackstopDetailsSchema,
  RedemptionRouteFamilySchema,
  RedemptionConfidenceDetailsSchema,
  RedemptionCostScenarioScoresSchema,
  RedemptionDocsSchema,
} from "@shared/types/redemption";
import {
  REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH,
  REDEMPTION_BACKSTOP_METHODOLOGY_VERSION,
  REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { getMethodologyVersionAt } from "@shared/lib/methodology-versions/registry";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-versions/base";
import {
  REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS,
  REDEMPTION_ROUTE_FAMILY_CAPS,
} from "@shared/lib/redemption-backstop-scoring";
import {
  deriveModelConfidence,
  inferStoredFeeConfidence,
  inferStoredFeeModelKind,
} from "@shared/lib/redemption-backstop-confidence";
import {
  inferProviderCapacityConfidence,
  inferProviderCapacitySemantics,
} from "@shared/lib/redemption-backstop-providers";
import { buildMethodologyEnvelope } from "./api-methodology";
import { decodeJsonString, type JsonDecodeResult } from "./cache-json";
import { SNAPSHOT_ROW_COLUMNS } from "./redemption-backstops-store-write";
export { upsertRedemptionBackstopSnapshots } from "./redemption-backstops-store-write";

interface RedemptionBackstopRow {
  stablecoin_id: string;
  score: number | null;
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
  methodologyVersion?: string | null;
  snapshotSource?: RedemptionSnapshotSource;
  reserveInputAssessment?: ConsumedRedemptionReserveAssessment;
  runMetadata?: RedemptionBackstopRunMetadata;
}

interface RedemptionBackstopRunRow {
  run_id: string;
  completed_at: number | null;
  status?: string;
  expected_count: number;
  written_count: number;
  min_updated_at: number | null;
  max_updated_at: number | null;
  methodology_version: string;
  metadata_json?: string | null;
  metadata?: RedemptionBackstopRunMetadata;
}

export interface RedemptionBackstopRunMetadata {
  registryHash?: string;
  familyCounts?: Record<string, number>;
  strongProxyCount?: number;
  heuristicCount?: number;
  resolved?: number;
  unresolved?: number;
  validatorVersion?: number;
  configMethodologyVersion?: string;
  v4ScoringParametersHash?: string;
  routeStatusProducer?: string;
  routeStatusProducerFetches?: boolean;
  stablecoinsInput?: RedemptionReserveRunMetadata["stablecoinsInput"];
  [key: string]: unknown;
}

const REDEMPTION_BACKSTOP_ROW_COLUMNS = [...SNAPSHOT_ROW_COLUMNS, "snapshot_run_id"].join(", ");

export class RedemptionBackstopSnapshotUnavailableError extends Error {
  cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "RedemptionBackstopSnapshotUnavailableError";
    this.cause = options?.cause;
  }
}

function pickStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item: unknown): item is string => typeof item === "string")) return undefined;
  return value;
}

function pickSchemaValue<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  value: unknown,
): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const CurrentImmutableDetailsSchema = RedemptionBackstopDetailsSchema.required({
  resolutionState: true,
  capacityConfidence: true,
  capacitySemantics: true,
  feeConfidence: true,
  feeModelKind: true,
  modelConfidence: true,
  routeStatus: true,
  routeStatusSource: true,
  holderEligibility: true,
});
const HistoricalImmutableDetailsSchema = RedemptionBackstopDetailsSchema.required({ resolutionState: true });
const HistoricalDetailsEvidenceSchema = HistoricalImmutableDetailsSchema
  .omit({
    docs: true,
    notes: true,
    capsApplied: true,
    confidenceDetails: true,
    costScenarioScores: true,
  })
  .strip();

type DetailsDropReason = "missing-details" | "json-parse-failed" | "invalid-payload" | "unrecognized-methodology-version";

function parseDetails(value: string | null, methodologyVersion: string): JsonDecodeResult<RedemptionBackstopDetails, DetailsDropReason> {
  // Pre-v4 rows have optional fields that were not written by their producer.
  // A version must positively identify that format; unknown versions are current.
  const version = Number(methodologyVersion);
  const recognizedVersion = /^[0-9]+$/.test(methodologyVersion) || /^[0-9]+[.][0-9]+$/.test(methodologyVersion);
  const historical = version > 0 && version < 4 && recognizedVersion;
  const schemaDropReason = recognizedVersion ? "invalid-payload" : "unrecognized-methodology-version";
  return decodeJsonString<RedemptionBackstopDetails, DetailsDropReason>(value, {
    missingReason: "missing-details",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "invalid-payload" };
      }
      const raw = parsed as Record<string, unknown>;
      if (!historical &&
        (raw.routeStatus === undefined || raw.routeStatusSource === undefined || raw.holderEligibility === undefined)) {
        return { ok: false, reason: schemaDropReason };
      }
      const parsedDetails = (historical
        ? HistoricalImmutableDetailsSchema
        : CurrentImmutableDetailsSchema).safeParse(raw);
      if (parsedDetails.success) return { ok: true, payload: parsedDetails.data };
      if (!historical) return { ok: false, reason: schemaDropReason };

      // Only historical diagnostics may be salvaged. Evidence, state and source
      // provenance must still validate intact, never disappear into defaults.
      const evidence = HistoricalDetailsEvidenceSchema.safeParse(raw);
      if (!evidence.success) return { ok: false, reason: "invalid-payload" };
      return {
        ok: true,
        payload: {
          ...evidence.data,
          docs: pickSchemaValue(RedemptionDocsSchema.nullable(), raw.docs),
          notes: pickStringArray(raw.notes),
          capsApplied: pickStringArray(raw.capsApplied),
          confidenceDetails: pickSchemaValue(RedemptionConfidenceDetailsSchema, raw.confidenceDetails),
          costScenarioScores: pickSchemaValue(RedemptionCostScenarioScoresSchema, raw.costScenarioScores),
        },
      };
    },
  });
}

export function normalizeRedemptionBackstopRunMetadata(
  value: string | null | undefined,
): RedemptionBackstopRunMetadata {
  if (!value) return {};
  const decoded = decodeJsonString<RedemptionBackstopRunMetadata, "json-parse-failed" | "invalid-payload">(value, {
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "invalid-payload" };
      }
      const { stablecoinsInput: rawStablecoinsInput, ...raw } = parsed as Record<string, unknown>;
      const stablecoinsInput = pickSchemaValue(RedemptionReserveRunMetadataSchema.shape.stablecoinsInput, rawStablecoinsInput);
      const familyCounts =
        raw.familyCounts && typeof raw.familyCounts === "object" && !Array.isArray(raw.familyCounts)
          ? Object.fromEntries(
              Object.entries(raw.familyCounts as Record<string, unknown>).flatMap(([family, count]) =>
                typeof count === "number" && Number.isFinite(count) && count >= 0 ? [[family, count]] : [],
              ),
            )
          : undefined;
      return {
        ok: true,
        payload: {
          ...raw,
          ...(stablecoinsInput ? { stablecoinsInput } : {}),
          ...(typeof raw.registryHash === "string" ? { registryHash: raw.registryHash } : {}),
          ...(familyCounts ? { familyCounts } : {}),
          ...(typeof raw.strongProxyCount === "number" ? { strongProxyCount: raw.strongProxyCount } : {}),
          ...(typeof raw.heuristicCount === "number" ? { heuristicCount: raw.heuristicCount } : {}),
          ...(typeof raw.resolved === "number" ? { resolved: raw.resolved } : {}),
          ...(typeof raw.unresolved === "number" ? { unresolved: raw.unresolved } : {}),
          ...(typeof raw.validatorVersion === "number" ? { validatorVersion: raw.validatorVersion } : {}),
          ...(typeof raw.configMethodologyVersion === "string"
            ? { configMethodologyVersion: raw.configMethodologyVersion }
            : {}),
          ...(typeof raw.v4ScoringParametersHash === "string"
            ? { v4ScoringParametersHash: raw.v4ScoringParametersHash }
            : {}),
          ...(typeof raw.routeStatusProducer === "string" ? { routeStatusProducer: raw.routeStatusProducer } : {}),
          ...(typeof raw.routeStatusProducerFetches === "boolean"
            ? { routeStatusProducerFetches: raw.routeStatusProducerFetches }
            : {}),
        },
      };
    },
  });
  return decoded.payload ?? {};
}

function recordRowRejection(
  row: RedemptionBackstopRow,
  runId: string,
  reason: DetailsDropReason | "invalid-entry",
  rejectionReasons: string[],
  error?: unknown,
): void {
  rejectionReasons.push(`${row.stablecoin_id}:${reason}`);
  logWorkerEvent({
    scope: "lib",
    level: "warn",
    event: "redemption-backstop-row-rejected",
    message: "Rejected malformed immutable redemption backstop row",
    runId,
    error,
    metadata: { stablecoinId: row.stablecoin_id, methodologyVersion: row.methodology_version, reason },
  });
}

function toEntry(row: RedemptionBackstopRow, runId: string, rejectionReasons: string[]): RedemptionBackstopEntry | null {
  const decodedDetails = parseDetails(row.details_json, row.methodology_version);
  if (!decodedDetails.ok || !decodedDetails.payload.resolutionState) {
    recordRowRejection(row, runId, decodedDetails.ok ? "invalid-payload" : decodedDetails.reason, rejectionReasons);
    return null;
  }
  const details = decodedDetails.payload;
  const resolutionState = decodedDetails.payload.resolutionState;
  const capacityConfidence =
    details.capacityConfidence ??
    inferProviderCapacityConfidence({
      provider: row.provider,
      sourceMode: row.source_mode,
    });
  const capacitySemantics =
    details.capacitySemantics ??
    inferProviderCapacitySemantics({
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
  const entry = {
    stablecoinId: row.stablecoin_id,
    ...details,
    score: row.score,
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
  const parsed = RedemptionBackstopEntrySchema.safeParse(entry);
  if (!parsed.success) {
    recordRowRejection(row, runId, "invalid-entry", rejectionReasons, parsed.error);
    return null;
  }
  return parsed.data;
}

function decodeBackstopRows(
  rows: readonly RedemptionBackstopRow[],
  errorMessage: string,
  runId: string,
  rejectionReasons: string[],
): RedemptionBackstopMap {
  try {
    const map: RedemptionBackstopMap = {};
    for (const row of rows) {
      const entry = toEntry(row, runId, rejectionReasons);
      // Skip individual rows that fail schema validation rather than letting a
      // single malformed row abort the entire snapshot decode. Skipped rows
      // make the run row count fall short of written_count, so the caller's
      // count guard rejects the run and falls through to an older valid run.
      if (entry) {
        map[row.stablecoin_id] = entry;
      }
    }
    return map;
  } catch (error) {
    throw new RedemptionBackstopSnapshotUnavailableError(errorMessage, {
      cause: error,
    });
  }
}

export function resolveSnapshotMethodologyVersion(
  coins: RedemptionBackstopMap,
  updatedAt: number,
): { version: string; versionLabel: string } {
  if (updatedAt > 0) {
    const latestEntry = Object.values(coins).find((entry) => entry.updatedAt === updatedAt);
    if (latestEntry?.methodologyVersion) {
      return {
        version: latestEntry.methodologyVersion,
        versionLabel: toMethodologyVersionLabel(latestEntry.methodologyVersion),
      };
    }
  }

  const version = getMethodologyVersionAt("redemption-backstop", updatedAt);
  return {
    version,
    versionLabel: toMethodologyVersionLabel(version),
  };
}

async function getRecentCompletedRedemptionBackstopRuns(
  db: D1Database,
  limit = 5,
): Promise<RedemptionBackstopRunRow[]> {
  const rows = await db
    .prepare(
        `SELECT run_id, completed_at, expected_count, written_count, min_updated_at,
                max_updated_at, methodology_version, status, metadata_json
           FROM redemption_backstop_runs
          WHERE status = 'completed'
          ORDER BY completed_at DESC
          LIMIT ?`,
      )
      .bind(limit)
    .all<RedemptionBackstopRunRow>();
  return (rows.results ?? [])
    .filter((row) => typeof row.run_id === "string" && row.run_id.length > 0)
    .map((row) => ({
      ...row,
      metadata: normalizeRedemptionBackstopRunMetadata(row.metadata_json),
    }));
}

async function queryRedemptionBackstopMapFromRunRows(
  db: D1Database,
  runId: string,
): Promise<{ map: RedemptionBackstopMap; rawRowCount: number; rowRejectionReasons: string[] }> {
  let rows: D1Result<RedemptionBackstopRow>;
  try {
    rows = await db
      .prepare(
        `SELECT ${REDEMPTION_BACKSTOP_ROW_COLUMNS}
           FROM redemption_backstop_run_rows
          WHERE snapshot_run_id = ?`,
      )
      .bind(runId)
      .all<RedemptionBackstopRow>();
  } catch (error) {
    throw new RedemptionBackstopSnapshotUnavailableError("Failed to load immutable redemption backstop run rows", {
      cause: error,
    });
  }

  const resultRows = rows.results ?? [];
  const rowRejectionReasons: string[] = [];
  return {
    map: decodeBackstopRows(resultRows, "Failed to decode immutable redemption backstop run rows", runId, rowRejectionReasons),
    rawRowCount: resultRows.length,
    rowRejectionReasons,
  };
}

export interface RedemptionBackstopLiveSignalRow {
  stablecoin_id: string;
  immediate_capacity_ratio: number | null;
  route_family: string | null;
  updated_at: number;
}

/**
 * Narrow completed-run reader for live depeg-resolver context. Serves the same
 * immutable run rows as loadRedemptionBackstopSnapshot() but only the live
 * signal fields for the requested coins, so callers avoid decoding the full
 * snapshot map. Throws RedemptionBackstopSnapshotUnavailableError when no
 * valid completed run exists.
 */
export async function loadRedemptionBackstopLiveSignalRows(
  db: D1Database,
  stablecoinIds: readonly string[],
): Promise<RedemptionBackstopLiveSignalRow[]> {
  if (stablecoinIds.length === 0) return [];

  const recentRuns = await getRecentCompletedRedemptionBackstopRuns(db);
  const requestedIds = new Set(stablecoinIds);
  let rowReadError: unknown;

  for (const run of recentRuns) {
    if (run.written_count !== run.expected_count) continue;
    if (run.expected_count > 0 && run.max_updated_at == null) continue;

    let rows: D1Result<RedemptionBackstopLiveSignalRow>;
    try {
      rows = await db
        .prepare(
          `SELECT stablecoin_id, immediate_capacity_ratio, route_family, updated_at
             FROM redemption_backstop_run_rows
            WHERE snapshot_run_id = ?`,
        )
        .bind(run.run_id)
        .all<RedemptionBackstopLiveSignalRow>();
    } catch (error) {
      rowReadError ??= error;
      continue;
    }

    const resultRows = rows.results ?? [];
    const decodedRows = resultRows.filter(
      (row) =>
        typeof row.stablecoin_id === "string" &&
        row.stablecoin_id.length > 0 &&
        (row.immediate_capacity_ratio == null ||
          (typeof row.immediate_capacity_ratio === "number" &&
            Number.isFinite(row.immediate_capacity_ratio) &&
            row.immediate_capacity_ratio >= 0 &&
            row.immediate_capacity_ratio <= 1)) &&
        (row.route_family == null || RedemptionRouteFamilySchema.safeParse(row.route_family).success) &&
        typeof row.updated_at === "number" &&
        Number.isFinite(row.updated_at) &&
        row.updated_at >= 0,
    );
    const decodedIds = new Set(decodedRows.map((row) => row.stablecoin_id));
    if (
      resultRows.length !== run.written_count ||
      decodedRows.length !== run.written_count ||
      decodedIds.size !== run.written_count
    ) {
      continue;
    }

    return decodedRows.filter((row) => requestedIds.has(row.stablecoin_id));
  }

  throw new RedemptionBackstopSnapshotUnavailableError("No valid completed redemption backstop run found for live signals", {
    cause: rowReadError,
  });
}

export async function loadRedemptionBackstopSnapshot(db: D1Database): Promise<RedemptionBackstopLoadResult> {
  try {
    const recentRuns = await getRecentCompletedRedemptionBackstopRuns(db);
    if (recentRuns.length === 0) {
      // The run-manifest rollout is complete: completed runs are the only
      // authoritative snapshot source. Without one (fresh local DB before the
      // first sync, or a manifest table with only running/failed runs) the
      // reader fails closed instead of serving current-table rows, so partial
      // manifested current rows are never treated as authoritative.
      throw new RedemptionBackstopSnapshotUnavailableError("No completed redemption backstop run found");
    }

    const rejectionReasons: string[] = [];

    for (const run of recentRuns) {
      if (run.written_count !== run.expected_count) {
        rejectionReasons.push(`${run.run_id}: incomplete (${run.written_count}/${run.expected_count})`);
        continue;
      }
      if (run.expected_count > 0 && run.max_updated_at == null) {
        rejectionReasons.push(`${run.run_id}: missing max_updated_at`);
        continue;
      }

      let map: RedemptionBackstopMap;
      let rawRowCount: number;
      let rowRejectionReasons: string[];
      try {
        ({ map, rawRowCount, rowRejectionReasons } = await queryRedemptionBackstopMapFromRunRows(db, run.run_id));
      } catch (error) {
        const message = toErrorMessage(error);
        rejectionReasons.push(`${run.run_id}: query failed (${message})`);
        continue;
      }

      const rowCount = Object.keys(map).length;
      if (rawRowCount !== run.written_count || rowCount !== run.written_count) {
        rejectionReasons.push(`${run.run_id}: run-row count mismatch (${rowCount}/${run.written_count}); row-rejections=${rowRejectionReasons.join(",")}`);
        continue;
      }

      return {
        map,
        latestUpdatedAt: run.max_updated_at,
        runId: run.run_id,
        methodologyVersion: run.methodology_version,
        snapshotSource: "run-rows",
        runMetadata: run.metadata,
        reserveInputAssessment: assessConsumedRedemptionReserves(Object.values(map), run.metadata, run.max_updated_at ?? 0, Math.floor(Date.now() / 1000)),
      };
    }

    throw new RedemptionBackstopSnapshotUnavailableError(
      `No valid completed redemption backstop run found (${rejectionReasons.join("; ")})`,
    );
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
  const snapshotMethodology = loaded.methodologyVersion
    ? {
        version: loaded.methodologyVersion,
        versionLabel: toMethodologyVersionLabel(loaded.methodologyVersion),
      }
    : resolveSnapshotMethodologyVersion(coins, updatedAt);

  return {
    coins,
    methodology: {
      ...buildMethodologyEnvelope({
        version: snapshotMethodology.version,
        versionLabel: snapshotMethodology.versionLabel,
        currentVersion: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION,
        currentVersionLabel: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION_LABEL,
        changelogPath: REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH,
        asOf: updatedAt,
      }),
      componentWeights: { ...REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS },
      routeFamilyCaps: { ...REDEMPTION_ROUTE_FAMILY_CAPS },
    },
    updatedAt,
    ...(loaded.snapshotSource ? { snapshotSource: loaded.snapshotSource } : {}),
  };
}
