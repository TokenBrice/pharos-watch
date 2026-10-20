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
  StatusResponseSchema,
  type StatusSectionErrors,
} from "@shared/types/status";
import { D1TableGrowthSnapshotSchema } from "./d1-usage";
import type { RawStatusComputation } from "../status-evaluation";
import { STATUS_SYSTEM_FRESHNESS_SEC } from "../status-reliability-shared";
import { PriceSourceHealthSchema } from "@shared/types/pricing-source-health";
import { z } from "zod";
import { loadStatusSnapshotPayload, writeStatusSnapshotPayload, type UnavailableStatusSnapshot } from "./status-snapshot-cache";

/**
 * Operator assessment envelope written by the status self-check: raw
 * availability/data-quality assessment plus supplements. It carries no cron
 * histories (`/api/status` always re-reads live cron health) and no public
 * health projection (`status:public-health-snapshot:v1` owns that). Payload
 * version 2 replaced the v1 shape under the same cache row, so a v1 row reads
 * as unreadable and is served by the live fallback until the next self-check.
 */
export const STATUS_RAW_SNAPSHOT_CACHE_KEY = "status:raw-snapshot:v1";
export const STATUS_RAW_SNAPSHOT_MAX_AGE_SEC = STATUS_SYSTEM_FRESHNESS_SEC;
const STATUS_RAW_SNAPSHOT_PAYLOAD_VERSION = 2;
const EXPECTED_CRON_JOBS = Object.keys(CRON_INTERVALS);

export type StatusSupplements = Omit<z.output<typeof StatusSupplementsSchema>, "sectionErrors"> & {
  sectionErrors: StatusSectionErrors;
};

/** The persisted assessment: everything but the live-reloaded cron records. */
export type SnapshotRawStatus = Omit<RawStatusComputation, "crons">;

interface FreshStatusRawSnapshot {
  kind: "fresh";
  raw: SnapshotRawStatus;
  supplements?: StatusSupplements;
  updatedAt: number;
  ageSec: number;
  maxAgeSec: number;
}

export type StatusRawSnapshotLoadResult = FreshStatusRawSnapshot | UnavailableStatusSnapshot;

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
const RawStatusSchema = StatusResponseSchema.in.pick({
  dbHealthy: true,
  availabilityStatus: true,
  dataQualityStatus: true,
  rawOverallStatus: true,
  confidence: true,
  causes: true,
  caches: true,
  budgetOnlySurfaces: true,
  dataQuality: true,
  telegramBot: true,
  sectionErrors: true,
  datasetFreshness: true,
  summary: true,
  reserveComposition: true,
  schedulerLiveness: true,
}).extend({
  budgetOnlySurfaces: StatusResponseSchema.in.shape.budgetOnlySurfaces.default([]),
  evidenceReadFailures: z.array(z.string()).optional(),
  freshnessDiagnostics: z.array(z.object({
    key: z.string(),
    freshnessSource: z.enum(["freshness-sentinel", "table-fallback", "cron-fallback"]),
    warning: z.string().optional(),
    failureSource: z.enum(["cache-table", "table-freshness", "cron-fallback"]).optional(),
  }).passthrough()),
}).refine(({ reserveComposition: reserve }) =>
  reserve.status === "unavailable" ||
  (reserve.healthConfiguredCoins != null
    && reserve.healthFreshCoins != null
    && reserve.healthAuthoritativeFreshCoins != null
    && reserve.acknowledgedFeeds != null
    && reserve.acknowledgedFeedIds != null
    && reserve.expiredFeedReviewIds != null
    && reserve.invalidFeedReviewIds != null
    && reserve.unacknowledgedPersistentlyStaleIndependentCoins != null),
);
const StatusRawSnapshotPayloadSchema = z.object({
  version: z.literal(STATUS_RAW_SNAPSHOT_PAYLOAD_VERSION),
  producedAt: z.number().finite(),
  /** Canonical cron cohort the assessment was computed over. */
  cronJobs: z.array(z.string()),
  raw: RawStatusSchema,
  supplements: StatusSupplementsSchema.optional(),
});

export interface StatusRawSnapshotWriteOptions {
  supplements?: StatusSupplements;
}

export async function loadStatusRawSnapshot(
  db: D1Database,
  now: number,
  maxAgeSec = STATUS_RAW_SNAPSHOT_MAX_AGE_SEC,
): Promise<StatusRawSnapshotLoadResult> {
  const loaded = await loadStatusSnapshotPayload(
    db, STATUS_RAW_SNAPSHOT_CACHE_KEY, StatusRawSnapshotPayloadSchema, now, maxAgeSec,
  );
  if (loaded.kind !== "fresh") return loaded;
  const { payload, updatedAt, ageSec } = loaded;
  // Membership changes invalidate the entire assessment, including its severity
  // floor. Filtering stale producers would leave their cached causes/status behind.
  const cohort = new Set(payload.cronJobs);
  if (cohort.size !== payload.cronJobs.length || cohort.size !== EXPECTED_CRON_JOBS.length
    || EXPECTED_CRON_JOBS.some((job) => !cohort.has(job))) {
    return { kind: "unreadable", updatedAt, ageSec, maxAgeSec, error: "status raw snapshot cron cohort mismatch" };
  }
  return { kind: "fresh", raw: payload.raw, supplements: payload.supplements, updatedAt, ageSec, maxAgeSec };
}

export async function writeStatusRawSnapshot(
  db: D1Database,
  now: number,
  raw: RawStatusComputation,
  options: StatusRawSnapshotWriteOptions = {},
): Promise<boolean> {
  const { crons, ...assessment } = raw;
  return writeStatusSnapshotPayload(db, STATUS_RAW_SNAPSHOT_CACHE_KEY, now, {
    version: STATUS_RAW_SNAPSHOT_PAYLOAD_VERSION,
    producedAt: now,
    cronJobs: Object.keys(crons),
    raw: assessment,
    supplements: options.supplements,
  });
}
