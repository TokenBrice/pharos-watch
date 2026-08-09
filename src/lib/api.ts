import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { isFreshnessWarningHeader } from "@shared/lib/api-freshness";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import { classifyFreshnessRatio } from "@shared/lib/status-thresholds";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { isRecord } from "@shared/lib/type-guards";
import type { ApiDependencyMeta, ApiMeta as ApiMetaWithAge } from "@shared/types/api-meta";
import type { StablecoinReservesResponse } from "@shared/types";
import { buildRequestUrl } from "@/lib/api-url";
import { formatSchemaLikeIssues, type SchemaLike } from "@/lib/schema-like";
import { normalizeRequestTimeoutMs, resolveRequestSignal } from "@/lib/request-lifecycle";

export { API_BASE, buildApiUrl, buildRequestUrl, resolveApiBase } from "@/lib/api-url";

export type ApiMeta =
  | ApiMetaWithAge
  | {
      status: ApiMetaWithAge["status"];
      warning: string;
      updatedAt?: undefined;
      ageSeconds?: undefined;
      dependencies?: ApiMetaWithAge["dependencies"];
    };

export type ApiContractMode = "strict" | "warn";

function withPublicApiAcceptMarker(path: string, init?: RequestInit): RequestInit | undefined {
  if (typeof window === "undefined") return init;
  if (!path.startsWith("/api/") || path.startsWith("/api/admin/")) return init;

  const headers = new Headers(init?.headers);
  const accept = headers.get("Accept");
  if (!accept) {
    headers.set("Accept", `application/json, ${PHAROS_WEB_ACCEPT_MARKER}`);
  } else if (!accept.toLowerCase().includes(PHAROS_WEB_ACCEPT_MARKER)) {
    headers.set("Accept", `${accept}, ${PHAROS_WEB_ACCEPT_MARKER}`);
  }

  return {
    ...init,
    headers,
  };
}

export interface ApiRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number | null;
}

function resolveResponseUpdatedAtSec(headers: Headers, ageSeconds: number): number {
  const dateHeader = headers.get("Date");
  const serverDateMs = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  const referenceNowSec = Number.isFinite(serverDateMs)
    ? Math.floor(serverDateMs / 1000)
    : Math.floor(Date.now() / 1000);
  return Math.max(0, Math.floor(referenceNowSec - ageSeconds));
}

export async function apiRequest(path: string, init?: RequestInit, options?: ApiRequestOptions): Promise<Response> {
  const parent = resolveRequestSignal(init?.signal, options?.signal, "explicit-over-init");
  const requestInit = withPublicApiAcceptMarker(path, {
    ...init,
    signal: parent.signal,
  });
  const timeoutMs = normalizeRequestTimeoutMs(options?.timeoutMs);

  if (timeoutMs == null) {
    try {
      return await fetch(buildRequestUrl(path, requestInit), requestInit);
    } finally {
      parent.dispose();
    }
  }

  const timeout = createTimeoutSignal({
    timeoutMs,
    timeoutReason: new DOMException(`API request timed out after ${timeoutMs}ms`, "TimeoutError"),
    parentSignal: parent.signal,
  });

  try {
    return await fetch(buildRequestUrl(path, requestInit), {
      ...(requestInit ?? {}),
      signal: timeout.signal,
    });
  } finally {
    timeout.dispose();
    parent.dispose();
  }
}

export class SchemaValidationError extends Error {
  readonly path: string;
  readonly issues: string;

  constructor(path: string, issues: string) {
    super(`Schema validation failed for ${path}: ${issues}`);
    this.name = "SchemaValidationError";
    this.path = path;
    this.issues = issues;
  }
}

export class ApiFetchError extends Error {
  readonly status: number;
  readonly path: string;
  readonly bodyText: string | null;

  constructor(path: string, status: number, bodyText: string | null) {
    super(`Failed to fetch ${path}: ${status}`);
    this.name = "ApiFetchError";
    this.status = status;
    this.path = path;
    this.bodyText = bodyText;
  }
}

function getBodyWarning(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  const warning = (data as { warning?: unknown }).warning;
  return typeof warning === "string" && warning.trim().length > 0 ? warning : null;
}

function normalizeApiDependencyMeta(value: unknown): ApiDependencyMeta | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (status !== "fresh" && status !== "degraded" && status !== "stale" && status !== "unavailable") {
    return null;
  }
  return {
    status,
    updatedAt: typeof value.updatedAt === "number" || value.updatedAt === null ? value.updatedAt : undefined,
    ageSeconds: typeof value.ageSeconds === "number" || value.ageSeconds === null ? value.ageSeconds : undefined,
    reason: typeof value.reason === "string" || value.reason === null ? value.reason : undefined,
  };
}

export function normalizeApiMeta(value: unknown): ApiMetaWithAge | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (status !== "fresh" && status !== "degraded" && status !== "stale") {
    return null;
  }
  if (typeof value.updatedAt !== "number" || typeof value.ageSeconds !== "number") {
    return null;
  }

  const dependencies: Record<string, ApiDependencyMeta> = {};
  if (isRecord(value.dependencies)) {
    for (const [key, raw] of Object.entries(value.dependencies)) {
      const dependency = normalizeApiDependencyMeta(raw);
      if (dependency) dependencies[key] = dependency;
    }
  }

  return {
    updatedAt: value.updatedAt,
    ageSeconds: value.ageSeconds,
    status,
    warning: typeof value.warning === "string" || value.warning === null ? value.warning : undefined,
    dependencies: Object.keys(dependencies).length > 0 ? dependencies : undefined,
  };
}

async function buildFetchError(path: string, res: Response): Promise<ApiFetchError> {
  let bodyText: string | null = null;
  try {
    bodyText = await res.text();
  } catch {
    bodyText = null;
  }
  return new ApiFetchError(path, res.status, bodyText);
}

