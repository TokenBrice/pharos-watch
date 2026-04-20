import { isCacheBypassPath } from "@shared/lib/api-endpoints";

interface EdgeCacheContext {
  cacheKey: Request;
  skipCache: boolean;
}

export function createEdgeCacheContext(request: Request, url: URL): EdgeCacheContext {
  return {
    cacheKey: new Request(request.url, { method: "GET" }),
    skipCache: request.method !== "GET" || isCacheBypassPath(url.pathname),
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
      console.warn("[edge-cache] Failed to write response:", err);
    }),
  );
}
