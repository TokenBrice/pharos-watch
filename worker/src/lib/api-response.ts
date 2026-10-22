import { createHash, randomUUID } from "node:crypto";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { SAFETY_SCORE_PUBLICATION_AGE_REASON } from "@pharos/contracts/api-meta";
import { cloneResponse, createJsonResponse } from "@shared/lib/http-response";
import { addFreshnessHeaders } from "./api-freshness-headers";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import type { V9PublicationHealth } from "@shared/types/report-cards-v9";
import { logWorkerEvent } from "./structured-log";
import { isSafetyScoreV9SnapshotFresh, SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "./safety-score-v9/consumer-freshness";

type ApiHandler<T extends unknown[] = unknown[]> = (...args: T) => Promise<Response>;

export interface JsonResponseOptions {
  status?: number;
  headers?: Record<string, string>;
  noStore?: boolean;
  retryAfterSec?: number;
}

/**
 * Semantic validators deliberately ignore assessment-clock churn. Callers must
 * include every mutable payload overlay (health/reason/version) in the identity.
 * Never pass the cohort/body: only bounded producer identity metadata is hashed.
 */
export function withRepresentationEtag(response: Response, identity: unknown): Response {
  if (!isReusableResponse(response)) return withoutValidators(response);
  return withResponseHeaders(response, {
    ETag: `W/"${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}"`,
  });
}

function isReusableResponse(response: Response): boolean {
  const policy = response.headers.get("Cache-Control") ?? "";
  const freshness = response.headers.get("X-Data-Freshness");
  return response.status === 200 && !/\b(?:no-store|no-cache|private)\b/i.test(policy)
    && /\b(?:s-maxage|max-age)\s*=\s*[1-9]\d*/i.test(policy)
    && (freshness === null || freshness === "fresh")
    && response.headers.get("X-Safety-Score-Status") !== "held";
}

function withoutValidators(response: Response): Response {
  if (!response.headers.has("ETag") && !response.headers.has("Last-Modified")) return response;
  return cloneResponse(response, { mutateHeaders: (headers) => {
    headers.delete("ETag");
    headers.delete("Last-Modified");
  } });
}

/** Scope validators to the exact route/query representation before cache admission. */
export function scopeResponseEtag(response: Response, representation: string, cacheable: boolean): Response {
  if (!isReusableResponse(response)) return withoutValidators(response);
  const sourceEtag = response.headers.get("ETag");
  if (!sourceEtag && !cacheable) return response;
  // Without a producer validator, identify this exact response-cache publication.
  // The token is stored with its bytes once, never inferred from a partial clock
  // that could omit independently mutable overlays.
  const scoped = withRepresentationEtag(response, [
    "http-representation-v1", representation,
    sourceEtag ?? ["response-cache-publication", response.headers.get("X-Data-Updated-At"), randomUUID()],
    response.headers.get("X-Data-Freshness"), response.headers.get("X-Data-Freshness-Reason"),
    response.headers.get("X-Safety-Score-Status"),
  ]);
  if (scoped.headers.has("Date")) return scoped;
  return withResponseHeaders(scoped, { Date: new Date(Date.now()).toUTCString() });
}

/** Shared admission for edge hits and conditionals, including composed Date bounds. */
export function isResponseWithinFreshLifetime(response: Response): boolean {
  const policy = response.headers.get("Cache-Control") ?? "";
  const ttl = policy.match(/\bs-maxage\s*=\s*(\d+)/i) ?? policy.match(/\bmax-age\s*=\s*(\d+)/i);
  const date = Date.parse(response.headers.get("Date") ?? "");
  const age = Number(response.headers.get("Age") ?? "0");
  const now = Date.now() / 1000;
  if (!ttl || !Number.isFinite(date) || !Number.isFinite(age) || age < 0
    || Math.max(age, Math.max(0, now - date / 1000)) >= Number(ttl[1])) return false;
  const updatedAt = response.headers.get("X-Data-Updated-At");
  const budget = response.headers.get("X-Data-Freshness-Budget");
  return updatedAt === null || budget === null || (Number.isFinite(Number(updatedAt))
    && Number.isFinite(Number(budget)) && now < Number(updatedAt) + Number(budget));
}

/** A 304 keeps the original Date/Age and bounded policy; it never renews a verdict. */
export function conditionalGetResponse(request: Request, response: Response): Response {
  if (request.method !== "GET" || !isReusableResponse(response)) return withoutValidators(response);
  const etag = response.headers.get("ETag");
  const condition = request.headers.get("If-None-Match");
  if (!etag || !condition) return response;
  if (!isResponseWithinFreshLifetime(response)) return response;
  const opaqueTag = etag.replace(/^W\//, "");
  // Entity-tag values can contain commas; do not split a quoted opaque tag.
  const tags = condition.match(/(?:W\/)?"[^"]*"|\*/g) ?? [];
  if (!tags.some((tag) => tag === "*" || tag.replace(/^W\//, "") === opaqueTag)) return response;
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  headers.delete("Content-Range");
  // Do not await cancellation of a tee branch; another cache writer may consume it.
  void response.body?.cancel().catch(() => undefined);
  return new Response(null, { status: 304, headers });
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
  return cloneResponse(response, {
    mutateHeaders: (headers) => {
      new Headers(headersInit).forEach((value, key) => {
        headers.set(key, value);
      });
    },
  });
}

export function noStoreResponse(response: Response): Response {
  const uncached = response.headers.get("Cache-Control") === "no-store"
    ? response : withResponseHeaders(response, { "Cache-Control": "no-store" });
  return withoutValidators(uncached);
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

interface SafetyScoreSnapshotResponseMetadata {
  publicationHealth: V9PublicationHealth;
  updatedAt: number;
}

export function jsonSafetyScoreSnapshotResponse(
  snapshot: SafetyScoreSnapshotResponseMetadata & {
    safetyScoreIdentity: SafetyScoreV9PublicationIdentity;
    publicationHealth: V9PublicationHealth;
  },
  body: unknown,
  representation: string,
): Response {
  return withRepresentationEtag(jsonResponseWithHeaders(body, safetyScoreSnapshotHeaders(
    snapshot, snapshot.safetyScoreIdentity.publicationGenerationId)), [representation, snapshot.safetyScoreIdentity, snapshot.publicationHealth]);
}

/**
 * Shared policy for object responses and admitted immutable byte streams.
 * The verdict uses the V9 consumer budget (one missed publication), not the
 * generic 8x endpoint runway: a stalled producer must read `stale`, and an
 * edge-cached `current` copy must not outlive that budget.
 */
export function safetyScoreSnapshotHeaders(
  snapshot: SafetyScoreSnapshotResponseMetadata,
  generationId: string,
): Record<string, string> {
  const nowSec = Date.now() / 1000;
  const held = snapshot.publicationHealth.status === "held";
  const status = held ? "held" : isSafetyScoreV9SnapshotFresh(snapshot, Math.floor(nowSec)) ? "current" : "stale";
  const headers = addFreshnessHeaders({
    "Content-Type": "application/json",
    "Cache-Control": status === "current" ? CACHE_PROFILES.standard : CACHE_PROFILES.noStore,
    "X-Safety-Score-Status": status,
    "X-Safety-Score-Generation": generationId,
    "X-Safety-Score-Freshness-Budget": String(SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC),
  }, snapshot.updatedAt, API_FRESHNESS_MAX_AGE_SEC.reportCards, {
    assessedAt: nowSec, freshBudgetSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
  });
  if (status !== "stale") return headers;
  // The generic helper tolerates small future skew, but the safety verdict
  // does not; keep the generic freshness surface consistent with it.
  const future = !(snapshot.updatedAt <= nowSec);
  return {
    ...headers,
    "X-Data-Freshness": "stale",
    "X-Data-Freshness-Reason": future ? "future-timestamp" : SAFETY_SCORE_PUBLICATION_AGE_REASON,
    Warning: headers.Warning ?? `110 - "Safety Score publication is ${future ? "future-dated" : "stale"} (consumer budget ${SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC}s)"`,
  };
}
