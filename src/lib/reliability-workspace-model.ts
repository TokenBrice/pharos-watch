import { getCacheFreshnessRatio } from "@shared/lib/cache-health";
import { isPublicImpactCircuitKey } from "@shared/lib/public-health";
import { STATUS_CACHE_RATIO_THRESHOLDS } from "@shared/lib/status-thresholds";
import type {
  ApiRequestAttributionResponse,
  EndpointProbeResult,
  HealthResponse,
  StatusHealthValue,
  StatusResponse,
  StatusSectionKey,
} from "@shared/types";
import { normalizeStatusIssues, type BrowserProbeSummary } from "@/lib/status-dashboard-model";

const RELIABILITY_MODE_QUERY_PARAM = "view";

export const RELIABILITY_MODES = [
  { id: "impact", label: "Impact" },
  { id: "endpoints", label: "Endpoints" },
  { id: "dependencies", label: "Dependencies" },
  { id: "demand", label: "Demand" },
  { id: "cache", label: "Cache freshness" },
] as const;

export type ReliabilityMode = (typeof RELIABILITY_MODES)[number]["id"];
export type ReliabilitySeverity = "healthy" | "watch" | "critical" | "unknown";
export type ReliabilityIssueKind = "critical" | "warning" | "maintenance" | "informational" | "unknown";

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

