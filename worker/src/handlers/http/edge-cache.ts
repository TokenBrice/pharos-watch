import { isCacheKeyQueryFreePath } from "@shared/lib/api-endpoints";
import { isCacheableGetRequest } from "./cache-eligibility";
import { logWorkerEvent } from "../../lib/structured-log";
import { isResponseWithinFreshLifetime } from "../../lib/api-response";
interface EdgeCacheContext {
  cacheKey: Request;
  skipCache: boolean;
}

function createCacheKeyRequest(request: Request, url: URL): Request {
  // A bare GET strips Range and all conditionals. Cache API must return the
  // complete stored 200 so our own lifetime admission precedes any 304 decision.
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
  if (response.status !== 200) return null;
  const cacheControl = response.headers.get("Cache-Control") ?? "";
  if (/\b(?:no-store|no-cache|private)\b/i.test(cacheControl)) return null;
  // Retain the original assessment Date/Age, including multi-producer bounds.
  if (!isResponseWithinFreshLifetime(response)) return null;
  return response;
}

export function writeEdgeCache(
  context: EdgeCacheContext,
  response: Response,
  execCtx: ExecutionContext,
): void {
  if (context.skipCache || response.status !== 200) return;
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
