import type { StatusHealthOrUnknown } from "./core";
import type { D1CapacityAssessment } from "./d1-capacity";

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

export interface ProducerHeadStatus {
  scheduleKey: string;
  job: string;
  producerPath: string;
  producerKind: string;
  observed: boolean;
  lastInvocationId: string | null;
  lastWorkerVersion: string | null;
  lastInvokedAt: number | null;
  lastCompletedAt: number | null;
  lastOutcome: string | null;
  lastError: string | null;
  lastProductiveInvocationId: string | null;
  lastProductiveAt: number | null;
  lastProductiveItemCount: number | null;
  lastPublicationAt: number | null;
  invocationCount: number;
  productiveCount: number;
}

export type PublicationSurfaceId =
  "dex-liquidity" | "yield-rankings" | "stablecoins" | "dews" | "psi" | "report-card-cache";
export type PublicationGenerationState = "candidate" | "validated" | "published" | "rejected" | "superseded" | "failed";

export interface PublicationGenerationHealth {
  generationId: string;
  sourceState: string;
  state: PublicationGenerationState;
  startedAt: number;
  validatedAt: number | null;
  publishedAt: number | null;
  failedAt: number | null;
  candidateRows: number | null;
  publishedRows: number | null;
  expectedRows: number | null;
  failureReason: string | null;
  metadata?: Record<string, unknown>;
}

export interface PublicationSurfaceHealth {
  surface: PublicationSurfaceId;
  label: string;
  sourceOfTruth: string;
  lastPublishedGeneration: PublicationGenerationHealth | null;
  lastAttemptedGeneration: PublicationGenerationHealth | null;
  lastFailureReason: string | null;
  candidateAgeSec: number | null;
  dependencyWatermarks: Record<string, unknown> | null;
}

export interface PublicationSurfaceFailure {
  surface: PublicationSurfaceId;
  code: string;
  message: string;
}

export interface PublicationHealth {
  checkedAt: number;
  surfaces: Partial<Record<PublicationSurfaceId, PublicationSurfaceHealth>>;
  failedSurfaces?: PublicationSurfaceFailure[];
}

export type DependencyHealthStatus = "healthy" | "degraded" | "stale" | "unknown";
export type DependencyImpactLayer = "availability" | "data-quality" | "system";
export type DependencyCriticality = "critical" | "watch";

export interface DependencyHealthItem {
  id: string;
  label: string;
  sourceOfTruth: string;
  producerJob: string | null;
  cacheKey: string | null;
  publicationSurface: PublicationSurfaceId | null;
  impactLayer: DependencyImpactLayer;
  criticality: DependencyCriticality;
  dependsOn: string[];
  consumers: string[];
  status: DependencyHealthStatus;
  checkedAt: number;
  updatedAt: number | null;
  ageSeconds: number | null;
  maxAgeSec: number | null;
  reason: string | null;
  runbookPath: string | null;
}

export interface DependencyRootCauseGroup {
  rootDependencyId: string;
  rootStatus: DependencyHealthStatus;
  rootReason: string | null;
  symptomDependencyIds: string[];
  impactedDependencyIds: string[];
  consumerIds: string[];
  criticality: DependencyCriticality;
}

export interface DependencyHealth {
  checkedAt: number;
  dependencies: Record<string, DependencyHealthItem>;
  rootCauseGroups: DependencyRootCauseGroup[];
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    stale: number;
    unknown: number;
    rootCauseGroupCount: number;
  };
}

export interface ProviderCircuitHealthEntry {
  providerId: string;
  family: string;
  state: "closed" | "half-open" | "open";
  consecutiveFailures: number;
  openedAt: number | null;
  openAgeSec: number | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

export interface ProviderCircuitHealthFamilySummary {
  total: number;
  closed: number;
  halfOpen: number;
  open: number;
}

export interface ProviderCircuitHealth {
  checkedAt: number;
  status: StatusHealthOrUnknown;
  totalTracked: number;
  closedCount: number;
  halfOpenCount: number;
  openCount: number;
  openProviders: ProviderCircuitHealthEntry[];
  byFamily: Record<string, ProviderCircuitHealthFamilySummary>;
}

export type CanaryRunStatus = "ok" | "degraded" | "error" | "skipped";
export type CanaryRunSeverity = "info" | "warning" | "error" | "critical";

export interface CanaryStatusCheck {
  checkId: string;
  label: string;
  description: string;
  status: CanaryRunStatus;
  severity: CanaryRunSeverity;
  observedAt: number;
  durationMs: number | null;
  metadata?: Record<string, unknown>;
  error?: string;
}

export interface CanaryStatus {
  checkedAt: number;
  status: StatusHealthOrUnknown;
  latestRunAt: number | null;
  maxAgeSec: number;
  totalChecks: number;
  okCount: number;
  degradedCount: number;
  errorCount: number;
  skippedCount: number;
  staleCount: number;
  checks: Record<string, CanaryStatusCheck>;
}

export interface D1UsageSummary {
  checkedAt: number;
  windowStart: number;
  windowEnd: number;
  databaseId: string;
  databaseName: string | null;
  databaseSizeBytes: number | null;
  numTables: number | null;
  region: string | null;
  readReplicationMode: string | null;
  readQueries24h: number | null;
  writeQueries24h: number | null;
  rowsRead24h: number | null;
  rowsWritten24h: number | null;
  /** Optional while an older Worker or a not-yet-initialized observation store is serving status. */
  capacity?: D1CapacityAssessment | null;
  /** Private-R2 DEX evidence archive control-plane telemetry. */
  archive?: DexArchiveStatus | null;
}

export interface DexArchiveFamilyStatus {
  family: "measured-execution" | "liquidity";
  configuredMode: string;
  effectiveMode: "off" | "shadow" | "delete";
  configError: string | null;
  eligibleGenerationCount: number;
  eligibleRowCount: number;
  eligibleLogicalBytes: number;
  verifiedPendingDeleteCount: number;
  oldestEligibleAt: number | null;
  oldestVerifiedPendingDeleteAt: number | null;
  uploadedObjectCount: number;
  verifiedObjectCount: number;
  deletedGenerationCount: number;
  archivedUncompressedBytes: number;
  archivedStoredBytes: number;
  deletedSourceRowCount: number;
  deletedSourceBytes: number;
  objectsWritten24h: number;
  sourceRowsDeleted24h: number;
  sourceBytesDeleted24h: number;
  orphanObjectCount: number;
  missingObjectCount: number;
  lifecycleDriftCount: number;
  lastUploadAt: number | null;
  lastVerifiedAt: number | null;
  lastDeleteAt: number | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  lastRunAt: number | null;
  updatedAt: number;
}

export interface DexArchiveStatus {
  checkedAt: number;
  releaseStage: "foundation" | "measured-shadow" | "measured-delete" | "liquidity-shadow" | "liquidity-delete";
  objectSchemaVersion: 1;
  logicalRetentionDays: 30;
  lifecycleExpiryDays: 35;
  manifestRetentionDays: 90;
  maxObjectsPerInvocation: 12;
  normalReadDependsOnR2: false;
  manifestCount: number;
  uploadedManifestCount: number;
  verifiedManifestCount: number;
  sourceDeletedManifestCount: number;
  failedManifestCount: number;
  familyStates: DexArchiveFamilyStatus[];
}
