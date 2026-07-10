/** Privacy-bounded structured logging for the Telegram subsystem. */
export type TelegramLogLevel = "info" | "warn" | "error";

export type TelegramLogErrorClass =
  | "abort"
  | "auth_error"
  | "bad_request"
  | "blocked"
  | "d1"
  | "execution_unknown"
  | "network"
  | "rate_limit"
  | "server_error"
  | "timeout"
  | "unknown";

export interface TelegramLogEvent {
  level?: TelegramLogLevel;
  message: string;
  action?: string | null;
  module?: string | null;
  signal?: string | null;
  errorClass?: TelegramLogErrorClass | null;
  statusCode?: number | null;
  retryAfterSec?: number | null;
  failureKind?: string | null;
  alertType?: string | null;
  reason?: string | null;
  reasonClass?: string | null;
  priorFailureReasonClass?: string | null;
  sourceType?: string | null;
  priority?: number | null;
  attempts?: number | null;
  ageSec?: number | null;
  timezone?: string | null;
  hasCurrentSecret?: boolean;
  hasPreviousSecret?: boolean;
  invalidSecretWindowCount?: number;
  invalidSecretSpike?: boolean;
  missingSecretWindowCount?: number;
  missingSecretSpike?: boolean;
  presentedLength?: number;
  attemptedCount?: number;
  sentCount?: number;
  queuedCount?: number;
  permanentFailureCount?: number;
  pendingAttemptedCount?: number;
  pendingSentCount?: number;
  pendingEnqueuedCount?: number;
  requestedStablecoinCount?: number;
  presetCount?: number;
  subscriberRowCount?: number;
  chunkSize?: number;
  updateCount?: number;
  rowCount?: number;
  affectedChatCount?: number;
  dedupeKeyCount?: number;
  affectedChats?: number;
  quietHoursTzFallback?: boolean;
  dedupeKeyPresent?: boolean;
  cappedAtLimit?: number | boolean;
}

const SECRET_AUTH_SPIKE_WINDOW_MS = 60_000;
const SECRET_AUTH_SPIKE_THRESHOLD = 5;
const MAX_MESSAGE_LENGTH = 240;
const MAX_METADATA_STRING_LENGTH = 96;

const ALLOWED_METADATA_KEYS = [
  "signal",
  "errorClass",
  "statusCode",
  "retryAfterSec",
  "failureKind",
  "alertType",
  "reason",
  "reasonClass",
  "priorFailureReasonClass",
  "sourceType",
  "priority",
  "attempts",
  "ageSec",
  "timezone",
  "hasCurrentSecret",
  "hasPreviousSecret",
  "invalidSecretWindowCount",
  "invalidSecretSpike",
  "missingSecretWindowCount",
  "missingSecretSpike",
  "presentedLength",
  "attemptedCount",
  "sentCount",
  "queuedCount",
  "permanentFailureCount",
  "pendingAttemptedCount",
  "pendingSentCount",
  "pendingEnqueuedCount",
  "requestedStablecoinCount",
  "presetCount",
  "subscriberRowCount",
  "chunkSize",
  "updateCount",
  "rowCount",
  "affectedChatCount",
  "dedupeKeyCount",
  "affectedChats",
  "quietHoursTzFallback",
  "dedupeKeyPresent",
  "cappedAtLimit",
] as const satisfies readonly (keyof TelegramLogEvent)[];

const ERROR_CLASS_VALUES = new Set<TelegramLogErrorClass>([
  "abort",
  "auth_error",
  "bad_request",
  "blocked",
  "d1",
  "execution_unknown",
  "network",
  "rate_limit",
  "server_error",
  "timeout",
  "unknown",
]);

// Intentional per-isolate counters throttle invalid-secret noise.
let invalidSecretWindowStartedAt = 0;
let invalidSecretWindowCount = 0;
let missingSecretWindowStartedAt = 0;
let missingSecretWindowCount = 0;

interface TelegramLogRecord {
  ts: string;
  scope: "telegram";
  level: TelegramLogLevel;
  message: string;
  action?: string;
  module?: string;
  [key: string]: string | number | boolean | null | undefined;
}

function sanitizeString(value: string, maxLength: number): string {
  return value
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,64}\b/g, "[redacted-secret]")
    .replace(/\bBearer [A-Za-z0-9._~-]{16,128}\b/gi, "[redacted-secret]")
    .replace(/\b(?:init_?data|bot_?token|token|secret|signature|hash)\s*[=:]\s*[^\s,;]+/gi, "[redacted-secret]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "[redacted-id]")
    .replace(/\b[0-9a-f]{16,128}\b/gi, "[redacted-id]")
    .replace(/\b(?=[A-Za-z0-9_-]{24,128}\b)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g, "[redacted-id]")
    .replace(/(^|\D)-?\d{5,20}(?=\D|$)/g, "$1[redacted-id]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = sanitizeString(value, MAX_METADATA_STRING_LENGTH);
  return /^[A-Za-z0-9][A-Za-z0-9:_./-]*$/.test(sanitized) ? sanitized : undefined;
}

function sanitizeMetadataValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const sanitized = sanitizeString(value, MAX_METADATA_STRING_LENGTH);
    return sanitized.length > 0 ? sanitized : undefined;
  }
  return undefined;
}

