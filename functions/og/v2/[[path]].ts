import { bufferReadableStream } from "@shared/lib/bounded-stream";
import {
  SOCIAL_PREVIEW_ASSET_CACHE_CONTROL,
  SOCIAL_PREVIEW_ASSET_MAX_BYTES,
  readSocialPreviewPngSource,
  socialPreviewAssetIdentity,
  verifySocialPreviewAsset,
} from "@shared/lib/social-preview-asset";
import type { SocialPreviewBucket } from "@shared/lib/social-preview-storage";

interface Context {
  request: Request;
  env: { SOCIAL_PREVIEWS?: SocialPreviewBucket };
  next: (input?: Request | string, init?: RequestInit) => Promise<Response>;
}

/** Current export first; previously published identities survive replacement/rollback in permanent R2. */
export async function onRequest({ request, env, next }: Context): Promise<Response> {
  const fail = (status: number) => new Response(null, {
    status, headers: { "Cache-Control": "no-store", ...(status === 405 ? { Allow: "GET, HEAD" } : {}) },
  });
  if (request.method !== "GET" && request.method !== "HEAD") return fail(405);
  const identity = socialPreviewAssetIdentity(new URL(request.url).pathname);
  if (!identity) return fail(404);
  try {
    // Read complete static bytes even for HEAD/conditional requests: a 304 or
    // cached metadata alone cannot establish PNG integrity. Never fetch a live image.
    const staticHeaders = new Headers(request.headers);
    for (const header of ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "range", "if-range"]) staticHeaders.delete(header);
    const staticResponse = await next(new Request(request, { method: "GET", headers: staticHeaders }));
    let bytes: Uint8Array<ArrayBuffer>;
    let hash: string;
    if (staticResponse.status === 200) {
      if (staticResponse.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "image/png" || !staticResponse.body) {
        await staticResponse.body?.cancel();
        return fail(502);
      }
      bytes = (await bufferReadableStream(staticResponse.body, { maxBytes: SOCIAL_PREVIEW_ASSET_MAX_BYTES })).bytes;
      readSocialPreviewPngSource(bytes);
      hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    } else {
      await staticResponse.body?.cancel();
      if (staticResponse.status !== 404) return fail(502);
      if (!env.SOCIAL_PREVIEWS) return fail(503);
      const stored = await env.SOCIAL_PREVIEWS.get(identity.key);
      if (!stored) return fail(404);
      bytes = new Uint8Array(await stored.arrayBuffer());
      hash = await verifySocialPreviewAsset(bytes, identity, stored.customMetadata);
    }
    const etag = `"${hash}"`;
    const headers = {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": SOCIAL_PREVIEW_ASSET_CACHE_CONTROL,
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    };
    const notModified = request.headers.get("if-none-match")?.split(",").some((value) => {
      const candidate = value.trim();
      return candidate === "*" || candidate.replace(/^W\//, "") === etag;
    });
    if (notModified) return new Response(null, { status: 304, headers });
    return new Response(request.method === "HEAD" ? null : bytes, { headers });
  } catch {
    return fail(502);
  }
}
