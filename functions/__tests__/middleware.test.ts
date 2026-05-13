import { describe, expect, it, vi } from "vitest";
import { buildContentSecurityPolicy, onRequest, prefersMarkdown } from "../_middleware";

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
    const type = asPath.endsWith(".md") ? "text/markdown" : "text/html";
    return new Response(body, { status: 200, headers: { "Content-Type": type } });
  });
  return { request, env, next };
}

function scriptSrc(csp: string | null): string {
  return csp
    ?.split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("script-src ")) ?? "";
}

describe("prefersMarkdown", () => {
  it.each([
    ["text/markdown", true],
    ["text/x-markdown; Q = 0.8, text/html; q=0.4", true],
    ["text/html,text/markdown;q=0.5", false],
    ["*/*;q=1, text/markdown;q=0.2", false],
    ["text/*;q=0.8, text/markdown;q=0.4", false],
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
    expect(res.headers.get("X-Robots-Tag")).toBeNull();
    expect(res.headers.get("Link")).toBeNull();
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
    expect(scriptSrc(res.headers.get("Content-Security-Policy"))).not.toContain("'unsafe-inline'");
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
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self' 'nonce-");
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

  it.each([
    ["/methodology/index.md", "/methodology/"],
    ["/stablecoin/usdt-tether/index.md", "/stablecoin/usdt-tether/"],
    ["/changelog/index.md", "/changelog/"],
    ["/digest/2026-05-12/index.md", "/digest/2026-05-12/"],
    ["/docs/report-cards/index.md", "/docs/report-cards/"],
  ])("marks direct generated markdown asset %s as noindex with canonical link", async (path, canonicalPath) => {
    const req = new Request(`https://preview.stablecoin-dashboard.pages.dev${path}`);
    const res = await onRequest(ctx(req, { [path]: "# Markdown export" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/markdown/);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, follow");
    expect(res.headers.get("Link")).toBe(`<https://pharos.watch${canonicalPath}>; rel="canonical"`);
    expect(await res.text()).toBe("# Markdown export");
  });

  it("marks direct generated markdown asset HEAD responses without a body", async () => {
    const path = "/docs/report-cards/index.md";
    const req = new Request(`https://pharos.watch${path}`, { method: "HEAD" });
    const res = await onRequest(ctx(req, { [path]: "# Report cards" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, follow");
    expect(res.headers.get("Link")).toBe('<https://pharos.watch/docs/report-cards/>; rel="canonical"');
    expect(await res.text()).toBe("");
  });

  it("does not noindex unrelated markdown assets", async () => {
    const req = new Request("https://pharos.watch/about/index.md");
    const res = await onRequest(ctx(req, { "/about/index.md": "# About" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toBeNull();
    expect(res.headers.get("Link")).toBeNull();
  });

  it("adds nonce-backed CSP to inline scripts while leaving external script hosts allowlisted", async () => {
    const req = new Request("https://pharos.watch/");
    const html = [
      "<html><head>",
      "<script>window.__INLINE_ONE__ = true;</script>",
      "<script src=\"/_next/static/chunks/app.js\"></script>",
      "<script type=\"application/ld+json\">{\"@context\":\"https://schema.org\"}</script>",
      "</head></html>",
    ].join("");

    const res = await onRequest(ctx(req, { "/index.html": html }));
    const body = await res.text();
    const csp = res.headers.get("Content-Security-Policy") ?? "";

    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("https://www.googletagmanager.com");
    expect(csp).toContain("https://static.cloudflareinsights.com");
    expect(scriptSrc(csp)).not.toContain("'unsafe-inline'");
    expect(res.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(body).toMatch(/<script nonce="[^"]+">window\.__INLINE_ONE__ = true;<\/script>/);
    expect(body).toContain('<script src="/_next/static/chunks/app.js"></script>');
    expect(body).toMatch(/<script nonce="[^"]+" type="application\/ld\+json">/);
  });

  it("sets CSP on HEAD responses without trying to transform a body", async () => {
    const req = new Request("https://pharos.watch/", { method: "HEAD" });
    const res = await onRequest(ctx(req, { "/index.html": "<html><script>1</script></html>" }));
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self' 'nonce-");
    expect(await res.text()).toBe("");
  });

  it("keeps the static fallback CSP free of unsafe inline script execution", () => {
    expect(buildContentSecurityPolicy("abc123")).toBe(
      "default-src 'self'; script-src 'self' 'nonce-abc123' 'unsafe-eval' https://www.googletagmanager.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' https://coin-images.coingecko.com https://www.google-analytics.com https://*.google-analytics.com https://analytics.google.com https://*.analytics.google.com https://pbs.twimg.com https://abs.twimg.com data:; connect-src 'self' https://api.pharos.watch https://www.google-analytics.com https://*.google-analytics.com https://analytics.google.com https://*.analytics.google.com https://*.googletagmanager.com; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
  });
});
