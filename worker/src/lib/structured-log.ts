import { stripSensitive } from "./safe-error-message";
import { sanitizeBoundedMetadata } from "./sensitive-metadata";

export type WorkerLogLevel = "debug" | "info" | "warn" | "error";
export type WorkerLogScope = "http" | "api" | "status" | "admin" | "lib" | "handler";

export interface WorkerStructuredLogEvent {
  scope: WorkerLogScope;
  message: string;
  level?: WorkerLogLevel;
  event?: string | null;
  route?: string | null;
  job?: string | null;
  provider?: string | null;
  source?: string | null;
  runId?: string | number | null;
  status?: string | number | null;
  requestLane?: string | null;
  error?: unknown;
  metadata?: Record<string, unknown>;
}

interface ErrorLogFields {
  errorName: string;
  errorMessage: string;
  errorStack?: string;
}

type WorkerStructuredLogRecord = {
  ts: string;
  scope: WorkerLogScope;
  level: WorkerLogLevel;
  message: string;
  event?: string;
  route?: string;
  job?: string;
  provider?: string;
  source?: string;
  runId?: string;
  status?: string | number;
  requestLane?: string;
  errorName?: string;
  errorMessage?: string;
  errorStack?: string;
  metadata?: Record<string, unknown>;
};

const MAX_STRING_CHARS = 500;
const MAX_STACK_CHARS = 1_000;
const MAX_METADATA_KEYS = 30;
const MAX_ARRAY_ITEMS = 20;
const MAX_METADATA_DEPTH = 3;

function normalizeOptionalString(value: string | number | null | undefined, maxLength = 160): string | undefined {
  if (value == null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  const sanitized = stripSensitive(text);
  return sanitized.length <= maxLength ? sanitized : `${sanitized.slice(0, maxLength)}...`;
}

function classifyError(error: unknown): ErrorLogFields | null {
  if (error == null) return null;
  if (error instanceof Error) {
    return {
      errorName: error.name || "Error",
      errorMessage: stripSensitive(error.message || String(error)).slice(0, MAX_STRING_CHARS),
      ...(error.stack ? { errorStack: stripSensitive(error.stack).slice(0, MAX_STACK_CHARS) } : {}),
    };
  }
  return {
    errorName: "NonError",
    errorMessage: stripSensitive(String(error)).slice(0, MAX_STRING_CHARS),
  };
}

function boundMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata || Object.keys(metadata).length === 0) return undefined;
  return sanitizeBoundedMetadata(metadata, {
    maxStringChars: MAX_STRING_CHARS,
    maxStackChars: MAX_STACK_CHARS,
    maxKeys: MAX_METADATA_KEYS,
    maxArrayItems: MAX_ARRAY_ITEMS,
    maxDepth: MAX_METADATA_DEPTH,
    emptyErrorNameFallback: "Error",
  }) as Record<string, unknown>;
}

export function buildWorkerLogRecord(event: WorkerStructuredLogEvent): WorkerStructuredLogRecord {
  const level = event.level ?? "error";
  const errorFields = classifyError(event.error);
  const record: WorkerStructuredLogRecord = {
    ts: new Date().toISOString(),
    scope: event.scope,
    level,
    message: stripSensitive(event.message).slice(0, MAX_STRING_CHARS),
    ...(normalizeOptionalString(event.event) ? { event: normalizeOptionalString(event.event) } : {}),
    ...(normalizeOptionalString(event.route) ? { route: normalizeOptionalString(event.route) } : {}),
    ...(normalizeOptionalString(event.job) ? { job: normalizeOptionalString(event.job) } : {}),
    ...(normalizeOptionalString(event.provider) ? { provider: normalizeOptionalString(event.provider) } : {}),
    ...(normalizeOptionalString(event.source) ? { source: normalizeOptionalString(event.source) } : {}),
    ...(normalizeOptionalString(event.runId) ? { runId: normalizeOptionalString(event.runId) } : {}),
    ...(event.status != null ? { status: event.status } : {}),
    ...(normalizeOptionalString(event.requestLane) ? { requestLane: normalizeOptionalString(event.requestLane) } : {}),
    ...(errorFields ?? {}),
  };
  const metadata = boundMetadata(event.metadata);
  if (metadata) {
    record.metadata = metadata;
  }
  return record;
}

export function logWorkerEvent(event: WorkerStructuredLogEvent): void {
  const record = buildWorkerLogRecord(event);
  const line = JSON.stringify(record);
  if (record.level === "warn") {
    console.warn(line);
  } else if (record.level === "info") {
    console.info(line);
  } else if (record.level === "debug") {
    console.debug(line);
  } else {
    console.error(line);
  }
}

/**
 * Compatibility bridge for legacy console-style call sites. It preserves the
 * original severity while routing message, error, and supplemental arguments
 * through the bounded structured sink. New call sites should prefer
 * `logWorkerEvent()` with named fields.
 */
export function logWorkerEventArgs(
  scope: WorkerLogScope,
  level: WorkerLogLevel,
  ...args: unknown[]
): void {
  const [first, ...rest] = args;
  const error = args.find((value) => value instanceof Error);
  const message = typeof first === "string"
    ? first
    : first instanceof Error
      ? first.message
      : "Worker event";
  const metadataArgs = (typeof first === "string" ? rest : args)
    .filter((value) => value !== error);

  logWorkerEvent({
    scope,
    level,
    message,
    ...(error ? { error } : {}),
    ...(metadataArgs.length > 0 ? { metadata: { arguments: metadataArgs } } : {}),
  });
}
