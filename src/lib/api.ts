import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { isRecord } from "@shared/lib/type-guards";
import {
  ApiDependencyMetaSchema,
  ApiMetaEnvelopeSchema,
  ApiMetaWarningOnlySchema,
  type ApiDependencyMeta,
  type ApiMetaEnvelope,
} from "@shared/types/api-meta";
import type { StablecoinReservesResponse } from "@shared/types";
import type { SupplyHistoryPoint } from "@shared/types/market";
import type { QueryClient } from "@tanstack/react-query";
import { buildRequestUrl } from "@/lib/api-url";
import {
  FRONTEND_API_QUERY_DESCRIPTORS,
  STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS,
  type StablecoinLiveSummary,
} from "@/lib/api-query-descriptors";
import { formatSchemaLikeIssues, type SchemaLike } from "@shared/lib/schema-like";
import { normalizeRequestTimeoutMs, resolveRequestSignal } from "@/lib/request-lifecycle";

export { API_BASE, buildApiUrl, buildRequestUrl, resolveApiBase } from "@/lib/api-url";

export type ApiMeta = ApiMetaEnvelope;

export interface StablecoinDetailSnapshot {
  version: 1;
  stablecoinId: string;
  generatedAt: number;
  lanes: {
    liveSummary?: StablecoinLiveSummary;
    supplyHistory?: SupplyHistoryPoint[];
  };
}

/** Seed only coin-scoped detail queries without resetting their producer clocks. */
export function seedStablecoinDetailQueryCache(
  queryClient: QueryClient,
  snapshot: StablecoinDetailSnapshot,
): void {
  const updatedAt = snapshot.generatedAt;
  const seedIfCurrent = <T>(queryKey: readonly unknown[], data: T): void => {
    const existingState = queryClient.getQueryState<T>(queryKey);
    if ((existingState?.dataUpdatedAt ?? 0) > updatedAt) return;
    queryClient.setQueryData(queryKey, data, { updatedAt });
  };

  if (snapshot.lanes.liveSummary) {
    seedIfCurrent(
      FRONTEND_API_QUERY_DESCRIPTORS.stablecoinLiveSummary(snapshot.stablecoinId).queryKey,
      snapshot.lanes.liveSummary,
    );
  }

  if (snapshot.lanes.supplyHistory) {
    seedIfCurrent(
      FRONTEND_API_QUERY_DESCRIPTORS.supplyHistory(
        snapshot.stablecoinId,
        STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS,
      ).queryKey,
      snapshot.lanes.supplyHistory,
    );
  }
}

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
  const edgeAgeHeader = headers.get("Age");
  const parsedEdgeAge = edgeAgeHeader ? Number(edgeAgeHeader) : 0;
  const edgeAgeSeconds = Number.isFinite(parsedEdgeAge) && parsedEdgeAge >= 0
    ? parsedEdgeAge
    : 0;
  const dateHeader = headers.get("Date");
  const serverDateMs = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  const referenceNowSec = Number.isFinite(serverDateMs)
    ? Math.floor(serverDateMs / 1000) + edgeAgeSeconds
    : Math.floor(Date.now() / 1000);
  return Math.max(0, Math.floor(referenceNowSec - ageSeconds - edgeAgeSeconds));
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
  const parsed = ApiDependencyMetaSchema.safeParse({
    ...value,
    updatedAt: typeof value.updatedAt === "number" || value.updatedAt === null ? value.updatedAt : undefined,
    ageSeconds: typeof value.ageSeconds === "number" || value.ageSeconds === null ? value.ageSeconds : undefined,
    reason: typeof value.reason === "string" || value.reason === null ? value.reason : undefined,
  });
  return parsed.success ? parsed.data : null;
}

function normalizeApiMeta(value: unknown): ApiMeta | null {
  if (!isRecord(value)) return null;

  const dependencies: Record<string, ApiDependencyMeta> = {};
  if (isRecord(value.dependencies)) {
    for (const [key, raw] of Object.entries(value.dependencies)) {
      const dependency = normalizeApiDependencyMeta(raw);
      if (dependency) dependencies[key] = dependency;
    }
  }

  const parsed = ApiMetaEnvelopeSchema.safeParse({
    ...value,
    warning: typeof value.warning === "string" || value.warning === null ? value.warning : undefined,
    dependencies: Object.keys(dependencies).length > 0 ? dependencies : undefined,
  });
  return parsed.success ? parsed.data : null;
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
  _maxAgeSec = 900,
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

  // Fill a missing producer clock from headers (for array responses,
  // warning-only body metadata, or non-cache-handler endpoints).
  if (meta?.updatedAt === undefined) {
    const ageHeader = res.headers.get("X-Data-Age");
    if (ageHeader) {
      const age = Number(ageHeader);
      if (Number.isFinite(age) && age >= 0) {
        meta = {
          updatedAt: resolveResponseUpdatedAtSec(res.headers, age),
          ageSeconds: age,
          status: meta?.status ?? "fresh",
          ...(meta?.warning ? { warning: meta.warning } : {}),
        };
      }
    }
  }

  const warningHeader = res.headers.get("Warning");
  if (warningHeader) {
    if (meta) {
      meta =
        meta.updatedAt !== undefined && meta.ageSeconds !== undefined
          ? {
              ...meta,
              updatedAt: meta.updatedAt,
              ageSeconds: meta.ageSeconds,
              warning: warningHeader,
            }
          : ApiMetaWarningOnlySchema.parse({ status: "degraded", warning: warningHeader });
    } else {
      // Preserve warning context without inventing freshness timestamps.
      meta = ApiMetaWarningOnlySchema.parse({
        status: "degraded",
        warning: warningHeader,
      });
    }
  }
  if (bodyWarning && !meta?.warning) {
    meta = meta
      ? { ...meta, warning: bodyWarning }
      : ApiMetaWarningOnlySchema.parse({ status: "degraded", warning: bodyWarning });
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
