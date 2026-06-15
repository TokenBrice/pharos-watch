import type { ZodType } from "zod";
import { D1_INT32_MAX } from "./d1-constants";
import { getCache, getCacheUpdatedAt, setCacheIfNewer } from "./db-cache";
import { buildFreshnessMeta, addFreshnessHeaders } from "./api-freshness";
import { errorResponse, jsonResponse, withErrorHandler } from "./api-response";
import { validatePayloadWithSchema } from "./api-schema";
import { IsolateLocalState } from "./isolate-local-state";
import { toErrorMessage } from "./error-utils";

const CACHE_JSON_PARSE_FAILURE_COUNTER_MAX_ENTRIES = 256;
const RESPONSE_READY_CACHE_VERSION = 1;

const _cacheRead = new IsolateLocalState(() => ({
  jsonParseFailuresByContext: new Map<string, { count: number; lastMessage: string }>(),
}));

function recordJsonParseFailure(context: string, message: string): void {
  const counters = _cacheRead.state.jsonParseFailuresByContext;
  const previous = counters.get(context);
  counters.delete(context);
  counters.set(context, {
    count: Math.min((previous?.count ?? 0) + 1, D1_INT32_MAX),
    lastMessage: message,
  });
  while (counters.size > CACHE_JSON_PARSE_FAILURE_COUNTER_MAX_ENTRIES) {
    const oldest = counters.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    counters.delete(oldest);
  }
  console.warn(`[cache] Failed to parse persisted JSON (${context}); count=${counters.get(context)?.count ?? 1}:`, message);
}

export function getCacheJsonParseFailureCountersForTests(): Record<string, { count: number; lastMessage: string }> {
  return Object.fromEntries(_cacheRead.state.jsonParseFailuresByContext);
}

export function resetCacheJsonParseFailureCountersForTests(): void {
  _cacheRead.reset();
}

export function safeJsonParse<T>(json: string | null | undefined, fallback: T, context = "safeJsonParse"): T {
  if (json == null) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    recordJsonParseFailure(context, toErrorMessage(err));
    return fallback;
  }
}

export type CachedJsonReadResult<T> =
  | { status: "missing" }
  | { status: "ok"; data: T }
  | { status: "malformed"; message: string };

export function readCachedJson<T>(
  endpoint: string,
  cacheKey: string,
  cached: { value: string } | null,
): CachedJsonReadResult<T> {
  if (!cached) {
    return { status: "missing" };
  }

  try {
    return { status: "ok", data: JSON.parse(cached.value) as T };
  } catch (err) {
    const message = toErrorMessage(err);
    recordJsonParseFailure(`${endpoint}:${cacheKey}`, message);
    return { status: "malformed", message };
  }
}

export function readCachedJsonOr503<T>(
  endpoint: string,
  cacheKey: string,
  cached: { value: string },
): { ok: true; data: T } | { ok: false; response: Response } {
  const parsed = readCachedJson<T>(endpoint, cacheKey, cached);
  if (parsed.status === "ok") {
    return { ok: true, data: parsed.data };
  }
  return {
    ok: false,
    response: errorResponse(503, `Cached ${cacheKey} payload is malformed`),
  };
}

export function getResponseReadyCacheKey(cacheKey: string): string {
  return `${cacheKey}:response-ready:v${RESPONSE_READY_CACHE_VERSION}`;
}

export async function writeResponseReadyCache(
  db: D1Database,
  cacheKey: string,
  body: string,
  updatedAt: number,
): Promise<void> {
  await setCacheIfNewer(db, getResponseReadyCacheKey(cacheKey), body, updatedAt);
}

async function getResponseReadyCache(
  db: D1Database,
  cacheKey: string,
): Promise<{ value: string; updatedAt: number } | null> {
  try {
    return await getCache(db, getResponseReadyCacheKey(cacheKey));
  } catch (error) {
    console.warn(
      `[cache] Failed to read response-ready companion for "${cacheKey}":`,
      toErrorMessage(error),
    );
    return null;
  }
}

