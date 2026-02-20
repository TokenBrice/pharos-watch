export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

/** Fetch JSON from the API. Throws on non-OK responses. */
export async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}
