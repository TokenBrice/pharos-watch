import { bufferReadableStream } from "@shared/lib/bounded-stream";
import {
  SOCIAL_PREVIEW_ASSET_CACHE_CONTROL,
  SOCIAL_PREVIEW_ASSET_MAX_BYTES,
  assertSocialPreviewPng,
  socialPreviewAssetIdentity,
} from "@shared/lib/social-preview-asset";
import type { SocialPreviewBucket } from "@shared/lib/social-preview-storage";

interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

interface Context {
  request: Request;
  env: { SOCIAL_PREVIEWS?: SocialPreviewBucket };
  next: (input?: Request | string, init?: RequestInit) => Promise<Response>;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** POP cache -> current export (when bundled) -> permanent R2 archive. */
export async function onRequest({ request, env, next, waitUntil }: Context): Promise<Response> {
  const fail = (status: number) => new Response(null, {
    status, headers: { "Cache-Control": "no-store", ...(status === 405 ? { Allow: "GET, HEAD" } : {}) },
  });
  if (request.method !== "GET" && request.method !== "HEAD") return fail(405);
  const identity = socialPreviewAssetIdentity(new URL(request.url).pathname);
  if (!identity) return fail(404);
  const matchesIfNoneMatch = (etag: string | null): boolean => {
    if (!etag) return false;
    const target = etag.replace(/^W\//, "");
    return Boolean(request.headers.get("if-none-match")?.split(",").some((value) => {
      const candidate = value.trim();
      return candidate === "*" || candidate.replace(/^W\//, "") === target;
    }));
  };
  const canonicalUrl = new URL(`/og/v2/${identity.filename}`, request.url).toString();
  const cacheKey = new Request(canonicalUrl, { method: "GET" });
  const edgeCache = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;
  if (edgeCache) {
    try {
      const cached = await edgeCache.match(cacheKey);
      if (cached && cached.status === 200) {
        const cachedEtag = cached.headers.get("etag");
        if (cachedEtag) {
          if (matchesIfNoneMatch(cachedEtag)) {
            await cached.body?.cancel();
            return new Response(null, { status: 304, headers: cached.headers });
          }
          if (request.method === "HEAD") {
            await cached.body?.cancel();
            return new Response(null, { status: 200, headers: cached.headers });
          }
          return cached;
        }
      }
      await cached?.body?.cancel();
    } catch {
      // Cache API failures must fail open to static assets / R2.
    }
  }
  try {
    // Read complete static bytes even for HEAD/conditional requests: a 304 or
    // cached metadata alone cannot establish PNG integrity. Never fetch a live image.
    const staticHeaders = new Headers(request.headers);
    for (const header of ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "range", "if-range"]) staticHeaders.delete(header);
    const staticResponse = await next(new Request(request, { method: "GET", headers: staticHeaders }));
    let bytes: Uint8Array<ArrayBuffer>;
    if (staticResponse.status === 200) {
      if (staticResponse.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "image/png" || !staticResponse.body) {
        await staticResponse.body?.cancel();
        return fail(502);
      }
      bytes = (await bufferReadableStream(staticResponse.body, { maxBytes: SOCIAL_PREVIEW_ASSET_MAX_BYTES })).bytes;
    } else {
      await staticResponse.body?.cancel();
      if (staticResponse.status !== 404) return fail(502);
      if (!env.SOCIAL_PREVIEWS) return fail(503);
      // Objects from every publisher generation are served: no metadata is required.
      const stored = await env.SOCIAL_PREVIEWS.get(identity.key);
      if (!stored) return fail(404);
      bytes = new Uint8Array(await stored.arrayBuffer());
    }
    assertSocialPreviewPng(bytes);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const etag = `"${hash}"`;
    // Indexable: Article JSON-LD names these images.
    const headers = {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": SOCIAL_PREVIEW_ASSET_CACHE_CONTROL,
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    };
    const notModified = matchesIfNoneMatch(etag);
    if (edgeCache) {
      try {
        const store = Promise.resolve(edgeCache.put(cacheKey, new Response(bytes, { status: 200, headers }))).catch(() => {});
        if (waitUntil) waitUntil(store);
        else await store;
      } catch {
        // Cache write failures must not break a verified image response.
      }
    }
    if (notModified) return new Response(null, { status: 304, headers });
    return new Response(request.method === "HEAD" ? null : bytes, { headers });
  } catch {
    return fail(502);
  }
}
