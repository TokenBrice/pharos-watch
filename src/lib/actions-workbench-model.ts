import { z } from "zod";
import { readRecord } from "@shared/lib/type-guards";
import type { StatusPageAction, StatusPageActionRisk } from "@shared/lib/api-endpoints";
import type { ActionReadinessCheck } from "@/lib/status/admin-ops-insights";

const AdminActionAuditEntrySchema = z.object({
  id: z.number().int(),
  at: z.number(),
  actor: z.string(),
  action: z.string(),
  target: z.string().nullable(),
  result: z.enum(["ok", "error"]),
  httpStatus: z.number().int().nullable(),
  details: z.unknown().nullable(),
});

export const AdminActionAuditLogResponseSchema = z.object({
  entries: z.array(AdminActionAuditEntrySchema),
});

export type AdminActionAuditEntry = z.infer<typeof AdminActionAuditEntrySchema>;
export type AdminActionAuditLogResponse = z.infer<typeof AdminActionAuditLogResponseSchema>;

export type ActionIntentCategory = "inspect" | "dry-run" | "recovery" | "communications" | "destructive";

export const ACTION_INTENT_ORDER: readonly ActionIntentCategory[] = [
  "inspect",
  "dry-run",
  "recovery",
  "communications",
  "destructive",
];

export const ACTION_INTENT_COPY: Record<ActionIntentCategory, { label: string; description: string }> = {
  inspect: {
    label: "Inspect",
    description: "Read evidence and validate assumptions without changing persisted state.",
  },
  "dry-run": {
    label: "Dry run",
    description: "Preview a bounded repair plan before deciding whether to write.",
  },
  recovery: {
    label: "Recovery",
    description: "Backfill or repair a known data lane with an explicit scope.",
  },
  communications: {
    label: "Communications",
    description: "Send or coordinate operator-facing and user-facing messages.",
  },
  destructive: {
    label: "Destructive intent",
    description: "Reset or remove state. Confirm evidence, scope, and recovery options first.",
  },
};

export interface ActionCatalogFilters {
  query: string;
  intent: ActionIntentCategory | "all";
  risk: StatusPageActionRisk | "all";
}

export interface SessionActionExecutionLike {
  action: Pick<StatusPageAction, "path" | "label">;
  intentId: string;
  scopeLabel: string;
  status: "ready" | "running" | "accepted" | "queued" | "succeeded" | "failed" | "unknown";
  ok: boolean;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  httpStatus: number | null;
}

export interface ActionActivity {
  id: string;
  actionPath: string | null;
  actionLabel: string;
  at: number;
  actor: string | null;
  target: string | null;
  status: SessionActionExecutionLike["status"] | "error";
  httpStatus: number | null;
  source: "session" | "persisted";
}

export interface ActionReadinessItem extends ActionReadinessCheck {
  blocking: boolean;
}

export interface ActionReadiness {
  blocked: boolean;
  reasons: string[];
  checks: ActionReadinessItem[];
  overrideAvailable: false;
}

export interface StructuredActionOutcome {
  headline: string;
  fields: Array<{ label: string; value: string }>;
  followUp: string | null;
}

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/u, "")
    .split("?", 1)[0]
    .replace(/^\/api\//u, "")
    .replace(/^\/+|\/+$/gu, "")
    .replace(/[_\s/]+/gu, "-");
}

function getActionSearchText(action: StatusPageAction): string {
  const scopeText =
    action.scope.type === "asset-or-batch"
      ? [action.scope.assetLabel, action.scope.assetPlaceholder, action.scope.batchLabel, action.scope.queryParam]
      : [action.scope.label];
  return [
    action.label,
    action.path,
    action.kind,
    action.risk,
    getActionIntentCategory(action),
    action.expectedDuration,
    ...scopeText,
    ...action.preconditions,
    ...action.blockedBy,
  ]
    .join(" ")
    .toLowerCase();
}

export function getActionIntentCategory(action: StatusPageAction): ActionIntentCategory {
  if (action.destructive || action.kind === "reset") return "destructive";
  if (action.kind === "communication") return "communications";
  if (action.kind === "inspect" || action.risk === "read-only") return "inspect";
  if (action.dryRun.supported) return "dry-run";
  return "recovery";
}

export function filterActionCatalog(
  actions: readonly StatusPageAction[],
  filters: ActionCatalogFilters,
): StatusPageAction[] {
  const tokens = filters.query.trim().toLowerCase().split(/\s+/u).filter(Boolean);

  return actions.filter((action) => {
    if (filters.intent !== "all" && getActionIntentCategory(action) !== filters.intent) return false;
    if (filters.risk !== "all" && action.risk !== filters.risk) return false;
    if (tokens.length === 0) return true;
    const searchText = getActionSearchText(action);
    return tokens.every((token) => searchText.includes(token));
  });
}

function readAuditPathCandidates(entry: AdminActionAuditEntry): string[] {
  const details = readRecord(entry.details);
  return [
    entry.action,
    typeof details?.action === "string" ? details.action : "",
    typeof details?.actionPath === "string" ? details.actionPath : "",
    typeof details?.path === "string" ? details.path : "",
  ].filter(Boolean);
}

export function auditEntryMatchesAction(entry: AdminActionAuditEntry, action: Pick<StatusPageAction, "path">): boolean {
  const actionKey = normalize(action.path);
  return readAuditPathCandidates(entry).some((candidate) => normalize(candidate) === actionKey);
}

