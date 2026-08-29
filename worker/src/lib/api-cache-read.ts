import { logWorkerEventArgs } from "./structured-log";
import type { ZodType } from "zod";
import { D1_INT32_MAX } from "./d1-constants";
import { getCache, getCacheUpdatedAt, setCacheIfNewer } from "./db-cache";
import { buildFreshnessMeta, addFreshnessHeaders } from "./api-freshness";
import { errorResponse, jsonResponseWithHeaders, withErrorHandler } from "./api-response";
import { validatePayloadWithSchema } from "./api-schema";
import { IsolateLocalState } from "./isolate-local-state";
import { toErrorMessage } from "@shared/lib/error-utils";
import { parseJson } from "./json-parse";

const CACHE_JSON_PARSE_FAILURE_COUNTER_MAX_ENTRIES = 256;
const RESPONSE_READY_CACHE_VERSION = 2;
const RESPONSE_READY_ENVELOPE_VERSION = 1;

interface ResponseReadyCacheEnvelope {
  version: typeof RESPONSE_READY_ENVELOPE_VERSION;
  schemaId: string;
  body: string;
}

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
  logWorkerEventArgs("lib", "warn", `[cache] Failed to parse persisted JSON (${context}); count=${counters.get(context)?.count ?? 1}:`, message);
}

export function getCacheJsonParseFailureCountersForTests(): Record<string, { count: number; lastMessage: string }> {
  return Object.fromEntries(_cacheRead.state.jsonParseFailuresByContext);
}

export function resetCacheJsonParseFailureCountersForTests(): void {
  _cacheRead.reset();
}

export function safeJsonParse<T>(json: string | null | undefined, fallback: T, context: string): T {
  const parsed = parseJson(json, {
    context,
    onFailure: (failure) => recordJsonParseFailure(context, failure.message),
  });
  return parsed.ok ? parsed.value as T : fallback;
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

  const context = `${endpoint}:${cacheKey}`;
  const parsed = parseJson(cached.value, {
    context,
    onFailure: (failure) => recordJsonParseFailure(context, failure.message),
  });
  if (parsed.ok) {
    return { status: "ok", data: parsed.value as T };
  }
  {
    const message = parsed.message;
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

export function encodeResponseReadyCacheValue(body: string, schemaId: string): string {
  return JSON.stringify({
    version: RESPONSE_READY_ENVELOPE_VERSION,
    schemaId,
    body,
  } satisfies ResponseReadyCacheEnvelope);
}

export async function writeResponseReadyCache(
  db: D1Database,
  cacheKey: string,
  body: string,
  updatedAt: number,
  options: { schemaId: string },
): Promise<void> {
  await setCacheIfNewer(
    db,
    getResponseReadyCacheKey(cacheKey),
    encodeResponseReadyCacheValue(body, options.schemaId),
    updatedAt,
  );
}

async function getResponseReadyCache(
  db: D1Database,
  cacheKey: string,
): Promise<{ value: string; updatedAt: number } | null> {
  try {
    return await getCache(db, getResponseReadyCacheKey(cacheKey));
  } catch (error) {
    logWorkerEventArgs("lib", "warn",
      `[cache] Failed to read response-ready companion for "${cacheKey}":`,
      toErrorMessage(error),
    );
    return null;
  }
}

function decodeResponseReadyCacheBody(
  cacheKey: string,
  cached: { value: string },
  expectedSchemaId: string,
): string | null {
  const parsed = readCachedJson<ResponseReadyCacheEnvelope>(
    "response-ready-cache",
    getResponseReadyCacheKey(cacheKey),
    cached,
  );
  if (parsed.status !== "ok") return null;

  const envelope = parsed.data;
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.version !== RESPONSE_READY_ENVELOPE_VERSION ||
    envelope.schemaId !== expectedSchemaId ||
    typeof envelope.body !== "string"
  ) {
    logWorkerEventArgs("lib", "warn", `[cache] Ignoring response-ready companion for "${cacheKey}" with missing or mismatched schema marker`);
    return null;
  }

  return envelope.body;
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
    responseReadySchemaId?: string;
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
          const trustedBody = options.responseReadySchemaId
            ? decodeResponseReadyCacheBody(cacheKey, responseReady, options.responseReadySchemaId)
            : null;
          const responseReadyBody = trustedBody != null
            && options.responseReadyCache === "json-object"
            && options.injectMeta !== "never"
            ? injectMetaIntoJsonObject(trustedBody, canonicalUpdatedAt, maxAgeSec)
            : trustedBody;
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
      return jsonResponseWithHeaders(
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
