import type { ZodType } from "zod";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

// --- Data freshness metadata ---

export interface ApiMeta {
  updatedAt: number;
  ageSeconds: number;
  status: "fresh" | "degraded" | "stale";
}

// --- Standard fetch (no meta) ---

/** Fetch JSON from the API. Throws on non-OK responses.
 *  When a Zod schema is provided, validates the response and warns on mismatch
 *  (graceful degradation — returns data as-is on failure). */
export async function apiFetch<T>(path: string, schema?: ZodType<T>): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);

  const data: unknown = await res.json();

  if (schema) {
    const result = schema.safeParse(data);
    if (!result.success) {
      console.warn(
        `[API] Schema validation failed for ${path}:`,
        result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      );
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
): Promise<{ data: T; meta: ApiMeta | null }> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);

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

  // Schema validation (same graceful degradation as apiFetch)
  if (schema) {
    const result = schema.safeParse(data);
    if (!result.success) {
      console.warn(
        `[API] Schema validation failed for ${path}:`,
        result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "),
      );
      return { data: data as T, meta };
    }
    return { data: result.data, meta };
  }

  return { data: data as T, meta };
}
