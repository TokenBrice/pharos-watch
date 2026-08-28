import { expect, vi } from "vitest";

export { hmacSha256Hex } from "../../lib/api-key-core";

type ApiRequestOptions = {
  method?: string;
  adminKey?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
};

function normalizeApiPath(path: string | URL): string {
  if (path instanceof URL) return path.toString();
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  if (path.startsWith("/")) return `https://x${path}`;
  return `https://x/${path}`;
}

export function makeApiUrl(path: string): URL {
  return new URL(normalizeApiPath(path));
}

export function makeApiRequest(path: string | URL, options: ApiRequestOptions = {}): Request {
  const { method = "GET", adminKey, headers, body } = options;
  const resolvedHeaders = new Headers(headers);
  const requestUrl = adminKey
    ? normalizeApiPath(path).replace("https://x", "https://ops-api.pharos.watch")
    : normalizeApiPath(path);
  if (adminKey) {
    resolvedHeaders.set("Cf-Access-Authenticated-User-Email", "test-operator@pharos.watch");
    // Admin mutations require the X-Pharos-Admin header (CSRF hardening).
    const upper = method.toUpperCase();
    if (upper === "POST" || upper === "PUT" || upper === "PATCH" || upper === "DELETE") {
      if (!resolvedHeaders.has("X-Pharos-Admin")) {
        resolvedHeaders.set("X-Pharos-Admin", "1");
      }
    }
  }
  return new Request(requestUrl, {
    method,
    headers: resolvedHeaders,
    body,
  });
}

export function makeJsonRequest(
  path: string | URL,
  body: unknown,
  options: Omit<ApiRequestOptions, "body"> = {},
): Request {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  return makeApiRequest(path, {
    ...options,
    method: options.method ?? "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export function makeJsonBodyRequest(
  path: string | URL,
  body: BodyInit,
  options: Omit<ApiRequestOptions, "body"> = {},
): Request {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  return makeApiRequest(path, {
    ...options,
    method: options.method ?? "POST",
    headers,
    body,
  });
}

export async function readJsonResponse<T = unknown>(response: Response, expectedStatus: number): Promise<T> {
  expect(response.status).toBe(expectedStatus);
  return (await response.json()) as T;
}

/**
 * Shared auth-test crypto stub used by handlers that call requireAdmin().
 */
export function stubCryptoForAuth(): void {
  vi.stubGlobal("crypto", crypto);
}

export function makeExecutionContext() {
  const waits: Promise<unknown>[] = [];
  return {
    waits,
    ctx: {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        waits.push(Promise.resolve(promise));
      }),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext,
  };
}
