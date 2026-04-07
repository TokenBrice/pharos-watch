import type { ZodType } from "zod";
import { addFreshnessHeaders } from "./api-freshness";

type ApiHandler<T extends unknown[] = unknown[]> = (...args: T) => Promise<Response>;

export interface JsonResponseOptions {
  status?: number;
  headers?: Record<string, string>;
  noStore?: boolean;
  retryAfterSec?: number;
}

type JsonResponseInit = Record<string, string> | JsonResponseOptions | undefined;
type DefinedJsonResponseInit = Exclude<JsonResponseInit, undefined>;

export function withErrorHandler<T extends unknown[]>(
  endpoint: string,
  handler: ApiHandler<T>,
): ApiHandler<T> {
  return async (...args: T): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error(`[api] Error in ${endpoint}:`, err);
      return errorResponse(500, "Internal Server Error");
    }
  };
}

function isJsonResponseOptions(value: DefinedJsonResponseInit): value is JsonResponseOptions {
  return "status" in value || "headers" in value || "noStore" in value || "retryAfterSec" in value;
}

function normalizeJsonResponseOptions(initOrHeaders: JsonResponseInit): JsonResponseOptions {
  if (!initOrHeaders) {
    return {};
  }
  if (isJsonResponseOptions(initOrHeaders)) {
    return initOrHeaders;
  }
  return { headers: initOrHeaders };
}

export function errorResponse(
  status: number,
  message: string,
  initOrHeaders?: JsonResponseInit,
): Response {
  const options = normalizeJsonResponseOptions(initOrHeaders);
  return jsonResponse({ error: message }, { ...options, status });
}

export function jsonResponse(body: unknown, initOrHeaders?: JsonResponseInit): Response {
  const options = normalizeJsonResponseOptions(initOrHeaders);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
  };
  if (options.noStore) {
    headers["Cache-Control"] = "no-store";
  }
  if (options.retryAfterSec != null) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(options.retryAfterSec)));
  }

  return new Response(JSON.stringify(body), {
    status: options.status,
    headers,
  });
}

interface JsonFreshResponseOptions {
  cacheControl?: string;
  updatedAt?: number | null;
  maxAgeSec?: number;
  headers?: Record<string, string>;
}

export function jsonFreshResponse(body: unknown, options: JsonFreshResponseOptions): Response {
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
  };

  if (options.cacheControl) {
    headers["Cache-Control"] = options.cacheControl;
  }

  if (options.updatedAt != null && options.maxAgeSec != null) {
    return jsonResponse(body, addFreshnessHeaders(headers, options.updatedAt, options.maxAgeSec));
  }

  return jsonResponse(body, headers);
}

export function validatePayloadWithSchema<T>(
  schema: ZodType<T>,
  payload: unknown,
  context: string,
): { ok: true; data: T } | { ok: false; issues: string } {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
    .join(", ");
  console.error(`[validate] ${context} schema validation failed: ${issues}`);
  return { ok: false, issues };
}
