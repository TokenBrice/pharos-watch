import { afterEach, describe, expect, it, vi } from "vitest";
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

const LEGACY_METADATA = { "png-sha256": "a".repeat(64), "source-fingerprint": "b".repeat(64), "semantic-hash": "c".repeat(64), kind: "rendered" };
async function evergreenContext(customMetadata: Record<string, string> = LEGACY_METADATA) {
  // A tEXt chunk stands in for the source stamp older objects carry; it is never parsed.
  const plain = await sharp({ create: { width: 1200, height: 630, channels: 4, background: "#15283b" } }).png().toBuffer();
  const text = Buffer.from("pharos-source-sha256\0legacy");
  const chunk = Buffer.alloc(text.length + 12);
  chunk.writeUInt32BE(text.length);
  chunk.write("tEXt", 4);
  text.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const bytes = Buffer.concat([plain.subarray(0, -12), chunk, plain.subarray(-12)]);
  const hash = createHash("sha256").update(bytes).digest("hex"), filename = `image-${"d".repeat(64)}.png`;
  const stored = { arrayBuffer: async () => Uint8Array.from(bytes).buffer, text: async () => "", customMetadata };
  const get = vi.fn(async () => stored as typeof stored | null);
  const put = vi.fn(async () => { throw new Error("reader must never write"); });
  const next = vi.fn(async (_input?: Request | string, _init?: RequestInit) => new Response(null, { status: 404 }));
  return { request: new Request(`https://pharos.watch/og/v2/${filename}`), env: { SOCIAL_PREVIEWS: { get, put } }, next, get, bytes, hash, filename };
}

describe("permanent evergreen preview assets", () => {
  it("serves actual current static output before consulting permanent storage", async () => {
    const ctx = await evergreenContext();
    ctx.next.mockImplementation(async () => new Response(Uint8Array.from(ctx.bytes), { headers: { "Content-Type": "image/png" } }));
    const response = await serveEvergreenPreview(ctx);
    expect([response.status, response.headers.get("etag"), response.headers.has("x-robots-tag")]).toEqual([200, `"${ctx.hash}"`, false]);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(ctx.bytes);
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(ctx.get).not.toHaveBeenCalled();
  });

  it.each([["legacy", LEGACY_METADATA], ["current", { "png-sha256": "e".repeat(64) }], ["no", {}]])("resolves a removed/rolled-back identity from R2 whatever its metadata (%s)", async (_generation, metadata) => {
    const ctx = await evergreenContext(metadata);
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

  it.each(["static", "stored"])("rejects corrupted or truncated %s PNG bytes", async (source) => {
    for (const corrupt of [(bytes: Buffer) => { bytes[0] = 0; return bytes; }, (bytes: Buffer) => bytes.subarray(0, -12)]) {
      const ctx = await evergreenContext();
      const bytes = Uint8Array.from(corrupt(ctx.bytes));
      if (source === "static") ctx.next.mockImplementation(async () => new Response(bytes, { headers: { "Content-Type": "image/png" } }));
      else ctx.get.mockResolvedValue({ arrayBuffer: async () => bytes.buffer, text: async () => "", customMetadata: {} });
      const response = await serveEvergreenPreview(ctx);
      expect(response.status).toBe(502);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  afterEach(() => vi.unstubAllGlobals());

  it("serves POP caches.default hits, populates via waitUntil, and fails open on cache errors", async () => {
    const ctx = await evergreenContext();
    const store = new Map<string, { bytes: Uint8Array; status: number; headers: Headers }>();
    const match = vi.fn(async (req: Request) => {
      const e = store.get(req.url);
      return e ? new Response(e.bytes.slice(), { status: e.status, headers: new Headers(e.headers) }) : undefined;
    });
    const put = vi.fn(async (req: Request, res: Response) => {
      store.set(req.url, { bytes: new Uint8Array(await res.arrayBuffer()), status: res.status, headers: new Headers(res.headers) });
    });
    vi.stubGlobal("caches", { default: { match, put } });
    const pending: Promise<unknown>[] = [], waitUntil = vi.fn((p: Promise<unknown>) => { pending.push(p); });
    const miss = await serveEvergreenPreview({ ...ctx, request: new Request(`${ctx.request.url}?utm=1`), waitUntil });
    expect([miss.status, Buffer.from(await miss.arrayBuffer())]).toEqual([200, ctx.bytes]);
    expect(waitUntil).toHaveBeenCalledOnce();
    await Promise.all(pending);
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0][0].url).toBe(`https://pharos.watch/og/v2/${ctx.filename}`);
    ctx.next.mockClear(); ctx.get.mockClear();
    const hit = await serveEvergreenPreview({ ...ctx, request: new Request(`${ctx.request.url}?other=2`) });
    expect([hit.status, Buffer.from(await hit.arrayBuffer())]).toEqual([200, ctx.bytes]);
    expect(ctx.next).not.toHaveBeenCalled(); expect(ctx.get).not.toHaveBeenCalled();
    const notMod = await serveEvergreenPreview({ ...ctx, request: new Request(ctx.request.url, { headers: { "If-None-Match": `W/"${ctx.hash}"` } }) });
    expect([notMod.status, await notMod.text()]).toEqual([304, ""]);
    const head = await serveEvergreenPreview({ ...ctx, request: new Request(ctx.request.url, { method: "HEAD" }) });
    expect([head.status, await head.text(), head.headers.get("etag")]).toEqual([200, "", `"${ctx.hash}"`]);
    expect(ctx.next).not.toHaveBeenCalled();
    match.mockRejectedValueOnce(new Error("cache read failed"));
    put.mockRejectedValueOnce(new Error("cache write failed"));
    const fallback = await serveEvergreenPreview({ ...ctx, waitUntil });
    expect([fallback.status, Buffer.from(await fallback.arrayBuffer())]).toEqual([200, ctx.bytes]);
    await Promise.all(pending);
    expect(ctx.get).toHaveBeenCalledOnce();
  });
});
