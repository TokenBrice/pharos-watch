/**
 * Compatibility surface for status-dashboard consumers.
 *
 * The implementation is split by responsibility under `lib/status/`; keeping
 * these exports here avoids coupling the 25 callers to that internal layout.
 */
export type {
  BrowserProbeSummary,
  DashboardCronGroup,
  DashboardDecision,
  DashboardEvidence,
  DashboardEvidenceState,
  DashboardIssue,
  DashboardIssueGroups,
  DashboardIssueKind,
  DashboardNotice,
  DashboardOperatorNextStep,
  DashboardQueryEvidenceState,
  DashboardQuerySync,
  DashboardSection,
  DashboardSectionId,
} from "@/lib/status/dashboard-types";
export {
  buildBrowserProbeSummary,
  buildDashboardCronGroups,
  countRunningDashboardCrons,
  getProbeDisplayStatus,
  getProbeStatusDetail,
  getProbeStatusLabel,
  isProbePassing,
} from "@/lib/status/probe-model";
export {
  STATUS_OK_PILL_CLASS,
  formatTimestampMs,
  formatTimestampSeconds,
  formatTransitionLabel,
  getIssueKindBadgeClass,
  getNoticeTone,
  getSeverityBadgeClass,
  getStatusTone,
} from "@/lib/status/dashboard-presentation";
export {
  STATUS_DASHBOARD_FRESHNESS_POLICY,
  buildDashboardDecision,
  buildDashboardEvidence,
  buildPublicHealthStatusCauses,
  groupDashboardIssues,
  normalizeStatusIssues,
} from "@/lib/status/issue-evidence-model";
export { buildStatusDashboardData } from "@/lib/status/dashboard-composition";
