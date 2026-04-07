import type { ZodType } from "zod";
import { addFreshnessHeaders } from "./api-freshness";

type ApiHandler<T extends unknown[] = unknown[]> = (...args: T) => Promise<Response>;

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

export function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function jsonResponse(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
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
