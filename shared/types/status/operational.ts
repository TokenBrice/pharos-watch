import { z } from "zod";
import { StatusHealthOrUnknownSchema } from "./schema-primitives";
import { D1CapacityAssessmentSchema } from "./d1-capacity";

export interface AlertBrokerHealthSummary {
  activeCount: number;
  pendingCount: number;
  criticalActiveCount: number;
  failedDeliveryCount: number;
  missingTargetCount: number;
  oldestActiveAt: number | null;
  activeConditionKeys: string[];
  queryFailed: boolean;
}

export const ProducerHeadStatusSchema = z.object({
  scheduleKey: z.string(),
  job: z.string(),
  producerPath: z.string(),
  producerKind: z.string(),
  observed: z.boolean(),
  lastInvocationId: z.string().nullable(),
  lastWorkerVersion: z.string().nullable(),
  lastInvokedAt: z.number().nullable(),
  lastCompletedAt: z.number().nullable(),
  lastOutcome: z.string().nullable(),
  lastError: z.string().nullable(),
  lastProductiveInvocationId: z.string().nullable(),
  lastProductiveAt: z.number().nullable(),
  lastProductiveItemCount: z.number().nullable(),
  lastPublicationAt: z.number().nullable(),
  invocationCount: z.number(),
  productiveCount: z.number(),
});
export type ProducerHeadStatus = z.output<typeof ProducerHeadStatusSchema>;

export const PUBLICATION_SURFACE_IDS = [
  "dex-liquidity",
  "yield-rankings",
  "stablecoins",
  "dews",
  "psi",
  "safety-score-v9",
] as const;
export type PublicationSurfaceId = (typeof PUBLICATION_SURFACE_IDS)[number];

export const PUBLICATION_GENERATION_STATES = [
  "candidate",
  "validated",
  "published",
  "rejected",
  "superseded",
  "failed",
] as const;
export const PublicationGenerationStateSchema = z.enum(PUBLICATION_GENERATION_STATES);
export type PublicationGenerationState = z.infer<typeof PublicationGenerationStateSchema>;

export const PublicationGenerationHealthSchema = z.object({
  generationId: z.string(),
  sourceState: z.string(),
  state: PublicationGenerationStateSchema,
  startedAt: z.number(),
  validatedAt: z.number().nullable(),
  publishedAt: z.number().nullable(),
  failedAt: z.number().nullable(),
  candidateRows: z.number().nullable(),
  publishedRows: z.number().nullable(),
  expectedRows: z.number().nullable(),
  failureReason: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type PublicationGenerationHealth = z.output<typeof PublicationGenerationHealthSchema>;

export const PublicationSurfaceHealthSchema = z.object({
  surface: z.enum(PUBLICATION_SURFACE_IDS),
  label: z.string(),
  sourceOfTruth: z.string(),
  lastPublishedGeneration: PublicationGenerationHealthSchema.nullable(),
  lastAttemptedGeneration: PublicationGenerationHealthSchema.nullable(),
  lastFailureReason: z.string().nullable(),
  candidateAgeSec: z.number().nullable(),
  dependencyWatermarks: z.record(z.string(), z.unknown()).nullable(),
});
export type PublicationSurfaceHealth = z.output<typeof PublicationSurfaceHealthSchema>;

export const PublicationSurfaceFailureSchema = z.object({
  surface: z.enum(PUBLICATION_SURFACE_IDS),
  code: z.string(),
  message: z.string(),
});
export type PublicationSurfaceFailure = z.output<typeof PublicationSurfaceFailureSchema>;

export const PublicationHealthSchema = z.object({
  checkedAt: z.number(),
  surfaces: z.record(z.string(), PublicationSurfaceHealthSchema),
  failedSurfaces: z.array(PublicationSurfaceFailureSchema).optional(),
});
export type PublicationHealth = z.output<typeof PublicationHealthSchema>;

export const DEPENDENCY_HEALTH_STATUS_VALUES = ["healthy", "degraded", "stale", "unknown"] as const;
export const DependencyHealthStatusSchema = z.enum(DEPENDENCY_HEALTH_STATUS_VALUES);
export type DependencyHealthStatus = z.infer<typeof DependencyHealthStatusSchema>;

export const DEPENDENCY_IMPACT_LAYER_VALUES = ["availability", "data-quality", "system"] as const;
export const DependencyImpactLayerSchema = z.enum(DEPENDENCY_IMPACT_LAYER_VALUES);
export type DependencyImpactLayer = z.infer<typeof DependencyImpactLayerSchema>;

export const DEPENDENCY_CRITICALITY_VALUES = ["critical", "watch"] as const;
export const DependencyCriticalitySchema = z.enum(DEPENDENCY_CRITICALITY_VALUES);
export type DependencyCriticality = z.infer<typeof DependencyCriticalitySchema>;

export const DependencyHealthItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  sourceOfTruth: z.string(),
  producerJob: z.string().nullable(),
  cacheKey: z.string().nullable(),
  publicationSurface: z.enum(PUBLICATION_SURFACE_IDS).nullable(),
  impactLayer: DependencyImpactLayerSchema,
  criticality: DependencyCriticalitySchema,
  dependsOn: z.array(z.string()),
  consumers: z.array(z.string()),
  status: DependencyHealthStatusSchema,
  checkedAt: z.number(),
  updatedAt: z.number().nullable(),
  ageSeconds: z.number().nullable(),
  maxAgeSec: z.number().nullable(),
  reason: z.string().nullable(),
  runbookPath: z.string().nullable(),
});
export type DependencyHealthItem = z.output<typeof DependencyHealthItemSchema>;

