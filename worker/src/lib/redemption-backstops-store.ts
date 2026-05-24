import type {
  RedemptionBackstopEntry,
  RedemptionBackstopDetails,
  RedemptionBackstopMap,
  RedemptionBackstopsResponse,
  RedemptionRouteFamily,
  RedemptionAccessModel,
  RedemptionSettlementModel,
  RedemptionExecutionModel,
  RedemptionOutputAssetType,
  RedemptionSourceMode,
} from "@shared/types/redemption";
import {
  RedemptionBackstopEntrySchema,
  RedemptionBackstopDetailsSchema,
  RedemptionCapacityProfileSchema,
  RedemptionCapacityBasisSchema,
  RedemptionCapacityConfidenceSchema,
  RedemptionCapacitySemanticsSchema,
  RedemptionConfidenceDetailsSchema,
  RedemptionCostScenarioScoresSchema,
  RedemptionDocsSchema,
  RedemptionFeeConfidenceSchema,
  RedemptionFeeModelKindSchema,
  RedemptionHolderEligibilitySchema,
  RedemptionLiveCapacityKindSchema,
  RedemptionLiveFreshnessKindSchema,
  RedemptionModelConfidenceSchema,
  RedemptionResolutionStateSchema,
  RedemptionRouteExitCorrelationSchema,
  RedemptionRouteStatusSchema,
  RedemptionRouteStatusSourceSchema,
} from "@shared/types/redemption";
import {
  REDEMPTION_BACKSTOP_METHODOLOGY_PATH,
  REDEMPTION_BACKSTOP_VERSION,
  REDEMPTION_BACKSTOP_VERSION_LABEL,
  getRedemptionBackstopVersionAt,
  toRedemptionBackstopVersionLabel,
} from "@shared/lib/redemption-backstop-version";
import {
  REDEMPTION_EFFECTIVE_EXIT_MODEL,
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
import { recordRuntimeFallbackUsage } from "./runtime-fallback-telemetry";
export {
  upsertRedemptionBackstopSnapshots,
  updateRedemptionBackstopRunMetadata,
  type RedemptionBackstopSnapshotWriteResult,
} from "./redemption-backstops-store-write";

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
  methodologyVersion?: string | null;
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
  [key: string]: unknown;
}

export class RedemptionBackstopSnapshotUnavailableError extends Error {
  cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "RedemptionBackstopSnapshotUnavailableError";
    this.cause = options?.cause;
  }
}

function pickStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value;
}

function pickSchemaValue<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  value: unknown,
): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function pickNonNegativeFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function pickUrlArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    try {
      const parsed = new URL(item);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
      const normalizedUrl = parsed.toString();
      if (seen.has(normalizedUrl)) continue;
      seen.add(normalizedUrl);
      urls.push(normalizedUrl);
    } catch {
      return undefined;
    }
  }
  return urls;
}

