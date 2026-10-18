import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { withPublicApiAcceptMarker } from "@/lib/api-request-policy";
import { isRecord } from "@shared/lib/type-guards";
import {
  ApiDependencyMetaSchema,
  ApiMetaEnvelopeSchema,
  ApiMetaWarningOnlySchema,
  type ApiDependencyMeta,
  type ApiMetaEnvelope,
} from "@pharos/contracts/api-meta";
import type { StablecoinReservesResponse } from "@shared/types";
import type { SupplyHistoryPoint } from "@shared/types/market";
import type { QueryClient } from "@tanstack/react-query";
import { buildRequestUrl } from "@/lib/api-url";
import {
  FRONTEND_API_QUERY_DESCRIPTORS,
  STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS,
} from "@/lib/api-query-descriptors";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import { formatSchemaLikeIssues, resolveSchemaLike, type SchemaLike, type SchemaLikeSource } from "@shared/lib/schema-like";
import { requestResponse } from "@/lib/request";
import { claimDataBootstrap } from "@/lib/data-bootstrap";

export { API_BASE, buildApiUrl, buildRequestUrl, resolveApiBase } from "@/lib/api-url";

export type ApiMeta = ApiMetaEnvelope;

export interface StablecoinDetailSnapshot {
  version: 1;
  stablecoinId: string;
  generatedAt: number;
  /** Per-lane producer timestamps in milliseconds; generatedAt is artifact provenance only. */
  updatedAt: { liveSummary?: number; supplyHistory?: number };
  lanes: {
    liveSummary?: StablecoinLiveSummary;
    supplyHistory?: SupplyHistoryPoint[];
  };
}
const detailSnapshotReads = new WeakMap<object, { dataUpdateCount: number; errorUpdateCount: number }>();

/** A real success/error settles a seed permanently, including across route remounts. */
export function isDetailSnapshotQuery(queryClient: QueryClient, queryKey: readonly unknown[]): boolean {
  const state = queryClient.getQueryState<object>(queryKey);
  const seeded = state?.data && detailSnapshotReads.get(state.data);
  return Boolean(state && seeded
    && state.dataUpdateCount === seeded.dataUpdateCount
    && state.errorUpdateCount === seeded.errorUpdateCount);
}


/** Seed only coin-scoped detail queries without resetting their producer clocks. */
export function seedStablecoinDetailQueryCache(
  queryClient: QueryClient,
  snapshot: StablecoinDetailSnapshot,
): void {
  const seedIfCurrent = <T>(queryKey: readonly unknown[], data: T, sourceUpdatedAt: number | undefined): void => {
    // Old artifacts without source clocks may render, but must immediately refetch.
    const updatedAt = sourceUpdatedAt != null && Number.isFinite(sourceUpdatedAt) && sourceUpdatedAt > 0
      ? sourceUpdatedAt
      : 0;
    const existingState = queryClient.getQueryState<{ data: T; meta: ApiMeta | null }>(queryKey);
    const existingUpdatedAt = existingState?.data?.meta?.updatedAt;
    if (existingUpdatedAt != null && existingUpdatedAt * 1000 >= updatedAt) return;
    const meta: ApiMeta = updatedAt > 0
      ? { updatedAt: updatedAt / 1000, ageSeconds: Math.max(0, (Date.now() - updatedAt) / 1000), status: "fresh" }
      : { updatedAt: null, ageSeconds: null, status: "unknown", reason: "snapshot-producer-timestamp-unavailable" };
    const envelope = queryClient.setQueryData(queryKey, { data, meta }, { updatedAt });
    const state = queryClient.getQueryState(queryKey);
    if (envelope && state) {
      detailSnapshotReads.set(envelope, {
        dataUpdateCount: state.dataUpdateCount,
        errorUpdateCount: state.errorUpdateCount,
      });
    }
  };

  if (snapshot.lanes.liveSummary) {
    seedIfCurrent(
      FRONTEND_API_QUERY_DESCRIPTORS.stablecoinLiveSummary(snapshot.stablecoinId).queryKey,
      snapshot.lanes.liveSummary,
      snapshot.updatedAt?.liveSummary,
    );
  }

  if (snapshot.lanes.supplyHistory) {
    seedIfCurrent(
      FRONTEND_API_QUERY_DESCRIPTORS.supplyHistory(
        snapshot.stablecoinId,
        STABLECOIN_DETAIL_SUPPLY_HISTORY_DAYS,
      ).queryKey,
      snapshot.lanes.supplyHistory,
      snapshot.updatedAt?.supplyHistory,
    );
  }
}

export type ApiContractMode = "strict" | "warn";

export interface ApiRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number | null;
  bootstrapQueryKey?: readonly unknown[];
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

