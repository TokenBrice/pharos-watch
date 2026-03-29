import { z, type ZodType } from "zod";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { STRICT_CONTRACT_PATHS_LIST } from "@shared/lib/api-endpoints";
import { FRESHNESS_RATIOS } from "@shared/lib/status-thresholds";
import { resolvePublicApiBase } from "@shared/lib/runtime-origins";

export type ApiContractMode = "strict" | "warn";

export function resolveApiBase(
  hostname?: string | null,
  envBase: string | undefined = process.env.NEXT_PUBLIC_API_BASE,
): string {
  return resolvePublicApiBase(hostname, envBase);
}

const browserHostname = typeof window !== "undefined" ? window.location.hostname : null;
export const API_BASE = resolveApiBase(browserHostname);

export const STRICT_CONTRACT_PATHS = new Set(STRICT_CONTRACT_PATHS_LIST);

export function buildApiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function buildRequestUrl(path: string): string {
  if (path.startsWith("/api/admin/")) {
    return path;
  }
  return buildApiUrl(path);
}

function apiRequest(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(buildRequestUrl(path), init);
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

function formatIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string {
  return issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join(", ");
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

// --- Data freshness metadata ---

export interface ApiMeta {
  updatedAt: number;
  ageSeconds: number;
  status: "fresh" | "degraded" | "stale";
  warning?: string | null;
}

const ApiMetaSchema = z.object({
  updatedAt: z.number(),
  ageSeconds: z.number(),
  status: z.enum(["fresh", "degraded", "stale"]),
  warning: z.string().nullish(),
});

function resolveContractMode(
  schema: ZodType<unknown> | undefined,
  mode: ApiContractMode | undefined,
): ApiContractMode | null {
  if (!schema) return null;
  return mode ?? "strict";
}

function validateApiPayload<T>(
  path: string,
  data: unknown,
  schema?: ZodType<T>,
  contractMode?: ApiContractMode,
): T {
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

export interface ApiFetchOptions {
  nullOn404?: boolean;
}

/** Fetch JSON from the API. Throws on non-OK responses.
 *  When a Zod schema is provided, validates the response and warns on mismatch
 *  (graceful degradation — returns data as-is on failure). */
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
  const res = await apiRequest(path, init);
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
): Promise<{ data: T; meta: ApiMeta | null }> {
  const res = await apiRequest(path, init);
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

  // Fallback: read X-Data-Age header (for array responses or non-cache-handler endpoints)
  if (!meta) {
    const ageHeader = res.headers.get("X-Data-Age");
    if (ageHeader) {
      const age = Number(ageHeader);
      if (Number.isFinite(age) && age >= 0) {
        const ratio = age / maxAgeSec;
        const status = ratio <= FRESHNESS_RATIOS.FRESH ? "fresh" : ratio <= FRESHNESS_RATIOS.DEGRADED ? "degraded" : "stale";
        meta = { updatedAt: Math.floor(Date.now() / 1000) - age, ageSeconds: age, status };
      }
    }
  }

  const warningHeader = res.headers.get("Warning");
  if (warningHeader) {
    if (meta) {
      meta = { ...meta, warning: warningHeader };
    } else {
      // Preserve warning context even when age metadata is absent.
      meta = {
        updatedAt: Math.floor(Date.now() / 1000),
        ageSeconds: 0,
        status: "degraded",
        warning: warningHeader,
      };
    }
  }

  return { data: validateApiPayload(path, data, schema, contractMode), meta };
}

export async function fetchStablecoinReserves(stablecoinId: string): Promise<import("@shared/types").StablecoinReservesResponse | null> {
  return apiFetch<import("@shared/types").StablecoinReservesResponse>(
    API_PATHS.stablecoinReserves(stablecoinId),
    undefined,
    undefined,
    undefined,
    { nullOn404: true },
  );
}
