import { createJsonResponse } from "@shared/lib/http-response";
import { addFreshnessHeaders } from "./api-freshness-headers";
import { CACHE_PROFILES } from "./constants";
import { logWorkerEvent } from "./structured-log";

type ApiHandler<T extends unknown[] = unknown[]> = (...args: T) => Promise<Response>;

export interface JsonResponseOptions {
  status?: number;
  headers?: Record<string, string>;
  noStore?: boolean;
  retryAfterSec?: number;
}


export function withErrorHandler<T extends unknown[]>(endpoint: string, handler: ApiHandler<T>): ApiHandler<T> {
  return async (...args: T): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      logWorkerEvent({
        scope: "api",
        level: "error",
        event: "api_handler_error",
        route: endpoint,
        message: "API handler error",
        error: err,
      });
      return errorResponse(500, "Internal Server Error");
    }
  };
}

export function withResponseHeaders(response: Response, headersInit: HeadersInit): Response {
  const headers = new Headers(response.headers);
  new Headers(headersInit).forEach((value, key) => {
    headers.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function noStoreResponse(response: Response): Response {
  if (response.headers.get("Cache-Control") === "no-store") return response;
  return withResponseHeaders(response, { "Cache-Control": "no-store" });
}

export function errorResponse(status: number, message: string, options: JsonResponseOptions = {}): Response {
  return jsonResponse({ error: message }, { ...options, status });
}

/**
 * Headers-only form. Kept explicit because the previous single signature
 * sniffed its argument shape and misread any header record that happened to
 * carry a `status` / `headers` / `noStore` / `retryAfterSec` key.
 */
export function jsonResponseWithHeaders(body: unknown, headers: Record<string, string>): Response {
  return jsonResponse(body, { headers });
}

export function jsonResponse(body: unknown, options: JsonResponseOptions = {}): Response {
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

  return createJsonResponse(body, {
    status: options.status,
    headers,
  });
}

export function methodNotAllowedResponse(message: string, allowedMethods: readonly string[]): Response {
  const response = errorResponse(405, message);
  response.headers.set("Allow", allowedMethods.join(", "));
  return response;
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
    return jsonResponseWithHeaders(body, addFreshnessHeaders(headers, options.updatedAt, options.maxAgeSec));
  }

  return jsonResponseWithHeaders(body, headers);
}

export function cacheControlForDegradedPayload(payload: { _meta: { degraded: boolean } }): string {
  return payload._meta.degraded ? CACHE_PROFILES.noStore : CACHE_PROFILES.standard;
}

export function jsonFreshDegradedResponse(payload: { _meta: { degraded: boolean } }, updatedAt: number, maxAgeSec: number): Response {
  return jsonFreshResponse(payload, { cacheControl: cacheControlForDegradedPayload(payload), updatedAt, maxAgeSec });
}

export async function respondWithFreshSnapshot<T extends { updatedAt: number }>(args: {
  load: () => Promise<T>;
  cacheControl: string;
  maxAgeSec: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unavailableError: new (...a: any[]) => Error;
  unavailableMessage: string;
}): Promise<Response> {
  let snapshot: T;
  try {
    snapshot = await args.load();
  } catch (err) {
    if (err instanceof args.unavailableError) {
      return errorResponse(503, args.unavailableMessage);
    }
    throw err;
  }
  if (snapshot.updatedAt === 0) {
    return errorResponse(503, "Data not yet available");
  }
  return jsonFreshResponse(snapshot, {
    cacheControl: args.cacheControl,
    updatedAt: snapshot.updatedAt,
    maxAgeSec: args.maxAgeSec,
  });
}
