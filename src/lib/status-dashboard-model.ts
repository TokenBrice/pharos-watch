import type { EndpointProbeResult, StatusCause, StatusResponse } from "@shared/types";
import { deriveStatusActionRecommendations } from "@/components/status/action-recommendations";
import { getStatusCronDisplay, STATUS_CRON_GROUPS } from "@/components/status/cron-config";
import { formatAge } from "@/components/status/format";

export type DashboardSectionId = "overview" | "pipeline" | "reliability" | "crons" | "control" | "history";

export interface DashboardSection {
  id: DashboardSectionId;
  label: string;
  kicker: string;
  title: string;
  description: string;
  accentClassName: string;
  value: string;
  valueClassName?: string;
  summary: string;
}

export interface DashboardNotice {
  id: string;
  title: string;
  detail: string;
  tone: "neutral" | "warning" | "critical";
}

const STATUS_TONE = {
  healthy: {
    label: "Healthy",
    badgeClassName: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
    valueClassName: "text-green-700 dark:text-green-400",
  },
  degraded: {
    label: "Degraded",
    badgeClassName: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    valueClassName: "text-amber-700 dark:text-amber-400",
  },
  stale: {
    label: "Stale",
    badgeClassName: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
    valueClassName: "text-red-700 dark:text-red-400",
  },
} as const;

const STATUS_PRIORITY = {
  healthy: 0,
  degraded: 1,
  stale: 2,
} as const;

const SEVERITY_RANK = {
  critical: 0,
  warning: 1,
  info: 2,
} as const;

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export function buildBrowserProbeSummary(
  probes: EndpointProbeResult[] | undefined,
  updatedAtMs: number,
) {
  if (!probes || probes.length === 0) return null;
  const passCount = probes.filter((probe) => probe.status != null && probe.status >= 200 && probe.status < 300).length;
  const latencies = probes.map((probe) => probe.latencyMs).filter((latency) => Number.isFinite(latency));

  return {
    sampleCount: probes.length,
    passCount,
    failCount: probes.length - passCount,
    p95LatencyMs: percentile(latencies, 95),
    updatedAt: updatedAtMs > 0 ? Math.floor(updatedAtMs / 1000) : null,
  };
}

export function formatTimestampSeconds(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  return new Date(seconds * 1000).toLocaleString();
}

