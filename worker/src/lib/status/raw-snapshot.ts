import { isRecord } from "@shared/lib/type-guards";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import {
  CanaryStatusSchema,
  CoinGeckoPriceDiffSchema,
  D1UsageSummarySchema,
  HealthResponseSchema,
  LiquidityHealthSchema,
  MintBurnReconciliationSummarySchema,
  PublicationHealthSchema,
  ProviderCircuitHealthSchema,
  ReserveDriftEntrySchema,
  YieldHealthSummarySchema,
  type CanaryStatus,
  type CoinGeckoPriceDiff,
  type HealthResponse,
  type LiquidityHealth,
  type MintBurnReconciliationSummary,
  type PublicationHealth,
  type PriceSourceHealth,
  type ProviderCircuitHealth,
  type ReserveDriftEntry,
  type StatusSectionErrors,
  type TelegramHealthSummary,
  type YieldHealthSummary,
} from "@shared/types/status";
import {
  D1TableGrowthSnapshotSchema,
  type D1UsageSummaryWithTableGrowth,
} from "./d1-usage";
import type { RawStatusComputation } from "../status-evaluation";
import { getCache, setCacheIfNewer } from "../db-cache";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  STATUS_SYSTEM_FRESHNESS_SEC,
  type StatusLevel,
} from "../status-reliability-shared";
import { logWorkerEvent } from "../structured-log";
import { PriceSourceHealthSchema } from "@shared/types/pricing-source-health";
import { parseJsonObjectWithSchema } from "../json-parse";
import { z } from "zod";
import { assessFreshnessTimestamp } from "../api-freshness-age";

export const STATUS_RAW_SNAPSHOT_CACHE_KEY = "status:raw-snapshot:v1";
export const STATUS_RAW_SNAPSHOT_MAX_AGE_SEC = STATUS_SYSTEM_FRESHNESS_SEC;
const EXPECTED_CRON_JOBS = Object.keys(CRON_INTERVALS);
const SNAPSHOT_RECENT_RUN_LIMIT = 10;
const SNAPSHOT_STALE_ARTIFACT_LIMIT = 8;
const SNAPSHOT_METADATA_DEPTH_LIMIT = 5;
const SNAPSHOT_METADATA_ARRAY_LIMIT = 40;
const SNAPSHOT_METADATA_OBJECT_KEY_LIMIT = 80;
const SNAPSHOT_STRING_LIMIT = 2_000;

interface StatusSupplements {
  liquidityHealth: LiquidityHealth | null;
  yieldHealth: YieldHealthSummary | null;
  publicationHealth: PublicationHealth | null;
  providerCircuitHealth: ProviderCircuitHealth | null;
  canaries: CanaryStatus | null;
  priceSourceHealth: PriceSourceHealth | null;
  coingeckoPriceDiff: CoinGeckoPriceDiff | null;
  d1Usage: D1UsageSummaryWithTableGrowth | null;
  mintBurnReconciliation: MintBurnReconciliationSummary | null;
  reserveDrift?: ReserveDriftEntry[];
  telegramSummary: TelegramHealthSummary | null;
  sectionErrors: StatusSectionErrors;
}

export type { StatusSupplements };

interface StatusRawSnapshotPayload {
  version: 1;
  producedAt: number;
  raw: RawStatusComputation;
  publicHealth?: HealthResponse;
  supplements?: StatusSupplements;
}

interface FreshStatusRawSnapshot {
  kind: "fresh";
  raw: RawStatusComputation;
  publicHealth?: HealthResponse;
  supplements?: StatusSupplements;
  updatedAt: number;
  ageSec: number;
  maxAgeSec: number;
}

interface UnavailableStatusRawSnapshot {
  kind: "missing" | "stale" | "unreadable" | "read-error";
  updatedAt: number | null;
  ageSec: number | null;
  maxAgeSec: number;
  error?: string;
}

export type StatusRawSnapshotLoadResult = FreshStatusRawSnapshot | UnavailableStatusRawSnapshot;


function isStatusLevel(value: unknown): value is StatusLevel {
  return value === "healthy" || value === "degraded" || value === "stale";
}