export function normalizeTelegramLogErrorClass(value: unknown): TelegramLogErrorClass {
  return typeof value === "string" && ERROR_CLASS_VALUES.has(value as TelegramLogErrorClass)
    ? value as TelegramLogErrorClass
    : "unknown";
}

export function classifyTelegramLogError(error: unknown): TelegramLogErrorClass {
  if (error && typeof error === "object" && "name" in error) {
    const name = String((error as { name?: unknown }).name).toLowerCase();
    if (name === "aborterror") return "abort";
    if (name === "timeouterror") return "timeout";
  }
  if (error instanceof TypeError) return "network";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/\b(?:d1|database|sqlite|sql)\b/.test(message)) return "d1";
  if (/\btimeout|timed out\b/.test(message)) return "timeout";
  return "unknown";
}

export function logTelegramEvent(event: TelegramLogEvent): void {
  const input = event as unknown as Record<string, unknown>;
  const resolvedLevel: TelegramLogLevel =
    input.level === "info" || input.level === "warn" ? input.level : "error";
  const sanitizedMessage = sanitizeString(
    typeof input.message === "string" ? input.message : "telegram event",
    MAX_MESSAGE_LENGTH,
  );
  const record: TelegramLogRecord = {
    ts: new Date().toISOString(),
    scope: "telegram",
    level: resolvedLevel,
    message: sanitizedMessage || "telegram event",
  };

  const action = sanitizeLabel(input.action);
  if (action) record.action = action;
  const moduleName = sanitizeLabel(input.module);
  if (moduleName) record.module = moduleName;

  for (const key of ALLOWED_METADATA_KEYS) {
    const value = key === "errorClass"
      ? input[key] == null ? input[key] : normalizeTelegramLogErrorClass(input[key])
      : sanitizeMetadataValue(input[key]);
    if (value !== undefined) record[key] = value;
  }

  const line = JSON.stringify(record);
  if (resolvedLevel === "warn") console.warn(line);
  else if (resolvedLevel === "info") console.info(line);
  else console.error(line);
}

function shouldEmitSecretAuthAttempt(windowCount: number): boolean {
  return windowCount <= SECRET_AUTH_SPIKE_THRESHOLD;
}

export function logTelegramInvalidSecretAttempt(context: {
  hasCurrentSecret: boolean;
  hasPreviousSecret: boolean;
  presentedLength: number;
}): void {
  const nowMs = Date.now();
  if (invalidSecretWindowStartedAt === 0 || nowMs - invalidSecretWindowStartedAt > SECRET_AUTH_SPIKE_WINDOW_MS) {
    invalidSecretWindowStartedAt = nowMs;
    invalidSecretWindowCount = 0;
  }
  invalidSecretWindowCount += 1;
  if (!shouldEmitSecretAuthAttempt(invalidSecretWindowCount)) return;

  logTelegramEvent({
    level: "warn",
    message: "invalid webhook secret",
    action: "auth-invalid-secret",
    signal: "invalid_secret",
    invalidSecretWindowCount,
    invalidSecretSpike: invalidSecretWindowCount >= SECRET_AUTH_SPIKE_THRESHOLD,
    ...context,
  });
}

export function logTelegramMissingSecretAttempt(context: {
  hasCurrentSecret: boolean;
  hasPreviousSecret: boolean;
}): void {
  const nowMs = Date.now();
  if (missingSecretWindowStartedAt === 0 || nowMs - missingSecretWindowStartedAt > SECRET_AUTH_SPIKE_WINDOW_MS) {
    missingSecretWindowStartedAt = nowMs;
    missingSecretWindowCount = 0;
  }
  missingSecretWindowCount += 1;
  if (!shouldEmitSecretAuthAttempt(missingSecretWindowCount)) return;

  logTelegramEvent({
    level: "warn",
    message: "missing webhook secret",
    action: "auth-missing-secret",
    signal: "missing_secret",
    missingSecretWindowCount,
    missingSecretSpike: missingSecretWindowCount >= SECRET_AUTH_SPIKE_THRESHOLD,
    ...context,
  });
}

/** @internal Exported for tests only. */
export function resetTelegramInvalidSecretLogStateForTests(): void {
  invalidSecretWindowStartedAt = 0;
  invalidSecretWindowCount = 0;
  missingSecretWindowStartedAt = 0;
  missingSecretWindowCount = 0;
}
