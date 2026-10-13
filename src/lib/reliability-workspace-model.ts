import type {
  ApiRequestAttributionResponse,
  EndpointProbeResult,
  HealthResponse,
  StatusResponse,
} from "@shared/types";
import type { OperatorVerdict } from "@shared/lib/classification";
import type { BrowserProbeSummary } from "@/lib/status-dashboard-model";
import { pickInitialMode, type WorkspaceSeverity } from "@/lib/status/workspace-mode";

export const RELIABILITY_MODES = [
  { id: "impact", label: "Impact" },
  { id: "endpoints", label: "Endpoints" },
  { id: "dependencies", label: "Dependencies" },
  { id: "demand", label: "Demand" },
  { id: "cache", label: "Cache freshness" },
] as const;

export type ReliabilityMode = (typeof RELIABILITY_MODES)[number]["id"];
export type ReliabilitySeverity = WorkspaceSeverity;
export type ReliabilityIssueKind = "critical" | "warning" | "maintenance" | "informational" | "unknown";

export const RELIABILITY_ISSUE_KIND_RANK: Readonly<Record<ReliabilityIssueKind, number>> = {
  informational: 0,
  maintenance: 1,
  warning: 2,
  unknown: 3,
  critical: 4,
};

/** Reliability issue kinds in the operator verdict vocabulary (critical acts; info-only watches). */
export const RELIABILITY_KIND_VERDICT: Readonly<Record<ReliabilityIssueKind, OperatorVerdict>> = {
  critical: "act",
  warning: "watch",
  maintenance: "watch",
  informational: "watch",
  unknown: "unavailable",
};

/** Raw dependency, circuit and canary state words in the operator verdict vocabulary. */
export function getReliabilityStateVerdict(state: string): OperatorVerdict {
  if (state === "ok" || state === "healthy" || state === "closed" || state === "verified") return "ok";
  if (state === "degraded" || state === "half-open") return "watch";
  if (state === "stale" || state === "open" || state === "error" || state === "failed") return "act";
  if (state === "running") return "running";
  return "unavailable";
}

export interface ReliabilityIssue {
  id: string;
  mode: ReliabilityMode;
  label: string;
  kind: ReliabilityIssueKind;
  rawCode: string;
  detail: string;
  affectedSurface: string;
}

export interface ReliabilityModeSummary {
  id: ReliabilityMode;
  label: string;
  issueCount: number;
  severity: ReliabilitySeverity;
}

export interface ReliabilityEvidenceGap {
  mode: ReliabilityMode;
  label: string;
  rawCode: string;
  code: string;
  message: string;
  kind: "failure" | "missing";
}

export interface ReliabilityEndpointModel {
  capturedAt: number;
  workerPlane: {
    status: StatusResponse["probe"]["status"];
    sampleCount: number;
    passCount: number;
    failCount: number;
    p95LatencyMs: number | null;
    sampledAt: number | null;
  };
  browserPlane: BrowserProbeSummary | null;
  unhealthyProbes: EndpointProbeResult[];
  healthyProbes: EndpointProbeResult[];
  diagnosticText: string;
}

export interface ReliabilityDependencyRoot {
  id: string;
  label: string;
  status: "healthy" | "degraded" | "stale" | "unknown";
  criticality: "critical" | "watch";
  reason: string | null;
  impactedCount: number;
  consumers: string[];
}

/** One row per tripped circuit key, merging provider and public-health views of the same breaker. */
export interface ReliabilityCircuitRow {
  key: string;
  /** Provider family when the provider-circuit view knows it. */
  family: string | null;
  state: "open" | "half-open" | "closed";
  consecutiveFailures: number;
  openedAt: number | null;
  lastFailureAt: number | null;
  /** Source-wide registry scope: an open breaker degrades the public surface. */
  publicImpact: boolean;
}

export interface ReliabilityDependenciesModel {
  roots: ReliabilityDependencyRoot[];
  circuits: ReliabilityCircuitRow[];
  dependencySummary: NonNullable<StatusResponse["dependencyHealth"]>["summary"] | null;
  providerCircuits: NonNullable<StatusResponse["providerCircuitHealth"]>["openProviders"];
  providerSummary: StatusResponse["providerCircuitHealth"];
  publicCircuits: Array<[string, NonNullable<HealthResponse["circuits"]>[string]]>;
  publicCircuitEvidenceAvailable: boolean;
  canaryChecks: Array<NonNullable<StatusResponse["canaries"]>["checks"][string]>;
  canarySummary: StatusResponse["canaries"];
  diagnosticText: string;
}

export interface ReliabilityWorkspaceModel {
  issues: ReliabilityIssue[];
  modeSummaries: ReliabilityModeSummary[];
  evidenceGaps: ReliabilityEvidenceGap[];
  endpoints: ReliabilityEndpointModel;
  dependencies: ReliabilityDependenciesModel;
  cacheUnknownCount: number;
}

export interface ReliabilityWorkspaceInput {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  healthError?: string | null;
  healthLoading?: boolean;
  probes: EndpointProbeResult[] | undefined;
  probesError?: string | null;
  probesLoading?: boolean;
  browserProbeSummary: BrowserProbeSummary | null;
  requestSourceStats: ApiRequestAttributionResponse | null | undefined;
  requestSourceError?: string | null;
  requestSourceLoading?: boolean;
}

export { sanitizeReliabilityProbePath } from "@/lib/reliability-workspace-endpoint-builder";
export { buildReliabilityWorkspaceModel } from "@/lib/reliability-workspace-issue-builder";

export function deriveInitialReliabilityMode(
  model: Pick<ReliabilityWorkspaceModel, "modeSummaries">,
): ReliabilityMode {
  return pickInitialMode(model.modeSummaries, RELIABILITY_MODES, "impact");
}