function persistedStatus(entry: AdminActionAuditEntry): ActionActivity["status"] {
  const details = readRecord(entry.details);
  const statusCandidates = [details?.status, details?.outcome, details?.executionCertainty];
  const statuses = statusCandidates
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  if (statuses.includes("unknown")) return "unknown";
  if (statuses.includes("failed") || statuses.includes("error")) return "error";
  const status = statuses[0] ?? "";
  if (status === "accepted" || status === "queued" || status === "running" || status === "succeeded") {
    return status;
  }
  if (entry.result === "error") return "error";
  return "succeeded";
}

function findCatalogAction(
  entry: AdminActionAuditEntry,
  actions: readonly StatusPageAction[],
): StatusPageAction | null {
  return actions.find((action) => auditEntryMatchesAction(entry, action)) ?? null;
}

function activityFingerprint(activity: ActionActivity): string {
  return [
    normalize(activity.actionPath ?? activity.actionLabel),
    normalize(activity.target ?? ""),
    Math.round(activity.at / 5_000),
  ].join("|");
}

export function reconcileActionActivity(
  actions: readonly StatusPageAction[],
  sessionExecutions: readonly SessionActionExecutionLike[],
  persistedEntries: readonly AdminActionAuditEntry[],
): ActionActivity[] {
  const session: ActionActivity[] = sessionExecutions
    .filter((execution) => execution.status !== "ready")
    .map((execution) => ({
      id: `session:${execution.intentId}`,
      actionPath: execution.action.path,
      actionLabel: execution.action.label,
      at: execution.completedAt ?? execution.startedAt ?? execution.createdAt,
      actor: null,
      target: execution.scopeLabel,
      status: execution.status,
      httpStatus: execution.httpStatus,
      source: "session",
    }));
  const persisted: ActionActivity[] = persistedEntries.map((entry) => {
    const action = findCatalogAction(entry, actions);
    return {
      id: `persisted:${entry.id}`,
      actionPath: action?.path ?? null,
      actionLabel: action?.label ?? entry.action,
      at: entry.at * 1_000,
      actor: entry.actor,
      target: entry.target,
      status: persistedStatus(entry),
      httpStatus: entry.httpStatus,
      source: "persisted",
    };
  });

  const unmatchedSessionByFingerprint = new Map<string, number>();
  for (const activity of session) {
    const fingerprint = activityFingerprint(activity);
    unmatchedSessionByFingerprint.set(fingerprint, (unmatchedSessionByFingerprint.get(fingerprint) ?? 0) + 1);
  }
  const unmatchedPersisted = persisted.filter((activity) => {
    const fingerprint = activityFingerprint(activity);
    const matchingSessions = unmatchedSessionByFingerprint.get(fingerprint) ?? 0;
    if (matchingSessions === 0) return true;
    unmatchedSessionByFingerprint.set(fingerprint, matchingSessions - 1);
    return false;
  });

  return [...session, ...unmatchedPersisted].sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at;
    if (a.source !== b.source) return a.source === "session" ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

export function getLastActionActivity(
  action: StatusPageAction,
  activities: readonly ActionActivity[],
): ActionActivity | null {
  return activities.find((activity) => activity.actionPath === action.path) ?? null;
}

function isReserveAction(action: StatusPageAction): boolean {
  return `${action.label} ${action.path}`.toLowerCase().includes("reserve");
}

export function buildActionReadiness(
  action: StatusPageAction,
  checks: readonly ActionReadinessCheck[],
  mode: "dry-run" | "live" = action.dryRun.supported && action.dryRun.default ? "dry-run" : "live",
): ActionReadiness {
  const isWrite = mode === "live" && action.risk !== "read-only";
  const relevantChecks = checks.filter((check) => {
    if (check.id === "d1-writes") return isWrite;
    if (check.id === "reserve-lane" || check.id === "reserve-cursor") return isReserveAction(action);
    return check.id === "fresh-status-view" || check.id === "public-health" || check.id === "manual-actions";
  });
  const readinessChecks = relevantChecks.map<ActionReadinessItem>((check) => {
    const blocking =
      isWrite && (check.state === "blocked" || (check.id === "fresh-status-view" && check.state !== "ready"));
    return { ...check, blocking };
  });
  const reasons = readinessChecks.filter((check) => check.blocking).map((check) => `${check.label}: ${check.detail}`);

  return {
    blocked: reasons.length > 0,
    reasons,
    checks: readinessChecks,
    overrideAvailable: false,
  };
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

export function extractStructuredActionOutcome(
  data: unknown,
  fallbackStatus: SessionActionExecutionLike["status"],
): StructuredActionOutcome {
  const record = readRecord(data);
  if (!record) {
    return { headline: fallbackStatus === "failed" ? "Action failed" : "Action completed", fields: [], followUp: null };
  }

  const status = readString(record, ["executionStatus", "status", "state"]);
  const fields = [
    { label: "Status", value: status },
    { label: "Job", value: readString(record, ["jobId", "jobID", "job_id", "runId", "run_id"]) },
    { label: "Queue", value: readString(record, ["queueId", "queue_id", "queue", "position"]) },
    { label: "Request", value: readString(record, ["requestId", "request_id", "invocationId", "invocation_id"]) },
    { label: "Continuation", value: readString(record, ["continuation", "nextCursor", "next_cursor", "cursor"]) },
  ].filter((field): field is { label: string; value: string } => field.value != null);
  const followUp = readString(record, ["followUpUrl", "followupUrl", "followUp", "followup", "url"]);

  return {
    headline:
      fallbackStatus === "failed" || fallbackStatus === "unknown"
        ? fallbackStatus === "unknown"
          ? "Outcome needs reconciliation"
          : "Action failed"
        : status
          ? `Action ${status}`
          : "Action completed",
    fields,
    followUp,
  };
}

export function getSafeActionFollowUpHref(value: string): string | null {
  if (value === "/" || /^\/[^/\\]/u.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}
