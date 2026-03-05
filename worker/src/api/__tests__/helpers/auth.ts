import { vi } from "vitest";

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
  if (adminKey) {
    resolvedHeaders.set("X-Admin-Key", adminKey);
  }
  return new Request(normalizeApiPath(path), {
    method,
    headers: resolvedHeaders,
    body,
  });
}

/**
 * Shared auth-test crypto stub used by handlers that call requireAdmin().
 */
export function stubCryptoForAuth(): void {
  vi.stubGlobal("crypto", {
    subtle: {
      digest: async (_algo: string, data: ArrayBuffer) => data,
      timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => {
        const av = new Uint8Array(a);
        const bv = new Uint8Array(b);
        if (av.length !== bv.length) return false;
        return av.every((byte, i) => byte === bv[i]);
      },
    },
  });
}
