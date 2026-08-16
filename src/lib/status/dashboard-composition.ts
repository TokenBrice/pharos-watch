import type { EndpointProbeResult, HealthResponse, StatusResponse } from "@shared/types";
import { formatElapsedSeconds } from "@shared/lib/format";
import { buildCommsWorkbenchModel, type CommsWorkbenchModel } from "@/lib/comms-workbench-model";
import { deriveStatusActionRecommendations } from "@/lib/status/action-recommendations";
import { STATUS_PRIORITY, getStatusTone } from "@/lib/status/dashboard-presentation";
import {
  STATUS_DASHBOARD_FRESHNESS_POLICY,
  buildDashboardDecision,
  buildDashboardEvidence,
  buildPublicHealthStatusCauses,
  buildQuerySync,
  groupDashboardIssues,
  normalizeStatusIssues,
} from "@/lib/status/issue-evidence-model";
import {
  buildBrowserProbeSummary,
  buildDashboardCronGroups,
  countRunningDashboardCrons,
} from "@/lib/status/probe-model";
import type {
  BrowserProbeSummary,
  DashboardCronGroup,
  DashboardEvidence,
  DashboardIssueGroups,
  DashboardNotice,
  DashboardSection,
} from "@/lib/status/dashboard-types";

function buildDashboardNotices({
  evidence,
  statusError,
  healthError,
  probesError,
  historyError,
  requestSourceError,
  publicHealthNeedsCallout,
  healthDiffersFromStatus,
  healthData,
  status,
  timestamp,
  publicationHealth,
  scheduledSlotRunningQueryFailed,
  scheduledSlotEventMarkerQueryFailed,
}: {
  evidence: DashboardEvidence;
  statusError: Error | null;
  healthError: Error | null;
  probesError: Error | null;
  historyError: Error | null;
  requestSourceError: Error | null;
  publicHealthNeedsCallout: boolean;
  healthDiffersFromStatus: boolean;
  healthData: HealthResponse | null | undefined;
  status: StatusResponse["overallStatus"];
  timestamp: number;
  publicationHealth: StatusResponse["publicationHealth"];
  scheduledSlotRunningQueryFailed: boolean | undefined;
  scheduledSlotEventMarkerQueryFailed: boolean | undefined;
}): DashboardNotice[] {
  const notices: DashboardNotice[] = [];
  if (evidence.state === "stale") {
    const staleLabels = evidence.staleLabels.join(", ");
    const staleAfterSec = STATUS_DASHBOARD_FRESHNESS_POLICY.staleAfterMs / 1000;
    notices.push({
      id: "client-stale",
      title: "Client view is lagging",
      detail: `${staleLabels} are older than the ${staleAfterSec}s polling and jitter budget in this browser. Refresh before treating the dashboard as current.`,
      tone: "warning",
    });
  } else if (evidence.state === "partial" || evidence.state === "unavailable") {
    const affectedLabels = [...new Set([...evidence.missingLabels, ...evidence.refreshErrorLabels])];
    notices.push({
      id: "client-partial",
      title: evidence.state === "unavailable" ? "Dashboard evidence is unavailable" : "Dashboard evidence is incomplete",
      detail: `${affectedLabels.join(", ") || "Required evidence"} ${affectedLabels.length === 1 ? "is" : "are"} unavailable or failed to refresh. Refresh evidence before acting.`,
      tone: "warning",
    });
  }
  if (statusError) notices.push({ id: "status-error", title: "Operator status endpoint failed to refresh", detail: statusError.message, tone: "critical" });
  if (healthError) {
    const hasRetainedHealth = !evidence.missingLabels.includes("Public health");
    notices.push({
      id: "health-error",
      title: hasRetainedHealth ? "Public health refresh failed" : "Public health endpoint unavailable",
      detail: hasRetainedHealth ? `Using the last successful response. ${healthError.message}` : healthError.message,
      tone: "warning",
    });
  }
  if (probesError) {
    const hasRetainedProbes = !evidence.missingLabels.includes("Browser probes");
    notices.push({
      id: "probe-error",
      title: hasRetainedProbes ? "Browser probe refresh failed" : "Browser probe loop unavailable",
      detail: hasRetainedProbes ? `Using the last successful response. ${probesError.message}` : probesError.message,
      tone: "warning",
    });
  }
  if (historyError) notices.push({ id: "history-error", title: "Status history unavailable", detail: historyError.message, tone: "warning" });
  if (requestSourceError) notices.push({ id: "request-source-error", title: "API attribution unavailable", detail: requestSourceError.message, tone: "warning" });
  if (publicHealthNeedsCallout && healthData) {
    const divergence = healthDiffersFromStatus ? `Public /api/health differs from /api/status (${status}). ` : "";
    const mintBurnWarning = healthData.mintBurn.sync.warning != null ? `${healthData.mintBurn.sync.warning} ` : "";
    const mintBurnSyncAge = healthData.mintBurn.sync.lastSuccessfulSyncAt != null
      ? `Last successful mint/burn sync ${formatElapsedSeconds(Math.max(0, timestamp - healthData.mintBurn.sync.lastSuccessfulSyncAt))} ago. `
      : "";
    const impactedMajors = healthData.mintBurn.majorStaleCount > 0 ? `Impacted majors: ${healthData.mintBurn.staleMajorSymbols.join(", ")}. ` : "";
    notices.push({
      id: "public-health",
      title: `Public /api/health reports ${healthData.status}`,
      detail: `${divergence}${mintBurnWarning}${mintBurnSyncAge}${impactedMajors}Blacklist gaps tracked by /api/health: ${healthData.blacklist.missingAmounts}.`,
      tone: healthData.status === "stale" ? "critical" : healthData.status === "degraded" ? "warning" : "neutral",
    });
  }
  publicationHealth?.failedSurfaces?.forEach((failure, index) => {
    const label = publicationHealth.surfaces[failure.surface]?.label;
    const surfaceLabel = label && label !== failure.surface ? `${label} (${failure.surface})` : failure.surface;
    notices.push({
      id: `publication-failed-${failure.surface}-${failure.code}-${index}`,
      title: `Publication surface failed: ${surfaceLabel}`,
      detail: `${failure.surface} reported ${failure.code}: ${failure.message}`,
      tone: "neutral",
    });
  });
  if (scheduledSlotRunningQueryFailed === true) notices.push({
    id: "scheduled-slot-running-query-failed",
    title: "Scheduled-slot running query failed",
    detail: "Status could not inspect running scheduled slots; stale-slot detection may be incomplete.",
    tone: "neutral",
  });
  if (scheduledSlotEventMarkerQueryFailed === true) notices.push({
    id: "scheduled-slot-event-marker-query-failed",
    title: "Scheduled-slot event-marker query failed",
    detail: "Status could not inspect scheduled-slot event markers; slot-abandonment diagnostics may be incomplete.",
    tone: "neutral",
  });
  return notices;
}

