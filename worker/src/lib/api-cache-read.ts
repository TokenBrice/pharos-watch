import { logWorkerEventArgs } from "./structured-log";
import type { ZodType } from "zod";
import { D1_INT32_MAX } from "./d1-constants";
import { getCache, getCacheUpdatedAt, setCacheIfNewer } from "./db-cache";
import { buildFreshnessMeta, addFreshnessHeaders, type FreshnessMeta } from "./api-freshness";
import { errorResponse, withErrorHandler, withRepresentationEtag } from "./api-response";
import { validatePayloadWithSchema } from "./api-schema";
import { IsolateLocalState } from "./isolate-local-state";
import { toErrorMessage } from "@shared/lib/error-utils";
import { decodeCachedJson, decodeJsonString } from "./cache-json";
import { sha256HexFromUtf8Chunks } from "./hash";

const CACHE_JSON_PARSE_FAILURE_COUNTER_MAX_ENTRIES = 256;
const RESPONSE_READY_CACHE_VERSION = 2;
const RESPONSE_READY_ENVELOPE_VERSION = 2;

interface ResponseReadyCacheEnvelope {
  version: typeof RESPONSE_READY_ENVELOPE_VERSION;
  schemaId: string;
  body: string;
  bodySha256: string;
}

const _cacheRead = new IsolateLocalState(() => ({
  jsonParseFailuresByContext: new Map<string, { count: number; lastMessage: string }>(),
}));

export function recordJsonParseFailure(context: string, message: string): void {
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
  const decoded = decodeJsonString<unknown, "missing" | "json-parse-failed">(
    json,
    {
      missingReason: "missing",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => ({ ok: true, payload: parsed }),
      onParseFailure: ({ message }) => recordJsonParseFailure(context, message),
    },
  );
  return decoded.ok ? decoded.payload as T : fallback;
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
  const context = `${endpoint}:${cacheKey}`;
  let parseFailureMessage: string | null = null;
  const decoded = decodeCachedJson<unknown, "missing-cache" | "json-parse-failed">(
    cached,
    {
      missingReason: "missing-cache",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => ({ ok: true, payload: parsed }),
      onParseFailure: ({ message }) => {
        parseFailureMessage = message;
        recordJsonParseFailure(context, message);
      },
    },
  );
  if (decoded.ok) {
    return { status: "ok", data: decoded.payload as T };
  }
  if (decoded.reason === "missing-cache") {
    return { status: "missing" };
  }
  return {
    status: "malformed",
    message: parseFailureMessage ?? "Cached JSON parse failed",
  };
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
    bodySha256: sha256HexFromUtf8Chunks([body]),
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
): Pick<ResponseReadyCacheEnvelope, "body" | "bodySha256"> | null {
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
    typeof envelope.body !== "string" ||
    typeof envelope.bodySha256 !== "string" || !/^[a-f0-9]{64}$/.test(envelope.bodySha256)
  ) {
    logWorkerEventArgs("lib", "warn", `[cache] Ignoring response-ready companion for "${cacheKey}" with missing or mismatched schema marker`);
    return null;
  }

  return { body: envelope.body, bodySha256: envelope.bodySha256 };
}

function injectMetaIntoJsonObject(rawBody: string, freshness: FreshnessMeta): string | null {
  const trimmedStart = rawBody.search(/\S/);
  if (trimmedStart < 0 || rawBody[trimmedStart] !== "{") return null;
  const trimmedEnd = rawBody.search(/\s*$/);
  const endIndex = trimmedEnd >= 0 ? trimmedEnd : rawBody.length;
  let closeBraceIndex = endIndex - 1;
  while (closeBraceIndex >= 0 && /\s/.test(rawBody[closeBraceIndex] ?? "")) {
    closeBraceIndex--;
  }
  if (rawBody[closeBraceIndex] !== "}") return null;

  const meta = JSON.stringify(freshness);
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
    readCache?: (db: D1Database, cacheKey: string) => Promise<{ value: string; updatedAt: number } | null>;
    transform?: (
      payload: unknown,
      context: {
        db: D1Database;
        cached: { value: string; updatedAt: number };
      },
    ) => Promise<unknown> | unknown;
    injectMeta?: "auto" | "never";
    responseReadyCache?: "json-object";
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
          const freshness = buildFreshnessMeta(canonicalUpdatedAt, maxAgeSec, cacheKey);
          const trustedBody = options.responseReadySchemaId
            ? decodeResponseReadyCacheBody(cacheKey, responseReady, options.responseReadySchemaId)
            : null;
          const responseReadyBody = trustedBody != null
            && options.injectMeta !== "never"
            ? injectMetaIntoJsonObject(trustedBody.body, freshness)
            : trustedBody?.body;
          if (responseReadyBody != null) {
            return withRepresentationEtag(new Response(responseReadyBody, {
              headers: addFreshnessHeaders({
                "Content-Type": "application/json",
                "Cache-Control": cacheControl,
              }, canonicalUpdatedAt, maxAgeSec, freshness),
            }), ["cache-handler-v1", endpoint, cacheKey, canonicalUpdatedAt,
              options.responseReadySchemaId, trustedBody?.bodySha256,
              freshness.status, freshness.freshBudgetSec, freshness.degradedBudgetSec]);
          }
        }
      }
    }

    const cached = await (options?.readCache ?? getCache)(db, cacheKey);
    if (!cached) {
      return errorResponse(503, "Data not yet available");
    }

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

    const freshness = buildFreshnessMeta(cached.updatedAt, maxAgeSec, cacheKey);
    const headers = addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
    }, cached.updatedAt, maxAgeSec, freshness);

    if (options?.injectMeta !== "never" && body && typeof body === "object" && !Array.isArray(body)) {
      body = { ...(body as Record<string, unknown>), _meta: freshness };
    }

    // updated_at admits same-clock replacement, so it is not a content identity.
    // Without a producer digest, dispatch assigns a response-cache publication
    // validator rather than claim independently mutable bodies are unchanged.
    return new Response(JSON.stringify(body), { headers });
  });
}
