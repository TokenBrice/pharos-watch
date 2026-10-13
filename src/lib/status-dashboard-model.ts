/**
 * Compatibility surface for status-dashboard consumers.
 *
 * The implementation is split by responsibility under `lib/status/`; keeping
 * these exports here avoids coupling the 25 callers to that internal layout.
 */
export type { BrowserProbeSummary, DashboardEvidence, DashboardIssueGroups, DashboardNotice, DashboardQuerySync, DashboardSection, DashboardSectionId } from "@/lib/status/dashboard-types";
export {
  buildBrowserProbeSummary,
  buildDashboardCronGroups,
  getProbeDisplayStatus,
  getProbeStatusDetail,
  getProbeStatusLabel,
  isProbePassing,
} from "@/lib/status/probe-model";
export {
  STATUS_OK_PILL_CLASS,
  formatTimestampSeconds,
  formatTransitionLabel,
  getNoticeTone,
  getSeverityBadgeClass,
  getStatusTone,
} from "@/lib/status/dashboard-presentation";
export {
  STATUS_DASHBOARD_FRESHNESS_POLICY,
  buildDashboardEvidence,
  buildPublicHealthStatusCauses,
  normalizeStatusIssues,
} from "@/lib/status/issue-evidence-model";
export { buildStatusDashboardData } from "@/lib/status/dashboard-composition";
