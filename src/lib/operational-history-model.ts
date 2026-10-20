import type { ApiKeyAuditEntry } from "@pharos/contracts/api-keys";
import { readRecord } from "@shared/lib/type-guards";
import type { AdminActionAuditEntry } from "@/lib/actions-workbench-model";

export type OperationalActivitySource = "admin-action" | "credential-audit";

export interface OperationalActivityEntry {
  id: string;
  sources: OperationalActivitySource[];
  at: number;
  actors: string[];
  actionCode: string;
  actionLabel: string;
  target: string;
  outcome: "ok" | "error" | "unknown" | "recorded";
  httpStatus: number | null;
  detail: unknown;
}

export interface OperationalActivityView {
  entries: OperationalActivityEntry[];
  rawEntryCount: number;
}

const SENSITIVE_DETAIL_KEYS = new Set([
  "accesstoken",
  "apikey",
  "apikeyhash",
  "authorization",
  "cookie",
  "credential",
  "idempotencykey",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "signature",
  "token",
]);
const MAX_DETAIL_DEPTH = 5;
const MAX_DETAIL_ARRAY_ITEMS = 20;
const MAX_DETAIL_OBJECT_KEYS = 30;
const MAX_DETAIL_STRING_LENGTH = 500;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isSensitiveDetailKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (normalized === "apikeyid" || normalized === "keyid") return false;
  return (
    SENSITIVE_DETAIL_KEYS.has(normalized) ||
    ["authorization", "credential", "password", "privatekey", "secret", "signature", "token"].some((fragment) =>
      normalized.includes(fragment),
    )
  );
}

function looksSensitiveString(value: string): boolean {
  return (
    /(?:bearer\s+\S+|ph_(?:live|test)_|sk-[a-z0-9_-]{8,})/iu.test(value) ||
    /(?:token|api[\s_-]?key|secret|authorization)\s*[:=]/iu.test(value) ||
    /[a-z0-9_-]{20,}\.[a-z0-9_-]{20,}\.[a-z0-9_-]{10,}/iu.test(value)
  );
}

export function sanitizeOperationalDetail(value: unknown, depth = 0, parentKey = ""): unknown {
  if (isSensitiveDetailKey(parentKey)) return "[redacted]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (looksSensitiveString(value)) return "[redacted]";
    return value.length > MAX_DETAIL_STRING_LENGTH ? `${value.slice(0, MAX_DETAIL_STRING_LENGTH)}...` : value;
  }
  if (depth >= MAX_DETAIL_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_DETAIL_ARRAY_ITEMS)
      .map((item) => sanitizeOperationalDetail(item, depth + 1, parentKey));
    if (value.length > MAX_DETAIL_ARRAY_ITEMS) items.push(`[${value.length - MAX_DETAIL_ARRAY_ITEMS} more items]`);
    return items;
  }
  if (typeof value !== "object") return String(value);

  const entries = Object.entries(value as Record<string, unknown>)
    .slice(0, MAX_DETAIL_OBJECT_KEYS)
    .map(([key, item]) => [key, sanitizeOperationalDetail(item, depth + 1, key)] as const);
  if (Object.keys(value as Record<string, unknown>).length > MAX_DETAIL_OBJECT_KEYS) {
    entries.push(["_truncated", "Additional fields omitted"]);
  }
  return Object.fromEntries(entries);
}

function humanizeAction(action: string): string {
  const words = action
    .trim()
    .replace(/^api[-_ /]?key[-_ /]?/iu, "")
    .replace(/[_/-]+/gu, " ")
    .replace(/\s+/gu, " ");
  if (!words) return "Unknown action";
  return `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}

function readKeyName(detail: unknown): string | null {
  const record = readRecord(detail);
  const keyRecord = readRecord(record?.key);
  for (const candidate of [record?.keyName, record?.name, keyRecord?.name]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function adminActionOutcome(entry: AdminActionAuditEntry): OperationalActivityEntry["outcome"] {
  const details = readRecord(entry.details);
  const statusCandidates = [details?.status, details?.outcome, details?.executionCertainty];
  const statuses = statusCandidates
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  if (statuses.includes("unknown")) return "unknown";
  if (statuses.includes("failed") || statuses.includes("error")) return "error";
  return entry.result;
}

function buildAdminActivity(entry: AdminActionAuditEntry): OperationalActivityEntry {
  return {
    id: `admin-action:${entry.id}`,
    sources: ["admin-action"],
    at: entry.at,
    actors: entry.actor.trim() ? [entry.actor] : [],
    actionCode: entry.action,
    actionLabel: humanizeAction(entry.action),
    target: entry.target?.trim() || "Unknown target",
    outcome: adminActionOutcome(entry),
    httpStatus: entry.httpStatus,
    detail: sanitizeOperationalDetail(entry.details),
  };
}

function buildCredentialActivity(entry: ApiKeyAuditEntry): OperationalActivityEntry {
  const keyName = readKeyName(entry.detail);
  return {
    id: `credential-audit:${entry.id}`,
    sources: ["credential-audit"],
    at: entry.createdAt,
    actors: entry.actor.trim() ? [entry.actor] : [],
    actionCode: entry.action,
    actionLabel: humanizeAction(entry.action),
    target: keyName ? `${keyName} (API key ${entry.apiKeyId})` : `API key ${entry.apiKeyId}`,
    outcome: "recorded",
    httpStatus: null,
    detail: sanitizeOperationalDetail(entry.detail),
  };
}

export function buildOperationalActivityView(
  adminEntries: readonly AdminActionAuditEntry[],
  credentialEntries: readonly ApiKeyAuditEntry[],
): OperationalActivityView {
  // The stores expose no shared durable mutation identity. A matching key,
  // action, actor or timestamp cannot prove that two rows describe one request.
  const entries = [...adminEntries.map(buildAdminActivity), ...credentialEntries.map(buildCredentialActivity)].sort(
    (left, right) => right.at - left.at || left.id.localeCompare(right.id),
  );
  return {
    entries,
    rawEntryCount: entries.length,
  };
}

export interface OperationalActivityGroup {
  /** The newest entry of the run. */
  entry: OperationalActivityEntry;
  count: number;
  firstAt: number;
  lastAt: number;
}

function activityRunKey(entry: OperationalActivityEntry): string {
  return JSON.stringify([entry.sources, entry.actionCode, entry.target, entry.outcome, entry.httpStatus, entry.actors]);
}

/** Collapses identical consecutive rows (same action, target, outcome, actor) into one ×N row (A5). */
export function groupConsecutiveActivity(entries: readonly OperationalActivityEntry[]): OperationalActivityGroup[] {
  const groups: OperationalActivityGroup[] = [];
  let previousKey: string | null = null;
  for (const entry of entries) {
    const key = activityRunKey(entry);
    const last = groups[groups.length - 1];
    if (last && key === previousKey) {
      last.count += 1;
      last.firstAt = Math.min(last.firstAt, entry.at);
      last.lastAt = Math.max(last.lastAt, entry.at);
    } else {
      groups.push({ entry, count: 1, firstAt: entry.at, lastAt: entry.at });
    }
    previousKey = key;
  }
  return groups;
}
