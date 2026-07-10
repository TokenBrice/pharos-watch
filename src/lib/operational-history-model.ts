import type { ApiKeyAuditEntry } from "@shared/types";
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
  lifecycleIdentity: { verb: string; apiKeyId: number } | null;
}

export interface OperationalActivityView {
  entries: OperationalActivityEntry[];
  rawEntryCount: number;
  deduplicatedCount: number;
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
const LIFECYCLE_DEDUPE_WINDOW_SECONDS = 5;

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

function readRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function readApiKeyId(details: unknown, target: string | null): number | null {
  const record = readRecord(details);
  const keyRecord = readRecord(record?.key);
  for (const candidate of [record?.apiKeyId, record?.keyId, record?.api_key_id, keyRecord?.id]) {
    const parsed = readPositiveInteger(candidate);
    if (parsed != null) return parsed;
  }
  if (!target) return null;
  const match = target.match(/(?:api\s*key|key|id)[^0-9]*(\d+)/iu) ?? target.match(/^\s*(\d+)\s*$/u);
  return readPositiveInteger(match?.[1]);
}

function canonicalLifecycleVerb(actionText: string): string | null {
  const normalized = actionText.toLowerCase();
  if (/rotat/iu.test(normalized)) return "rotated";
  if (/deactivat|revok/iu.test(normalized)) return "deactivated";
  if (/updat|edit/iu.test(normalized)) return "updated";
  if (/creat|issu/iu.test(normalized)) return "created";
  return null;
}

function adminLifecycleIdentity(entry: AdminActionAuditEntry): OperationalActivityEntry["lifecycleIdentity"] {
  const details = readRecord(entry.details);
  const actionText = [
    entry.action,
    typeof details?.action === "string" ? details.action : "",
    typeof details?.actionPath === "string" ? details.actionPath : "",
    typeof details?.path === "string" ? details.path : "",
  ].join(" ");
  if (!/api[-_ /]?keys?/iu.test(actionText)) return null;
  const verb = canonicalLifecycleVerb(actionText);
  const apiKeyId = readApiKeyId(entry.details, entry.target);
  return verb && apiKeyId != null ? { verb, apiKeyId } : null;
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
    lifecycleIdentity: adminLifecycleIdentity(entry),
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
    lifecycleIdentity: {
      verb: canonicalLifecycleVerb(entry.action) ?? entry.action.trim().toLowerCase(),
      apiKeyId: entry.apiKeyId,
    },
  };
}

function isCrossSourceLifecycleDuplicate(left: OperationalActivityEntry, right: OperationalActivityEntry): boolean {
  if (!left.lifecycleIdentity || !right.lifecycleIdentity) return false;
  if (left.sources.some((source) => right.sources.includes(source))) return false;
  return (
    left.lifecycleIdentity.verb === right.lifecycleIdentity.verb &&
    left.lifecycleIdentity.apiKeyId === right.lifecycleIdentity.apiKeyId &&
    Math.abs(left.at - right.at) <= LIFECYCLE_DEDUPE_WINDOW_SECONDS
  );
}

function mergeDuplicateActivity(
  left: OperationalActivityEntry,
  right: OperationalActivityEntry,
): OperationalActivityEntry {
  const admin = left.sources.includes("admin-action") ? left : right;
  const credential = left.sources.includes("credential-audit") ? left : right;
  const detailEntries: Array<readonly [string, unknown]> = [];
  if (admin.detail != null) detailEntries.push(["adminAction", admin.detail]);
  if (credential.detail != null) detailEntries.push(["credentialAudit", credential.detail]);
  const details = Object.fromEntries(detailEntries);
  return {
    id: `combined:${admin.id}:${credential.id}`,
    sources: ["admin-action", "credential-audit"],
    at: Math.max(left.at, right.at),
    actors: [...new Set([...left.actors, ...right.actors])],
    actionCode: credential.actionCode,
    actionLabel: credential.actionLabel,
    target: credential.target !== "Unknown target" ? credential.target : admin.target,
    outcome: admin.outcome,
    httpStatus: admin.httpStatus,
    detail: Object.keys(details).length > 0 ? details : null,
    lifecycleIdentity: credential.lifecycleIdentity,
  };
}

export function buildOperationalActivityView(
  adminEntries: readonly AdminActionAuditEntry[],
  credentialEntries: readonly ApiKeyAuditEntry[],
): OperationalActivityView {
  const merged: OperationalActivityEntry[] = [];
  const candidates = [...adminEntries.map(buildAdminActivity), ...credentialEntries.map(buildCredentialActivity)].sort(
    (left, right) => right.at - left.at || left.id.localeCompare(right.id),
  );

  let deduplicatedCount = 0;
  for (const candidate of candidates) {
    const duplicateIndex = merged.findIndex((existing) => isCrossSourceLifecycleDuplicate(existing, candidate));
    if (duplicateIndex < 0) {
      merged.push(candidate);
      continue;
    }
    const existing = merged[duplicateIndex];
    if (existing) merged[duplicateIndex] = mergeDuplicateActivity(existing, candidate);
    deduplicatedCount += 1;
  }

  merged.sort((left, right) => right.at - left.at || left.id.localeCompare(right.id));
  return {
    entries: merged,
    rawEntryCount: candidates.length,
    deduplicatedCount,
  };
}
