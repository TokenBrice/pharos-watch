import type { KVNamespace } from "@shared/types/cloudflare-runtime";

export interface SafetyMapEnv {
  SELECTOR_SNAPSHOTS?: KVNamespace;
}

export interface SafetyMapContext {
  request: Request;
  env: SafetyMapEnv;
}

export const SAFETY_MAP_KEY_PREFIX = "safety-map:";
export const SAFETY_MAP_MANIFEST_KEY = `${SAFETY_MAP_KEY_PREFIX}latest.json`;
export const SAFETY_MAP_LATEST_KEY = `${SAFETY_MAP_KEY_PREFIX}latest.png`;
export const SAFETY_MAP_ARCHIVE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const SAFETY_MAP_MANIFEST_MAX_BYTES = 16_384;

export const SAFETY_MAP_LATEST_CACHE_CONTROL =
  "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";
export const SAFETY_MAP_ARCHIVE_CACHE_CONTROL =
  "public, max-age=31536000, s-maxage=31536000, immutable";

export const SAFETY_MAP_JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export const SAFETY_MAP_IMAGE_HEADERS = {
  "Content-Type": "image/png",
  "X-Content-Type-Options": "nosniff",
} as const;

export const SAFETY_MAP_ERROR_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export type SafetyMapReadMethod = "GET" | "HEAD";

export function getSafetyMapReadMethod(request: Request): SafetyMapReadMethod | null {
  const method = request.method.toUpperCase();
  return method === "GET" || method === "HEAD" ? method : null;
}

export function safetyMapJsonResponse(
  status: number,
  body: unknown,
  method: SafetyMapReadMethod,
  headers?: HeadersInit,
): Response {
  return new Response(method === "HEAD" ? null : `${JSON.stringify(body)}\n`, {
    status,
    headers: { ...SAFETY_MAP_JSON_HEADERS, ...headers },
  });
}

export function safetyMapTextError(status: number, message: string, headers?: HeadersInit): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { ...SAFETY_MAP_ERROR_HEADERS, ...headers },
  });
}

export function withoutSafetyMapBody(response: Response): Response {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export type SafetyMapKvReadResult<T> =
  | { ok: true; value: T | null }
  | { ok: false; error: unknown };

export async function readSafetyMapKv<T>(read: () => Promise<T | null>): Promise<SafetyMapKvReadResult<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    console.warn("[safety-map] KV read failure", error);
    return { ok: false, error };
  }
}
