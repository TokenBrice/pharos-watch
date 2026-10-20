import { z } from "zod";

const CRON_RUN_STATUS_VALUES = [
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
export type CronResultStatus = Exclude<CronRunStatus, "skipped_duplicate" | "skipped_running">;

export const SchedulerChildDispositionSchema = z.enum([
  "completed", "abandoned", "not_started", "execution_unknown", "interrupted-by-deploy",
]);
export type SchedulerChildDisposition = z.output<typeof SchedulerChildDispositionSchema>;
export type SchedulerTerminalSource = "real" | "preflight" | "synthetic";
export type ProducerOutcome = CronResultStatus | "not_started" | "abandoned";
const SchedulerSummaryOutcomeSchema = z.enum(["ok", "degraded", "error", "skipped"]);
export type SchedulerSummaryOutcome = z.output<typeof SchedulerSummaryOutcomeSchema>;
export type CronTerminalAccountingStage = "cron-run" | "producer-history" | "terminal-batch";

const ResourceCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();

/** Byte-policy evidence, not a heap measurement or inferred platform failure. */
export const ResourcePressureSchema = z.object({
  phase: z.string().min(1).max(80),
  observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bodyCapBytes: ResourceCountSchema,
  cacheCapBytes: ResourceCountSchema,
  cacheEntryCapBytes: ResourceCountSchema,
  maxConcurrentDecodes: ResourceCountSchema,
  inputCapBytes: ResourceCountSchema,
  catalogMaxAssets: ResourceCountSchema,
  intakeBytes: ResourceCountSchema,
  cacheBytes: ResourceCountSchema,
  rejectedBodies: ResourceCountSchema,
  inputBytes: ResourceCountSchema,
  catalogAssets: ResourceCountSchema,
  intakeBasis: z.enum(["actual-stream", "unavailable"]),
  cacheBasis: z.enum(["intake-estimate", "declared-estimate", "mixed", "unavailable"]),
  guard: z.enum(["not-measured", "within-policy", "approaching-resource-budget", "cache-bypassed", "resource-budget-exceeded"]),
  platformOutcome: z.enum(["platform-abandoned", "platform-interrupted"]).nullable(),
  platformOutcomeSource: z.literal("slot-reconciliation").nullable(),
  heapUsedBytes: z.null(),
  heapUnavailableReason: z.literal("workers-runtime-no-heap-api"),
}).strict().refine(
  (value) => (value.platformOutcome === null) === (value.platformOutcomeSource === null),
  { message: "Platform outcome must name its reconciliation source" },
);
export type ResourcePressure = z.output<typeof ResourcePressureSchema>;

const CronMetadataSchema = z.object({
  resourcePressure: ResourcePressureSchema.optional(),
}).catchall(z.unknown());

/** Bound on a run's `error` text in the default status summary; detail keeps the full text. */
export const CRON_RUN_SUMMARY_ERROR_MAX_CHARS = 500;

/**
 * Lightweight attempt outcome served by the default `/api/status` summary.
 * Typed projection of the attempt's metadata: no arbitrary metadata is carried.
 * Absent optional fields mean the attempt did not record them.
 */
export const CronRunSummarySchema = z.object({
  startedAt: z.number(),
  durationMs: z.number(),
  status: CronRunStatusSchema,
  /** Bounded to CRON_RUN_SUMMARY_ERROR_MAX_CHARS in the summary; full text in detail. */
  error: z.string().optional(),
  degradedReason: z.string().optional(),
  itemCount: z.number().optional(),
  /** Persisted status string when it was not a known run status (served as `error`). */
  rawStatus: z.string().optional(),
  reason: z.string().optional(),
  skippedReason: z.string().optional(),
  childDisposition: z.string().optional(),
  workerVersion: z.string().optional(),
  /** Operator findings derived from `metadata.quality` (shared `getCronQualityReasons`). */
  qualityReasons: z.array(z.string()).optional(),
  /** Synthetic-abandonment timing: last heartbeat versus reconciliation clocks. */
  activeDurationMs: z.number().optional(),
  progressUpdatedAt: z.number().optional(),
  reconciledAt: z.number().optional(),
  reconciliationDelayMs: z.number().optional(),
});
export type CronRunSummary = z.output<typeof CronRunSummarySchema>;

/** Selected-attempt detail: the summary projection plus the full persisted metadata. */
export const CronRunDetailSchema = CronRunSummarySchema.extend({
  metadata: CronMetadataSchema.optional(),
});
export type CronRunDetail = z.output<typeof CronRunDetailSchema>;

export const CronInFlightSchema = z.object({
  startedAt: z.number(),
  updatedAt: z.number(),
  stage: z.string().optional(),
  itemsDone: z.number().optional(),
  itemsTotal: z.number().optional(),
  message: z.string().optional(),
  leaseOwner: z.string().optional(),
  metadata: CronMetadataSchema.optional(),
  stale: z.boolean(),
});
export type CronInFlight = z.output<typeof CronInFlightSchema>;

/** Current progress in the default summary; progress metadata is detail-only. */
const CronInFlightSummarySchema = CronInFlightSchema.omit({ metadata: true });

/** Rejected progress is diagnostic evidence, never an admitted live heartbeat. */
const CronInFlightUnavailableSchema = CronInFlightSummarySchema
  .omit({ startedAt: true, updatedAt: true })
  .extend({
    startedAt: z.unknown(),
    updatedAt: z.unknown(),
    timestampReason: z.enum(["missing-timestamp", "invalid-timestamp", "future-timestamp"]),
  });

const CronStaleArtifactSchema = z.object({
  kind: z.enum(["expired-lease", "orphaned-progress"]),
  job: z.string(),
  leaseOwner: z.string().optional(),
  leaseUntil: z.number().optional(),
  progressUpdatedAt: z.number().optional(),
  progressStage: z.string().optional(),
  slotStartedAt: z.number().nullable().optional(),
});
export type CronStaleArtifact = z.output<typeof CronStaleArtifactSchema>;

const CronEventSchema = z.object({
  event: z.literal("cron_event"),
  job: z.string(),
  eventType: z.string(),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  recordedAt: z.number(),
});
export type CronEvent = z.output<typeof CronEventSchema>;

const CronStatusVerdictShape = {
  expectedIntervalSec: z.number(),
  /**
   * `true`/`false` only when cron telemetry was actually read. `null` means the
   * cron-history read failed, so no availability claim is published for this
   * job (rule R2); `telemetryUnknownReason` names why.
   */
  healthy: z.boolean().nullable(),
  telemetryUnknown: z.boolean().optional(),
  telemetryUnknownReason: z.string().optional(),
  inFlightUnavailable: CronInFlightUnavailableSchema.optional(),
  /**
   * Newest confirmed output clock (`confirmedCronOutputAt`) among the bounded
   * history read for this response. `null` means none was found in that read
   * (or the read failed); it is not proof that the job never published.
   */
  confirmedOutputAt: z.number().nullable(),
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
};

/**
 * Default `/api/status` per-job summary. `runs` is newest first: `runs[0]` is
 * the latest attempt (there is no separate `lastRun`). It holds the ten-row
 * display window plus the inheritance evidence appended behind an all-neutral
 * window (latest required attempts and a fresh proven-satisfied readback).
 */
export const CronStatusSchema = z.object({
  ...CronStatusVerdictShape,
  runs: z.array(CronRunSummarySchema),
  /**
   * Registry-selected keys of `runs[0].metadata` that default operator views
   * read (`CRON_STATUS_LATEST_FACT_KEYS`). Absent when the job has no
   * registered facts or the latest attempt carried no metadata.
   */
  latestRunFacts: z.record(z.string(), z.unknown()).optional(),
  inFlight: CronInFlightSummarySchema.nullable().optional(),
});
export type CronStatus = z.output<typeof CronStatusSchema>;

/** Per-job detail (`/api/status-cron-detail`): same verdict with full run and progress metadata. */
const CronStatusDetailSchema = z.object({
  ...CronStatusVerdictShape,
  runs: z.array(CronRunDetailSchema),
  inFlight: CronInFlightSchema.nullable().optional(),
});
export type CronStatusDetail = z.output<typeof CronStatusDetailSchema>;

export const StatusCronDetailResponseSchema = z.object({
  timestamp: z.number(),
  job: z.string(),
  cron: CronStatusDetailSchema,
  /**
   * Companion reads that failed for this request (progress, leases, slot event
   * markers). A failed read leaves the matching field empty without implying
   * the job is idle or event-free.
   */
  sectionErrors: z.record(z.string(), z.object({ code: z.string(), message: z.string() })),
});
export type StatusCronDetailResponse = z.output<typeof StatusCronDetailResponseSchema>;

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
  outcome: SchedulerSummaryOutcomeSchema.or(z.literal("unknown")),
  skippedReason: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type BudgetOnlySurfaceStatus = z.output<typeof BudgetOnlySurfaceStatusSchema>;