function injectMetaIntoJsonObject(rawBody: string, updatedAt: number, maxAgeSec: number): string | null {
  const trimmedStart = rawBody.search(/\S/);
  if (trimmedStart < 0 || rawBody[trimmedStart] !== "{") return null;
  const trimmedEnd = rawBody.search(/\s*$/);
  const endIndex = trimmedEnd >= 0 ? trimmedEnd : rawBody.length;
  let closeBraceIndex = endIndex - 1;
  while (closeBraceIndex >= 0 && /\s/.test(rawBody[closeBraceIndex] ?? "")) {
    closeBraceIndex--;
  }
  if (rawBody[closeBraceIndex] !== "}") return null;

  const meta = JSON.stringify(buildFreshnessMeta(updatedAt, maxAgeSec));
  const prefix = rawBody.slice(0, closeBraceIndex).trimEnd();
  const suffix = rawBody.slice(closeBraceIndex);
  const emptyObject = prefix.replace(/\s+/g, "") === "{";
  return `${prefix}${emptyObject ? "" : ","}"_meta":${meta}${suffix}`;
}

export function createCacheHandler(
  endpoint: string,
  cacheKey: string,
  cacheControl: string,
  maxAgeSec: number,
  options?: {
    schema?: ZodType<unknown>;
    transform?: (
      payload: unknown,
      context: {
        db: D1Database;
        cached: { value: string; updatedAt: number };
      },
    ) => Promise<unknown> | unknown;
    injectMeta?: "auto" | "never";
    responseReadyCache?: "json-object" | "raw-json";
    malformedMessage?: string;
  },
): (db: D1Database) => Promise<Response> {
  return withErrorHandler(endpoint, async (db: D1Database): Promise<Response> => {
    if (options?.responseReadyCache) {
      // Probe updated_at only first so a fresh companion hit never transfers
      // the (potentially multi-megabyte) canonical value column.
      const canonicalUpdatedAt = await getCacheUpdatedAt(db, cacheKey);
      if (canonicalUpdatedAt != null) {
        const responseReady = await getResponseReadyCache(db, cacheKey);
        if (responseReady?.updatedAt === canonicalUpdatedAt) {
          const responseReadyBody = options.responseReadyCache === "json-object" && options.injectMeta !== "never"
            ? injectMetaIntoJsonObject(responseReady.value, canonicalUpdatedAt, maxAgeSec)
            : responseReady.value;
          if (responseReadyBody != null) {
            return new Response(responseReadyBody, {
              headers: addFreshnessHeaders({
                "Content-Type": "application/json",
                "Cache-Control": cacheControl,
              }, canonicalUpdatedAt, maxAgeSec),
            });
          }
        }
      }
    }

    const cached = await getCache(db, cacheKey);
    if (!cached) {
      return errorResponse(503, "Data not yet available");
    }

    const headers = addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
    }, cached.updatedAt, maxAgeSec);

    const parsed = readCachedJsonOr503<unknown>(endpoint, cacheKey, cached);
    if (!parsed.ok) {
      return parsed.response;
    }

    let body: unknown = parsed.data;
    if (options?.schema) {
      const validation = validatePayloadWithSchema(options.schema, body, `${endpoint}:cache-read`);
      if (!validation.ok) {
        return errorResponse(503, options.malformedMessage ?? `Cached ${cacheKey} payload is malformed`);
      }
      body = validation.data;
    }

    if (options?.transform) {
      body = await options.transform(body, { db, cached });
      if (body instanceof Response) {
        return body;
      }
    }

    if (options?.injectMeta !== "never" && body && typeof body === "object" && !Array.isArray(body)) {
      return jsonResponse(
        {
          ...(body as Record<string, unknown>),
          _meta: buildFreshnessMeta(cached.updatedAt, maxAgeSec),
        },
        headers,
      );
    }

    return new Response(JSON.stringify(body), { headers });
  });
}
