import type { ZodType } from "zod";
import { STRICT_CONTRACT_PATHS_LIST } from "@shared/lib/strict-contract-paths";

export function resolveApiBase(
  hostname?: string | null,
  envBase: string | undefined = process.env.NEXT_PUBLIC_API_BASE,
): string {
  const explicit = (envBase ?? "").trim();
  if (explicit) return explicit;
  if (!hostname) return "";

  if (
    hostname === "pharos.watch" ||
    hostname.endsWith(".pharos.watch") ||
    hostname === "stablecoin-dashboard.pages.dev" ||
    hostname.endsWith(".stablecoin-dashboard.pages.dev")
  ) {
    return "https://api.pharos.watch";
  }

  return "";
}

const browserHostname = typeof window !== "undefined" ? window.location.hostname : null;
export const API_BASE = resolveApiBase(browserHostname);

export const STRICT_CONTRACT_PATHS = new Set(STRICT_CONTRACT_PATHS_LIST);

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

function normalizePath(path: string): string {
  try {
    return new URL(path, API_BASE || "http://localhost").pathname;
  } catch {
    return path.split("?")[0] ?? path;
  }
}

function formatIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string {
  return issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join(", ");
}

function isStrictContractPath(path: string): boolean {
  return STRICT_CONTRACT_PATHS.has(normalizePath(path));
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

// --- Standard fetch (no meta) ---

/** Fetch JSON from the API. Throws on non-OK responses.
 *  When a Zod schema is provided, validates the response and warns on mismatch
 *  (graceful degradation — returns data as-is on failure). */
export async function apiFetch<T>(
  path: string,
  schema?: ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) throw await buildFetchError(path, res);

  const data: unknown = await res.json();

  if (schema) {
    const result = schema.safeParse(data);
    if (!result.success) {
      const issues = formatIssues(result.error.issues);
      if (isStrictContractPath(path)) {
        throw new SchemaValidationError(path, issues);
      }
      console.warn(`[API] Schema validation failed for ${path}:`, issues);
      return data as T;
    }
    return result.data;
  }

  return data as T;
}

// --- Meta-aware fetch ---

/** Fetch JSON + extract freshness metadata from _meta field or X-Data-Age header. */
export async function apiFetchWithMeta<T>(
  path: string,
  schema?: ZodType<T>,
  init?: RequestInit,
): Promise<{ data: T; meta: ApiMeta | null }> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) throw await buildFetchError(path, res);

  const json: unknown = await res.json();

  // Extract _meta from response body (injected by createCacheHandler for object responses)
  let meta: ApiMeta | null = null;
  let data = json;
  if (json && typeof json === "object" && !Array.isArray(json) && "_meta" in json) {
    const { _meta, ...rest } = json as Record<string, unknown>;
    meta = _meta as ApiMeta;
    data = rest;
  }

  // Fallback: read X-Data-Age header (for array responses or non-cache-handler endpoints)
  if (!meta) {
    const ageHeader = res.headers.get("X-Data-Age");
    if (ageHeader) {
      const age = parseInt(ageHeader, 10);
      if (!isNaN(age)) {
        // Use 900s as default maxAge, compute ratio-based status like worker's buildFreshnessMeta
        const maxAge = 900;
        const ratio = age / maxAge;
        const status = ratio <= 1 ? "fresh" : ratio <= 1.5 ? "degraded" : "stale";
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

  // Schema validation (same graceful degradation as apiFetch)
  if (schema) {
    const result = schema.safeParse(data);
    if (!result.success) {
      const issues = formatIssues(result.error.issues);
      if (isStrictContractPath(path)) {
        throw new SchemaValidationError(path, issues);
      }
      console.warn(`[API] Schema validation failed for ${path}:`, issues);
      return { data: data as T, meta };
    }
    return { data: result.data, meta };
  }

  return { data: data as T, meta };
}
