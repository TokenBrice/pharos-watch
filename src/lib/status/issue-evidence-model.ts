import type { HealthResponse, StatusCause, StatusResponse } from "@shared/types";
import { getPollingWindow } from "@/lib/api-query-polling";
import { CRON_1MIN } from "@/lib/cron-intervals";
import { deriveStatusActionRecommendations } from "@/lib/status/action-recommendations";
import { STATUS_CAUSE_SEVERITY_RANK } from "@/lib/status/cause-severity";
import { getActivePriceCoverageImpactDetail, getPublicHealthWarningPresentation } from "@/lib/status/public-status";
import { transitionHasPublicImpact } from "@shared/lib/status-public-impact";
import { STATUS_PRIORITY, STATUS_TONE } from "@/lib/status/dashboard-presentation";
import type {
  DashboardDecision,
  DashboardEvidence,
  DashboardEvidenceState,
  DashboardIssue,
  DashboardIssueGroups,
  DashboardIssueKind,
  DashboardOperatorNextStep,
  DashboardQueryEvidenceState,
  DashboardQuerySync,
} from "@/lib/status/dashboard-types";

const DASHBOARD_POLLING_WINDOW = getPollingWindow(CRON_1MIN);

export const STATUS_DASHBOARD_FRESHNESS_POLICY = Object.freeze({
  producerIntervalMs: CRON_1MIN,
  refetchIntervalMs: DASHBOARD_POLLING_WINDOW.refetchInterval,
  jitterToleranceMs: CRON_1MIN,
  staleAfterMs: DASHBOARD_POLLING_WINDOW.refetchInterval + CRON_1MIN,
});

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

export function buildQuerySync({
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
      : getPublicHealthWarningPresentation(warning, healthData).detail;
  return [{
    code: ACTIVE_PRICE_COVERAGE_CAUSE_CODE,
    layer: "data-quality",
    severity: "warning",
    message,
    metric: "missingActivePrices",
    value: coverage?.missingPriceCount,
    threshold: 1,
  }];
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
      existing != null && cause.code === ACTIVE_PRICE_COVERAGE_CAUSE_CODE && additionalCauses.includes(cause) &&
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
  return [...deduped.entries()].map(([id, cause]) => {
    const publicImpacting = transitionHasPublicImpact([cause]);
    const kind = getIssueKind(cause, publicImpacting);
    return { ...cause, id, kind, publicImpacting, affectedSurface: getAffectedSurface(cause, publicImpacting), impactLabel: getIssueImpactLabel(kind) };
  }).sort((a, b) => {
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
  const oldestRequiredSuccessAtMs = allRequiredHaveTimestamps ? Math.min(...required.map((sync) => sync.updatedAtMs)) : null;
  const oldestRequiredAgeSec = oldestRequiredSuccessAtMs == null ? null : Math.max(0, Math.floor((nowMs - oldestRequiredSuccessAtMs) / 1000));
  const state: DashboardEvidenceState =
    statusSync?.state === "unavailable" ? "unavailable" : staleLabels.length > 0 ? "stale" :
      required.some((sync) => sync.state !== "current") ? "partial" : "current";
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

type StatusActionRecommendation = ReturnType<typeof deriveStatusActionRecommendations>[number];
const NEXT_STEP_LABELS: Record<DashboardOperatorNextStep, string> = {
  "no-action": "No action",
  "observe-next-run": "Observe next scheduled run",
  investigate: "Investigate",
  "manual-action": "Manual action recommended",
  "refresh-evidence": "Refresh evidence before acting",
  "action-blocked": "Action blocked",
};

function getDecisionSystemState(adminState: StatusResponse["overallStatus"], publicState: StatusResponse["overallStatus"] | "unknown"): DashboardDecision["systemState"] {
  if (publicState === "unknown") return adminState;
  return STATUS_PRIORITY[publicState] > STATUS_PRIORITY[adminState] ? publicState : adminState;
}

function getSystemSummary(adminState: StatusResponse["overallStatus"], publicState: StatusResponse["overallStatus"] | "unknown"): string {
  if (publicState === "unknown") return `Public service state unknown. Admin state ${adminState}.`;
  if (publicState === adminState) return `Public service ${publicState}.`;
  return `Public service ${publicState}. Admin state ${adminState}.`;
}

export function buildDashboardDecision({ data, healthData, evidence, issueGroups, recommendedActions }: {
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
  if (evidence.state === "unavailable") nextStep = "action-blocked";
  else if (evidence.state === "stale" || evidence.state === "partial") nextStep = "refresh-evidence";
  else if (issueGroups.impacting.length > 0 && recommendedActions.length > 0) nextStep = "manual-action";
  else if (issueGroups.impacting.length > 0 || systemState !== "healthy") nextStep = "investigate";
  else if (issueGroups.warnings.length > 0 || recoveryHold) nextStep = "observe-next-run";
  else nextStep = "no-action";
  const systemSummary = getSystemSummary(adminState, publicState);
  const evidenceSummary = `Evidence ${evidence.state === "current" ? "current" : evidence.state}.`;
  let actionSummary = `${NEXT_STEP_LABELS[nextStep]}.`;
  if (nextStep === "refresh-evidence" && evidence.state === "partial") actionSummary = "Refresh missing evidence before deciding.";
  else if (nextStep === "no-action" && issueGroups.maintenance.length > 0) {
    const count = issueGroups.maintenance.length;
    actionSummary = `No immediate action; ${count === 1 ? "one maintenance item is" : `${count} maintenance items are`} queued.`;
  } else if (nextStep === "no-action" && issueGroups.watches.length > 0) {
    actionSummary = `No immediate action; ${issueGroups.watches.length} informational watch${issueGroups.watches.length === 1 ? " remains" : "es remain"}.`;
  } else if (nextStep === "no-action") actionSummary = "No immediate action.";
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