interface DashboardSectionPriority {
  active: boolean;
  severity: number;
  publicImpact: number;
  evidenceRisk: number;
  persistence: number;
  count: number;
}

function buildSectionPriority({ data, healthData, browserProbeSummary, issueGroups, evidence, commsModel }: {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  browserProbeSummary: BrowserProbeSummary | null;
  issueGroups: DashboardIssueGroups;
  evidence: DashboardEvidence;
  commsModel: CommsWorkbenchModel;
}): Record<DashboardSection["id"], DashboardSectionPriority> {
  const evidencePriority = evidence.state === "stale" || evidence.state === "unavailable" ? 2 : evidence.state === "partial" ? 1 : 0;
  const reliabilityStatus = Math.max(
    STATUS_PRIORITY[data.availabilityStatus],
    healthData ? STATUS_PRIORITY[healthData.status] : 0,
    browserProbeSummary && browserProbeSummary.failCount > 0 ? 1 : 0,
    data.summary.worstCacheRatio > 2 ? 2 : data.summary.worstCacheRatio > 1.5 ? 1 : 0,
  );
  const cronStatus = data.summary.availabilityImpactingConsecutiveCronErrors > 0 ? 2
    : data.summary.availabilityImpactingCronErrors > 0 || data.summary.availabilityImpactingUnhealthyCrons > 0 ? 1
      : data.summary.degradedCrons > 0 || data.summary.watchUnhealthyCrons > 0 ? 1 : 0;
  const commsStatus = commsModel.delivery.health === "failed" ? 2 : commsModel.delivery.health === "degraded" ? 1 : 0;
  const pipelineIssues = [...issueGroups.impacting, ...issueGroups.warnings, ...issueGroups.maintenance].filter((issue) => issue.layer === "data-quality");
  return {
    pipeline: {
      active: STATUS_PRIORITY[data.dataQualityStatus] > 0 || pipelineIssues.length > 0,
      severity: STATUS_PRIORITY[data.dataQualityStatus],
      publicImpact: pipelineIssues.some((issue) => issue.publicImpacting) ? 1 : 0,
      evidenceRisk: 0,
      persistence: 0,
      count: pipelineIssues.length,
    },
    crons: {
      active: cronStatus > 0,
      severity: cronStatus,
      publicImpact: data.summary.availabilityImpactingUnhealthyCrons > 0 || data.summary.availabilityImpactingCronErrors > 0 ? 1 : 0,
      evidenceRisk: 0,
      persistence: data.summary.availabilityImpactingConsecutiveCronErrors,
      count: data.summary.availabilityImpactingUnhealthyCrons + data.summary.availabilityImpactingCronErrors + data.summary.degradedCrons + data.summary.watchUnhealthyCrons,
    },
    reliability: {
      active: reliabilityStatus > 0 || evidencePriority > 0,
      severity: reliabilityStatus,
      publicImpact: data.availabilityStatus !== "healthy" || (healthData != null && healthData.status !== "healthy") || (browserProbeSummary?.failCount ?? 0) > 0 ? 1 : 0,
      evidenceRisk: evidencePriority,
      persistence: 0,
      count: (browserProbeSummary?.failCount ?? 0) + data.summary.availabilityImpactingCronErrors,
    },
    comms: {
      active: commsModel.delivery.health !== "healthy",
      severity: commsStatus,
      publicImpact: commsModel.delivery.health === "failed" ? 1 : 0,
      evidenceRisk: commsModel.delivery.health === "unknown" ? 2 : 0,
      persistence: commsModel.delivery.oldestBacklogAgeSec ?? 0,
      count: commsModel.delivery.pendingDeliveries ?? 0,
    },
  };
}

