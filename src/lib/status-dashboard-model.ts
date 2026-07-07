import type { EndpointProbeResult, HealthResponse, StatusCause, StatusHealthValue, StatusResponse } from "@shared/types";
import { deriveStatusActionRecommendations } from "@/lib/status/action-recommendations";
import { getStatusCronDisplay } from "@/lib/status/cron-config";
import { CRON_GROUPS } from "@shared/lib/cron-jobs";
import { formatElapsedSeconds } from "@shared/lib/format";
import { percentileNearestRank } from "@shared/lib/stats";

export type DashboardSectionId =
  | "overview"
  | "pipeline"
  | "crons"
  | "reliability"
  | "actions"
  | "credentials"
  | "comms"
  | "history";

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

export interface DashboardQuerySync {
  key: "status" | "health" | "probes" | "history" | "requestSource";
  label: string;
  updatedAtMs: number;
  updatedAtSec: number | null;
  ageSec: number | null;
  stale: boolean;
}

export interface BrowserProbeSummary {
  sampleCount: number;
  passCount: number;
  failCount: number;
  degradedCount: number;
  staleCount: number;
  p95LatencyMs: number | null;
  status: StatusResponse["overallStatus"];
  updatedAt: number | null;
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

function getProbeDisplayStatus(
  probe: EndpointProbeResult,
): StatusHealthValue {
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

function buildQuerySync(
  key: DashboardQuerySync["key"],
  label: DashboardQuerySync["label"],
  updatedAtMs: number,
  nowMs: number,
): DashboardQuerySync {
  const safeUpdatedAtMs = Number.isFinite(updatedAtMs) ? updatedAtMs : 0;
  const ageSec = safeUpdatedAtMs > 0 ? Math.max(0, Math.floor((nowMs - safeUpdatedAtMs) / 1000)) : null;

  return {
    key,
    label,
    updatedAtMs: safeUpdatedAtMs,
    updatedAtSec: safeUpdatedAtMs > 0 ? Math.floor(safeUpdatedAtMs / 1000) : null,
    ageSec,
    stale: ageSec != null && ageSec > 120,
  };
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
    if (status === "healthy") {
      passCount += 1;
    } else if (status === "degraded") {
      degradedCount += 1;
    } else {
      staleCount += 1;
    }
  }
  const latencies = probes.map((probe) => probe.latencyMs).filter((latency) => Number.isFinite(latency));
  const failCount = degradedCount + staleCount;
  const status: StatusHealthValue =
    staleCount > 0 ? "stale" : degradedCount > 0 ? "degraded" : "healthy";

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

/** Status-dashboard-scoped timestamp formatter. Not a candidate for shared extraction. */
function formatLocaleTimestampMs(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { timeZoneName: 'short' });
}

export function formatTimestampSeconds(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  return formatLocaleTimestampMs(seconds * 1000);
}

export function formatTimestampMs(ms: number): string {
  if (!ms) return "—";
  return formatLocaleTimestampMs(ms);
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

function dedupeCauses(causes: StatusCause[]): StatusCause[] {
  const deduped = new Map<string, StatusCause>();

  for (const cause of causes) {
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
    });
}

function getCauses(causes: StatusResponse["causes"], kind: "blocker" | "watch"): StatusCause[] {
  return dedupeCauses(
    [...causes.overall, ...causes.availability, ...causes.dataQuality].filter((cause) =>
      kind === "blocker" ? cause.severity !== "info" : cause.severity === "info",
    ),
  );
}

type StatusActionRecommendation = ReturnType<typeof deriveStatusActionRecommendations>[number];

function buildDashboardNotices({
  clientDataStale,
  staleQuerySyncs,
  healthError,
  probesError,
  historyError,
  requestSourceError,
  publicHealthNeedsCallout,
  healthDiffersFromStatus,
  healthData,
  status,
  timestamp,
}: {
  clientDataStale: boolean;
  staleQuerySyncs: readonly DashboardQuerySync[];
  healthError: Error | null;
  probesError: Error | null;
  historyError: Error | null;
  requestSourceError: Error | null;
  publicHealthNeedsCallout: boolean;
  healthDiffersFromStatus: boolean;
  healthData: HealthResponse | null | undefined;
  status: StatusResponse["overallStatus"];
  timestamp: number;
}): DashboardNotice[] {
  const notices: DashboardNotice[] = [];
  if (clientDataStale) {
    const staleLabels = staleQuerySyncs.map((sync) => sync.label).join(", ");
    notices.push({
      id: "client-stale",
      title: "Client view is lagging",
      detail: `${staleLabels} are older than 120s in this browser. Refresh before treating the dashboard as current.`,
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
  if (requestSourceError) {
    notices.push({
      id: "request-source-error",
      title: "API attribution unavailable",
      detail: requestSourceError.message,
      tone: "warning",
    });
  }
  if (publicHealthNeedsCallout && healthData) {
    const divergence = healthDiffersFromStatus ? `Public /api/health differs from /api/status (${status}). ` : "";
    const mintBurnWarning = healthData.mintBurn.sync.warning != null ? `${healthData.mintBurn.sync.warning} ` : "";
    const mintBurnSyncAge =
      healthData.mintBurn.sync.lastSuccessfulSyncAt != null
        ? `Last successful mint/burn sync ${formatElapsedSeconds(Math.max(0, timestamp - healthData.mintBurn.sync.lastSuccessfulSyncAt))} ago. `
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
  return notices;
}

function buildSectionPriority({
  data,
  healthData,
  browserProbeSummary,
  blockerCauses,
  recommendedActions,
}: {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  browserProbeSummary: BrowserProbeSummary | null;
  blockerCauses: readonly StatusCause[];
  recommendedActions: readonly StatusActionRecommendation[];
}): Record<DashboardSectionId, number> {
  const reliabilityStatus = Math.max(
    STATUS_PRIORITY[data.availabilityStatus],
    healthData ? STATUS_PRIORITY[healthData.status] : 0,
    browserProbeSummary && browserProbeSummary.failCount > 0 ? 1 : 0,
    data.summary.worstCacheRatio > 2 ? 2 : data.summary.worstCacheRatio > 1.5 ? 1 : 0,
  );
  const cronStatus =
    data.summary.availabilityImpactingConsecutiveCronErrors > 0
      ? 2
      : data.summary.availabilityImpactingCronErrors > 0
        || data.summary.availabilityImpactingUnhealthyCrons > 0
        ? 1
        : data.summary.degradedCrons > 0 || data.summary.watchUnhealthyCrons > 0
          ? 1
          : 0;
  const actionsStatus = recommendedActions.length > 0 ? 2 : 0;
  const telegramDispatch = data.crons["dispatch-telegram-alerts"]?.lastRun ?? null;
  const commsStatus =
    (data.telegramBot?.pendingDeliveries ?? 0) > 0 ||
    (telegramDispatch != null && telegramDispatch.status !== "ok")
      ? 1
      : 0;

  return {
    overview: 999,
    pipeline: STATUS_PRIORITY[data.dataQualityStatus] * 100 + blockerCauses.filter((cause) => cause.layer === "data-quality").length,
    crons: cronStatus * 100 + data.summary.availabilityImpactingUnhealthyCrons * 10 + data.summary.availabilityImpactingCronErrors,
    reliability: reliabilityStatus * 100 + (browserProbeSummary?.failCount ?? 0) + data.summary.availabilityImpactingCronErrors,
    actions: actionsStatus * 100 + recommendedActions.length,
    credentials: 0,
    comms: commsStatus * 100 + (data.telegramBot?.pendingDeliveries ?? 0),
    history: -1,
  };
}

function buildAttentionSections(
  sections: readonly DashboardSection[],
  sectionPriority: Record<DashboardSectionId, number>,
): DashboardSection[] {
  const sectionOrder: DashboardSectionId[] = ["overview", "pipeline", "crons", "reliability", "actions", "credentials", "comms", "history"];
  return sections
    .filter((section) => section.id !== "overview" && section.id !== "credentials" && section.id !== "history")
    .filter((section) => sectionPriority[section.id] > 0)
    .sort((a, b) => {
      const priorityDelta = sectionPriority[b.id] - sectionPriority[a.id];
      if (priorityDelta !== 0) return priorityDelta;

      return sectionOrder.indexOf(a.id) - sectionOrder.indexOf(b.id);
    });
}

function buildDashboardSections({
  data,
  allTransitions,
  latestTransition,
  overallTone,
  pipelineTone,
  overallCauseCount,
  watchCauseCount,
  statusHoldingAge,
  browserProbeSummary,
  cronGroups,
  runningCrons,
  recommendedActions,
}: {
  data: StatusResponse;
  allTransitions: StatusResponse["timeline"];
  latestTransition: StatusResponse["timeline"][number] | null;
  overallTone: ReturnType<typeof getStatusTone>;
  pipelineTone: ReturnType<typeof getStatusTone>;
  overallCauseCount: number;
  watchCauseCount: number;
  statusHoldingAge: number;
  browserProbeSummary: BrowserProbeSummary | null;
  cronGroups: Array<(typeof CRON_GROUPS)[number] & { entries: Array<[string, StatusResponse["crons"][string]]> }>;
  runningCrons: number;
  recommendedActions: readonly StatusActionRecommendation[];
}): DashboardSection[] {
  return [
    {
      id: "overview",
      label: "Triage",
      kicker: "Command Center",
      title: "Triage",
      description: "Current incident state, blockers, watch items, recommended action, and diagnostics.",
      accentClassName: "border-l-frost-blue",
      value: overallTone.label,
      valueClassName: overallTone.valueClassName,
      summary: `${overallCauseCount} blockers, ${watchCauseCount} watch items, confidence ${(data.confidence * 100).toFixed(1)}%, last change ${formatElapsedSeconds(statusHoldingAge)} ago`,
    },
    {
      id: "pipeline",
      label: "Pipeline",
      kicker: "Data Pipeline",
      title: "Pipeline Health",
      description: "Dataset recency, price coverage, supply drift, liquidity coverage, and discovery backlog.",
      accentClassName: "border-l-cyan-500",
      value: pipelineTone.label,
      valueClassName: pipelineTone.valueClassName,
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
      summary: `${data.summary.availabilityImpactingCronErrors} impacting cron errors, ${browserProbeSummary?.failCount ?? 0} failing browser probes, worst cache ${data.summary.worstCacheRatio.toFixed(2)}x`,
    },
    {
      id: "crons",
      label: "Crons",
      kicker: "Schedulers",
      title: "Cron Lanes",
      description: "Grouped by trigger theme so failures, degraded runs, and in-flight leases are easier to scan.",
      accentClassName: "border-l-orange-500",
      value: `${data.summary.availabilityImpactingUnhealthyCrons} impacting`,
      valueClassName:
        data.summary.availabilityImpactingUnhealthyCrons > 0
          ? "text-red-700 dark:text-red-400"
          : "text-green-700 dark:text-green-400",
      summary: `${cronGroups.length} groups, ${data.summary.watchUnhealthyCrons} watch unhealthy, ${data.summary.degradedCrons} degraded jobs, ${runningCrons} running now`,
    },
    {
      id: "actions",
      label: "Actions",
      kicker: "Operations",
      title: "Actions",
      description: "Recommended recovery actions, backfills, audits, diagnostics, and recent execution results.",
      accentClassName: "border-l-emerald-500",
      value: recommendedActions.length > 0 ? `${recommendedActions.length} suggested` : "Clear",
      valueClassName:
        recommendedActions.length > 0 ? "text-amber-700 dark:text-amber-400" : "text-green-700 dark:text-green-400",
      summary: `${recommendedActions.length} recommended actions, ${data.summary.cronErrors} cron errors`,
    },
    {
      id: "credentials",
      label: "Credentials",
      kicker: "Access",
      title: "Credentials",
      description: "API-key inventory, creation, rotation, deactivation, and rate-limit controls.",
      accentClassName: "border-l-slate-500",
      value: "Managed",
      valueClassName: "text-foreground",
      summary: "API-key inventory and lifecycle controls",
    },
    {
      id: "comms",
      label: "Comms",
      kicker: "Messaging",
      title: "Comms",
      description: "Telegram delivery, pending queues, alert-ready audiences, and outbound operator messaging.",
      accentClassName: "border-l-teal-500",
      value: `${data.telegramBot?.pendingDeliveries ?? 0} pending`,
      valueClassName:
        (data.telegramBot?.pendingDeliveries ?? 0) > 0
          ? "text-amber-700 dark:text-amber-400"
          : "text-green-700 dark:text-green-400",
      summary: `${data.telegramBot?.deliverableChats ?? 0} alert-ready chats, ${data.telegramBot?.pendingDeliveries ?? 0} pending deliveries`,
    },
    {
      id: "history",
      label: "History",
      kicker: "Incident Log",
      title: "Incident History",
      description: "Persisted transitions for drills, regressions, and dwell-state validation.",
      accentClassName: "border-l-rose-500",
      value: latestTransition ? formatTransitionLabel(latestTransition) : "No transitions",
      summary: `${allTransitions.length} transitions in view, latest ${latestTransition ? formatElapsedSeconds(Math.max(0, data.timestamp - latestTransition.at)) : "—"} ago`,
    },
  ];
}

interface BuildStatusDashboardOptions {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  probes: EndpointProbeResult[] | undefined;
  querySyncs: {
    statusUpdatedAt: number;
    healthUpdatedAt: number;
    probesUpdatedAt: number;
    historyUpdatedAt: number;
    requestSourceUpdatedAt: number;
  };
  nowMs: number;
  healthError: Error | null;
  probesError: Error | null;
  historyError: Error | null;
  requestSourceError: Error | null;
  historyTransitions: StatusResponse["timeline"] | undefined;
}

export function buildStatusDashboardData({
  data,
  healthData,
  probes,
  querySyncs,
  nowMs,
  healthError,
  probesError,
  historyError,
  requestSourceError,
  historyTransitions,
}: BuildStatusDashboardOptions) {
  const syncDetails = [
    buildQuerySync("status", "Status API", querySyncs.statusUpdatedAt, nowMs),
    buildQuerySync("health", "Public health", querySyncs.healthUpdatedAt, nowMs),
    buildQuerySync("probes", "Browser probes", querySyncs.probesUpdatedAt, nowMs),
    buildQuerySync("history", "Status history", querySyncs.historyUpdatedAt, nowMs),
    buildQuerySync("requestSource", "API attribution", querySyncs.requestSourceUpdatedAt, nowMs),
  ];
  const criticalSyncs = syncDetails.filter((sync) => sync.key !== "history" && sync.key !== "requestSource" && sync.updatedAtMs > 0);
  const freshnessFloorMs =
    criticalSyncs.length > 0
      ? Math.min(...criticalSyncs.map((sync) => sync.updatedAtMs))
      : 0;
  const clientDataAgeSec =
    freshnessFloorMs > 0 ? Math.max(0, Math.floor((nowMs - freshnessFloorMs) / 1000)) : 0;
  const browserProbeSummary = buildBrowserProbeSummary(probes, querySyncs.probesUpdatedAt);
  const cronEntries = Object.entries(data.crons);
  const cronGroups = CRON_GROUPS.map((group) => ({
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
  const blockerCauses = getCauses(data.causes, "blocker");
  const watchCauses = getCauses(data.causes, "watch");
  const overallCauseCount = blockerCauses.length;
  const watchCauseCount = watchCauses.length;
  const statusHoldingAge = Math.max(0, data.timestamp - data.state.lastChangedAt);
  const overallTone = getStatusTone(data.overallStatus);
  const pipelineTone = getStatusTone(data.dataQualityStatus);
  const staleQuerySyncs = criticalSyncs.filter((sync) => sync.stale);
  const clientDataStale = staleQuerySyncs.length > 0;
  const notices = buildDashboardNotices({
    clientDataStale,
    staleQuerySyncs,
    healthError,
    probesError,
    historyError,
    requestSourceError,
    publicHealthNeedsCallout,
    healthDiffersFromStatus,
    healthData,
    status: data.overallStatus,
    timestamp: data.timestamp,
  });
  const sectionPriority = buildSectionPriority({
    data,
    healthData,
    browserProbeSummary,
    blockerCauses,
    recommendedActions,
  });
  const baseSections = buildDashboardSections({
    data,
    allTransitions,
    latestTransition,
    overallTone,
    pipelineTone,
    overallCauseCount,
    watchCauseCount,
    statusHoldingAge,
    browserProbeSummary,
    cronGroups,
    runningCrons,
    recommendedActions,
  });
  const attentionSections = buildAttentionSections(baseSections, sectionPriority);

  return {
    allTransitions,
    attentionSections,
    blockerCauses,
    browserProbeSummary,
    clientDataAgeSec,
    clientDataStale,
    cronGroups,
    freshnessFloorMs,
    healthDiffersFromStatus,
    latestTransition,
    notices,
    overallCauseCount,
    watchCauseCount,
    overallTone,
    publicHealthNeedsCallout,
    querySyncs: syncDetails,
    recommendedActions,
    runningCrons,
    sections: baseSections,
    statusHoldingAge,
  };
}
