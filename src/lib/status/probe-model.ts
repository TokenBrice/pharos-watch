import type { EndpointProbeResult, StatusHealthValue, StatusResponse } from "@shared/types";
import { CRON_GROUPS } from "@shared/lib/cron-jobs";
import { percentileNearestRank } from "@shared/lib/stats";
import { getStatusCronDisplay } from "@/lib/status/cron-config";
import type { BrowserProbeSummary, DashboardCronGroup } from "@/lib/status/dashboard-types";

export function getProbeDisplayStatus(probe: EndpointProbeResult): StatusHealthValue {
  if (probe.status == null || probe.status >= 400) return "stale";
  if (probe.semanticStatus) return probe.semanticStatus;
  return probe.status >= 200 && probe.status < 300 ? "healthy" : "stale";
}

export function isProbePassing(probe: EndpointProbeResult): boolean {
  return getProbeDisplayStatus(probe) === "healthy";
}

export function getProbeStatusLabel(probe: EndpointProbeResult): string {
  if (probe.status == null) return "unreachable";
  if (probe.semanticStatus) return probe.semanticStatus;
  return `http ${probe.status}`;
}

export function getProbeStatusDetail(probe: EndpointProbeResult): string | null {
  if (probe.error) return probe.error;
  if (probe.semanticDetail) return probe.semanticDetail;
  if (probe.status == null) return "No HTTP response from this browser session.";
  return `HTTP ${probe.status}`;
}

export function buildBrowserProbeSummary(
  probes: EndpointProbeResult[] | undefined,
  updatedAtMs: number,
): BrowserProbeSummary | null {
  if (!probes || probes.length === 0) return null;
  let passCount = 0;
  let degradedCount = 0;
  let staleCount = 0;
  for (const probe of probes) {
    const status = getProbeDisplayStatus(probe);
    if (status === "healthy") passCount += 1;
    else if (status === "degraded") degradedCount += 1;
    else staleCount += 1;
  }
  const latencies = probes.map((probe) => probe.latencyMs).filter((latency) => Number.isFinite(latency));
  const failCount = degradedCount + staleCount;
  const status: StatusHealthValue = staleCount > 0 ? "stale" : degradedCount > 0 ? "degraded" : "healthy";
  return {
    sampleCount: probes.length,
    passCount,
    failCount,
    degradedCount,
    staleCount,
    p95LatencyMs: percentileNearestRank(latencies, 95),
    status,
    updatedAt: updatedAtMs > 0 ? Math.floor(updatedAtMs / 1000) : null,
  };
}

export function buildDashboardCronGroups(data: Pick<StatusResponse, "crons">): DashboardCronGroup[] {
  const cronEntries = Object.entries(data.crons);
  return CRON_GROUPS.map((group) => ({
    ...group,
    entries: cronEntries.filter(([job]) => getStatusCronDisplay(job).group === group.key),
  })).filter((group) => group.entries.length > 0);
}

export function countRunningDashboardCrons(data: Pick<StatusResponse, "crons">): number {
  return Object.values(data.crons).filter((cron) => cron.inFlight && !cron.inFlight.stale).length;
}