function pickValidDetails(raw: Record<string, unknown>): RedemptionBackstopDetails {
  const result: RedemptionBackstopDetails = {};
  if (raw.docs != null) result.docs = pickSchemaValue(RedemptionDocsSchema.nullable(), raw.docs);
  result.notes = pickStringArray(raw.notes);
  result.capsApplied = pickStringArray(raw.capsApplied);
  if (typeof raw.feeDescription === "string") result.feeDescription = raw.feeDescription;
  result.capacityBasis = pickSchemaValue(RedemptionCapacityBasisSchema, raw.capacityBasis);
  result.resolutionState = pickSchemaValue(RedemptionResolutionStateSchema, raw.resolutionState);
  result.capacityConfidence = pickSchemaValue(RedemptionCapacityConfidenceSchema, raw.capacityConfidence);
  result.capacitySemantics = pickSchemaValue(RedemptionCapacitySemanticsSchema, raw.capacitySemantics);
  result.capacityProfile = pickSchemaValue(RedemptionCapacityProfileSchema, raw.capacityProfile);
  result.capacityKind = pickSchemaValue(RedemptionLiveCapacityKindSchema, raw.capacityKind);
  result.freshnessKind = pickSchemaValue(RedemptionLiveFreshnessKindSchema, raw.freshnessKind);
  result.sourceTimestamp = pickNonNegativeFiniteNumber(raw.sourceTimestamp);
  result.sourceUrls = pickUrlArray(raw.sourceUrls);
  result.settlementDelaySec = pickNonNegativeFiniteNumber(raw.settlementDelaySec);
  result.queueDepthUsd = pickNonNegativeFiniteNumber(raw.queueDepthUsd);
  result.dailyLimitUsd = pickNonNegativeFiniteNumber(raw.dailyLimitUsd);
  result.minRedeemUsd = pickNonNegativeFiniteNumber(raw.minRedeemUsd);
  result.liveHolderEligibility = pickSchemaValue(RedemptionHolderEligibilitySchema, raw.liveHolderEligibility);
  result.feeConfidence = pickSchemaValue(RedemptionFeeConfidenceSchema, raw.feeConfidence);
  result.feeModelKind = pickSchemaValue(RedemptionFeeModelKindSchema, raw.feeModelKind);
  result.modelConfidence = pickSchemaValue(RedemptionModelConfidenceSchema, raw.modelConfidence);
  result.confidenceDetails = pickSchemaValue(RedemptionConfidenceDetailsSchema, raw.confidenceDetails);
  result.routeStatus = pickSchemaValue(RedemptionRouteStatusSchema, raw.routeStatus);
  result.routeStatusSource = pickSchemaValue(RedemptionRouteStatusSourceSchema, raw.routeStatusSource);
  if (typeof raw.routeStatusReason === "string") result.routeStatusReason = raw.routeStatusReason;
  if (typeof raw.routeStatusReviewedAt === "string") result.routeStatusReviewedAt = raw.routeStatusReviewedAt;
  result.holderEligibility = pickSchemaValue(RedemptionHolderEligibilitySchema, raw.holderEligibility);
  result.eventualRedeemabilityScore = pickNonNegativeFiniteNumber(raw.eventualRedeemabilityScore);
  result.costScenarioScores = pickSchemaValue(RedemptionCostScenarioScoresSchema, raw.costScenarioScores);
  result.routeExitCorrelation = pickSchemaValue(RedemptionRouteExitCorrelationSchema, raw.routeExitCorrelation);
  return result;
}

function parseDetails(value: string | null): RedemptionBackstopDetails {
  if (!value) return {};
  const decoded = decodeJsonString<RedemptionBackstopDetails, "json-parse-failed">(value, {
    mode: "best-effort",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => {
      const raw = parsed as Record<string, unknown>;
      const parsedDetails = RedemptionBackstopDetailsSchema.safeParse(raw);
      return { ok: true, payload: parsedDetails.success ? parsedDetails.data : pickValidDetails(raw) };
    },
  });
  return decoded.payload ?? {};
}

export function normalizeRedemptionBackstopRunMetadata(
  value: string | null | undefined,
): RedemptionBackstopRunMetadata {
  if (!value) return {};
  const decoded = decodeJsonString<RedemptionBackstopRunMetadata, "json-parse-failed" | "invalid-payload">(value, {
    mode: "best-effort",
    parseErrorReason: "json-parse-failed",
    normalize: (parsed) => {
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "invalid-payload" };
      }
      const raw = parsed as Record<string, unknown>;
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

function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("no such table");
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
  const entry = {
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
  const parsed = RedemptionBackstopEntrySchema.safeParse(entry);
  if (!parsed.success) {
    throw new Error(`Invalid redemption backstop row for ${row.stablecoin_id}: ${parsed.error.message}`);
  }
  return parsed.data;
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

async function getRecentCompletedRedemptionBackstopRuns(
  db: D1Database,
  limit = 5,
): Promise<RedemptionBackstopRunRow[]> {
  try {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("no such table")) return [];
    throw error;
  }
}

async function hasAnyRedemptionBackstopRunManifest(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT run_id FROM redemption_backstop_runs LIMIT 1").first<{ run_id: string }>();
    return row != null;
  } catch (error) {
    if (isMissingTableError(error)) return false;
    throw error;
  }
}

async function hasManifestedCurrentRedemptionBackstopRows(db: D1Database): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT stablecoin_id FROM redemption_backstop WHERE snapshot_run_id IS NOT NULL LIMIT 1")
      .first<{ stablecoin_id: string }>();
    return row != null;
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (isMissingTableError(error) || message.includes("no such column")) return false;
    throw error;
  }
}