export function formatTimestampMs(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

export function formatTransitionLabel(transition: StatusResponse["timeline"][number] | null): string {
  if (!transition) return "No transition history";
  return `${transition.from ?? "init"} -> ${transition.to}`;
}

export function getStatusTone(status: StatusResponse["overallStatus"]) {
  return STATUS_TONE[status];
}

export function getSeverityBadgeClass(severity: StatusCause["severity"]): string {
  if (severity === "critical") return "bg-red-500/15 text-red-700 dark:text-red-400";
  if (severity === "warning") return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
  return "bg-muted text-muted-foreground";
}

export function getNoticeTone(tone: DashboardNotice["tone"]): string {
  if (tone === "critical") return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  if (tone === "warning") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-border/60 bg-muted/30 text-muted-foreground";
}

export function getTopCauses(causes: StatusResponse["causes"], limit: number): StatusCause[] {
  const deduped = new Map<string, StatusCause>();

  for (const cause of [...causes.overall, ...causes.availability, ...causes.dataQuality]) {
    const key = `${cause.layer}:${cause.code}:${cause.message}`;
    if (!deduped.has(key)) {
      deduped.set(key, cause);
    }
  }

  return [...deduped.values()]
    .sort((a, b) => {
      const severityDelta = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (severityDelta !== 0) return severityDelta;
      return a.code.localeCompare(b.code);
    })
    .slice(0, limit);
}

interface BuildStatusDashboardOptions {
  data: StatusResponse;
  healthData: StatusResponse["overallStatus"] extends never ? never : {
    status: "healthy" | "degraded" | "stale";
    blacklist: { missingAmounts: number };
    mintBurn: {
      sync: {
        warning: string | null;
        lastSuccessfulSyncAt: number | null;
      };
      majorStaleCount: number;
      staleMajorSymbols: string[];
    };
  } | null | undefined;
  probes: EndpointProbeResult[] | undefined;
  probesUpdatedAt: number;
  lastUpdated: number;
  nowMs: number;
  healthError: Error | null;
  probesError: Error | null;
  historyError: Error | null;
  historyTransitions: StatusResponse["timeline"] | undefined;
}

export function buildStatusDashboardData({
  data,
  healthData,
  probes,
  probesUpdatedAt,
  lastUpdated,
  nowMs,
  healthError,
  probesError,
  historyError,
  historyTransitions,
}: BuildStatusDashboardOptions) {
  const clientDataAgeSec = Math.max(0, Math.floor((nowMs - lastUpdated) / 1000));
  const browserProbeSummary = buildBrowserProbeSummary(probes, probesUpdatedAt);
  const cronEntries = Object.entries(data.crons);
  const cronGroups = STATUS_CRON_GROUPS.map((group) => ({
    ...group,
    entries: cronEntries.filter(([job]) => getStatusCronDisplay(job).group === group.key),
  })).filter((group) => group.entries.length > 0);
  const runningCrons = cronEntries.filter(([, cron]) => cron.inFlight && !cron.inFlight.stale).length;
  const healthDiffersFromStatus = healthData != null && healthData.status !== data.overallStatus;
  const publicHealthNeedsCallout =
    healthData != null && (healthData.status !== "healthy" || healthDiffersFromStatus);
  const allTransitions = historyTransitions ?? data.timeline;
  const latestTransition = allTransitions[0] ?? null;
  const recommendedActions = deriveStatusActionRecommendations({ causes: data.causes, crons: data.crons });
  const topCauses = getTopCauses(data.causes, 4);
  const overallCauseCount = data.causes.availability.length + data.causes.dataQuality.length;
  const statusHoldingAge = Math.max(0, data.timestamp - data.state.lastChangedAt);
  const overallTone = getStatusTone(data.overallStatus);
  const clientDataStale = lastUpdated > 0 && nowMs - lastUpdated > 120_000;

  const notices: DashboardNotice[] = [];
  if (clientDataStale) {
    notices.push({
      id: "client-stale",
      title: "Client view is lagging",
      detail: `This browser is ${clientDataAgeSec}s behind the last fetch cycle. Refresh before treating the dashboard as current.`,
      tone: "warning",
    });
  }
  if (healthError) {
    notices.push({
      id: "health-error",
      title: "Public health endpoint unavailable",
      detail: healthError.message,
      tone: "warning",
    });
  }
  if (probesError) {
    notices.push({
      id: "probe-error",
      title: "Browser probe loop unavailable",
      detail: probesError.message,
      tone: "warning",
    });
  }
  if (historyError) {
    notices.push({
      id: "history-error",
      title: "Status history unavailable",
      detail: historyError.message,
      tone: "warning",
    });
  }
  if (publicHealthNeedsCallout && healthData) {
    const divergence = healthDiffersFromStatus ? `Public /api/health differs from /api/status (${data.overallStatus}). ` : "";
    const mintBurnWarning = healthData.mintBurn.sync.warning != null ? `${healthData.mintBurn.sync.warning} ` : "";
    const mintBurnSyncAge =
      healthData.mintBurn.sync.lastSuccessfulSyncAt != null
        ? `Last successful mint/burn sync ${formatAge(Math.max(0, data.timestamp - healthData.mintBurn.sync.lastSuccessfulSyncAt))} ago. `
        : "";
    const impactedMajors =
      healthData.mintBurn.majorStaleCount > 0
        ? `Impacted majors: ${healthData.mintBurn.staleMajorSymbols.join(", ")}. `
        : "";

    notices.push({
      id: "public-health",
      title: `Public /api/health reports ${healthData.status}`,
      detail: `${divergence}${mintBurnWarning}${mintBurnSyncAge}${impactedMajors}Blacklist gaps tracked by /api/health: ${healthData.blacklist.missingAmounts}.`,
      tone: healthData.status === "stale" ? "critical" : healthData.status === "degraded" ? "warning" : "neutral",
    });
  }

  const reliabilityStatus = Math.max(
    STATUS_PRIORITY[data.availabilityStatus],
    healthData ? STATUS_PRIORITY[healthData.status] : 0,
    browserProbeSummary && browserProbeSummary.failCount > 0 ? 1 : 0,
    data.summary.worstCacheRatio > 2 ? 2 : data.summary.worstCacheRatio > 1.5 ? 1 : 0,
  );
  const cronStatus = data.summary.cronErrors > 0 ? 2 : data.summary.unhealthyCrons > 0 ? 1 : data.summary.degradedCrons > 0 ? 1 : 0;
  const controlStatus = recommendedActions.length > 0 ? 2 : 0;
  const sectionPriority: Record<DashboardSectionId, number> = {
    overview: 999,
    control: controlStatus * 100 + recommendedActions.length,
    pipeline: STATUS_PRIORITY[data.dataQualityStatus] * 100 + data.causes.dataQuality.length,
    crons: cronStatus * 100 + data.summary.unhealthyCrons * 10 + data.summary.cronErrors,
    reliability: reliabilityStatus * 100 + (browserProbeSummary?.failCount ?? 0) + data.summary.cronErrors,
    history: -1,
  };
  const sectionOrder: DashboardSectionId[] = ["overview", "control", "pipeline", "crons", "reliability", "history"];
  const baseSections: DashboardSection[] = [
    {
      id: "overview",
      label: "Overview",
      kicker: "Command Center",
      title: "Current incident picture",
      description: "State machine counters, root causes, and the operator-facing view of what changed last.",
      accentClassName: "border-l-frost-blue",
      value: overallTone.label,
      valueClassName: overallTone.valueClassName,
      summary: `${overallCauseCount} active causes, confidence ${(data.confidence * 100).toFixed(1)}%, last change ${formatAge(statusHoldingAge)} ago`,
    },
    {
      id: "pipeline",
      label: "Pipeline",
      kicker: "Data Pipeline",
      title: "Freshness and coverage",
      description: "Dataset recency, price coverage, supply drift, liquidity coverage, and discovery backlog.",
      accentClassName: "border-l-cyan-500",
      value: getStatusTone(data.dataQualityStatus).label,
      valueClassName: getStatusTone(data.dataQualityStatus).valueClassName,
      summary: `${data.dataQuality.missingPrices} missing prices, ${data.dataQuality.staleOnchainSupply} stale on-chain feeds, ${data.dataQuality.blacklistMissingAmounts} blacklist gaps`,
    },
    {
      id: "reliability",
      label: "Reliability",
      kicker: "Service Health",
      title: "Probes, breakers, and cache pressure",
      description: "Browser endpoint probes, public route health, circuit state, and stale cache detection.",
      accentClassName: "border-l-amber-500",
      value: browserProbeSummary ? `${browserProbeSummary.passCount}/${browserProbeSummary.sampleCount}` : "No probes",
      valueClassName:
        browserProbeSummary && browserProbeSummary.failCount > 0
          ? "text-amber-700 dark:text-amber-400"
          : "text-foreground",
      summary: `${data.summary.cronErrors} cron errors, ${browserProbeSummary?.failCount ?? 0} failing browser probes, worst cache ${data.summary.worstCacheRatio.toFixed(2)}x`,
    },
    {
      id: "crons",
      label: "Cron Lanes",
      kicker: "Schedulers",
      title: "Worker job lanes",
      description: "Grouped by trigger theme so failures, degraded runs, and in-flight leases are easier to scan.",
      accentClassName: "border-l-orange-500",
      value: `${data.summary.unhealthyCrons} unhealthy`,
      valueClassName:
        data.summary.unhealthyCrons > 0 ? "text-red-700 dark:text-red-400" : "text-green-700 dark:text-green-400",
      summary: `${cronGroups.length} groups, ${data.summary.degradedCrons} degraded jobs, ${runningCrons} running now`,
    },
    {
      id: "control",
      label: "Actions",
      kicker: "Operations",
      title: "Manual response",
      description: "Recovery actions and operator controls for active incidents.",
      accentClassName: "border-l-emerald-500",
      value: recommendedActions.length > 0 ? `${recommendedActions.length} suggested` : "Clear",
      valueClassName:
        recommendedActions.length > 0 ? "text-amber-700 dark:text-amber-400" : "text-green-700 dark:text-green-400",
      summary: `${recommendedActions.length} recommended actions, ${data.telegramBot?.deliverableChats ?? 0} alert-ready chats, ${data.telegramBot?.pendingDeliveries ?? 0} pending deliveries`,
    },
    {
      id: "history",
      label: "History",
      kicker: "Incident Log",
      title: "Timeline and recovery trail",
      description: "Persisted transitions for drills, regressions, and dwell-state validation.",
      accentClassName: "border-l-rose-500",
      value: latestTransition ? formatTransitionLabel(latestTransition) : "No transitions",
      summary: `${allTransitions.length} transitions in view, latest ${latestTransition ? formatAge(Math.max(0, data.timestamp - latestTransition.at)) : "—"} ago`,
    },
  ];
  const sections = [...baseSections].sort((a, b) => {
    if (a.id === "overview") return -1;
    if (b.id === "overview") return 1;
    if (a.id === "history") return 1;
    if (b.id === "history") return -1;

    const priorityDelta = sectionPriority[b.id] - sectionPriority[a.id];
    if (priorityDelta !== 0) return priorityDelta;

    return sectionOrder.indexOf(a.id) - sectionOrder.indexOf(b.id);
  });

  return {
    allTransitions,
    browserProbeSummary,
    clientDataAgeSec,
    clientDataStale,
    cronGroups,
    healthDiffersFromStatus,
    latestTransition,
    notices,
    overallCauseCount,
    overallTone,
    publicHealthNeedsCallout,
    recommendedActions,
    runningCrons,
    sections,
    statusHoldingAge,
    topCauses,
  };
}
