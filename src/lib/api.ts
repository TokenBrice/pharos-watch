import type { ZodType } from "zod";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import { isSiteDataAllowedUiHostname, resolveSiteDataProxyPath } from "@shared/lib/site-data-lane";
import { classifyFreshnessRatio } from "@shared/lib/status-thresholds";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { resolvePublicApiBase } from "@shared/lib/runtime-origins";
import { ApiMetaSchema, type ApiMeta } from "@shared/types/api-meta";
import type { StablecoinReservesResponse } from "@shared/types";
import { StablecoinReservesResponseSchema } from "@shared/types/live-reserves";

export type { ApiMeta } from "@shared/types/api-meta";

export type ApiContractMode = "strict" | "warn";
export const DEFAULT_API_REQUEST_TIMEOUT_MS = 10_000;

export function resolveApiBase(
  hostname?: string | null,
  envBase: string | undefined = process.env.NEXT_PUBLIC_API_BASE,
): string {
  return resolvePublicApiBase(hostname, envBase);
}

function getBrowserHostname(): string | null {
  return typeof window !== "undefined" ? window.location.hostname : null;
}

export const API_BASE = resolveApiBase(getBrowserHostname());

export function buildApiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function resolveSiteDataRequestPath(
  path: string,
  method: string | null | undefined,
  hostname?: string | null,
  envBase: string | undefined = process.env.NEXT_PUBLIC_API_BASE,
  forceSiteDataProxy: string | undefined = process.env.NEXT_PUBLIC_FORCE_SITE_DATA_PROXY,
): string | null {
  if ((envBase ?? "").trim()) {
    return null;
  }
  const forceProxy = (forceSiteDataProxy ?? "").trim().toLowerCase() === "true";
  if (!forceProxy && (!hostname || !isSiteDataAllowedUiHostname(hostname))) {
    return null;
  }
  return resolveSiteDataProxyPath(path, method);
}

function resolveRequestMethod(init?: Pick<RequestInit, "method"> | string | null): string | undefined {
  return typeof init === "string" ? init : init?.method;
}

export function buildRequestUrl(path: string, init?: Pick<RequestInit, "method"> | string | null): string {
  if (path.startsWith("/api/admin/")) {
    return path;
  }
  const siteDataPath = resolveSiteDataRequestPath(path, resolveRequestMethod(init), getBrowserHostname());
  if (siteDataPath) {
    return siteDataPath;
  }
  return buildApiUrl(path);
}

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

function resolveApiRequestSignal(init?: RequestInit, options?: ApiRequestOptions): AbortSignal | undefined {
  return options?.signal ?? init?.signal ?? undefined;
}

function resolveApiRequestTimeoutMs(options?: ApiRequestOptions): number | null {
  if (options?.timeoutMs === null) {
    return null;
  }

  if (options?.timeoutMs === undefined) {
    return DEFAULT_API_REQUEST_TIMEOUT_MS;
  }

  if (!Number.isFinite(options.timeoutMs)) {
    return DEFAULT_API_REQUEST_TIMEOUT_MS;
  }

  return Math.max(1, Math.ceil(options.timeoutMs));
}

export async function apiRequest(path: string, init?: RequestInit, options?: ApiRequestOptions): Promise<Response> {
  const parentSignal = resolveApiRequestSignal(init, options);
  const requestInit = withPublicApiAcceptMarker(path, {
    ...init,
    signal: parentSignal,
  });
  const timeoutMs = resolveApiRequestTimeoutMs(options);

  if (timeoutMs == null) {
    return fetch(buildRequestUrl(path, requestInit), requestInit);
  }

  const timeout = createTimeoutSignal({
    timeoutMs,
    timeoutReason: new DOMException(`API request timed out after ${timeoutMs}ms`, "TimeoutError"),
    parentSignal,
  });

  try {
    return await fetch(buildRequestUrl(path, requestInit), {
      ...(requestInit ?? {}),
      signal: timeout.signal,
    });
  } finally {
    timeout.dispose();
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

function formatIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join(", ");
}

function isFreshnessWarningHeader(warningHeader: string): boolean {
  return /(?:^|,\s*)110\b/.test(warningHeader) || /Response is (?:degraded|stale)/i.test(warningHeader);
}

function getBodyWarning(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  const warning = (data as { warning?: unknown }).warning;
  return typeof warning === "string" && warning.trim().length > 0 ? warning : null;
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
  schema: ZodType<unknown> | undefined,
  mode: ApiContractMode | undefined,
): ApiContractMode | null {
  if (!schema) return null;
  return mode ?? "strict";
}

function validateApiPayload<T>(path: string, data: unknown, schema?: ZodType<T>, contractMode?: ApiContractMode): T {
  if (!schema) {
    return data as T;
  }

  const resolvedMode = resolveContractMode(schema, contractMode);
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  const issues = formatIssues(result.error.issues);
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
  schema?: ZodType<T>,
  init?: RequestInit,
  contractMode?: ApiContractMode,
): Promise<T>;
/** Overload: passing `{ nullOn404: true }` makes the return type `T | null`. */
export async function apiFetch<T>(
  path: string,
  schema: ZodType<T> | undefined,
  init: RequestInit | undefined,
  contractMode: ApiContractMode | undefined,
  options: ApiFetchOptions & { nullOn404: true },
): Promise<T | null>;
export async function apiFetch<T>(
  path: string,
  schema?: ZodType<T>,
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
  schema?: ZodType<T>,
  init?: RequestInit,
  maxAgeSec = 900,
  contractMode?: ApiContractMode,
  requestOptions?: ApiRequestOptions,
): Promise<{ data: T; meta: ApiMeta | null }> {
  const res = await apiRequest(path, init, requestOptions);
  if (!res.ok) throw await buildFetchError(path, res);

  const json: unknown = await res.json();

  // Extract _meta from response body (injected by createCacheHandler for object responses)
  let meta: ApiMeta | null = null;
  let data = json;
  if (json && typeof json === "object" && !Array.isArray(json) && "_meta" in json) {
    const { _meta, ...rest } = json as Record<string, unknown>;
    const parsed = ApiMetaSchema.safeParse(_meta);
    if (parsed.success) meta = parsed.data;
    data = rest;
  }
  const bodyWarning = getBodyWarning(data);

  // Fallback: read X-Data-Age header (for array responses or non-cache-handler endpoints)
  if (!meta) {
    const ageHeader = res.headers.get("X-Data-Age");
    if (ageHeader) {
      const age = Number(ageHeader);
      if (Number.isFinite(age) && age >= 0) {
        meta = {
          updatedAt: Math.floor(Date.now() / 1000) - age,
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
      // Preserve warning context even when age metadata is absent.
      meta = {
        updatedAt: Math.floor(Date.now() / 1000),
        ageSeconds: 0,
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

  return { data: validateApiPayload(path, data, schema, contractMode), meta };
}

export async function fetchStablecoinReserves(stablecoinId: string): Promise<StablecoinReservesResponse | null> {
  return apiFetch<StablecoinReservesResponse>(
    API_PATHS.stablecoinReserves(stablecoinId),
    StablecoinReservesResponseSchema,
    undefined,
    undefined,
    { nullOn404: true },
  );
}
