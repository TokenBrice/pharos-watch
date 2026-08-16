import type { StatusCause, StatusResponse } from "@shared/types";
import { CRON_GROUPS } from "@shared/lib/cron-jobs";

export type DashboardSectionId =
  "overview" | "pipeline" | "crons" | "reliability" | "actions" | "credentials" | "comms" | "history";

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