function compareSectionPriority(left: DashboardSectionPriority, right: DashboardSectionPriority): number {
  const leftTuple = [left.severity, left.publicImpact, left.evidenceRisk, left.persistence, left.count];
  const rightTuple = [right.severity, right.publicImpact, right.evidenceRisk, right.persistence, right.count];
  for (let index = 0; index < leftTuple.length; index += 1) {
    const delta = (rightTuple[index] ?? 0) - (leftTuple[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function buildAttentionSections(sections: readonly DashboardSection[], sectionPriority: Record<DashboardSection["id"], DashboardSectionPriority>): DashboardSection[] {
  const sectionOrder: Array<DashboardSection["id"]> = ["pipeline", "crons", "reliability", "comms"];
  return sections.filter((section) => sectionPriority[section.id].active).sort((a, b) => {
    const priorityDelta = compareSectionPriority(sectionPriority[a.id], sectionPriority[b.id]);
    return priorityDelta !== 0 ? priorityDelta : sectionOrder.indexOf(a.id) - sectionOrder.indexOf(b.id);
  });
}

function buildDashboardSections({ data, pipelineTone, browserProbeSummary, cronGroups, runningCrons, commsModel }: {
  data: StatusResponse;
  pipelineTone: ReturnType<typeof getStatusTone>;
  browserProbeSummary: BrowserProbeSummary | null;
  cronGroups: DashboardCronGroup[];
  runningCrons: number;
  commsModel: CommsWorkbenchModel;
}): DashboardSection[] {
  return [
    { id: "pipeline", title: "Pipeline Health", value: pipelineTone.label, valueClassName: pipelineTone.valueClassName, summary: `${data.dataQuality.missingPrices} missing prices, ${data.dataQuality.staleOnchainSupply} stale on-chain feeds, ${data.dataQuality.blacklistMissingAmounts} blacklist gaps` },
    {
      id: "reliability", title: "Probes, breakers, and cache pressure",
      value: browserProbeSummary ? `${browserProbeSummary.passCount}/${browserProbeSummary.sampleCount}` : "Unknown",
      valueClassName: browserProbeSummary && browserProbeSummary.failCount > 0 ? "text-amber-700 dark:text-amber-400" : "text-foreground",
      summary: `${data.summary.availabilityImpactingCronErrors} impacting cron errors, ${browserProbeSummary ? `${browserProbeSummary.failCount} failing browser probes` : "browser probe result unknown"}, worst cache ${data.summary.worstCacheRatio.toFixed(2)}x`,
    },
    {
      id: "crons", title: "Cron Lanes", value: `${data.summary.availabilityImpactingUnhealthyCrons} impacting`,
      valueClassName: data.summary.availabilityImpactingUnhealthyCrons > 0 ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400",
      summary: `${cronGroups.length} groups, ${data.summary.watchUnhealthyCrons} watch unhealthy, ${data.summary.degradedCrons} degraded jobs, ${runningCrons} running now`,
    },
    {
      id: "comms", title: "Comms",
      value: commsModel.delivery.health === "unknown" ? "Unknown" : commsModel.delivery.health === "failed" ? "Failed" : `${commsModel.delivery.pendingDeliveries ?? 0} pending`,
      valueClassName: commsModel.delivery.health === "failed" ? "text-red-700 dark:text-red-400" : commsModel.delivery.health === "degraded" ? "text-amber-700 dark:text-amber-400" : commsModel.delivery.health === "healthy" ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground",
      summary: `${commsModel.delivery.healthReason} ${commsModel.audience.deliverableChats == null ? "Alert-ready audience Unknown." : `${commsModel.audience.deliverableChats} alert-ready chats.`}`,
    },
  ];
}

interface BuildStatusDashboardOptions {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  probes: EndpointProbeResult[] | undefined;
  probeLabel?: string;
  querySyncs: { statusUpdatedAt: number; healthUpdatedAt: number; probesUpdatedAt: number; historyUpdatedAt: number; requestSourceUpdatedAt: number };
  nowMs: number;
  statusError?: Error | null;
  healthError: Error | null;
  probesError: Error | null;
  historyError: Error | null;
  requestSourceError: Error | null;
  historyTransitions: StatusResponse["timeline"] | undefined;
}

export function buildStatusDashboardData({ data, healthData, probes, probeLabel = "Browser probes", querySyncs, nowMs, statusError = null, healthError, probesError, historyError, requestSourceError, historyTransitions }: BuildStatusDashboardOptions) {
  const syncDetails = [
    buildQuerySync({ key: "status", label: "Status API", required: true, hasData: true, updatedAtMs: querySyncs.statusUpdatedAt, nowMs, error: statusError }),
    buildQuerySync({ key: "health", label: "Public health", required: true, hasData: healthData != null, updatedAtMs: querySyncs.healthUpdatedAt, nowMs, error: healthError }),
    buildQuerySync({ key: "probes", label: probeLabel, required: true, hasData: probes !== undefined, updatedAtMs: querySyncs.probesUpdatedAt, nowMs, error: probesError }),
    buildQuerySync({ key: "history", label: "Status history", required: false, hasData: historyTransitions !== undefined || querySyncs.historyUpdatedAt > 0, updatedAtMs: querySyncs.historyUpdatedAt, nowMs, error: historyError }),
    buildQuerySync({ key: "requestSource", label: "API attribution", required: false, hasData: querySyncs.requestSourceUpdatedAt > 0, updatedAtMs: querySyncs.requestSourceUpdatedAt, nowMs, error: requestSourceError }),
  ];
  const evidence = buildDashboardEvidence(syncDetails, nowMs);
  const browserProbeSummary = buildBrowserProbeSummary(probes, querySyncs.probesUpdatedAt);
  const cronGroups = buildDashboardCronGroups(data);
  const runningCrons = countRunningDashboardCrons(data);
  const healthDiffersFromStatus = healthData != null && healthData.status !== data.overallStatus;
  const publicHealthNeedsCallout = healthData != null && (healthData.status !== "healthy" || healthDiffersFromStatus);
  const recommendedActions = deriveStatusActionRecommendations({ causes: data.causes, crons: data.crons });
  const issueGroups = groupDashboardIssues(normalizeStatusIssues(data.causes, buildPublicHealthStatusCauses(healthData)));
  const decision = buildDashboardDecision({ data, healthData, evidence, issueGroups, recommendedActions });
  const overallTone = decision.systemState === "unknown" ? getStatusTone(data.overallStatus) : getStatusTone(decision.systemState);
  const pipelineTone = getStatusTone(data.dataQualityStatus);
  const notices = buildDashboardNotices({
    evidence, statusError, healthError, probesError, historyError, requestSourceError, publicHealthNeedsCallout,
    healthDiffersFromStatus, healthData, status: data.overallStatus, timestamp: data.timestamp,
    publicationHealth: data.publicationHealth,
    scheduledSlotRunningQueryFailed: data.summary.scheduledSlotRunningQueryFailed,
    scheduledSlotEventMarkerQueryFailed: data.summary.scheduledSlotEventMarkerQueryFailed,
  });
  const commsModel = buildCommsWorkbenchModel({ telegramBot: data.telegramBot, dispatchCron: data.crons["dispatch-telegram-alerts"], sectionError: data.sectionErrors.telegramBot, nowSeconds: data.timestamp });
  const sectionPriority = buildSectionPriority({ data, healthData, browserProbeSummary, issueGroups, evidence, commsModel });
  const attentionSections = buildAttentionSections(buildDashboardSections({ data, pipelineTone, browserProbeSummary, cronGroups, runningCrons, commsModel }), sectionPriority);
  return {
    attentionSections,
    browserProbeSummary,
    clientDataStale: evidence.state !== "current",
    decision,
    evidence,
    freshnessFloorMs: evidence.oldestRequiredSuccessAtMs,
    healthDiffersFromStatus,
    latestTransition: (historyTransitions ?? data.timeline)[0] ?? null,
    notices,
    issueGroups,
    overallTone,
    querySyncs: syncDetails,
    recommendedActions,
    statusHoldingAge: Math.max(0, data.timestamp - data.state.lastChangedAt),
  };
}
