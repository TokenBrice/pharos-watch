import { vi } from "vitest";

export { hmacSha256Hex } from "../../lib/api-key-core";

type ApiRequestOptions = {
  method?: string;
  adminKey?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
};

function normalizeApiPath(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  if (path.startsWith("/")) return `https://x${path}`;
  return `https://x/${path}`;
}

export function makeApiUrl(path: string): URL {
  return new URL(normalizeApiPath(path));
}

export function makeApiRequest(path: string, options: ApiRequestOptions = {}): Request {
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
        waits.push(promise);
      }),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext,
  };
}
