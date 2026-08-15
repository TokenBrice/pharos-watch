import type {
  EndpointProbeResult,
  HealthResponse,
  StatusCause,
  StatusHealthValue,
  StatusResponse,
} from "@shared/types";
import { getPollingWindow } from "@/lib/api-query-polling";
import { buildCommsWorkbenchModel, type CommsWorkbenchModel } from "@/lib/comms-workbench-model";
import { CRON_1MIN } from "@/lib/cron-intervals";
import { deriveStatusActionRecommendations } from "@/lib/status/action-recommendations";
import { STATUS_CAUSE_SEVERITY_RANK } from "@/lib/status/cause-severity";
import { getStatusCronDisplay } from "@/lib/status/cron-config";
import { getActivePriceCoverageImpactDetail, getPublicHealthWarningPresentation } from "@/lib/status/public-status";
import { CRON_GROUPS } from "@shared/lib/cron-jobs";
import { formatElapsedSeconds } from "@shared/lib/format";
import { transitionHasPublicImpact } from "@shared/lib/status-public-impact";
import { percentileNearestRank } from "@shared/lib/stats";

export type DashboardSectionId =
  "overview" | "pipeline" | "crons" | "reliability" | "actions" | "credentials" | "comms" | "history";

/** Descriptor for the lanes that can surface in the Triage "needs attention" list. */
export interface DashboardSection {
  id: Extract<DashboardSectionId, "pipeline" | "crons" | "reliability" | "comms">;
  title: string;
  value: string;
  valueClassName?: string;
  summary: string;
}

export type DashboardCronGroup = (typeof CRON_GROUPS)[number] & {
  entries: Array<[string, StatusResponse["crons"][string]]>;
};

export interface DashboardNotice {
  id: string;
  title: string;
  detail: string;
  tone: "neutral" | "warning" | "critical";
}

export type DashboardIssueKind = "impacting" | "warning" | "maintenance" | "watch";

export interface DashboardIssue extends StatusCause {
  id: string;
  kind: DashboardIssueKind;
  publicImpacting: boolean;
  affectedSurface: string;
  impactLabel: string;
}

export interface DashboardIssueGroups {
  impacting: DashboardIssue[];
  warnings: DashboardIssue[];
  maintenance: DashboardIssue[];
  watches: DashboardIssue[];
}

export type DashboardQueryEvidenceState = "current" | "partial" | "stale" | "unavailable";

export interface DashboardQuerySync {
  key: "status" | "health" | "probes" | "history" | "requestSource";
  label: string;
  required: boolean;
  hasData: boolean;
  updatedAtMs: number;
  updatedAtSec: number | null;
  ageSec: number | null;
  errorMessage: string | null;
  state: DashboardQueryEvidenceState;
  stale: boolean;
}

export type DashboardEvidenceState = "current" | "partial" | "stale" | "unavailable";

export interface DashboardEvidence {
  state: DashboardEvidenceState;
  label: string;
  requiredQueryCount: number;
  currentQueryCount: number;
  missingLabels: string[];
  staleLabels: string[];
  refreshErrorLabels: string[];
  oldestRequiredSuccessAtMs: number | null;
  oldestRequiredAgeSec: number | null;
}

export type DashboardOperatorNextStep =
  "no-action" | "observe-next-run" | "investigate" | "manual-action" | "refresh-evidence" | "action-blocked";

