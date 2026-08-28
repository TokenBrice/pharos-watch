import type { EndpointProbeResult } from "@shared/types";
import { getProbeDisplayStatus } from "@/lib/status-dashboard-model";
import type {
  ReliabilityEndpointModel,
  ReliabilityIssueKind,
  ReliabilityWorkspaceInput,
} from "@/lib/reliability-workspace-model";

const ISSUE_KIND_RANK: Record<ReliabilityIssueKind, number> = {
  informational: 0,
  maintenance: 1,
  warning: 2,
  unknown: 3,
  critical: 4,
};

export function probeKind(probe: EndpointProbeResult): ReliabilityIssueKind | null {
  const status = getProbeDisplayStatus(probe);
  if (status === "stale") return "critical";
  if (status === "degraded") return "warning";
  return null;
}

export function sanitizeReliabilityProbePath(path: string): string {
  try {
    return new URL(path, "https://ops.invalid").pathname;
  } catch {
    return path.split(/[?#]/, 1)[0] ?? "unknown";
  }
}

export function buildEndpointModel(input: ReliabilityWorkspaceInput): ReliabilityEndpointModel {
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
