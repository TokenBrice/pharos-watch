import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import type { KVNamespace } from "@shared/types/cloudflare-runtime";
import { buildDailySocialTweetText, buildDailySocialAltText, type DailySocialSnapshot } from "@shared/lib/daily-social";
import { getDailySocialEdition } from "@shared/lib/daily-social-schedule";
import { onRequest } from "../social-posts/[[path]]";
import { onRequest as serveEvergreenPreview } from "../og/v2/[[path]]";
import { SOCIAL_PREVIEW_ASSET_OBJECT_PREFIX } from "@shared/lib/social-preview-storage";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
async function context(path: string, bytes = png, overrides: Record<string, unknown> = {}) {
  const at = Date.parse("2026-09-14T12:00:00Z") / 1000;
  const date = /^\d{4}-\d{2}-\d{2}/.exec(path)?.[0] ?? "2026-09-14";
  const snapshot: DailySocialSnapshot = {
    schemaVersion: 1, ...getDailySocialEdition(Date.parse(`${date}T12:00:00Z`) / 1000 || at), editionDate: date,
    scheduledAt: Date.parse(`${date}T12:00:00Z`) / 1000 || at,
    capturedAt: (Date.parse(`${date}T12:00:00Z`) / 1000 || at) - 600, asOf: (Date.parse(`${date}T12:00:00Z`) / 1000 || at) - 900,
    title: "Growth", subtitle: "Seven-day change", unit: "usd",
    rows: [{ id: "usdc-circle", name: "USD Coin", symbol: "USDC", value: 1000000, context: "+1%" }],
    highlights: [], source: "Pharos", methodology: "Seven-day dollar growth.",
  };
  const imageSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", png)), (b) => b.toString(16).padStart(2, "0")).join("");
  const manifest = { schemaVersion: 1, snapshot, imageSha256, tweetText: buildDailySocialTweetText(snapshot), altText: buildDailySocialAltText(snapshot), ...overrides };
  const get = vi.fn(async (key: string): Promise<ReadableStream<unknown> | null> => new Response(key.endsWith(".json") ? JSON.stringify(manifest) : new Uint8Array(bytes)).body);
  return { request: new Request(`https://pharos.watch/social-posts/${path}`), env: { SELECTOR_SNAPSHOTS: { get } as unknown as KVNamespace }, get, imageSha256 };
}
describe("daily social artifacts", () => {
  it.each(["2026-09-14", "2026-09-15", "2026-09-20"])("serves immutable committed graphics for any day: %s", async (date) => {
    const ctx = await context(`${date}.png`);
    const response = await onRequest(ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(ctx.get).toHaveBeenNthCalledWith(1, `daily-social:${date}.json`, "stream");
    expect(ctx.get).toHaveBeenNthCalledWith(2, `daily-social:${date}:${ctx.imageSha256}.png`, "stream");
  });
  it.each(["2026-02-30.png", "latest.png", "2026-09-14.svg"])("rejects invalid edition paths: %s", async (path) => {
    const ctx = await context(path);
    expect((await onRequest(ctx)).status).toBe(404);
    expect(ctx.get).not.toHaveBeenCalled();
  });
  it("never serves an uncommitted orphan PNG", async () => {
    const ctx = await context("2026-09-14.png");
    ctx.get.mockResolvedValueOnce(null);
    expect((await onRequest(ctx)).status).toBe(404);
    expect(ctx.get).toHaveBeenCalledTimes(1);
  });
  it("serves manifests without fetching the image", async () => {
    const ctx = await context("2026-09-14.json");
    expect((await onRequest(ctx)).status).toBe(200);
    expect(ctx.get).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized streams, non-PNG content and checksum mismatches", async () => {
    for (const bytes of [new Uint8Array(5 * 1024 * 1024 + 1), new TextEncoder().encode("<html>error</html>"), new Uint8Array([...png, 1])]) {
      const response = await onRequest(await context("2026-09-14.png", bytes));
      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
  it.each(["manifest", "image"])("rejects malformed %s stream chunks", async (artifact) => {
    const ctx = await context("2026-09-14.png");
    const cancel = vi.fn();
    const malformed = new ReadableStream<unknown>({
      start(controller) { controller.enqueue("not bytes"); },
      cancel,
    });
    if (artifact === "image") {
      const manifest = await ctx.get(`daily-social:2026-09-14.json`);
      ctx.get.mockClear();
      ctx.get.mockResolvedValueOnce(manifest);
    }
    ctx.get.mockResolvedValueOnce(malformed);
    const response = await onRequest(ctx);
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cancel).toHaveBeenCalledOnce();
    expect(ctx.get).toHaveBeenCalledTimes(artifact === "manifest" ? 1 : 2);
  });
  it("rejects corrupted manifest copy", async () => {
    expect((await onRequest(await context("2026-09-14.json", png, { tweetText: "manipulated" }))).status).toBe(502);
  });
});

async function evergreenContext(kind: "rendered" | "authored" = "rendered") {
  let bytes = await sharp({ create: { width: 1200, height: 630, channels: 4, background: "#15283b" } }).png().toBuffer();
  const source = "a".repeat(64);
  if (kind === "rendered") {
    const data = Buffer.from(`pharos-source-sha256\0${source}`);
    const chunk = Buffer.alloc(data.length + 12);
    chunk.writeUInt32BE(data.length);
    chunk.write("tEXt", 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    bytes = Buffer.concat([bytes.subarray(0, -12), chunk, bytes.subarray(-12)]);
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  const semanticHash = kind === "rendered" ? "b".repeat(64) : hash;
  const filename = `old-route-${semanticHash}.png`;
  const customMetadata: Record<string, string> = {
    "png-sha256": hash, "source-fingerprint": kind === "rendered" ? source : hash, "semantic-hash": semanticHash, kind,
  };
  const stored = { arrayBuffer: async () => Uint8Array.from(bytes).buffer, text: async () => "", customMetadata };
  const get = vi.fn(async () => stored as typeof stored | null);
  const put = vi.fn(async () => { throw new Error("reader must never write"); });
  const next = vi.fn(async (_input?: Request | string, _init?: RequestInit) => new Response(null, { status: 404 }));
  return {
    request: new Request(`https://pharos.watch/og/v2/${filename}`),
    env: { SOCIAL_PREVIEWS: { get, put } }, next, get, bytes, hash, filename, customMetadata,
  };
}

describe("permanent evergreen preview assets", () => {
  it("serves actual current static output before consulting permanent storage", async () => {
    const ctx = await evergreenContext();
    ctx.next.mockImplementation(async () => new Response(Uint8Array.from(ctx.bytes), { headers: { "Content-Type": "image/png" } }));
    const response = await serveEvergreenPreview(ctx);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(ctx.bytes);
    expect(response.headers.get("etag")).toBe(`"${ctx.hash}"`);
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(ctx.get).not.toHaveBeenCalled();
  });

  it.each(["rendered", "authored"] as const)("resolves a removed/rolled-back identity from its permanent object (%s)", async (kind) => {
    const ctx = await evergreenContext(kind);
    const response = await serveEvergreenPreview(ctx);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(ctx.bytes);
    expect(ctx.get).toHaveBeenCalledExactlyOnceWith(`${SOCIAL_PREVIEW_ASSET_OBJECT_PREFIX}${ctx.filename}`);
    expect(ctx.env.SOCIAL_PREVIEWS.put).not.toHaveBeenCalled();
  });

  it("preserves verified GET/HEAD and weak/list/wildcard ETag semantics", async () => {
    const ctx = await evergreenContext();
    ctx.request = new Request(ctx.request, { method: "HEAD" });
    const head = await serveEvergreenPreview(ctx);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(ctx.bytes.length));
    expect((ctx.next.mock.calls[0][0] as Request).method).toBe("GET");
    for (const method of ["GET", "HEAD"]) {
      for (const etag of [`"${ctx.hash}"`, `"other", W/"${ctx.hash}"`, "*"]) {
        ctx.request = new Request(ctx.request.url, { method, headers: { "If-None-Match": etag } });
        const response = await serveEvergreenPreview(ctx);
        expect(response.status).toBe(304);
        expect(await response.text()).toBe("");
        expect(response.headers.get("etag")).toBe(`"${ctx.hash}"`);
        expect((ctx.next.mock.calls.at(-1)?.[0] as Request).headers.has("if-none-match")).toBe(false);
      }
    }
  });

  it.each(["nested/file", "../secret", "home-deadbeef.png", `home-${"a".repeat(64)}.svg`, `home-${"A".repeat(64)}.png`])("rejects noncanonical or unsafe filenames (%s)", async (path) => {
    const ctx = await evergreenContext();
    ctx.request = new Request(`https://pharos.watch/og/v2/${path}`);
    expect((await serveEvergreenPreview(ctx)).status).toBe(404);
    expect(ctx.next).not.toHaveBeenCalled();
    expect(ctx.get).not.toHaveBeenCalled();
  });

  it("returns explicit no-store failures without root/live/corruption fallback", async () => {
    const ctx = await evergreenContext();
    ctx.request = new Request(ctx.request, { method: "POST" });
    const method = await serveEvergreenPreview(ctx);
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET, HEAD");
    ctx.request = new Request(ctx.request.url);
    expect((await serveEvergreenPreview({ ...ctx, env: {} })).status).toBe(503);
    ctx.get.mockResolvedValueOnce(null);
    expect((await serveEvergreenPreview(ctx)).status).toBe(404);
    ctx.next.mockImplementationOnce(async () => new Response("<html>root fallback</html>", { headers: { "Content-Type": "text/html" } }));
    ctx.get.mockClear();
    const corruptStatic = await serveEvergreenPreview(ctx);
    expect(corruptStatic.status).toBe(502);
    expect(corruptStatic.headers.get("cache-control")).toBe("no-store");
    expect(ctx.get).not.toHaveBeenCalled();
    ctx.next.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    expect((await serveEvergreenPreview(ctx)).status).toBe(502);
    expect(ctx.get).not.toHaveBeenCalled();
  });

  it("rejects corrupted PNG bytes, source stamps and object identity metadata", async () => {
    const ctx = await evergreenContext();
    for (const field of ["png-sha256", "source-fingerprint", "semantic-hash", "kind"]) {
      const original = ctx.customMetadata[field];
      ctx.customMetadata[field] = "c".repeat(64);
      const response = await serveEvergreenPreview(ctx);
      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
      ctx.customMetadata[field] = original;
    }
    ctx.bytes[0] = 0;
    expect((await serveEvergreenPreview(ctx)).status).toBe(502);
  });
});