/** Consume the response inside the request's timeout and cancellation lifetime. */
export async function apiRequest<T>(
  path: string,
  handleResponse: (response: Response) => Promise<T>,
  init?: RequestInit,
  options?: ApiRequestOptions,
): Promise<T> {
  const requestInit = withPublicApiAcceptMarker(path, init);
  const result = await requestResponse(buildRequestUrl(path, requestInit), {
    init: requestInit,
    signal: options?.signal,
    timeoutMs: options?.timeoutMs,
    signalPolicy: "explicit-over-init",
    errorMode: "passthrough",
    timeoutMessage: (timeoutMs) => `API request timed out after ${timeoutMs}ms`,
    allowHttpError: true,
  }, handleResponse);
  return result.data;
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

/** Both parser-started and ordinary reads enter the same JSON/error/meta pipeline. */
async function readApiJson(
  path: string,
  init?: RequestInit,
  options?: ApiRequestOptions,
  nullOn404?: boolean,
): Promise<{ res: Pick<Response, "headers">; json: unknown } | null> {
  const requestInit = withPublicApiAcceptMarker(path, init);
  const adopted = options?.timeoutMs === undefined
    ? claimDataBootstrap(options?.bootstrapQueryKey, buildRequestUrl(path, requestInit), {
        ...requestInit,
        signal: options?.signal ?? requestInit?.signal,
      })
    : undefined;
  if (adopted) {
    const body = await adopted;
    if (body.status < 200 || body.status >= 300) {
      if (nullOn404 && body.status === 404) return null;
      throw new ApiFetchError(path, body.status, body.bodyText);
    }
    return { res: { headers: new Headers(body.headers) }, json: JSON.parse(body.bodyText ?? "") as unknown };
  }
  return apiRequest(path, async (res) => {
    if (!res.ok) {
      if (nullOn404 && res.status === 404) return null;
      throw await buildFetchError(path, res);
    }
    const json: unknown = await res.json();
    return { res, json };
  }, init, options);
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
  schema?: SchemaLikeSource<T>,
  init?: RequestInit,
  contractMode?: ApiContractMode,
): Promise<T>;
/** Overload: passing `{ nullOn404: true }` makes the return type `T | null`. */
export async function apiFetch<T>(
  path: string,
  schema: SchemaLikeSource<T> | undefined,
  init: RequestInit | undefined,
  contractMode: ApiContractMode | undefined,
  options: ApiFetchOptions & { nullOn404: true },
): Promise<T | null>;
/** Overload: request options without `nullOn404` preserve the non-null return type. */
export async function apiFetch<T>(
  path: string,
  schema: SchemaLikeSource<T> | undefined,
  init: RequestInit | undefined,
  contractMode: ApiContractMode | undefined,
  options: ApiFetchOptions & { nullOn404?: false },
): Promise<T>;
export async function apiFetch<T>(
  path: string,
  schema?: SchemaLikeSource<T>,
  init?: RequestInit,
  contractMode?: ApiContractMode,
  options?: ApiFetchOptions,
): Promise<T | null> {
  const [payload, resolvedSchema] = await Promise.all([
    readApiJson(path, init, options, options?.nullOn404),
    resolveSchemaLike(schema),
  ]);
  (options?.signal ?? init?.signal)?.throwIfAborted();
  if (payload === null) return null;
  return validateApiPayload(path, payload.json, resolvedSchema, contractMode);
}

// --- Meta-aware fetch ---

/** Fetch JSON + extract freshness metadata from _meta field or X-Data-Age header. */
export async function apiFetchWithMeta<T>(
  path: string,
  schema?: SchemaLikeSource<T>,
  init?: RequestInit,
  contractMode?: ApiContractMode,
  requestOptions?: ApiRequestOptions,
): Promise<{ data: T; meta: ApiMeta | null }> {
  const [payload, resolvedSchema] = await Promise.all([
    readApiJson(path, init, requestOptions),
    resolveSchemaLike(schema),
  ]);
  (requestOptions?.signal ?? init?.signal)?.throwIfAborted();
  const { res, json } = payload!;

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

  const ageHeader = res.headers.get("X-Data-Age");
  const updatedAtHeader = res.headers.get("X-Data-Updated-At");
  const freshnessHeader = res.headers.get("X-Data-Freshness");
  const headerStatus = freshnessHeader === "stale" || freshnessHeader === "degraded" ? freshnessHeader : "fresh";
  const unknownClockMeta = (): ApiMeta => ({
    updatedAt: null,
    ageSeconds: null,
    status: freshnessHeader === "stale" ? "stale" : "unknown",
    reason: res.headers.get("X-Data-Freshness-Reason") ?? "producer-timestamp-unavailable",
  });

  // Header-only responses name their absolute producer clock. A present but
  // invalid clock fails closed instead of falling back to request receipt time.
  if (meta?.updatedAt === undefined) {
    if (ageHeader === "unavailable") {
      meta = unknownClockMeta();
    } else if (updatedAtHeader !== null) {
      const updatedAt = Number(updatedAtHeader);
      meta = updatedAtHeader.trim() !== "" && Number.isFinite(updatedAt) && updatedAt > 0
        ? {
            ...meta,
            updatedAt,
            ageSeconds: Math.max(0, Math.floor(Date.now() / 1000) - updatedAt),
            status: meta?.status ?? headerStatus,
          }
        : unknownClockMeta();
    } else if (ageHeader !== null) {
      const age = Number(ageHeader);
      meta = ageHeader.trim() !== "" && Number.isFinite(age) && age >= 0
        ? {
            ...meta,
            updatedAt: resolveResponseUpdatedAtSec(res.headers, age),
            ageSeconds: age,
            status: meta?.status ?? headerStatus,
          }
        : unknownClockMeta();
    }
  }

  const warningHeader = res.headers.get("Warning");
  if (warningHeader) {
    if (meta) {
      meta =
        meta.updatedAt !== undefined && meta.ageSeconds !== undefined
          ? { ...meta, warning: warningHeader }
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
  return { data: validateApiPayload(path, data, resolvedSchema, contractMode), meta };
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