function resolveContractMode(
  schema: SchemaLike<unknown> | undefined,
  mode: ApiContractMode | undefined,
): ApiContractMode | null {
  if (!schema) return null;
  return mode ?? "strict";
}

function validateApiPayload<T>(path: string, data: unknown, schema?: SchemaLike<T>, contractMode?: ApiContractMode): T {
  if (!schema) {
    return data as T;
  }

  const resolvedMode = resolveContractMode(schema, contractMode);
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  const issues = formatSchemaLikeIssues(result.error.issues);
  if (resolvedMode === "strict") {
    throw new SchemaValidationError(path, issues);
  }

  console.warn(`[API contract] Schema validation failed`, {
    endpoint: path,
    issueCount: result.error.issues.length,
    issues,
  });
  return data as T;
}

// --- Standard fetch (no meta) ---

export interface ApiFetchOptions extends ApiRequestOptions {
  nullOn404?: boolean;
}

/** Fetch JSON from the API. Throws on non-OK responses.
 *  When a Zod schema is provided, strict validation is the default and
 *  schema mismatch throws. Pass contractMode="warn" only for explicit
 *  graceful degradation that returns data as-is after logging. */
export async function apiFetch<T>(
  path: string,
  schema?: SchemaLike<T>,
  init?: RequestInit,
  contractMode?: ApiContractMode,
): Promise<T>;
/** Overload: passing `{ nullOn404: true }` makes the return type `T | null`. */
export async function apiFetch<T>(
  path: string,
  schema: SchemaLike<T> | undefined,
  init: RequestInit | undefined,
  contractMode: ApiContractMode | undefined,
  options: ApiFetchOptions & { nullOn404: true },
): Promise<T | null>;
/** Overload: request options without `nullOn404` preserve the non-null return type. */
export async function apiFetch<T>(
  path: string,
  schema: SchemaLike<T> | undefined,
  init: RequestInit | undefined,
  contractMode: ApiContractMode | undefined,
  options: ApiFetchOptions & { nullOn404?: false },
): Promise<T>;
export async function apiFetch<T>(
  path: string,
  schema?: SchemaLike<T>,
  init?: RequestInit,
  contractMode?: ApiContractMode,
  options?: ApiFetchOptions,
): Promise<T | null> {
  const res = await apiRequest(path, init, options);
  if (!res.ok) {
    if (options?.nullOn404 && res.status === 404) return null;
    throw await buildFetchError(path, res);
  }

  const data: unknown = await res.json();
  return validateApiPayload(path, data, schema, contractMode);
}

// --- Meta-aware fetch ---

/** Fetch JSON + extract freshness metadata from _meta field or X-Data-Age header. */
export async function apiFetchWithMeta<T>(
  path: string,
  schema?: SchemaLike<T>,
  init?: RequestInit,
  maxAgeSec = 900,
  contractMode?: ApiContractMode,
  requestOptions?: ApiRequestOptions,
): Promise<{ data: T; meta: ApiMeta | null }> {
  const res = await apiRequest(path, init, requestOptions);
  if (!res.ok) throw await buildFetchError(path, res);

  const json: unknown = await res.json();

  // Extract only the generic freshness envelope. Some endpoints expose domain
  // metadata under `_meta`; that must stay in `data` for consumers.
  let meta: ApiMeta | null = null;
  let data = json;
  if (json && typeof json === "object" && !Array.isArray(json) && "_meta" in json) {
    const record = json as Record<string, unknown>;
    const normalizedMeta = normalizeApiMeta(record._meta);
    if (normalizedMeta) {
      const { _meta, ...rest } = record;
      meta = normalizedMeta;
      data = rest;
    }
  }
  const bodyWarning = getBodyWarning(data);

  // Fallback: read X-Data-Age header (for array responses or non-cache-handler endpoints)
  if (!meta) {
    const ageHeader = res.headers.get("X-Data-Age");
    if (ageHeader) {
      const age = Number(ageHeader);
      if (Number.isFinite(age) && age >= 0) {
        meta = {
          updatedAt: resolveResponseUpdatedAtSec(res.headers, age),
          ageSeconds: age,
          status: classifyFreshnessRatio(age / maxAgeSec),
        };
      }
    }
  }

  const warningHeader = res.headers.get("Warning");
  if (warningHeader) {
    const isFreshnessWarning = isFreshnessWarningHeader(warningHeader);
    if (meta) {
      meta = {
        ...meta,
        status: isFreshnessWarning && meta.status === "fresh" ? "degraded" : meta.status,
        warning: warningHeader,
      };
    } else if (isFreshnessWarning) {
      // Preserve warning context without inventing freshness timestamps.
      meta = {
        status: "degraded",
        warning: warningHeader,
      };
    }
  }
  if (bodyWarning && meta && !meta.warning) {
    meta = {
      ...meta,
      warning: bodyWarning,
    };
  }

  // Validate the stripped body. A failure here is not recoverable by
  // re-validating the un-stripped `json` (which still carries `_meta`); a
  // consumer that needs the raw envelope should use `apiFetch` instead.
  return { data: validateApiPayload(path, data, schema, contractMode), meta };
}

export async function fetchStablecoinReserves(
  stablecoinId: string,
  requestInit?: RequestInit,
): Promise<StablecoinReservesResponse | null> {
  const { StablecoinReservesResponseSchema } = await import("@shared/types/live-reserves");
  return apiFetch<StablecoinReservesResponse>(
    API_PATHS.stablecoinReserves(stablecoinId),
    StablecoinReservesResponseSchema,
    requestInit,
    undefined,
    { nullOn404: true },
  );
}
