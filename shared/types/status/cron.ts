import { z } from "zod";

export const CRON_RUN_STATUS_VALUES = [
  "ok",
  "degraded",
  "error",
  "skipped_locked",
  "skipped_neutral",
  "skipped_duplicate",
  "skipped_running",
] as const;
export const CronRunStatusSchema = z.enum(CRON_RUN_STATUS_VALUES);
export type CronRunStatus = z.infer<typeof CronRunStatusSchema>;

export const CronRunSchema = z.object({
  startedAt: z.number(),
  durationMs: z.number(),
  status: CronRunStatusSchema,
  error: z.string().optional(),
  itemCount: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CronRun = z.output<typeof CronRunSchema>;

export const CronInFlightSchema = z.object({
  startedAt: z.number(),
  updatedAt: z.number(),
  stage: z.string().optional(),
  itemsDone: z.number().optional(),
  itemsTotal: z.number().optional(),
  message: z.string().optional(),
  leaseOwner: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  stale: z.boolean(),
});
export type CronInFlight = z.output<typeof CronInFlightSchema>;

export const CronStaleArtifactSchema = z.object({
  kind: z.enum(["expired-lease", "orphaned-progress"]),
  job: z.string(),
  leaseOwner: z.string().optional(),
  leaseUntil: z.number().optional(),
  progressUpdatedAt: z.number().optional(),
  progressStage: z.string().optional(),
  slotStartedAt: z.number().nullable().optional(),
});
export type CronStaleArtifact = z.output<typeof CronStaleArtifactSchema>;

export const CronEventSchema = z.object({
  event: z.literal("cron_event"),
  job: z.string(),
  eventType: z.string(),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  recordedAt: z.number(),
});
export type CronEvent = z.output<typeof CronEventSchema>;

export const CronStatusSchema = z.object({
  lastRun: CronRunSchema.nullable(),
  recentRuns: z.array(CronRunSchema),
  expectedIntervalSec: z.number(),
  healthy: z.boolean(),
  telemetryUnknown: z.boolean().optional(),
  inFlight: CronInFlightSchema.nullable().optional(),
  staleArtifacts: z.array(CronStaleArtifactSchema).optional(),
  latestEvent: CronEventSchema.optional(),
  /**
   * Set to `true` only for watch-tier crons that have zero historical runs
   * (bootstrap state). The cron is considered healthy in this state because
   * its first successful run has not yet produced a `cron_runs` row, so
   * there is no history to compare against. Critical-tier crons do not get
   * this flag — they are unhealthy until they have produced at least one run.
   */
  bootstrap: z.boolean().optional(),
});
export type CronStatus = z.output<typeof CronStatusSchema>;

export const BudgetOnlySurfaceStatusSchema = z.object({
  job: z.string(),
  label: z.string(),
  scheduleKey: z.string(),
  schedule: z.string(),
  expectedIntervalSec: z.number(),
  maxAgeSec: z.number(),
  maxConnections: z.number(),
  connectionGroup: z.string().optional(),
  telemetryStatus: z.enum(["fresh", "stale", "missing", "unreadable"]),
  telemetryUnknown: z.boolean(),
  checkedAt: z.number().nullable(),
  ageSeconds: z.number().nullable(),
  durationMs: z.number().nullable(),
  dueCount: z.number().nullable(),
  processedCount: z.number().nullable(),
  outcome: z.enum(["ok", "degraded", "error", "skipped", "unknown"]),
  skippedReason: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type BudgetOnlySurfaceStatus = z.output<typeof BudgetOnlySurfaceStatusSchema>;