async function queryRedemptionBackstopMap(db: D1Database, runId?: string | null): Promise<RedemptionBackstopMap> {
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
      : db.prepare(
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

  try {
    return Object.fromEntries((rows.results ?? []).map((row) => [row.stablecoin_id, toEntry(row)]));
  } catch (error) {
    throw new RedemptionBackstopSnapshotUnavailableError("Failed to decode redemption backstop snapshot rows", {
      cause: error,
    });
  }
}

async function queryRedemptionBackstopMapFromRunRows(db: D1Database, runId: string): Promise<RedemptionBackstopMap> {
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
                methodology_version, details_json, snapshot_run_id
           FROM redemption_backstop_run_rows
          WHERE snapshot_run_id = ?`,
      )
      .bind(runId)
      .all<RedemptionBackstopRow>();
  } catch (error) {
    if (isMissingTableError(error)) {
      throw error;
    }
    throw new RedemptionBackstopSnapshotUnavailableError("Failed to load immutable redemption backstop run rows", {
      cause: error,
    });
  }

  try {
    return Object.fromEntries((rows.results ?? []).map((row) => [row.stablecoin_id, toEntry(row)]));
  } catch (error) {
    throw new RedemptionBackstopSnapshotUnavailableError("Failed to decode immutable redemption backstop run rows", {
      cause: error,
    });
  }
}

async function queryCompletedRedemptionBackstopRunMap(
  db: D1Database,
  runId: string,
): Promise<{ map: RedemptionBackstopMap; source: "run-rows" | "legacy-current" }> {
  try {
    const map = await queryRedemptionBackstopMapFromRunRows(db, runId);
    if (Object.keys(map).length > 0) {
      return { map, source: "run-rows" };
    }
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
  }

  return {
    map: await queryRedemptionBackstopMap(db, runId),
    source: "legacy-current",
  };
}

export async function loadLegacyRedemptionBackstopCurrentMap(db: D1Database): Promise<RedemptionBackstopMap> {
  // Legacy/current-table reader retained for rollout bootstrap and focused
  // compatibility tests. API/report-card paths should use
  // loadRedemptionBackstopSnapshot() so completed run rows remain authoritative.
  return queryRedemptionBackstopMap(db);
}

export async function loadRedemptionBackstopSnapshot(db: D1Database): Promise<RedemptionBackstopLoadResult> {
  try {
    const recentRuns = await getRecentCompletedRedemptionBackstopRuns(db);
    if (recentRuns.length > 0) {
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
        let source: "run-rows" | "legacy-current" = "run-rows";
        try {
          const result = await queryCompletedRedemptionBackstopRunMap(db, run.run_id);
          map = result.map;
          source = result.source;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          rejectionReasons.push(`${run.run_id}: query failed (${message})`);
          continue;
        }

        const rowCount = Object.keys(map).length;
        if (source === "legacy-current") {
          recordRuntimeFallbackUsage("redemption-backstop-legacy-current", {
            runId: run.run_id,
            rowCount,
            expectedCount: run.written_count,
          });
        }
        if (rowCount !== run.written_count) {
          rejectionReasons.push(`${run.run_id}: ${source} row count mismatch (${rowCount}/${run.written_count})`);
          continue;
        }

        return {
          map,
          latestUpdatedAt: run.max_updated_at,
          runId: run.run_id,
          methodologyVersion: run.methodology_version,
        };
      }

      throw new RedemptionBackstopSnapshotUnavailableError(
        `No valid completed redemption backstop run found (${rejectionReasons.join("; ")})`,
      );
    }

    if ((await hasAnyRedemptionBackstopRunManifest(db)) && (await hasManifestedCurrentRedemptionBackstopRows(db))) {
      throw new RedemptionBackstopSnapshotUnavailableError(
        "No completed redemption backstop run found for manifested current rows",
      );
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
  const snapshotMethodology = loaded.methodologyVersion
    ? {
        version: loaded.methodologyVersion,
        versionLabel: toRedemptionBackstopVersionLabel(loaded.methodologyVersion),
      }
    : resolveSnapshotMethodologyVersion(coins, updatedAt);

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
      effectiveExitModel: REDEMPTION_EFFECTIVE_EXIT_MODEL,
      routeFamilyCaps: {
        queueRedeem: REDEMPTION_ROUTE_FAMILY_CAPS.queueRedeem,
        offchainIssuer: REDEMPTION_ROUTE_FAMILY_CAPS.offchainIssuer,
      },
    },
    updatedAt,
  };
}
