import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestD1Database } from "../../scripts/test-utils/d1";
import { onRequest } from "../_site-data/[[path]].ts";
import { resetSiteDataRequestAttributionStateForTests } from "../lib/request-attribution";

function makeEnv(db = makeTestD1Database(), overrides: Record<string, unknown> = {}) {
  return {
    DB: db,
    SITE_ORIGIN: "https://pharos.watch",
    OPS_UI_ORIGIN: "https://ops.pharos.watch",
    SITE_API_ORIGIN: "https://site-api.pharos.watch",
    SITE_API_SHARED_SECRET: "shared-secret",
    ...overrides,
  };
}

function makeWaitUntil() {
  const pending: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    pending.push(promise);
  });

  return {
    waitUntil,
    flush: async () => {
      await Promise.all(pending);
    },
  };
}

describe("site-data proxy", () => {
  const cacheMatch = vi.fn();
  const cachePut = vi.fn(async () => undefined);

  beforeEach(() => {
    resetSiteDataRequestAttributionStateForTests();
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
    vi.restoreAllMocks();
  });

  it("rejects requests without Origin or Referer", async () => {
    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins"),
      env: makeEnv(),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(404);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("rejects direct Pages preview requests without Origin or Referer", async () => {
    const response = await onRequest({
      request: new Request("https://stablecoin-dashboard.pages.dev/_site-data/stablecoins"),
      env: makeEnv(),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(404);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("rejects requests from foreign origins", async () => {
    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://evil.example.com" },
      }),
      env: makeEnv(),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(404);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("rejects non-allowlisted paths", async () => {
    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/status", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(),
      params: { path: "status" },
    });

    expect(response.status).toBe(404);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("enforces GET-only method rules", async () => {
    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        method: "POST",
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("never grants an upstream response a second Pages cache lifetime", async () => {
    cacheMatch.mockRejectedValueOnce(new Error("Pages cache unavailable"));
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            Age: "299",
            "Cache-Control": "public, max-age=300",
            "Content-Type": "application/json",
            Date: "Mon, 15 Jun 2026 09:55:01 GMT",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get("Age")).toBe("299");
    expect(response.headers.get("Date")).toBe("Mon, 15 Jun 2026 09:55:01 GMT");
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("forwards conditional requests without consulting a Pages cache", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(null, {
          status: 304,
          headers: { ETag: '"stablecoins-v1"' },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { "If-None-Match": '"stablecoins-v1"', Origin: "https://pharos.watch" },
      }),
      env: makeEnv(),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(304);
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("proxies allowlisted requests to the site API with the shared secret and records an upstream fetch", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Cache-Control": "public, max-age=60",
            "Content-Type": "application/json",
            Warning: '199 - "advisory"',
            "X-Data-Age": "12",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const db = makeTestD1Database();

    const response = await onRequest({
      request: new Request("https://ops.pharos.watch/_site-data/stablecoin-summary/usdt-tether", {
        headers: { Accept: "application/json", Origin: "https://ops.pharos.watch" },
      }),
      env: makeEnv(db),
      params: { path: ["stablecoin-summary", "usdt-tether"] },
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://site-api.pharos.watch/api/stablecoin-summary/usdt-tether",
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
    expect(response.headers.get("Warning")).toContain("advisory");
    expect(response.headers.get("X-Data-Age")).toBe("12");
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
    expect(
      db
        .getHistory()
        .some(
          (entry) =>
            entry.sql.includes("INSERT INTO site_data_request_stats") &&
            entry.binds[1] === "stablecoin-summary" &&
            entry.binds[2] === "/api/stablecoin-summary/:id" &&
            entry.binds[3] === "pages-upstream-fetch" &&
            entry.binds[4] === "site-api" &&
            entry.binds[5] === 1,
        ),
    ).toBe(true);
  });

  it("proxies the events endpoint through the site-data lane for public UI reads", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ events: [] }), {
          status: 200,
          headers: {
            "Cache-Control": "public, max-age=60",
            "Content-Type": "application/json",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/events?limit=1", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(),
      params: { path: "events" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ events: [] });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [upstreamUrl, init] = fetchSpy.mock.calls[0] ?? [];
    expect(upstreamUrl).toBe("https://site-api.pharos.watch/api/events?limit=1");
    expect((init as RequestInit).headers).toBeInstanceOf(Headers);
    expect(((init as RequestInit).headers as Headers).get("X-Pharos-Site-Proxy-Secret")).toBe("shared-secret");
  });

  it("records site-data attribution through waitUntil when the Pages DB binding is present", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Cache-Control": "public, max-age=60",
            "Content-Type": "application/json",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const db = makeTestD1Database();
    const ctx = makeWaitUntil();

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoin/usdt-tether", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(db),
      params: { path: ["stablecoin", "usdt-tether"] },
      waitUntil: ctx.waitUntil,
    });

    expect(response.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalled();

    await ctx.flush();
    expect(
      db
        .getHistory()
        .some(
          (entry) =>
            entry.sql.includes("INSERT INTO site_data_request_stats") &&
            entry.binds[1] === "stablecoin-detail" &&
            entry.binds[2] === "/api/stablecoin/:id" &&
            entry.binds[3] === "pages-upstream-fetch" &&
            entry.binds[4] === "site-api" &&
            entry.binds[5] === 1,
        ),
    ).toBe(true);
  });

  it("honors the route/source attribution kill switch for Pages site-data requests", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Cache-Control": "public, max-age=60",
            "Content-Type": "application/json",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const db = makeTestD1Database();

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(db, { REQUEST_SOURCE_ATTRIBUTION_DISABLED: "true" }),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(200);
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO site_data_request_stats"))).toBe(false);
  });

  it("proxies site-data requests when Pages attribution DB is not bound", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Cache-Control": "public, max-age=60",
            "Content-Type": "application/json",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(makeTestD1Database(), { DB: undefined }),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does not cache upstream responses marked no-store", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("does not cache stale upstream responses with Warning 110", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Cache-Control": "public, max-age=60",
            "Content-Type": "application/json",
            Warning: '110 - "Response is stale"',
          },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Warning")).toContain("Response is stale");
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("preserves upstream Retry-After headers on site-data rate limits", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "45",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45");
    await expect(response.json()).resolves.toEqual({ error: "Rate limit exceeded" });
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("proxies public-status-history through the site-data lane", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const db = makeTestD1Database();

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/public-status-history", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(db),
      params: { path: "public-status-history" },
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://site-api.pharos.watch/api/public-status-history",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
    expect(
      db
        .getHistory()
        .some(
          (entry) =>
            entry.sql.includes("INSERT INTO site_data_request_stats") &&
            entry.binds[1] === "public-status-history" &&
            entry.binds[2] === "/api/public-status-history" &&
            entry.binds[3] === "pages-upstream-fetch" &&
            entry.binds[4] === "site-api",
        ),
    ).toBe(true);
  });

  it("proxies telegram-pulse through the site-data lane", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const db = makeTestD1Database();

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/telegram-pulse", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(db),
      params: { path: "telegram-pulse" },
    });

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://site-api.pharos.watch/api/telegram-pulse",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
    expect(
      db
        .getHistory()
        .some(
          (entry) =>
            entry.sql.includes("INSERT INTO site_data_request_stats") &&
            entry.binds[1] === "telegram-pulse" &&
            entry.binds[2] === "/api/telegram-pulse" &&
            entry.binds[3] === "pages-upstream-fetch" &&
            entry.binds[4] === "site-api",
        ),
    ).toBe(true);
  });

  it("fails closed on production site hosts when SITE_API_ORIGIN is unset", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(makeTestD1Database(), { SITE_API_ORIGIN: undefined }),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Site API proxy is not configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("fails closed when SITE_API_ORIGIN is malformed", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(makeTestD1Database(), { SITE_API_ORIGIN: "not a url" }),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Site API proxy is not configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("records upstream fetch errors through site-data attribution", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const db = makeTestD1Database();

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(db),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Site API upstream fetch failed" });
    expect(
      db
        .getHistory()
        .some(
          (entry) =>
            entry.sql.includes("INSERT INTO site_data_request_stats") &&
            entry.binds[1] === "stablecoins" &&
            entry.binds[2] === "/api/stablecoins" &&
            entry.binds[3] === "pages-upstream-error" &&
            entry.binds[4] === "site-api" &&
            entry.binds[5] === 1,
        ),
    ).toBe(true);
    expect(warn).toHaveBeenCalledWith("[site-data-proxy] upstream fetch failed (Error): network down");
  });

  it("times out when headers arrive but the upstream body stalls", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));

    const responsePromise = onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(makeTestD1Database(), { DB: undefined }),
      params: { path: "stablecoins" },
    });

    await vi.advanceTimersByTimeAsync(10_000);

    const response = await responsePromise;
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({ error: "Site API upstream timed out" });
  });

  it("returns 500 when the site-proxy secret is missing", async () => {
    cacheMatch.mockResolvedValueOnce(
      new Response(JSON.stringify({ cached: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await onRequest({
      request: new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }),
      env: makeEnv(makeTestD1Database(), { SITE_API_SHARED_SECRET: " " }),
      params: { path: "stablecoins" },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Site API proxy is not configured" });
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
