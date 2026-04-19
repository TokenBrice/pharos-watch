import { describe, expect, it, vi } from "vitest";
import { onRequest, prefersMarkdown } from "../_middleware";

function makeAssetsFetch(files: Record<string, string>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname;
    const body = files[path];
    if (body === undefined) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/html" },
      });
    }
    const type = path.endsWith(".md") ? "text/markdown" : "text/html";
    return new Response(body, { status: 200, headers: { "Content-Type": type } });
  });
}

function ctx(request: Request, assetsFiles: Record<string, string>) {
  const env = { ASSETS: { fetch: makeAssetsFetch(assetsFiles) } };
  const next = vi.fn(async () => {
    const asPath = new URL(request.url).pathname;
    const body = assetsFiles[asPath] ?? assetsFiles[`${asPath}index.html`];
    if (!body) return new Response("Not Found", { status: 404 });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
  });
  return { request, env, next };
}

describe("prefersMarkdown", () => {
  it.each([
    ["text/markdown", true],
    ["text/x-markdown; Q = 0.8, text/html; q=0.4", true],
    ["text/html,text/markdown;q=0.5", false],
    ["text/markdown;q=0", false],
    ["text/html;q=0,text/markdown;q=0", false],
    ["*/*", false],
    ["text/markdown;q=not-a-number", false],
  ])("parses %s", (accept, expected) => {
    expect(prefersMarkdown(accept)).toBe(expected);
  });
});

describe("pages middleware markdown negotiation", () => {
  const files = {
    "/stablecoin/usdt-tether/index.html": "<html>USDT HTML</html>",
    "/stablecoin/usdt-tether/index.md": "# USDT Markdown",
  };

  it("serves markdown when Accept: text/markdown matches a variant", async () => {
    const req = new Request("https://pharos.watch/stablecoin/usdt-tether/", {
      headers: { Accept: "text/markdown" },
    });
    const res = await onRequest(ctx(req, files));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/markdown/);
    expect(res.headers.get("Vary")).toContain("Accept");
    expect(res.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe("# USDT Markdown");
  });

  it("serves markdown headers for HEAD without a body", async () => {
    const req = new Request("https://pharos.watch/stablecoin/usdt-tether/", {
      method: "HEAD",
      headers: { Accept: "text/markdown" },
    });
    const res = await onRequest(ctx(req, files));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/markdown/);
    expect(res.headers.get("Vary")).toContain("Accept");
    expect(await res.text()).toBe("");
  });

  it("falls through to HTML when Accept header is missing", async () => {
    const req = new Request("https://pharos.watch/stablecoin/usdt-tether/");
    const res = await onRequest(ctx(req, files));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(res.headers.get("Vary")).toContain("Accept");
  });

  it("falls through to HTML when Accept prefers HTML", async () => {
    const req = new Request("https://pharos.watch/stablecoin/usdt-tether/", {
      headers: { Accept: "text/html,text/markdown;q=0.5" },
    });
    const res = await onRequest(ctx(req, files));
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
  });

  it("preserves Vary: Accept-Encoding while adding a distinct Accept token", async () => {
    const req = new Request("https://pharos.watch/stablecoin/usdt-tether/");
    const next = vi.fn(async () =>
      new Response("<html>USDT HTML</html>", {
        status: 200,
        headers: { "Content-Type": "text/html", Vary: "Accept-Encoding" },
      }),
    );
    const res = await onRequest({
      request: req,
      env: { ASSETS: { fetch: makeAssetsFetch(files) } },
      next,
    });
    expect(res.headers.get("Vary")).toBe("Accept-Encoding, Accept");
  });

  it("does not rewrite to markdown for unsupported route prefixes", async () => {
    const req = new Request("https://pharos.watch/about/", {
      headers: { Accept: "text/markdown" },
    });
    const res = await onRequest(ctx(req, { "/about/index.html": "<html>About</html>" }));
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    expect(res.headers.get("Vary")).toBeNull();
  });

  it("passes through /api/* untouched", async () => {
    const req = new Request("https://pharos.watch/api/stablecoins", {
      headers: { Accept: "text/markdown" },
    });
    const { env, next } = ctx(req, {});
    await onRequest({ request: req, env, next });
    expect(next).toHaveBeenCalled();
  });

  it("falls through gracefully when the .md variant is missing", async () => {
    const req = new Request("https://pharos.watch/stablecoin/not-found/", {
      headers: { Accept: "text/markdown" },
    });
    const res = await onRequest(ctx(req, { "/stablecoin/not-found/index.html": "<html>HTML</html>" }));
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
  });
});
