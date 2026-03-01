import type { ZodType } from "zod";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

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
