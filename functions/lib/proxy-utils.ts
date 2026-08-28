import { createJsonErrorResponse } from "@shared/lib/http-response";

/**
 * Shared proxy utilities for Cloudflare Pages Function handlers.
 * Used by both the ops-admin proxy and the site-data proxy.
 */

/** Return a JSON error response with no-store cache control. */
export function jsonError(status: number, message: string, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("Cache-Control")) responseHeaders.set("Cache-Control", "no-store");
  return createJsonErrorResponse(status, message, {
    headers: responseHeaders,
  });
}

/** Normalize a fetch error into a loggable kind/message pair. */
export function summarizeFetchError(error: unknown): { kind: string; message: string } {
  if (error instanceof DOMException) {
    return { kind: error.name, message: error.message };
  }
  if (error instanceof Error) {
    return { kind: error.name, message: error.message };
  }
  return { kind: typeof error, message: String(error) };
}

export function isHtmlResponse(response: Response): boolean {
  return response.headers.get("Content-Type")?.toLowerCase().includes("text/html") ?? false;
}

/**
 * Build upstream request headers by forwarding a set of client headers
 * and appending auth/service headers.
 */
export function buildUpstreamHeaders(
  request: Request,
  forwardedHeaders: readonly string[],
  authHeaders: Record<string, string>,
): Headers {
  const headers = new Headers();
  for (const name of forwardedHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  for (const [k, v] of Object.entries(authHeaders)) headers.set(k, v);
  return headers;
}

/**
 * Build a proxy response by forwarding a set of upstream response headers.
 * Optionally null out the body for HEAD requests and set a default Cache-Control.
 * Preserve Retry-After by default so degraded upstream backoff semantics survive
 * the Pages proxy layers.
 */
export function buildProxyResponse(
  upstreamRes: Response,
  forwardedHeaders: readonly string[],
  options?: { method?: string; defaultCacheControl?: string },
): Response {
  const headers = new Headers();
  for (const name of forwardedHeaders) {
    const value = upstreamRes.headers.get(name);
    if (value) headers.set(name, value);
  }
  const retryAfter = upstreamRes.headers.get("Retry-After");
  if (retryAfter) {
    headers.set("Retry-After", retryAfter);
  }
  if (!headers.has("Cache-Control") && options?.defaultCacheControl) {
    headers.set("Cache-Control", options.defaultCacheControl);
  }
  return new Response(options?.method === "HEAD" ? null : upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers,
  });
}