function truncateString(value: string, limit = SNAPSHOT_STRING_LIMIT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}... [truncated ${value.length - limit} chars]`;
}

function compactSnapshotValue(value: unknown, depth = 0, path = ""): unknown {
  if (value == null) return value;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const latencyGroups = path === "adapterLatency.groups";
    if (depth >= (path.startsWith("adapterLatency.") ? 7 : SNAPSHOT_METADATA_DEPTH_LIMIT)) return "[truncated-depth]";
    return value
      .slice(0, latencyGroups ? 128 : SNAPSHOT_METADATA_ARRAY_LIMIT)
      .map((entry) => compactSnapshotValue(entry, depth + 1, path));
  }
  if (!isRecord(value)) return null;
  if (depth >= (path.startsWith("adapterLatency.") ? 7 : SNAPSHOT_METADATA_DEPTH_LIMIT)) return "[truncated-depth]";

  const compacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, SNAPSHOT_METADATA_OBJECT_KEY_LIMIT)) {
    // Reserve latency is producer-bounded to 128 groups / 36 KiB. Preserve its
    // histogram subtree; a second silent 40-group cap falsifies omittedGroups.
    compacted[key] = compactSnapshotValue(entry, depth + 1, path ? `${path}.${key}` : key);
  }
  return compacted;
}

function compactCronRunForSnapshot(run: unknown, options: { includeMetadata: boolean }): unknown {
  if (!isRecord(run)) return run;
  const compacted: Record<string, unknown> = {};
  for (const key of ["startedAt", "durationMs", "status", "itemCount"] as const) {
    if (key in run) compacted[key] = run[key];
  }
  if (typeof run.error === "string") {
    compacted.error = truncateString(run.error);
  } else if (run.error != null) {
    compacted.error = compactSnapshotValue(run.error);
  }
  if (options.includeMetadata && run.metadata != null) {
    compacted.metadata = compactSnapshotValue(run.metadata);
  }
  return compacted;
}

function compactCronStatusForSnapshot(status: unknown): unknown {
  if (!isRecord(status)) return status;
  const compacted: Record<string, unknown> = { ...status };

  if (status.lastRun != null) {
    compacted.lastRun = compactCronRunForSnapshot(status.lastRun, { includeMetadata: true });
  }
  if (Array.isArray(status.recentRuns)) {
    compacted.recentRuns = status.recentRuns
      .slice(0, SNAPSHOT_RECENT_RUN_LIMIT)
      .map((run, index) => compactCronRunForSnapshot(run, { includeMetadata: index === 0 }));
  }
  if (status.inFlight != null) {
    compacted.inFlight = compactSnapshotValue(status.inFlight);
  }
  if (Array.isArray(status.staleArtifacts)) {
    compacted.staleArtifacts = status.staleArtifacts
      .slice(0, SNAPSHOT_STALE_ARTIFACT_LIMIT)
      .map((artifact) => compactSnapshotValue(artifact));
  }
  return compacted;
}

function compactRawStatusForSnapshot(raw: RawStatusComputation): RawStatusComputation {
  if (!isRecord(raw.crons)) return raw;
  return {
    ...raw,
    crons: Object.fromEntries(
      Object.entries(raw.crons).map(([job, status]) => [job, compactCronStatusForSnapshot(status)]),
    ) as RawStatusComputation["crons"],
  };
}

function hasRawStatusShape(value: unknown): value is RawStatusComputation {
  if (!isRecord(value)) return false;
  return (
    typeof value.dbHealthy === "boolean" &&
    isStatusLevel(value.availabilityStatus) &&
    isStatusLevel(value.dataQualityStatus) &&
    isStatusLevel(value.rawOverallStatus) &&
    typeof value.confidence === "number" &&
    isRecord(value.causes) &&
    isRecord(value.caches) &&
    isRecord(value.crons) &&
    isRecord(value.dataQuality) &&
    (value.telegramBot === null || isRecord(value.telegramBot)) &&
    isRecord(value.sectionErrors) &&
    isRecord(value.datasetFreshness) &&
    isRecord(value.summary) &&
    isRecord(value.reserveComposition) &&
    (value.reserveComposition.status === "unavailable"
      || (typeof value.reserveComposition.healthConfiguredCoins === "number"
        && typeof value.reserveComposition.healthFreshCoins === "number"
        && typeof value.reserveComposition.healthAuthoritativeFreshCoins === "number"
        && Array.isArray(value.reserveComposition.acknowledgedFeeds)
        && Array.isArray(value.reserveComposition.acknowledgedFeedIds)
        && Array.isArray(value.reserveComposition.expiredFeedReviewIds)
        && Array.isArray(value.reserveComposition.invalidFeedReviewIds)
        && Array.isArray(value.reserveComposition.unacknowledgedPersistentlyStaleIndependentCoins))) &&
    Array.isArray(value.freshnessDiagnostics)
  );
}
function hasPublicHealthShape(value: unknown): value is HealthResponse {
  if (!isRecord(value)) return false;
  return (
    isStatusLevel(value.status)
    && typeof value.timestamp === "number"
    && Number.isFinite(value.timestamp)
    && Array.isArray(value.warnings)
    && isRecord(value.caches)
    && isRecord(value.blacklist)
    && isRecord(value.mintBurn)
    && isRecord(value.circuits)
  );
}


const StatusSectionErrorsSchema = z.record(
  z.string(),
  z.object({ code: z.string(), message: z.string() }),
);
const D1UsageSummaryWithTableGrowthSchema = D1UsageSummarySchema.extend({
  tableGrowth: D1TableGrowthSnapshotSchema.nullable(),
});
const StatusSupplementsSchema = z.object({
  liquidityHealth: LiquidityHealthSchema.nullable(),
  yieldHealth: YieldHealthSummarySchema.nullable(),
  publicationHealth: PublicationHealthSchema.nullable(),
  providerCircuitHealth: ProviderCircuitHealthSchema.nullable(),
  canaries: CanaryStatusSchema.nullable(),
  priceSourceHealth: PriceSourceHealthSchema.nullable(),
  coingeckoPriceDiff: CoinGeckoPriceDiffSchema.nullable(),
  d1Usage: D1UsageSummaryWithTableGrowthSchema.nullable(),
  mintBurnReconciliation: MintBurnReconciliationSummarySchema.nullable(),
  reserveDrift: z.array(ReserveDriftEntrySchema).optional(),
  telegramSummary: HealthResponseSchema.shape.telegramSummary.unwrap(),
  sectionErrors: StatusSectionErrorsSchema,
});
const StatusRawSnapshotPayloadSchema = z.object({
  version: z.literal(1),
  producedAt: z.number().finite(),
  raw: z.custom<RawStatusComputation>(hasRawStatusShape).transform((raw) => ({
    ...raw,
    budgetOnlySurfaces: Array.isArray(raw.budgetOnlySurfaces)
      ? raw.budgetOnlySurfaces
      : [],
  })),
  publicHealth: z.custom<HealthResponse>(hasPublicHealthShape).optional(),
  supplements: StatusSupplementsSchema.optional(),
});

export interface StatusRawSnapshotWriteOptions {
  publicHealth?: HealthResponse;
  supplements?: StatusSupplements;
}

function parseStatusRawSnapshotPayload(value: string): StatusRawSnapshotPayload | null {
  return parseJsonObjectWithSchema(value, StatusRawSnapshotPayloadSchema);
}

export async function loadStatusRawSnapshot(
  db: D1Database,
  now: number,
  maxAgeSec = STATUS_RAW_SNAPSHOT_MAX_AGE_SEC,
): Promise<StatusRawSnapshotLoadResult> {
  try {
    const cached = await getCache(db, STATUS_RAW_SNAPSHOT_CACHE_KEY);
    if (!cached) {
      return {
        kind: "missing",
        updatedAt: null,
        ageSec: null,
        maxAgeSec,
      };
    }

    const timestamp = assessFreshnessTimestamp(now, cached.updatedAt);
    if (timestamp.reason != null) {
      return { kind: "unreadable", updatedAt: cached.updatedAt, ageSec: null, maxAgeSec, error: timestamp.reason };
    }
    const ageSec = timestamp.ageSeconds;
    if (ageSec > maxAgeSec) {
      return {
        kind: "stale",
        updatedAt: cached.updatedAt,
        ageSec,
        maxAgeSec,
      };
    }

    const payload = parseStatusRawSnapshotPayload(cached.value);
    if (!payload) {
      return {
        kind: "unreadable",
        updatedAt: cached.updatedAt,
        ageSec,
        maxAgeSec,
        error: "invalid status raw snapshot payload",
      };
    }
    // Membership changes invalidate the entire assessment, including its severity
    // floor. Filtering stale producers would leave their cached causes/status behind.
    const cronJobs = Object.keys(payload.raw.crons);
    if (cronJobs.length !== EXPECTED_CRON_JOBS.length
      || EXPECTED_CRON_JOBS.some((job) => !Object.prototype.hasOwnProperty.call(payload.raw.crons, job))) {
      return {
        kind: "unreadable",
        updatedAt: cached.updatedAt,
        ageSec,
        maxAgeSec,
        error: "status raw snapshot cron cohort mismatch",
      };
    }
    const generationTimestamp = assessFreshnessTimestamp(now, payload.producedAt);
    if (generationTimestamp.reason != null) {
      return { kind: "unreadable", updatedAt: cached.updatedAt, ageSec: null, maxAgeSec, error: generationTimestamp.reason };
    }

    return {
      kind: "fresh",
      raw: payload.raw,
      publicHealth: payload.publicHealth,
      supplements: payload.supplements,
      updatedAt: cached.updatedAt,
      ageSec,
      maxAgeSec,
    };
  } catch (error) {
    return {
      kind: "read-error",
      updatedAt: null,
      ageSec: null,
      maxAgeSec,
      error: toErrorMessage(error),
    };
  }
}

export async function writeStatusRawSnapshot(
  db: D1Database,
  now: number,
  raw: RawStatusComputation,
  options: StatusRawSnapshotWriteOptions = {},
): Promise<boolean> {
  const payload: StatusRawSnapshotPayload = {
    version: 1,
    producedAt: now,
    raw: compactRawStatusForSnapshot(raw),
    publicHealth: options.publicHealth,
    supplements: options.supplements,
  };

  try {
    const { written } = await setCacheIfNewer(
      db,
      STATUS_RAW_SNAPSHOT_CACHE_KEY,
      JSON.stringify(payload),
      now,
    );
    return written;
  } catch (error) {
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "raw_status_snapshot_persist_failed",
      route: "status",
      source: STATUS_RAW_SNAPSHOT_CACHE_KEY,
      message: "Failed to persist raw status snapshot",
      error,
    });
    return false;
  }
}
