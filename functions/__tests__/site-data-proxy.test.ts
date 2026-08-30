import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestD1Database } from "@shared/test-utils/mock-d1";
import { onRequest } from "../_site-data/[[path]].ts";
import * as requestAttribution from "../lib/request-attribution";
import { resetSiteDataRequestAttributionStateForTests } from "../lib/request-attribution";
import { MAX_PROXY_RESPONSE_BODY_BYTES } from "../lib/upstream-proxy";
import {
  matchesHttpResponseObservation,
  observeHttpResponse,
  type HttpResponseObservation,
} from "@shared/test-utils/http-response-contract";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { makePagesProxyContext } from "./helpers/pages-context";

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

/** Pages context bag for the `/_site-data/[[path]]` catch-all. */
function siteDataContext(
  request: Request,
  env: ReturnType<typeof makeEnv> = makeEnv(),
  waitUntil?: (promise: Promise<unknown>) => void,
) {
  return makePagesProxyContext({ request, env, mountPath: "/_site-data", waitUntil });
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

function installSiteDataFetch(
  path: string,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return mockFetch([{
    match: `https://site-api.pharos.watch${path}`,
    body,
    status,
    headers,
  }], { requireMatch: true, strictUrl: true });
}

function installSiteDataResponse(path: string, response: Response) {
  return mockFetch([{
    match: `https://site-api.pharos.watch${path}`,
    outcomes: [{ response }],
  }], { requireMatch: true, strictUrl: true });
}

function installSiteDataError(path: string, error: Error) {
  return mockFetch([{
    match: `https://site-api.pharos.watch${path}`,
    outcomes: [error],
  }], { requireMatch: true, strictUrl: true });
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

  it("keeps the response contract for site-data pass-through", async () => {
    installSiteDataFetch("/api/stablecoins", { z: "last", a: "first" }, 200, {
      "Cache-Control": "public, max-age=60",
      "X-Data-Age": "12",
    });

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      })),
    );
    const observed = await observeHttpResponse(response, ["Cache-Control", "Content-Type", "X-Data-Age"]);
    const expected: HttpResponseObservation = {
      status: 200,
      headers: {
        "cache-control": "public, max-age=60",
        "content-type": "application/json",
        "x-data-age": "12",
      },
      bodyKind: "json",
      canonicalBody: { a: "first", z: "last" },
    };

    expect(observed).toEqual(expected);
    expect(matchesHttpResponseObservation(observed, expected)).toBe(true);
  });

  it("rejects requests without Origin or Referer", async () => {
    const response = await onRequest(siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins")));

    expect(response.status).toBe(404);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("rejects direct Pages preview requests without Origin or Referer", async () => {
    const response = await onRequest(
      siteDataContext(new Request("https://stablecoin-dashboard.pages.dev/_site-data/stablecoins")),
    );

    expect(response.status).toBe(404);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("rejects requests from foreign origins", async () => {
    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://evil.example.com" },
      })),
    );

    expect(response.status).toBe(404);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("rejects non-allowlisted paths", async () => {
    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/status", {
        headers: { Origin: "https://pharos.watch" },
      })),
    );

    expect(response.status).toBe(404);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("enforces GET-only method rules", async () => {
    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        method: "POST",
        headers: { Origin: "https://pharos.watch" },
      })),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("never grants an upstream response a second Pages cache lifetime", async () => {
    cacheMatch.mockRejectedValueOnce(new Error("Pages cache unavailable"));
    installSiteDataFetch("/api/stablecoins", { ok: true }, 200, {
      Age: "299",
      "Cache-Control": "public, max-age=300",
      Date: "Mon, 15 Jun 2026 09:55:01 GMT",
    });

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      })),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.headers.get("Age")).toBe("299");
    expect(response.headers.get("Date")).toBe("Mon, 15 Jun 2026 09:55:01 GMT");
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("forwards conditional requests without consulting a Pages cache", async () => {
    const fetchSpy = installSiteDataResponse(
      "/api/stablecoins",
      new Response(null, {
        status: 304,
        headers: { ETag: '"stablecoins-v1"' },
      }),
    );

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { "If-None-Match": '"stablecoins-v1"', Origin: "https://pharos.watch" },
      })),
    );

    expect(response.status).toBe(304);
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("proxies allowlisted requests to the site API with the shared secret and records an upstream fetch", async () => {
    const fetchSpy = installSiteDataFetch("/api/stablecoin-summary/usdt-tether", { ok: true }, 200, {
      "Cache-Control": "public, max-age=60",
      Warning: '199 - "advisory"',
      "X-Data-Age": "12",
    });
    const db = makeTestD1Database();

    const response = await onRequest(
      siteDataContext(new Request("https://ops.pharos.watch/_site-data/stablecoin-summary/usdt-tether", {
        headers: { Accept: "application/json", Origin: "https://ops.pharos.watch" },
      }), makeEnv(db)),
    );

    expect(response.status).toBe(200);
    expect(fetchSpy.getHistory()).toHaveLength(1);
    expect(fetchSpy.getHistory()[0]).toMatchObject({
      url: "https://site-api.pharos.watch/api/stablecoin-summary/usdt-tether",
      method: "GET",
    });
    expect(fetchSpy.getHistory()[0]?.headers.accept).toBe("application/json");
    expect(fetchSpy.getHistory()[0]?.headers["x-pharos-site-proxy-secret"]).toBe("shared-secret");
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
    const fetchSpy = installSiteDataFetch("/api/events?limit=1", { events: [] }, 200, {
      "Cache-Control": "public, max-age=60",
    });

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/events?limit=1", {
        headers: { Origin: "https://pharos.watch" },
      })),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ events: [] });
    expect(fetchSpy.getHistory()).toHaveLength(1);
    expect(fetchSpy.getHistory()[0]?.url).toBe("https://site-api.pharos.watch/api/events?limit=1");
    expect(fetchSpy.getHistory()[0]?.headers["x-pharos-site-proxy-secret"]).toBe("shared-secret");
  });

  it("records site-data attribution through waitUntil when the Pages DB binding is present", async () => {
    installSiteDataFetch("/api/stablecoin/usdt-tether", { ok: true }, 200, {
      "Cache-Control": "public, max-age=60",
    });
    const db = makeTestD1Database();
    const ctx = makeWaitUntil();

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoin/usdt-tether", {
        headers: { Origin: "https://pharos.watch" },
      }), makeEnv(db), ctx.waitUntil),
    );

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
    installSiteDataFetch("/api/stablecoins", { ok: true }, 200, {
      "Cache-Control": "public, max-age=60",
    });
    const db = makeTestD1Database();

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }), makeEnv(db, { REQUEST_SOURCE_ATTRIBUTION_DISABLED: "true" })),
    );

    expect(response.status).toBe(200);
    expect(db.getHistory().some((entry) => entry.sql.includes("INSERT INTO site_data_request_stats"))).toBe(false);
  });

  it("proxies site-data requests when Pages attribution DB is not bound", async () => {
    const fetchSpy = installSiteDataFetch("/api/stablecoins", { ok: true }, 200, {
      "Cache-Control": "public, max-age=60",
    });

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }), makeEnv(makeTestD1Database(), { DB: undefined })),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does not cache upstream responses marked no-store", async () => {
    installSiteDataFetch("/api/stablecoins", { ok: true }, 200, {
      "Cache-Control": "no-store",
    });

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      })),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("does not cache stale upstream responses with Warning 110", async () => {
    installSiteDataFetch("/api/stablecoins", { ok: true }, 200, {
      "Cache-Control": "public, max-age=60",
      Warning: '110 - "Response is stale"',
    });

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      })),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Warning")).toContain("Response is stale");
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("preserves upstream Retry-After headers on site-data rate limits", async () => {
    installSiteDataFetch("/api/stablecoins", { error: "Rate limit exceeded" }, 429, {
      "Retry-After": "45",
    });

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      })),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45");
    await expect(response.json()).resolves.toEqual({ error: "Rate limit exceeded" });
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("proxies public-status-history through the site-data lane", async () => {
    const fetchSpy = installSiteDataFetch("/api/public-status-history", { ok: true });
    const db = makeTestD1Database();

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/public-status-history", {
        headers: { Origin: "https://pharos.watch" },
      }), makeEnv(db)),
    );

    expect(response.status).toBe(200);
    expect(fetchSpy.getHistory()).toHaveLength(1);
    expect(fetchSpy.getHistory()[0]).toMatchObject({
      url: "https://site-api.pharos.watch/api/public-status-history",
      method: "GET",
    });
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
    const fetchSpy = installSiteDataFetch("/api/telegram-pulse", { ok: true });
    const db = makeTestD1Database();

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/telegram-pulse", {
        headers: { Origin: "https://pharos.watch" },
      }), makeEnv(db)),
    );

    expect(response.status).toBe(200);
    expect(fetchSpy.getHistory()).toHaveLength(1);
    expect(fetchSpy.getHistory()[0]).toMatchObject({
      url: "https://site-api.pharos.watch/api/telegram-pulse",
      method: "GET",
    });
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
    const fetchSpy = mockFetch([], { requireMatch: true });

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }), makeEnv(makeTestD1Database(), { SITE_API_ORIGIN: undefined })),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Site API proxy is not configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("fails closed when SITE_API_ORIGIN is malformed", async () => {
    const fetchSpy = mockFetch([], { requireMatch: true });

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }), makeEnv(makeTestD1Database(), { SITE_API_ORIGIN: "not a url" })),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Site API proxy is not configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("records upstream fetch errors through site-data attribution", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installSiteDataError("/api/stablecoins", new Error("network down"));
    const db = makeTestD1Database();

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }), makeEnv(db)),
    );

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

  it("keeps the upstream response when site-data attribution recording fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const record = vi.spyOn(requestAttribution, "recordSiteDataRequest")
      .mockRejectedValueOnce(new Error("attribution unavailable"));
    installSiteDataFetch("/api/stablecoins", { ok: true });

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      })),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(record).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[site-data-proxy] Failed to record site-data attribution:",
      expect.any(Error),
    );
  });

  it("times out when headers arrive but the upstream body stalls", async () => {
    vi.useFakeTimers();
    installSiteDataResponse("/api/stablecoins", new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    const responsePromise = onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }), makeEnv(makeTestD1Database(), { DB: undefined })),
    );

    await vi.advanceTimersByTimeAsync(10_000);

    const response = await responsePromise;
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({ error: "Site API upstream timed out" });
  });

  it("rejects a response whose declared body exceeds the proxy limit", async () => {
    const cancel = vi.fn();
    installSiteDataResponse("/api/stablecoins", new Response(
      new ReadableStream<Uint8Array>({ cancel }),
      {
        status: 200,
        headers: { "Content-Length": String(MAX_PROXY_RESPONSE_BODY_BYTES + 1) },
      },
    ));

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      })),
    );

    expect(response.status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels a chunked response as soon as it crosses the proxy limit", async () => {
    const cancel = vi.fn();
    installSiteDataResponse("/api/stablecoins", new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_PROXY_RESPONSE_BODY_BYTES));
          controller.enqueue(new Uint8Array(1));
        },
        cancel,
      }),
      { status: 200 },
    ));

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      })),
    );

    expect(response.status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns 500 when the site-proxy secret is missing", async () => {
    cacheMatch.mockResolvedValueOnce(
      new Response(JSON.stringify({ cached: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const fetchSpy = mockFetch([], { requireMatch: true });

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }), makeEnv(makeTestD1Database(), { SITE_API_SHARED_SECRET: " " })),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Site API proxy is not configured" });
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
