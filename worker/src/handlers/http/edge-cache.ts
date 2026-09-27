import { isCacheKeyQueryFreePath } from "@shared/lib/api-endpoints";
import { isCacheableGetRequest } from "./cache-eligibility";
import { logWorkerEvent } from "../../lib/structured-log";
interface EdgeCacheContext {
  cacheKey: Request;
  skipCache: boolean;
}

function createCacheKeyRequest(request: Request, url: URL): Request {
  if (url.pathname.startsWith("/api/og/") || isCacheKeyQueryFreePath(url.pathname)) {
    const canonicalUrl = new URL(request.url);
    canonicalUrl.search = "";
    return new Request(canonicalUrl.toString(), { method: "GET" });
  }

  return new Request(request.url, { method: "GET" });
}

export function createEdgeCacheContext(request: Request, url: URL): EdgeCacheContext {
  return {
    cacheKey: createCacheKeyRequest(request, url),
    skipCache: !isCacheableGetRequest(request, url),
  };
}

export async function readEdgeCache(context: EdgeCacheContext): Promise<Response | null> {
  if (context.skipCache) return null;
  const response = await caches.default.match(context.cacheKey);
  if (!response) return null;
  const cacheControl = response.headers.get("Cache-Control") ?? "";
  const ttl = cacheControl.match(/\bs-maxage\s*=\s*(\d+)/i)
    ?? cacheControl.match(/\bmax-age\s*=\s*(\d+)/i);
  if (ttl) {
    const date = Date.parse(response.headers.get("Date") ?? "");
    const age = Number(response.headers.get("Age") ?? 0);
    const elapsed = Number.isFinite(date) ? Math.max(0, (Date.now() - date) / 1000) : 0;
    // Do not reset Date/Age or re-assess the body's generation-time verdict.
    // Both dispatch lanes must miss once the bounded shared lifetime ends.
    if (Math.max(elapsed, Number.isFinite(age) ? age : 0) >= Number(ttl[1])) return null;
  }
  return response;
}

export function writeEdgeCache(
  context: EdgeCacheContext,
  response: Response,
  execCtx: ExecutionContext,
): void {
  if (context.skipCache || !response.ok) return;
  const cacheControl = response.headers.get("Cache-Control")?.toLowerCase() ?? "";
  if (
    cacheControl.includes("no-store") ||
    cacheControl.includes("no-cache") ||
    cacheControl.includes("private")
  ) {
    return;
  }
  execCtx.waitUntil(
    caches.default.put(context.cacheKey, response.clone()).catch((err) => {
      logWorkerEvent({
        scope: "http",
        level: "warn",
        event: "edge_cache_write_failed",
        route: new URL(context.cacheKey.url).pathname,
        message: "Edge cache write failed",
        error: err,
      });
    }),
  );
}
