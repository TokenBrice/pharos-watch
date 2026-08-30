import { describe, expect, it, vi } from "vitest";
import { buildContentSecurityPolicy } from "@shared/lib/site-csp";
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

function imgSrc(csp: string | null): string {
  return csp
    ?.split(";")
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith("img-src ")) ?? "";
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
    ["text/markdown;q=not-a-number", true],
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
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
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

  it("passes through non-negotiable methods before markdown negotiation", async () => {
    const req = new Request("https://pharos.watch/stablecoin/usdt-tether/", {
      method: "POST",
      headers: { Accept: "text/markdown" },
    });
    const next = vi.fn(async () => new Response("POST passthrough", { status: 200 }));

    const response = await onRequest({
      request: req,
      env: { ASSETS: { fetch: makeAssetsFetch(files) } },
      next,
    });

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("POST passthrough");
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
      "<script nonce=\"route-nonce\">window.__INLINE_TWO__ = true;</script>",
      "<script nonce=\"\">window.__INLINE_THREE__ = true;</script>",
      "<script src=\"/_next/static/chunks/app.js\"></script>",
      "<script type=\"application/ld+json\">{\"@context\":\"https://schema.org\"}</script>",
      "</head></html>",
    ].join("");

    const res = await onRequest(ctx(req, { "/index.html": html }));
    const body = await res.text();
    const csp = res.headers.get("Content-Security-Policy") ?? "";

    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("https://www.googletagmanager.com");
    expect(csp).not.toContain("https://static.cloudflareinsights.com");
    expect(imgSrc(csp)).toContain("https://www.googletagmanager.com");
    expect(imgSrc(csp)).toContain("https://*.googletagmanager.com");
    expect(scriptSrc(csp)).not.toContain("'unsafe-inline'");
    expect(res.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(body).toMatch(/<script nonce="[^"]+">window\.__INLINE_ONE__ = true;<\/script>/);
    expect(body).toMatch(/<script nonce="[^"]+">window\.__INLINE_TWO__ = true;<\/script>/);
    expect(body).toMatch(/<script nonce="[^"]+">window\.__INLINE_THREE__ = true;<\/script>/);
    expect(body).not.toContain("route-nonce");
    expect(body).toContain('<script src="/_next/static/chunks/app.js"></script>');
    expect(body).toMatch(/<script nonce="[^"]+" type="application\/ld\+json">/);
  });

  it("sets CSP on HEAD responses without trying to transform a body", async () => {
    const req = new Request("https://pharos.watch/", { method: "HEAD" });
    const res = await onRequest(ctx(req, { "/index.html": "<html><script>1</script></html>" }));
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self' 'nonce-");
    expect(await res.text()).toBe("");
  });

  it("serves decoded HTML when the client accepts gzip while preserving nonce injection", async () => {
    const req = new Request("https://pharos.watch/", {
      headers: { "Accept-Encoding": "gzip, deflate, br" },
    });
    const html = "<html><head><script>window.__INLINE__ = true;</script></head></html>";
    const res = await onRequest(ctx(req, { "/index.html": html }));

    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Vary")).toContain("Accept-Encoding");
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self' 'nonce-");

    const body = await res.text();
    expect(body).toMatch(/<script nonce="[^"]+">window\.__INLINE__ = true;<\/script>/);
  });

  it("serves plaintext HTML with the nonce when the client does not accept gzip", async () => {
    const req = new Request("https://pharos.watch/", {
      headers: { "Accept-Encoding": "identity" },
    });
    const html = "<html><head><script>window.__INLINE__ = true;</script></head></html>";
    const res = await onRequest(ctx(req, { "/index.html": html }));

    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Vary")).toContain("Accept-Encoding");

    const body = await res.text();
    expect(body).toMatch(/<script nonce="[^"]+">window\.__INLINE__ = true;<\/script>/);
  });

  it("keeps HEAD responses unencoded even when the client accepts gzip", async () => {
    const req = new Request("https://pharos.watch/", {
      method: "HEAD",
      headers: { "Accept-Encoding": "gzip" },
    });
    const res = await onRequest(ctx(req, { "/index.html": "<html><script>1</script></html>" }));

    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self' 'nonce-");
    expect(await res.text()).toBe("");
  });

  it("strips a stale upstream Content-Encoding and serves decoded HTML", async () => {
    const req = new Request("https://pharos.watch/", {
      headers: { "Accept-Encoding": "gzip" },
    });
    // The upstream body has already been decoded (as the local dev asset server
    // hands it to us) but still carries a Content-Encoding header. After reading
    // the text the body is plaintext, so the stale header must not survive.
    const next = vi.fn(async () =>
      new Response("<html><script>1</script></html>", {
        status: 200,
        headers: { "Content-Type": "text/html", "Content-Encoding": "gzip" },
      }),
    );
    const res = await onRequest({
      request: req,
      env: { ASSETS: { fetch: makeAssetsFetch({}) } },
      next,
    });

    expect(res.headers.get("Content-Encoding")).toBeNull();
    const body = await res.text();
    expect(body).toMatch(/<script nonce="[^"]+">1<\/script>/);
  });

  it("allows Telegram bridge script and framing only on the Mini App route", async () => {
    const req = new Request("https://pharos.watch/pharoswatchbot/app/");
    const next = vi.fn(async () =>
      new Response("<html><script>1</script></html>", {
        status: 200,
        headers: { "Content-Type": "text/html", "X-Frame-Options": "DENY" },
      }),
    );
    const res = await onRequest({
      request: req,
      env: { ASSETS: { fetch: makeAssetsFetch({}) } },
      next,
    });
    const csp = res.headers.get("Content-Security-Policy") ?? "";

    expect(scriptSrc(csp)).toContain("https://telegram.org");
    expect(csp).toContain("frame-ancestors https://telegram.org https://*.telegram.org");
    expect(res.headers.get("X-Frame-Options")).toBeNull();
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("keeps the static fallback CSP free of unsafe inline script execution", () => {
    expect(buildContentSecurityPolicy("abc123")).toBe(
      "default-src 'self'; script-src 'self' 'nonce-abc123' https://www.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self' https://coin-images.coingecko.com https://www.google-analytics.com https://*.google-analytics.com https://analytics.google.com https://*.analytics.google.com https://www.googletagmanager.com https://*.googletagmanager.com https://pbs.twimg.com https://abs.twimg.com data:; connect-src 'self' https://api.pharos.watch https://www.google-analytics.com https://*.google-analytics.com https://analytics.google.com https://*.analytics.google.com https://www.googletagmanager.com https://*.googletagmanager.com; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
  });
});
