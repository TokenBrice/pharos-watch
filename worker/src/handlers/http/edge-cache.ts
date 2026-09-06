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
  return (await caches.default.match(context.cacheKey)) ?? null;
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