export interface ReliabilityDependenciesModel {
  roots: ReliabilityDependencyRoot[];
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

const RELIABILITY_MODE_IDS = new Set<string>(RELIABILITY_MODES.map((mode) => mode.id));

const SECTION_ERROR_META: Partial<Record<StatusSectionKey, { mode: ReliabilityMode; label: string }>> = {
  dependencyHealth: { mode: "dependencies", label: "Dependency health" },
  providerCircuitHealth: { mode: "dependencies", label: "Provider circuits" },
  canaries: { mode: "dependencies", label: "Invariant canaries" },
};

const MODE_SEVERITY_RANK: Record<ReliabilitySeverity, number> = {
  healthy: 0,
  watch: 1,
  unknown: 2,
  critical: 3,
};

const ISSUE_KIND_RANK: Record<ReliabilityIssueKind, number> = {
  informational: 0,
  maintenance: 1,
  warning: 2,
  unknown: 3,
  critical: 4,
};

function issueSeverity(kind: ReliabilityIssueKind): ReliabilitySeverity {
  if (kind === "critical") return "critical";
  if (kind === "unknown") return "unknown";
  if (kind === "warning" || kind === "maintenance") return "watch";
  return "healthy";
}

function healthKind(status: StatusHealthValue | "unknown" | null | undefined): ReliabilityIssueKind | null {
  if (status === "stale") return "critical";
  if (status === "degraded") return "warning";
  if (status === "unknown" || status == null) return "unknown";
  return null;
}

function worstSeverity(issues: readonly ReliabilityIssue[]): ReliabilitySeverity {
  return issues.reduce<ReliabilitySeverity>((current, issue) => {
    const next = issueSeverity(issue.kind);
    return MODE_SEVERITY_RANK[next] > MODE_SEVERITY_RANK[current] ? next : current;
  }, "healthy");
}

function addIssue(map: Map<string, ReliabilityIssue>, issue: ReliabilityIssue): void {
  const current = map.get(issue.id);
  if (!current) {
    map.set(issue.id, issue);
    return;
  }

  const preferred = ISSUE_KIND_RANK[issue.kind] > ISSUE_KIND_RANK[current.kind] ? issue : current;
  const details = [...new Set([current.detail, issue.detail].filter(Boolean))].join(" ");
  map.set(issue.id, { ...preferred, detail: details });
}

function probeKind(probe: EndpointProbeResult): ReliabilityIssueKind | null {
  if (probe.semanticStatus === "stale" || probe.status == null || probe.status >= 400) return "critical";
  if (probe.semanticStatus === "degraded") return "warning";
  return null;
}

export function sanitizeReliabilityProbePath(path: string): string {
  try {
    return new URL(path, "https://ops.invalid").pathname;
  } catch {
    return path.split(/[?#]/, 1)[0] ?? "unknown";
  }
}

function buildEndpointModel(input: ReliabilityWorkspaceInput): ReliabilityEndpointModel {
  const probes = input.probes ?? [];
  const unhealthyProbes = probes
    .filter((probe) => probeKind(probe) != null)
    .sort((left, right) => {
      const leftRank = ISSUE_KIND_RANK[probeKind(left) ?? "informational"];
      const rightRank = ISSUE_KIND_RANK[probeKind(right) ?? "informational"];
      return rightRank - leftRank || left.path.localeCompare(right.path);
    });
  const healthyProbes = probes.filter((probe) => probeKind(probe) == null).sort((a, b) => a.path.localeCompare(b.path));
  const worker = input.data.probe;

  const diagnostics = {
    capturedAt: input.data.timestamp,
    workerProbe: {
      sampledAt: worker.timestamp,
      status: worker.status,
      sampleCount: worker.sampleCount,
      passCount: worker.passCount,
      failCount: worker.failCount,
      p95LatencyMs: worker.p95LatencyMs,
    },
    browserProbe: input.browserProbeSummary
      ? {
          sampledAt: input.browserProbeSummary.updatedAt,
          status: input.browserProbeSummary.status,
          sampleCount: input.browserProbeSummary.sampleCount,
          passCount: input.browserProbeSummary.passCount,
          failCount: input.browserProbeSummary.failCount,
          p95LatencyMs: input.browserProbeSummary.p95LatencyMs,
        }
      : null,
    failingEndpoints: unhealthyProbes.map((probe) => ({
      path: sanitizeReliabilityProbePath(probe.path),
      httpStatus: probe.status,
      semanticStatus: probe.semanticStatus ?? null,
      semanticScope: probe.semanticScope ?? null,
      latencyMs: probe.latencyMs,
      transportError: Boolean(probe.error),
    })),
  };

  return {
    capturedAt: input.data.timestamp,
    workerPlane: {
      status: worker.status,
      sampleCount: worker.sampleCount,
      passCount: worker.passCount,
      failCount: worker.failCount,
      p95LatencyMs: worker.p95LatencyMs,
      sampledAt: worker.timestamp,
    },
    browserPlane: input.browserProbeSummary,
    unhealthyProbes,
    healthyProbes,
    diagnosticText: JSON.stringify(diagnostics, null, 2),
  };
}

function buildDependenciesModel(input: ReliabilityWorkspaceInput): ReliabilityDependenciesModel {
  const dependencyHealth = input.data.dependencyHealth;
  const dependencies = dependencyHealth?.dependencies ?? {};
  const roots = (dependencyHealth?.rootCauseGroups ?? []).map((root) => ({
    id: root.rootDependencyId,
    label: dependencies[root.rootDependencyId]?.label ?? root.rootDependencyId,
    status: root.rootStatus,
    criticality: root.criticality,
    reason: root.rootReason,
    impactedCount: root.impactedDependencyIds.length,
    consumers: root.consumerIds,
  }));
  const providerCircuits = [...(input.data.providerCircuitHealth?.openProviders ?? [])].sort((left, right) => {
    const stateRank = { open: 2, "half-open": 1, closed: 0 } as const;
    return stateRank[right.state] - stateRank[left.state] || right.consecutiveFailures - left.consecutiveFailures;
  });
  const publicCircuits = Object.entries(input.healthData?.circuits ?? {})
    .filter(([key, circuit]) => isPublicImpactCircuitKey(key) && circuit.state !== "closed")
    .sort((left, right) => {
      const stateRank = { open: 2, "half-open": 1, closed: 0 } as const;
      return stateRank[right[1].state] - stateRank[left[1].state] || left[0].localeCompare(right[0]);
    });
  const canaryChecks = Object.values(input.data.canaries?.checks ?? {}).sort((left, right) => {
    const statusRank = { error: 3, degraded: 2, skipped: 1, ok: 0 } as const;
    return statusRank[right.status] - statusRank[left.status] || left.label.localeCompare(right.label);
  });

  const diagnostics = {
    capturedAt: input.data.timestamp,
    dependencyRoots: roots.map((root) => ({
      id: root.id,
      status: root.status,
      criticality: root.criticality,
      impactedCount: root.impactedCount,
      consumers: root.consumers,
    })),
    providerCircuits: providerCircuits.map((circuit) => ({
      providerId: circuit.providerId,
      family: circuit.family,
      state: circuit.state,
      consecutiveFailures: circuit.consecutiveFailures,
      openedAt: circuit.openedAt,
      lastFailureAt: circuit.lastFailureAt,
      lastSuccessAt: circuit.lastSuccessAt,
    })),
    publicCircuits: publicCircuits.map(([name, circuit]) => ({
      name,
      state: circuit.state,
      consecutiveFailures: circuit.consecutiveFailures,
      openedAt: circuit.openedAt,
      lastFailureAt: circuit.lastFailureAt,
      lastSuccessAt: circuit.lastSuccessAt,
    })),
    canaries: canaryChecks.map((check) => ({
      checkId: check.checkId,
      status: check.status,
      severity: check.severity,
      observedAt: check.observedAt,
      durationMs: check.durationMs,
    })),
  };

  return {
    roots,
    dependencySummary: dependencyHealth?.summary ?? null,
    providerCircuits,
    providerSummary: input.data.providerCircuitHealth,
    publicCircuits,
    publicCircuitEvidenceAvailable: input.healthData != null,
    canaryChecks,
    canarySummary: input.data.canaries,
    diagnosticText: JSON.stringify(diagnostics, null, 2),
  };
}

export function parseReliabilityMode(search: string | URLSearchParams): ReliabilityMode | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const candidate = params.get(RELIABILITY_MODE_QUERY_PARAM);
  return candidate && RELIABILITY_MODE_IDS.has(candidate) ? (candidate as ReliabilityMode) : null;
}

export function buildReliabilityModeUrl(
  location: Pick<Location, "pathname" | "search" | "hash">,
  mode: ReliabilityMode,
): string {
  const params = new URLSearchParams(location.search);
  params.set(RELIABILITY_MODE_QUERY_PARAM, mode);
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
}

function collectReliabilityEvidenceGaps(input: ReliabilityWorkspaceInput): ReliabilityEvidenceGap[] {
  const gaps = new Map<string, ReliabilityEvidenceGap>();
  const add = (gap: ReliabilityEvidenceGap) => {
    if (!gaps.has(gap.rawCode)) gaps.set(gap.rawCode, gap);
  };

  if (input.healthError) {
    add({
      mode: "impact",
      label: "Public health",
      rawCode: "publicHealth",
      code: "query_failed",
      message: input.healthError,
      kind: "failure",
    });
  } else if (!input.healthLoading && !input.healthData) {
    add({
      mode: "impact",
      label: "Public health",
      rawCode: "publicHealth",
      code: "not_loaded",
      message: "No public-health response is available.",
      kind: "missing",
    });
  }

  if (input.probesError) {
    add({
      mode: "endpoints",
      label: "Browser endpoint probes",
      rawCode: "browserProbes",
      code: "query_failed",
      message: input.probesError,
      kind: "failure",
    });
  } else if (
    !input.probesLoading &&
    (input.probes === undefined || input.probes.length === 0 || input.browserProbeSummary == null)
  ) {
    add({
      mode: "endpoints",
      label: "Browser endpoint probes",
      rawCode: "browserProbes",
      code: "not_loaded",
      message: "No browser-origin probe response is available.",
      kind: "missing",
    });
  }

  if (!input.data.probe.timestamp || input.data.probe.sampleCount <= 0 || input.data.probe.status === "unknown") {
    add({
      mode: "endpoints",
      label: "Worker self-check probes",
      rawCode: "workerProbe",
      code: "sample_missing",
      message: "The worker-origin self-check sample is unavailable or empty.",
      kind: "missing",
    });
  }

  if (input.requestSourceError) {
    add({
      mode: "demand",
      label: "Request attribution",
      rawCode: "requestSourceStats",
      code: "query_failed",
      message: input.requestSourceError,
      kind: "failure",
    });
  } else if (!input.requestSourceLoading && !input.requestSourceStats) {
    add({
      mode: "demand",
      label: "Request attribution",
      rawCode: "requestSourceStats",
      code: "not_loaded",
      message: "No request-attribution response is available.",
      kind: "missing",
    });
  }

  (
    Object.entries(input.data.sectionErrors) as Array<
      [StatusSectionKey, StatusResponse["sectionErrors"][StatusSectionKey]]
    >
  ).forEach(([rawCode, error]) => {
    const meta = SECTION_ERROR_META[rawCode];
    if (!meta || !error) return;
    add({ ...meta, rawCode, code: error.code, message: error.message, kind: "failure" });
  });

  const optionalEvidence = [
    ["dependencyHealth", "Dependency health", input.data.dependencyHealth],
    ["providerCircuitHealth", "Provider circuits", input.data.providerCircuitHealth],
    ["canaries", "Invariant canaries", input.data.canaries],
  ] as const;
  optionalEvidence.forEach(([rawCode, label, value]) => {
    if (value || gaps.has(rawCode)) return;
    add({
      mode: "dependencies",
      label,
      rawCode,
      code: "not_reported",
      message: `${label} is not present in the status payload.`,
      kind: "missing",
    });
  });

  if (Object.keys(input.data.caches).length === 0) {
    add({
      mode: "cache",
      label: "Cache freshness inventory",
      rawCode: "caches",
      code: "empty_inventory",
      message: "No cache freshness rows are present in the status payload.",
      kind: "missing",
    });
  }

  return [...gaps.values()].sort((left, right) => {
    const modeDelta =
      RELIABILITY_MODES.findIndex((mode) => mode.id === left.mode) -
      RELIABILITY_MODES.findIndex((mode) => mode.id === right.mode);
    return modeDelta || left.label.localeCompare(right.label);
  });
}

export function buildReliabilityWorkspaceModel(input: ReliabilityWorkspaceInput): ReliabilityWorkspaceModel {
  const issues = new Map<string, ReliabilityIssue>();
  const evidenceGaps = collectReliabilityEvidenceGaps(input);
  const evidenceGapCodes = new Set(evidenceGaps.map((gap) => gap.rawCode));
  const endpoints = buildEndpointModel(input);
  const dependencies = buildDependenciesModel(input);

  evidenceGaps.forEach((gap) => {
    addIssue(issues, {
      id: `evidence:${gap.rawCode}`,
      mode: gap.mode,
      label: gap.label,
      kind: "unknown",
      rawCode: gap.code,
      detail: gap.message,
      affectedSurface: "Operator evidence",
    });
  });

  const normalizedCauses = normalizeStatusIssues(input.data.causes);
  normalizedCauses.forEach((issue) => {
    addIssue(issues, {
      id: `cause:${issue.id}`,
      mode: "impact",
      label: issue.message,
      kind:
        issue.kind === "impacting"
          ? "critical"
          : issue.kind === "warning"
            ? "warning"
            : issue.kind === "maintenance"
              ? "maintenance"
              : "informational",
      rawCode: issue.code,
      detail: `${issue.impactLabel}; ${issue.affectedSurface}.`,
      affectedSurface: issue.affectedSurface,
    });
  });

  const hasPublicCause = normalizedCauses.some((issue) => issue.publicImpacting);
  const publicKind = healthKind(input.healthData?.status);
  if (publicKind && !hasPublicCause && !evidenceGapCodes.has("publicHealth")) {
    addIssue(issues, {
      id: "impact:public-health",
      mode: "impact",
      label: `Public health is ${input.healthData?.status ?? "unknown"}`,
      kind: publicKind,
      rawCode: "public_health_state",
      detail: input.healthData?.warnings.join(" ") || "Public health did not report a supporting warning.",
      affectedSurface: "Public service",
    });
  }

  const hasAdminCause = normalizedCauses.some((issue) => issue.layer === "availability" || issue.layer === "system");
  const adminKind = healthKind(input.data.availabilityStatus);
  if (adminKind && !hasAdminCause) {
    addIssue(issues, {
      id: "impact:admin-health",
      mode: "impact",
      label: `Operator availability is ${input.data.availabilityStatus}`,
      kind: adminKind,
      rawCode: "availability_status",
      detail: "No distinct availability cause accompanied the aggregate state.",
      affectedSurface: "Operator reliability",
    });
  }

  const workerKind = healthKind(input.data.probe.status);
  if (workerKind && !evidenceGapCodes.has("workerProbe")) {
    addIssue(issues, {
      id: "endpoint-plane:worker",
      mode: "endpoints",
      label: "Worker self-check probe plane",
      kind: workerKind,
      rawCode: "worker_probe",
      detail: `${input.data.probe.passCount}/${input.data.probe.sampleCount} checks passed.`,
      affectedSurface: "Worker execution plane",
    });
  }

  endpoints.unhealthyProbes.forEach((probe) => {
    const kind = probeKind(probe);
    if (!kind) return;
    addIssue(issues, {
      id: `endpoint:${sanitizeReliabilityProbePath(probe.path)}`,
      mode: "endpoints",
      label: sanitizeReliabilityProbePath(probe.path),
      kind,
      rawCode: probe.semanticScope ?? "browser_transport_probe",
      detail: `${probe.status == null ? "No HTTP response" : `HTTP ${probe.status}`}; ${probe.latencyMs}ms.`,
      affectedSurface: "Browser-origin endpoint probe",
    });
  });

  const dependencyHealth = input.data.dependencyHealth;
  dependencies.roots.forEach((root) => {
    addIssue(issues, {
      id: `dependency:${root.id}`,
      mode: "dependencies",
      label: root.label,
      kind: healthKind(root.status) ?? "informational",
      rawCode: root.id,
      detail: root.reason ?? `${root.impactedCount} dependencies are grouped under this root cause.`,
      affectedSurface: root.consumers.join(", ") || "Dependency consumers",
    });
  });
  Object.values(dependencyHealth?.dependencies ?? {}).forEach((dependency) => {
    const kind = healthKind(dependency.status);
    if (!kind) return;
    addIssue(issues, {
      id: `dependency:${dependency.id}`,
      mode: "dependencies",
      label: dependency.label,
      kind,
      rawCode: dependency.id,
      detail: dependency.reason ?? "Dependency is outside its health budget.",
      affectedSurface: dependency.consumers.join(", ") || "Dependency consumers",
    });
  });

  dependencies.providerCircuits.forEach((circuit) => {
    addIssue(issues, {
      id: `circuit:${circuit.providerId}`,
      mode: "dependencies",
      label: circuit.providerId,
      kind: circuit.state === "open" ? "critical" : circuit.state === "half-open" ? "warning" : "informational",
      rawCode: circuit.family,
      detail: `${circuit.state}; ${circuit.consecutiveFailures} consecutive failures.`,
      affectedSurface: `${circuit.family} provider family`,
    });
  });
  dependencies.publicCircuits.forEach(([name, circuit]) => {
    addIssue(issues, {
      id: `circuit:${name}`,
      mode: "dependencies",
      label: name,
      kind: circuit.state === "open" ? "critical" : "warning",
      rawCode: "public_health_circuit",
      detail: `${circuit.state}; ${circuit.consecutiveFailures} consecutive failures.`,
      affectedSurface: "Public health provider circuit",
    });
  });
  dependencies.canaryChecks.forEach((check) => {
    if (check.status === "ok") return;
    addIssue(issues, {
      id: `canary:${check.checkId}`,
      mode: "dependencies",
      label: check.label,
      kind:
        check.status === "error" || check.severity === "critical"
          ? "critical"
          : check.status === "degraded"
            ? "warning"
            : "informational",
      rawCode: check.checkId,
      detail: check.error ?? check.description,
      affectedSurface: "Invariant canary",
    });
  });

  if (input.requestSourceStats) {
    const timeouts = input.requestSourceStats.siteDelivery.pagesUpstreamTimeouts;
    const errors = input.requestSourceStats.siteDelivery.pagesUpstreamErrors;
    if (timeouts > 0 || errors > 0) {
      addIssue(issues, {
        id: "demand:site-upstream-failures",
        mode: "demand",
        label: "Site upstream delivery failures",
        kind: "warning",
        rawCode: "site_delivery_failures",
        detail: `${timeouts} timeouts and ${errors} upstream errors in the selected window.`,
        affectedSurface: "Site data delivery",
      });
    }
  }

  let cacheUnknownCount = 0;
  Object.entries(input.data.caches).forEach(([key, cache]) => {
    const ratio = getCacheFreshnessRatio(cache);
    let kind: ReliabilityIssueKind | null = null;
    if (ratio == null) {
      kind = "unknown";
      cacheUnknownCount += 1;
    } else if (ratio > STATUS_CACHE_RATIO_THRESHOLDS.stale) {
      kind = "critical";
    } else if (ratio > STATUS_CACHE_RATIO_THRESHOLDS.degraded || cache.mode === "cached-fallback") {
      kind = "warning";
    }
    if (!kind) return;
    addIssue(issues, {
      id: `cache:${key}`,
      mode: "cache",
      label: key,
      kind,
      rawCode: "cache_freshness_ratio",
      detail:
        ratio == null
          ? "Cache age or availability budget is missing; no healthy zero is inferred."
          : `${ratio.toFixed(2)}x availability budget${cache.mode === "cached-fallback" ? "; cached fallback active" : ""}.`,
      affectedSurface: "Cache freshness",
    });
  });

  const issueList = [...issues.values()].sort((left, right) => {
    const severityDelta = ISSUE_KIND_RANK[right.kind] - ISSUE_KIND_RANK[left.kind];
    if (severityDelta !== 0) return severityDelta;
    const modeDelta =
      RELIABILITY_MODES.findIndex((mode) => mode.id === left.mode) -
      RELIABILITY_MODES.findIndex((mode) => mode.id === right.mode);
    return modeDelta || left.label.localeCompare(right.label);
  });
  const modeSummaries = RELIABILITY_MODES.map((mode) => {
    const modeIssues = issueList.filter((issue) => issue.mode === mode.id);
    return {
      ...mode,
      issueCount: modeIssues.length,
      severity: worstSeverity(modeIssues),
    };
  });

  return {
    issues: issueList,
    modeSummaries,
    evidenceGaps,
    endpoints,
    dependencies,
    cacheUnknownCount,
  };
}

export function deriveInitialReliabilityMode(model: Pick<ReliabilityWorkspaceModel, "modeSummaries">): ReliabilityMode {
  return (
    [...model.modeSummaries].sort((left, right) => {
      const severityDelta = MODE_SEVERITY_RANK[right.severity] - MODE_SEVERITY_RANK[left.severity];
      if (severityDelta !== 0) return severityDelta;
      const countDelta = right.issueCount - left.issueCount;
      if (countDelta !== 0) return countDelta;
      return (
        RELIABILITY_MODES.findIndex((mode) => mode.id === left.id) -
        RELIABILITY_MODES.findIndex((mode) => mode.id === right.id)
      );
    })[0]?.id ?? "impact"
  );
}