export interface DashboardDecision {
  systemState: "healthy" | "degraded" | "stale" | "unknown";
  systemLabel: "Healthy" | "Degraded" | "Stale" | "Unknown";
  publicState: StatusResponse["overallStatus"] | "unknown";
  adminState: StatusResponse["overallStatus"];
  evidenceState: DashboardEvidenceState;
  evidenceLabel: string;
  nextStep: DashboardOperatorNextStep;
  nextStepLabel: string;
  summary: string;
  hasPublicAdminDivergence: boolean;
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

const DASHBOARD_POLLING_WINDOW = getPollingWindow(CRON_1MIN);

export const STATUS_DASHBOARD_FRESHNESS_POLICY = Object.freeze({
  producerIntervalMs: CRON_1MIN,
  refetchIntervalMs: DASHBOARD_POLLING_WINDOW.refetchInterval,
  jitterToleranceMs: CRON_1MIN,
  staleAfterMs: DASHBOARD_POLLING_WINDOW.refetchInterval + CRON_1MIN,
});

const STATUS_TONE = {
  healthy: {
    label: "Healthy",
    badgeClassName: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    valueClassName: "text-emerald-700 dark:text-emerald-400",
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

const ISSUE_KIND_RANK: Record<DashboardIssueKind, number> = {
  impacting: 0,
  warning: 1,
  maintenance: 2,
  watch: 3,
};

const MAINTENANCE_CAUSE_CODES = new Set(["ddr_repair_debt_present", "reserve_sync_history_write_gap"]);

const PUBLICATION_BLOCKING_CAUSE_CODES = new Set(["stablecoin_publication_incomplete"]);

const ACTIVE_PRICE_COVERAGE_CAUSE_CODE = "active_price_coverage_incomplete";
const ACTIVE_PRICE_COVERAGE_CAUSE_CODES = new Set([ACTIVE_PRICE_COVERAGE_CAUSE_CODE, "active_price_coverage_unknown"]);

const MULTI_INSTANCE_CAUSE_CODES = new Set(["cache_warning"]);

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

function buildQuerySync({
  key,
  label,
  required,
  hasData,
  updatedAtMs,
  nowMs,
  error,
}: {
  key: DashboardQuerySync["key"];
  label: DashboardQuerySync["label"];
  required: boolean;
  hasData: boolean;
  updatedAtMs: number;
  nowMs: number;
  error: Error | null;
}): DashboardQuerySync {
  const safeUpdatedAtMs = Number.isFinite(updatedAtMs) ? updatedAtMs : 0;
  const ageSec = safeUpdatedAtMs > 0 ? Math.max(0, Math.floor((nowMs - safeUpdatedAtMs) / 1000)) : null;
  const isStale = hasData && ageSec != null && ageSec * 1000 > STATUS_DASHBOARD_FRESHNESS_POLICY.staleAfterMs;
  const state: DashboardQueryEvidenceState = !hasData
    ? "unavailable"
    : isStale
      ? "stale"
      : error != null || ageSec == null
        ? "partial"
        : "current";

  return {
    key,
    label,
    required,
    hasData,
    updatedAtMs: safeUpdatedAtMs,
    updatedAtSec: safeUpdatedAtMs > 0 ? Math.floor(safeUpdatedAtMs / 1000) : null,
    ageSec,
    errorMessage: error?.message ?? null,
    state,
    stale: state === "stale",
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

/** Status-dashboard-scoped timestamp formatter. Not a candidate for shared extraction. */
function formatLocaleTimestampMs(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { timeZoneName: "short" });
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

/**
 * The operator surface's "good state" outlined pill.
 *
 * Emerald, matching the site-wide `SEVERITY_TONE_CLASS.ok`. The operator
 * surface carried Tailwind `green` for healthy across ~40 sites from the day
 * it shipped; the owner ruled that split hue closed on 2026-08-10 and the
 * whole cluster moved to emerald in one pass. This constant still exists so
 * the four components that spelled the identical string by hand share one
 * definition (WS8.14).
 */
export const STATUS_OK_PILL_CLASS = STATUS_TONE.healthy.badgeClassName;

export function getSeverityBadgeClass(severity: StatusCause["severity"]): string {
  if (severity === "critical") return "bg-red-500/15 text-red-700 dark:text-red-400";
  if (severity === "warning") return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
  return "bg-muted text-muted-foreground";
}

export function getIssueKindBadgeClass(kind: DashboardIssueKind): string {
  if (kind === "impacting") return "bg-red-500/15 text-red-700 dark:text-red-400";
  if (kind === "warning") return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
  if (kind === "maintenance") return "bg-blue-500/15 text-blue-700 dark:text-blue-400";
  return "bg-muted text-muted-foreground";
}

export function getNoticeTone(tone: DashboardNotice["tone"]): string {
  if (tone === "critical") return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  if (tone === "warning") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-border/60 bg-muted/30 text-muted-foreground";
}

type StatusActionRecommendation = ReturnType<typeof deriveStatusActionRecommendations>[number];

function getIssueIdentity(cause: StatusCause): string {
  const discriminator = cause.metric ?? (MULTI_INSTANCE_CAUSE_CODES.has(cause.code) ? cause.message : "");
  return [cause.layer, cause.code, discriminator].filter(Boolean).join(":");
}

function getIssueKind(cause: StatusCause, publicImpacting: boolean): DashboardIssueKind {
  if (cause.severity === "critical" || publicImpacting || PUBLICATION_BLOCKING_CAUSE_CODES.has(cause.code)) {
    return "impacting";
  }
  if (MAINTENANCE_CAUSE_CODES.has(cause.code)) return "maintenance";
  if (cause.severity === "warning") return "warning";
  return "watch";
}

function getAffectedSurface(cause: StatusCause, publicImpacting: boolean): string {
  if (ACTIVE_PRICE_COVERAGE_CAUSE_CODES.has(cause.code)) return "Stablecoin prices";
  if (publicImpacting) return "Public service";
  if (PUBLICATION_BLOCKING_CAUSE_CODES.has(cause.code)) return "Publication";
  if (cause.layer === "data-quality") return "Data pipeline";
  if (cause.layer === "availability") return "Operator reliability";
  return "Status system";
}

function getIssueImpactLabel(kind: DashboardIssueKind): string {
  if (kind === "impacting") return "Impacting";
  if (kind === "warning") return "Warning";
  if (kind === "maintenance") return "Maintenance debt";
  return "Informational watch";
}

export function buildPublicHealthStatusCauses(healthData: HealthResponse | null | undefined): StatusCause[] {
  if (!healthData) return [];
  const coverage = healthData.activePriceCoverage;
  const warning = healthData.warnings.find((item) => item.startsWith("active-price-coverage-incomplete:"));
  if (!warning) return [];

  const message =
    coverage?.status === "incomplete"
      ? getActivePriceCoverageImpactDetail(coverage)
      : getPublicHealthWarningPresentation(warning!, healthData).detail;

  return [
    {
      code: ACTIVE_PRICE_COVERAGE_CAUSE_CODE,
      layer: "data-quality",
      severity: "warning",
      message,
      metric: "missingActivePrices",
      value: coverage?.missingPriceCount,
      threshold: 1,
    },
  ];
}

export function normalizeStatusIssues(
  causes: StatusResponse["causes"],
  additionalCauses: readonly StatusCause[] = [],
): DashboardIssue[] {
  const deduped = new Map<string, StatusCause>();

  for (const cause of [...causes.overall, ...causes.availability, ...causes.dataQuality, ...additionalCauses]) {
    const id = getIssueIdentity(cause);
    const existing = deduped.get(id);
    const isRicherActivePriceCause =
      existing != null &&
      cause.code === ACTIVE_PRICE_COVERAGE_CAUSE_CODE &&
      additionalCauses.includes(cause) &&
      STATUS_CAUSE_SEVERITY_RANK[cause.severity] === STATUS_CAUSE_SEVERITY_RANK[existing.severity];
    if (!existing || STATUS_CAUSE_SEVERITY_RANK[cause.severity] < STATUS_CAUSE_SEVERITY_RANK[existing.severity]) {
      deduped.set(id, cause);
    } else if (isRicherActivePriceCause) {
      deduped.set(id, {
        ...existing,
        ...cause,
        metric: cause.metric ?? existing.metric,
        value: cause.value ?? existing.value,
        threshold: cause.threshold ?? existing.threshold,
        runbookUrl: cause.runbookUrl ?? existing.runbookUrl,
      });
    }
  }

  return [...deduped.entries()]
    .map(([id, cause]) => {
      const publicImpacting = transitionHasPublicImpact([cause]);
      const kind = getIssueKind(cause, publicImpacting);
      return {
        ...cause,
        id,
        kind,
        publicImpacting,
        affectedSurface: getAffectedSurface(cause, publicImpacting),
        impactLabel: getIssueImpactLabel(kind),
      };
    })
    .sort((a, b) => {
      const kindDelta = ISSUE_KIND_RANK[a.kind] - ISSUE_KIND_RANK[b.kind];
      if (kindDelta !== 0) return kindDelta;
      const severityDelta = STATUS_CAUSE_SEVERITY_RANK[a.severity] - STATUS_CAUSE_SEVERITY_RANK[b.severity];
      if (severityDelta !== 0) return severityDelta;
      return a.code.localeCompare(b.code);
    });
}

export function groupDashboardIssues(issues: readonly DashboardIssue[]): DashboardIssueGroups {
  return {
    impacting: issues.filter((issue) => issue.kind === "impacting"),
    warnings: issues.filter((issue) => issue.kind === "warning"),
    maintenance: issues.filter((issue) => issue.kind === "maintenance"),
    watches: issues.filter((issue) => issue.kind === "watch"),
  };
}

const EVIDENCE_LABELS: Record<DashboardEvidenceState, string> = {
  current: "Current and complete",
  partial: "Current with partial evidence",
  stale: "Stale",
  unavailable: "Unavailable",
};

export function buildDashboardEvidence(
  querySyncs: readonly DashboardQuerySync[],
  nowMs: number = Date.now(),
): DashboardEvidence {
  const required = querySyncs.filter((sync) => sync.required);
  const statusSync = required.find((sync) => sync.key === "status");
  const missingLabels = required.filter((sync) => sync.state === "unavailable").map((sync) => sync.label);
  const staleLabels = required.filter((sync) => sync.state === "stale").map((sync) => sync.label);
  const refreshErrorLabels = required.filter((sync) => sync.errorMessage != null).map((sync) => sync.label);
  const allRequiredHaveTimestamps = required.length > 0 && required.every((sync) => sync.updatedAtMs > 0);
  const oldestRequiredSuccessAtMs = allRequiredHaveTimestamps
    ? Math.min(...required.map((sync) => sync.updatedAtMs))
    : null;
  const oldestRequiredAgeSec =
    oldestRequiredSuccessAtMs == null ? null : Math.max(0, Math.floor((nowMs - oldestRequiredSuccessAtMs) / 1000));
  const state: DashboardEvidenceState =
    statusSync?.state === "unavailable"
      ? "unavailable"
      : staleLabels.length > 0
        ? "stale"
        : required.some((sync) => sync.state !== "current")
          ? "partial"
          : "current";

  return {
    state,
    label: EVIDENCE_LABELS[state],
    requiredQueryCount: required.length,
    currentQueryCount: required.filter((sync) => sync.state === "current").length,
    missingLabels,
    staleLabels,
    refreshErrorLabels,
    oldestRequiredSuccessAtMs,
    oldestRequiredAgeSec,
  };
}

const NEXT_STEP_LABELS: Record<DashboardOperatorNextStep, string> = {
  "no-action": "No action",
  "observe-next-run": "Observe next scheduled run",
  investigate: "Investigate",
  "manual-action": "Manual action recommended",
  "refresh-evidence": "Refresh evidence before acting",
  "action-blocked": "Action blocked",
};

function getDecisionSystemState(
  adminState: StatusResponse["overallStatus"],
  publicState: StatusResponse["overallStatus"] | "unknown",
): DashboardDecision["systemState"] {
  if (publicState === "unknown") return adminState;
  return STATUS_PRIORITY[publicState] > STATUS_PRIORITY[adminState] ? publicState : adminState;
}

function getSystemSummary(
  adminState: StatusResponse["overallStatus"],
  publicState: StatusResponse["overallStatus"] | "unknown",
): string {
  if (publicState === "unknown") return `Public service state unknown. Admin state ${adminState}.`;
  if (publicState === adminState) return `Public service ${publicState}.`;
  return `Public service ${publicState}. Admin state ${adminState}.`;
}

export function buildDashboardDecision({
  data,
  healthData,
  evidence,
  issueGroups,
  recommendedActions,
}: {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  evidence: DashboardEvidence;
  issueGroups: DashboardIssueGroups;
  recommendedActions: readonly StatusActionRecommendation[];
}): DashboardDecision {
  const publicState = healthData?.status ?? "unknown";
  const adminState = data.overallStatus;
  const systemState = getDecisionSystemState(adminState, publicState);
  const recoveryHold = STATUS_PRIORITY[data.overallStatus] > STATUS_PRIORITY[data.rawOverallStatus];
  let nextStep: DashboardOperatorNextStep;

  if (evidence.state === "unavailable") {
    nextStep = "action-blocked";
  } else if (evidence.state === "stale" || evidence.state === "partial") {
    nextStep = "refresh-evidence";
  } else if (issueGroups.impacting.length > 0 && recommendedActions.length > 0) {
    nextStep = "manual-action";
  } else if (issueGroups.impacting.length > 0 || systemState !== "healthy") {
    nextStep = "investigate";
  } else if (issueGroups.warnings.length > 0 || recoveryHold) {
    nextStep = "observe-next-run";
  } else {
    nextStep = "no-action";
  }

  const systemSummary = getSystemSummary(adminState, publicState);
  const evidenceSummary = `Evidence ${evidence.state === "current" ? "current" : evidence.state}.`;
  let actionSummary = `${NEXT_STEP_LABELS[nextStep]}.`;
  if (nextStep === "refresh-evidence" && evidence.state === "partial") {
    actionSummary = "Refresh missing evidence before deciding.";
  } else if (nextStep === "no-action" && issueGroups.maintenance.length > 0) {
    const count = issueGroups.maintenance.length;
    actionSummary = `No immediate action; ${count === 1 ? "one maintenance item is" : `${count} maintenance items are`} queued.`;
  } else if (nextStep === "no-action" && issueGroups.watches.length > 0) {
    actionSummary = `No immediate action; ${issueGroups.watches.length} informational watch${issueGroups.watches.length === 1 ? " remains" : "es remain"}.`;
  } else if (nextStep === "no-action") {
    actionSummary = "No immediate action.";
  }

  return {
    systemState,
    systemLabel: systemState === "unknown" ? "Unknown" : STATUS_TONE[systemState].label,
    publicState,
    adminState,
    evidenceState: evidence.state,
    evidenceLabel: evidence.label,
    nextStep,
    nextStepLabel: NEXT_STEP_LABELS[nextStep],
    summary: `${systemSummary} ${evidenceSummary} ${actionSummary}`,
    hasPublicAdminDivergence: publicState !== "unknown" && publicState !== adminState,
  };
}

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
      title:
        evidence.state === "unavailable" ? "Dashboard evidence is unavailable" : "Dashboard evidence is incomplete",
      detail: `${affectedLabels.join(", ") || "Required evidence"} ${affectedLabels.length === 1 ? "is" : "are"} unavailable or failed to refresh. Refresh evidence before acting.`,
      tone: "warning",
    });
  }
  if (statusError) {
    notices.push({
      id: "status-error",
      title: "Operator status endpoint failed to refresh",
      detail: statusError.message,
      tone: "critical",
    });
  }
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
  if (scheduledSlotRunningQueryFailed === true) {
    notices.push({
      id: "scheduled-slot-running-query-failed",
      title: "Scheduled-slot running query failed",
      detail: "Status could not inspect running scheduled slots; stale-slot detection may be incomplete.",
      tone: "neutral",
    });
  }
  if (scheduledSlotEventMarkerQueryFailed === true) {
    notices.push({
      id: "scheduled-slot-event-marker-query-failed",
      title: "Scheduled-slot event-marker query failed",
      detail: "Status could not inspect scheduled-slot event markers; slot-abandonment diagnostics may be incomplete.",
      tone: "neutral",
    });
  }
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

function buildSectionPriority({
  data,
  healthData,
  browserProbeSummary,
  issueGroups,
  evidence,
  commsModel,
}: {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  browserProbeSummary: BrowserProbeSummary | null;
  issueGroups: DashboardIssueGroups;
  evidence: DashboardEvidence;
  commsModel: CommsWorkbenchModel;
}): Record<DashboardSection["id"], DashboardSectionPriority> {
  const evidencePriority =
    evidence.state === "stale" || evidence.state === "unavailable" ? 2 : evidence.state === "partial" ? 1 : 0;
  const reliabilityStatus = Math.max(
    STATUS_PRIORITY[data.availabilityStatus],
    healthData ? STATUS_PRIORITY[healthData.status] : 0,
    browserProbeSummary && browserProbeSummary.failCount > 0 ? 1 : 0,
    data.summary.worstCacheRatio > 2 ? 2 : data.summary.worstCacheRatio > 1.5 ? 1 : 0,
  );
  const cronStatus =
    data.summary.availabilityImpactingConsecutiveCronErrors > 0
      ? 2
      : data.summary.availabilityImpactingCronErrors > 0 || data.summary.availabilityImpactingUnhealthyCrons > 0
        ? 1
        : data.summary.degradedCrons > 0 || data.summary.watchUnhealthyCrons > 0
          ? 1
          : 0;
  const commsStatus = commsModel.delivery.health === "failed" ? 2 : commsModel.delivery.health === "degraded" ? 1 : 0;
  const pipelineIssues = [...issueGroups.impacting, ...issueGroups.warnings, ...issueGroups.maintenance].filter(
    (issue) => issue.layer === "data-quality",
  );
  const pipelinePublicImpact = pipelineIssues.some((issue) => issue.publicImpacting) ? 1 : 0;
  const reliabilityPublicImpact =
    data.availabilityStatus !== "healthy" ||
    (healthData != null && healthData.status !== "healthy") ||
    (browserProbeSummary?.failCount ?? 0) > 0
      ? 1
      : 0;
  const commsCount = commsModel.delivery.pendingDeliveries ?? 0;

  // Overview, Credentials, and History are never causal lanes, and recommendations
  // are attached to their causal lane in Triage: the Actions catalog remains
  // directly reachable, but it is not a duplicate cause.
  return {
    pipeline: {
      active: STATUS_PRIORITY[data.dataQualityStatus] > 0 || pipelineIssues.length > 0,
      severity: STATUS_PRIORITY[data.dataQualityStatus],
      publicImpact: pipelinePublicImpact,
      evidenceRisk: 0,
      persistence: 0,
      count: pipelineIssues.length,
    },
    crons: {
      active: cronStatus > 0,
      severity: cronStatus,
      publicImpact:
        data.summary.availabilityImpactingUnhealthyCrons > 0 || data.summary.availabilityImpactingCronErrors > 0
          ? 1
          : 0,
      evidenceRisk: 0,
      persistence: data.summary.availabilityImpactingConsecutiveCronErrors,
      count:
        data.summary.availabilityImpactingUnhealthyCrons +
        data.summary.availabilityImpactingCronErrors +
        data.summary.degradedCrons +
        data.summary.watchUnhealthyCrons,
    },
    reliability: {
      active: reliabilityStatus > 0 || evidencePriority > 0,
      severity: reliabilityStatus,
      publicImpact: reliabilityPublicImpact,
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
      count: commsCount,
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

function buildAttentionSections(
  sections: readonly DashboardSection[],
  sectionPriority: Record<DashboardSection["id"], DashboardSectionPriority>,
): DashboardSection[] {
  const sectionOrder: Array<DashboardSection["id"]> = ["pipeline", "crons", "reliability", "comms"];
  return sections
    .filter((section) => sectionPriority[section.id].active)
    .sort((a, b) => {
      const priorityDelta = compareSectionPriority(sectionPriority[a.id], sectionPriority[b.id]);
      if (priorityDelta !== 0) return priorityDelta;

      return sectionOrder.indexOf(a.id) - sectionOrder.indexOf(b.id);
    });
}

function buildDashboardSections({
  data,
  pipelineTone,
  browserProbeSummary,
  cronGroups,
  runningCrons,
  commsModel,
}: {
  data: StatusResponse;
  pipelineTone: ReturnType<typeof getStatusTone>;
  browserProbeSummary: BrowserProbeSummary | null;
  cronGroups: DashboardCronGroup[];
  runningCrons: number;
  commsModel: CommsWorkbenchModel;
}): DashboardSection[] {
  return [
    {
      id: "pipeline",
      title: "Pipeline Health",
      value: pipelineTone.label,
      valueClassName: pipelineTone.valueClassName,
      summary: `${data.dataQuality.missingPrices} missing prices, ${data.dataQuality.staleOnchainSupply} stale on-chain feeds, ${data.dataQuality.blacklistMissingAmounts} blacklist gaps`,
    },
    {
      id: "reliability",
      title: "Probes, breakers, and cache pressure",
      value: browserProbeSummary ? `${browserProbeSummary.passCount}/${browserProbeSummary.sampleCount}` : "Unknown",
      valueClassName:
        browserProbeSummary && browserProbeSummary.failCount > 0
          ? "text-amber-700 dark:text-amber-400"
          : "text-foreground",
      summary: `${data.summary.availabilityImpactingCronErrors} impacting cron errors, ${browserProbeSummary ? `${browserProbeSummary.failCount} failing browser probes` : "browser probe result unknown"}, worst cache ${data.summary.worstCacheRatio.toFixed(2)}x`,
    },
    {
      id: "crons",
      title: "Cron Lanes",
      value: `${data.summary.availabilityImpactingUnhealthyCrons} impacting`,
      valueClassName:
        data.summary.availabilityImpactingUnhealthyCrons > 0
          ? "text-red-700 dark:text-red-400"
          : "text-emerald-700 dark:text-emerald-400",
      summary: `${cronGroups.length} groups, ${data.summary.watchUnhealthyCrons} watch unhealthy, ${data.summary.degradedCrons} degraded jobs, ${runningCrons} running now`,
    },
    {
      id: "comms",
      title: "Comms",
      value:
        commsModel.delivery.health === "unknown"
          ? "Unknown"
          : commsModel.delivery.health === "failed"
            ? "Failed"
            : `${commsModel.delivery.pendingDeliveries ?? 0} pending`,
      valueClassName:
        commsModel.delivery.health === "failed"
          ? "text-red-700 dark:text-red-400"
          : commsModel.delivery.health === "degraded"
            ? "text-amber-700 dark:text-amber-400"
            : commsModel.delivery.health === "healthy"
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-muted-foreground",
      summary: `${commsModel.delivery.healthReason} ${
        commsModel.audience.deliverableChats == null
          ? "Alert-ready audience Unknown."
          : `${commsModel.audience.deliverableChats} alert-ready chats.`
      }`,
    },
  ];
}

interface BuildStatusDashboardOptions {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  probes: EndpointProbeResult[] | undefined;
  probeLabel?: string;
  querySyncs: {
    statusUpdatedAt: number;
    healthUpdatedAt: number;
    probesUpdatedAt: number;
    historyUpdatedAt: number;
    requestSourceUpdatedAt: number;
  };
  nowMs: number;
  statusError?: Error | null;
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
  probeLabel = "Browser probes",
  querySyncs,
  nowMs,
  statusError = null,
  healthError,
  probesError,
  historyError,
  requestSourceError,
  historyTransitions,
}: BuildStatusDashboardOptions) {
  const syncDetails = [
    buildQuerySync({
      key: "status",
      label: "Status API",
      required: true,
      hasData: true,
      updatedAtMs: querySyncs.statusUpdatedAt,
      nowMs,
      error: statusError,
    }),
    buildQuerySync({
      key: "health",
      label: "Public health",
      required: true,
      hasData: healthData != null,
      updatedAtMs: querySyncs.healthUpdatedAt,
      nowMs,
      error: healthError,
    }),
    buildQuerySync({
      key: "probes",
      label: probeLabel,
      required: true,
      hasData: probes !== undefined,
      updatedAtMs: querySyncs.probesUpdatedAt,
      nowMs,
      error: probesError,
    }),
    buildQuerySync({
      key: "history",
      label: "Status history",
      required: false,
      hasData: historyTransitions !== undefined || querySyncs.historyUpdatedAt > 0,
      updatedAtMs: querySyncs.historyUpdatedAt,
      nowMs,
      error: historyError,
    }),
    buildQuerySync({
      key: "requestSource",
      label: "API attribution",
      required: false,
      hasData: querySyncs.requestSourceUpdatedAt > 0,
      updatedAtMs: querySyncs.requestSourceUpdatedAt,
      nowMs,
      error: requestSourceError,
    }),
  ];
  const evidence = buildDashboardEvidence(syncDetails, nowMs);
  const freshnessFloorMs = evidence.oldestRequiredSuccessAtMs;
  const browserProbeSummary = buildBrowserProbeSummary(probes, querySyncs.probesUpdatedAt);
  const cronGroups = buildDashboardCronGroups(data);
  const runningCrons = countRunningDashboardCrons(data);
  const healthDiffersFromStatus = healthData != null && healthData.status !== data.overallStatus;
  const publicHealthNeedsCallout = healthData != null && (healthData.status !== "healthy" || healthDiffersFromStatus);
  const latestTransition = (historyTransitions ?? data.timeline)[0] ?? null;
  const recommendedActions = deriveStatusActionRecommendations({ causes: data.causes, crons: data.crons });
  const issueGroups = groupDashboardIssues(normalizeStatusIssues(data.causes, buildPublicHealthStatusCauses(healthData)));
  const decision = buildDashboardDecision({ data, healthData, evidence, issueGroups, recommendedActions });
  const statusHoldingAge = Math.max(0, data.timestamp - data.state.lastChangedAt);
  const overallTone =
    decision.systemState === "unknown" ? getStatusTone(data.overallStatus) : getStatusTone(decision.systemState);
  const pipelineTone = getStatusTone(data.dataQualityStatus);
  const clientDataStale = evidence.state !== "current";
  const notices = buildDashboardNotices({
    evidence,
    statusError,
    healthError,
    probesError,
    historyError,
    requestSourceError,
    publicHealthNeedsCallout,
    healthDiffersFromStatus,
    healthData,
    status: data.overallStatus,
    timestamp: data.timestamp,
    publicationHealth: data.publicationHealth,
    scheduledSlotRunningQueryFailed: data.summary.scheduledSlotRunningQueryFailed,
    scheduledSlotEventMarkerQueryFailed: data.summary.scheduledSlotEventMarkerQueryFailed,
  });
  const commsModel = buildCommsWorkbenchModel({
    telegramBot: data.telegramBot,
    dispatchCron: data.crons["dispatch-telegram-alerts"],
    sectionError: data.sectionErrors.telegramBot,
    nowSeconds: data.timestamp,
  });
  const sectionPriority = buildSectionPriority({
    data,
    healthData,
    browserProbeSummary,
    issueGroups,
    evidence,
    commsModel,
  });
  const attentionSections = buildAttentionSections(
    buildDashboardSections({ data, pipelineTone, browserProbeSummary, cronGroups, runningCrons, commsModel }),
    sectionPriority,
  );

  return {
    attentionSections,
    browserProbeSummary,
    clientDataStale,
    decision,
    evidence,
    freshnessFloorMs,
    healthDiffersFromStatus,
    latestTransition,
    notices,
    issueGroups,
    overallTone,
    querySyncs: syncDetails,
    recommendedActions,
    statusHoldingAge,
  };
}
