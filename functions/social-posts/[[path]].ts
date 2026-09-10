import type { KVNamespace } from "@shared/types/cloudflare-runtime";
import { bufferReadableStream } from "@shared/lib/bounded-stream";
import { DailySocialManifestSchema } from "@shared/lib/daily-social-manifest";

interface Context {
  request: Request;
  env: { SELECTOR_SNAPSHOTS?: KVNamespace };
}

/** Immutable daily graphics and their manifest (published last as a commit marker). */
export async function onRequest({ request, env }: Context): Promise<Response> {
  const fail = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });
  if (request.method !== "GET" && request.method !== "HEAD") return fail(405);
  const match = /^\/social-posts\/(\d{4}-\d{2}-\d{2})\.(png|json)$/.exec(new URL(request.url).pathname);
  if (!match) return fail(404);
  const [, date, extension] = match;
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) return fail(404);
  if (!env.SELECTOR_SNAPSHOTS) return fail(503);
  try {
    const manifestStream = await env.SELECTOR_SNAPSHOTS.get(`daily-social:${date}.json`, "stream");
    if (!manifestStream) return fail(404);
    const manifestBytes = (await bufferReadableStream(manifestStream, { maxBytes: 32_768 })).bytes;
    const manifest = DailySocialManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
    if (manifest.snapshot.editionDate !== date) return fail(502);
    let bytes = manifestBytes;
    if (extension === "png") {
      const stream = await env.SELECTOR_SNAPSHOTS.get(`daily-social:${date}:${manifest.imageSha256}.png`, "stream");
      if (!stream) return fail(404);
      bytes = (await bufferReadableStream(stream, { maxBytes: 5 * 1024 * 1024 })).bytes;
      if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return fail(502);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (sha256 !== manifest.imageSha256) return fail(502);
    }
    return new Response(request.method === "HEAD" ? null : bytes, {
      headers: {
        "Content-Type": extension === "png" ? "image/png" : "application/json; charset=utf-8",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex",
      },
    });
  } catch {
    return fail(502);
  }
}
