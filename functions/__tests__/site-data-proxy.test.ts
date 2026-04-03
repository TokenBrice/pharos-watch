import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onRequest } from "../_site-data/[[path]].ts";

const BASE_ENV = {
  SITE_ORIGIN: "https://pharos.watch",
  OPS_UI_ORIGIN: "https://ops.pharos.watch",
  SITE_API_ORIGIN: "https://site-api.pharos.watch",
  SITE_API_SHARED_SECRET: "shared-secret",
};

describe("site-data proxy", () => {
  const cacheMatch = vi.fn();
  const cachePut = vi.fn(async () => undefined);

  beforeEach(() => {
    cacheMatch.mockReset();
    cachePut.mockReset();
    vi.stubGlobal("caches", {
      default: {
        match: cacheMatch,
        put: cachePut,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("rejects requests from non-site hosts", async () => {
    const response = await onRequest({
      request: new Request("https://example.com/_site-data/stablecoins"),
      env: BASE_ENV,
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(404);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("rejects non-allowlisted paths", async () => {
    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoin-summary/usdt-tether"),
      env: BASE_ENV,
      params: { path: ["stablecoin-summary", "usdt-tether"] },
    });

    expect(response.status).toBe(404);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("enforces GET-only method rules", async () => {
    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", { method: "POST" }),
      env: BASE_ENV,
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("returns a cached response without re-fetching upstream", async () => {
    cacheMatch.mockResolvedValueOnce(new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins"),
      env: BASE_ENV,
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ cached: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("proxies allowlisted requests to the site API with the shared secret", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=60",
        "Content-Type": "application/json",
        Warning: '110 - "stale"',
        "X-Data-Age": "12",
      },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://ops.pharos.watch/_site-data/stablecoin/usdt-tether?detail=true", {
        headers: { Accept: "application/json" },
      }),
      env: BASE_ENV,
      params: { path: ["stablecoin", "usdt-tether"] },
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://site-api.pharos.watch/api/stablecoin/usdt-tether?detail=true",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );

    const fetchInit = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const forwardedHeaders = fetchInit.headers as Headers;
    expect(forwardedHeaders.get("Accept")).toBe("application/json");
    expect(forwardedHeaders.get("X-Pharos-Site-Proxy-Secret")).toBe("shared-secret");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(response.headers.get("Warning")).toContain("stale");
    expect(response.headers.get("X-Data-Age")).toBe("12");
    expect(cachePut).toHaveBeenCalledTimes(1);
  });

  it("falls back to the public API origin when SITE_API_ORIGIN is unset", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins"),
      env: { ...BASE_ENV, SITE_API_ORIGIN: undefined },
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.pharos.watch/api/stablecoins",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
  });

  it("returns 500 when the site-proxy secret is missing", async () => {
    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins"),
      env: { ...BASE_ENV, SITE_API_SHARED_SECRET: " " },
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Site API proxy is not configured" });
  });
});
