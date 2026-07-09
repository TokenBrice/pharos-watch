import { describe, expect, it, vi } from "vitest";
import { onRequest as serveAdmin } from "../admin/[[path]].ts";
import { onRequest as serveAdminApi } from "../admin-api/[[path]].ts";
import routes from "../../public/_routes.json";

const SURFACES = [
  { label: "admin", path: "/admin/", marker: "window.__ADMIN__ = true;", onRequest: serveAdmin },
  { label: "admin-api", path: "/admin-api/", marker: "window.__ADMIN_API__ = true;", onRequest: serveAdminApi },
] as const;

describe("ops asset host gates", () => {
  it("keeps both static route families behind Pages Functions", () => {
    expect(routes.include).toContain("/*");
    expect(routes.exclude).not.toEqual(expect.arrayContaining([
      "/admin",
      "/admin/*",
      "/admin-api",
      "/admin-api/*",
    ]));
  });

  for (const surface of SURFACES) {
    it(`${surface.label} returns 404 outside the configured ops host`, async () => {
      const response = await surface.onRequest({
        request: new Request(`https://pharos.watch${surface.path}`),
        env: {
          ASSETS: { fetch: vi.fn() as typeof fetch },
          OPS_UI_ORIGIN: "https://ops.pharos.watch",
        },
      });

      expect(response.status).toBe(404);
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    });

    it(`${surface.label} serves assets only on the configured ops host`, async () => {
      const assetsFetch = vi.fn(async () => new Response("ok", { status: 200 }));
      const response = await surface.onRequest({
        request: new Request(`https://ops.pharos.watch${surface.path}`),
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

    it(`${surface.label} nonce-authorizes inline HTML and strips stale body headers`, async () => {
      const html = `<html><body><script>${surface.marker}</script></body></html>`;
      const assetsFetch = vi.fn(async () =>
        new Response(html, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": String(html.length),
            "Content-Encoding": "gzip",
          },
        }),
      );
      const response = await surface.onRequest({
        request: new Request(`https://ops.pharos.watch${surface.path}`),
        env: {
          ASSETS: { fetch: assetsFetch as typeof fetch },
          OPS_UI_ORIGIN: "https://ops.pharos.watch",
        },
      });

      const scriptSrc = (response.headers.get("Content-Security-Policy") ?? "")
        .split(";")
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith("script-src")) ?? "";
      expect(scriptSrc).toContain("script-src 'self' 'nonce-");
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(response.headers.get("Content-Length")).toBeNull();
      expect(response.headers.get("Content-Encoding")).toBeNull();
      expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
      expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      expect(await response.text()).toMatch(/<script nonce="[^"]+">/);
    });
  }
});
