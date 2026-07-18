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

type JsonResponseInit = Record<string, string> | JsonResponseOptions | undefined;
type DefinedJsonResponseInit = Exclude<JsonResponseInit, undefined>;

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

export function errorResponse(status: number, message: string, initOrHeaders?: JsonResponseInit): Response {
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
    return jsonResponse(body, addFreshnessHeaders(headers, options.updatedAt, options.maxAgeSec));
  }

  return jsonResponse(body, headers);
}

export function cacheControlForDegradedPayload(payload: { _meta: { degraded: boolean } }): string {
  return payload._meta.degraded ? CACHE_PROFILES.noStore : CACHE_PROFILES.standard;
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
