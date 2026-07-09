import type { StatusHealthOrUnknown } from "./core";
import type { CircuitRecord } from "./public-health";

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
  state: CircuitRecord["state"];
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
}