const DependencyRootCauseGroupSchema = z.object({
  rootDependencyId: z.string(),
  rootStatus: DependencyHealthStatusSchema,
  rootReason: z.string().nullable(),
  symptomDependencyIds: z.array(z.string()),
  impactedDependencyIds: z.array(z.string()),
  consumerIds: z.array(z.string()),
  criticality: DependencyCriticalitySchema,
});

export const DependencyHealthSchema = z.object({
  checkedAt: z.number(),
  dependencies: z.record(z.string(), DependencyHealthItemSchema),
  rootCauseGroups: z.array(DependencyRootCauseGroupSchema),
  summary: z.object({
    total: z.number(),
    healthy: z.number(),
    degraded: z.number(),
    stale: z.number(),
    unknown: z.number(),
    rootCauseGroupCount: z.number(),
  }),
});
export type DependencyHealth = z.output<typeof DependencyHealthSchema>;

export const ProviderCircuitHealthEntrySchema = z.object({
  providerId: z.string(),
  family: z.string(),
  state: z.enum(["closed", "half-open", "open"]),
  consecutiveFailures: z.number(),
  openedAt: z.number().nullable(),
  openAgeSec: z.number().nullable(),
  lastFailureAt: z.number().nullable(),
  lastSuccessAt: z.number().nullable(),
});
export type ProviderCircuitHealthEntry = z.output<typeof ProviderCircuitHealthEntrySchema>;

export const ProviderCircuitHealthFamilySummarySchema = z.object({
  total: z.number(),
  closed: z.number(),
  halfOpen: z.number(),
  open: z.number(),
});
export type ProviderCircuitHealthFamilySummary = z.output<
  typeof ProviderCircuitHealthFamilySummarySchema
>;

export const ProviderCircuitHealthSchema = z.object({
  checkedAt: z.number(),
  status: StatusHealthOrUnknownSchema,
  totalTracked: z.number(),
  closedCount: z.number(),
  halfOpenCount: z.number(),
  openCount: z.number(),
  openProviders: z.array(ProviderCircuitHealthEntrySchema),
  byFamily: z.record(z.string(), ProviderCircuitHealthFamilySummarySchema),
});
export type ProviderCircuitHealth = z.output<typeof ProviderCircuitHealthSchema>;

export const CANARY_RUN_STATUS_VALUES = ["ok", "degraded", "error", "skipped"] as const;
export const CanaryRunStatusSchema = z.enum(CANARY_RUN_STATUS_VALUES);
export type CanaryRunStatus = z.infer<typeof CanaryRunStatusSchema>;

export const CANARY_RUN_SEVERITY_VALUES = ["info", "warning", "error", "critical"] as const;
export const CanaryRunSeveritySchema = z.enum(CANARY_RUN_SEVERITY_VALUES);
export type CanaryRunSeverity = z.infer<typeof CanaryRunSeveritySchema>;

const CanaryStatusCheckSchema = z.object({
  checkId: z.string(),
  label: z.string(),
  description: z.string(),
  status: CanaryRunStatusSchema,
  severity: CanaryRunSeveritySchema,
  observedAt: z.number(),
  durationMs: z.number().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

export const CanaryStatusSchema = z.object({
  checkedAt: z.number(),
  status: StatusHealthOrUnknownSchema,
  latestRunAt: z.number().nullable(),
  maxAgeSec: z.number(),
  totalChecks: z.number(),
  okCount: z.number(),
  degradedCount: z.number(),
  errorCount: z.number(),
  skippedCount: z.number(),
  staleCount: z.number(),
  checks: z.record(z.string(), CanaryStatusCheckSchema),
});
export type CanaryStatus = z.output<typeof CanaryStatusSchema>;

export const D1UsageSummarySchema = z.object({
  checkedAt: z.number(),
  windowStart: z.number(),
  windowEnd: z.number(),
  databaseId: z.string(),
  databaseName: z.string().nullable(),
  databaseSizeBytes: z.number().nullable(),
  numTables: z.number().nullable(),
  region: z.string().nullable(),
  readReplicationMode: z.string().nullable(),
  readQueries24h: z.number().nullable(),
  writeQueries24h: z.number().nullable(),
  rowsRead24h: z.number().nullable(),
  rowsWritten24h: z.number().nullable(),
  /** Optional while an older Worker or a not-yet-initialized observation store is serving status. */
  capacity: D1CapacityAssessmentSchema.nullable().optional(),
});
export type D1UsageSummary = z.output<typeof D1UsageSummarySchema>;
