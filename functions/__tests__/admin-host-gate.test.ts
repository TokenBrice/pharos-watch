import { describe, expect, it, vi } from "vitest";
import { onRequest } from "../admin/[[path]].ts";

describe("admin host gate", () => {
  it("returns 404 outside the configured ops host", async () => {
    const response = await onRequest({
      request: new Request("https://pharos.watch/admin/"),
      env: {
        ASSETS: { fetch: vi.fn() as typeof fetch },
        OPS_UI_ORIGIN: "https://ops.pharos.watch",
      },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("serves the asset on the configured ops host", async () => {
    const assetsFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const response = await onRequest({
      request: new Request("https://ops.pharos.watch/admin/"),
      env: {
        ASSETS: { fetch: assetsFetch as typeof fetch },
        OPS_UI_ORIGIN: "https://ops.pharos.watch",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await response.text()).toBe("ok");
    expect(assetsFetch).toHaveBeenCalledTimes(1);
  });

  it("nonce-authorizes inline scripts in served admin HTML", async () => {
    const html = "<html><body><script>window.__ADMIN__ = true;</script></body></html>";
    const assetsFetch = vi.fn(async () =>
      new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Content-Length": String(html.length) },
      }),
    );
    const response = await onRequest({
      request: new Request("https://ops.pharos.watch/admin/"),
      env: {
        ASSETS: { fetch: assetsFetch as typeof fetch },
        OPS_UI_ORIGIN: "https://ops.pharos.watch",
      },
    });

    const csp = response.headers.get("Content-Security-Policy") ?? "";
    const scriptSrc = csp
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("script-src")) ?? "";
    expect(scriptSrc).toContain("script-src 'self' 'nonce-");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await response.text()).toMatch(/<script nonce="[^"]+">window\.__ADMIN__ = true;<\/script>/);
  });
});
