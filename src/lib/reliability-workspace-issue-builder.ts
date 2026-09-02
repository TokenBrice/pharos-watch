import { getCacheFreshnessRatio } from "@shared/lib/cache-health";
import { STATUS_CACHE_RATIO_THRESHOLDS } from "@shared/lib/status-thresholds";
import type { StatusHealthValue } from "@shared/types";
import { normalizeStatusIssues } from "@/lib/status-dashboard-model";
import { worstSeverity as worstWorkspaceSeverity } from "@/lib/status/workspace-mode";
import {
  RELIABILITY_ISSUE_KIND_RANK,
  RELIABILITY_MODES,
  type ReliabilityIssue,
  type ReliabilityIssueKind,
  type ReliabilitySeverity,
  type ReliabilityWorkspaceInput,
  type ReliabilityWorkspaceModel,
} from "@/lib/reliability-workspace-model";
import {
  buildEndpointModel,
  probeKind,
  sanitizeReliabilityProbePath,
} from "@/lib/reliability-workspace-endpoint-builder";
import { buildDependenciesModel } from "@/lib/reliability-workspace-dependency-builder";
import { collectReliabilityEvidenceGaps } from "@/lib/reliability-workspace-evidence-gap-builder";

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

function worstIssueSeverity(issues: readonly ReliabilityIssue[]): ReliabilitySeverity {
  return worstWorkspaceSeverity(issues.map((issue) => issueSeverity(issue.kind)));
}

function addIssue(map: Map<string, ReliabilityIssue>, issue: ReliabilityIssue): void {
  const current = map.get(issue.id);
  if (!current) {
    map.set(issue.id, issue);
    return;
  }

  const preferred = RELIABILITY_ISSUE_KIND_RANK[issue.kind] > RELIABILITY_ISSUE_KIND_RANK[current.kind] ? issue : current;
  const details = [...new Set([current.detail, issue.detail].filter(Boolean))].join(" ");
  map.set(issue.id, { ...preferred, detail: details });
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
    const severityDelta = RELIABILITY_ISSUE_KIND_RANK[right.kind] - RELIABILITY_ISSUE_KIND_RANK[left.kind];
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
      severity: worstIssueSeverity(modeIssues),
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
