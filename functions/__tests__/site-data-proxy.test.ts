import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestD1Database, type MockD1Database } from "@shared/test-utils/mock-d1";
import { onRequest } from "../_site-data/[[path]].ts";
import * as requestAttribution from "../lib/request-attribution";
import { resetSiteDataRequestAttributionStateForTests } from "../lib/request-attribution";
import {
  observeHttpResponse,
  type HttpResponseObservation,
} from "@shared/test-utils/http-response-contract";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { mockUpstream } from "./helpers/mock-upstream";
import { makePagesProxyContext } from "./helpers/pages-context";

function makeEnv(db?: MockD1Database, overrides: Record<string, unknown> = {}) {
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

const siteApi = mockUpstream("https://site-api.pharos.watch");

function expectAttribution(
  db: MockD1Database,
  route: string,
  path: string,
  delivery = "pages-upstream-fetch",
) {
  const rows = db.getHistory().filter((entry) => entry.sql.includes("INSERT INTO site_data_request_stats"));
  expect(rows.map((entry) => entry.binds.slice(1, 6))).toEqual([[route, path, delivery, "site-api", 1]]);
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
    resetSiteDataRequestAttributionStateForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the response contract for site-data pass-through", async () => {
    siteApi.json("/api/stablecoins", { z: "last", a: "first" }, 200, {
      "Cache-Control": "public, max-age=60",
      "X-Data-Age": "12",
      "X-Data-Updated-At": "1700000000.125",
    });

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      })),
    );
    const observed = await observeHttpResponse(response, ["Cache-Control", "Content-Type", "X-Data-Age", "X-Data-Updated-At"]);
    const expected: HttpResponseObservation = {
      status: 200,
      headers: {
        "cache-control": "public, max-age=60",
        "content-type": "application/json",
        "x-data-age": "12",
        "x-data-updated-at": "1700000000.125",
      },
      bodyKind: "json",
      canonicalBody: { a: "first", z: "last" },
    };

    expect(observed).toEqual(expected);
  });

  it.each([false, true])("passes conditional 304 status, empty body and allowlisted headers through binding=%s", async (useBinding) => {
    const headers = {
      ETag: 'W/"generation-1"',
      "Cache-Control": "public, s-maxage=300, max-age=60",
      Age: "42", Date: "Sun, 18 Oct 2026 12:00:00 GMT",
      "X-Data-Updated-At": "1792324700", "X-Data-Assessed-At": "1792324800",
      "X-Data-Freshness-Budget": "4800", "X-Data-Freshness": "fresh",
      "Access-Control-Allow-Origin": "https://pharos.watch",
      "Access-Control-Expose-Headers": "ETag, Age, Date, X-Data-Updated-At",
      Vary: "Origin",
    };
    const upstreamResponse = new Response(null, { status: 304, headers: { ...headers, "X-Private-Upstream": "secret" } });
    const binding = { fetch: vi.fn(async (_request: Request) => upstreamResponse) };
    const networkFetch = useBinding
      ? mockFetch([], { requireMatch: true })
      : siteApi.response("/api/stablecoins", upstreamResponse);
    const response = await onRequest(siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
      headers: { Origin: "https://pharos.watch", "If-None-Match": headers.ETag,
        "If-Modified-Since": headers.Date },
    }), makeEnv(undefined, useBinding ? { SITE_API: binding } : {})));
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    await expect(response.text()).resolves.toBe("");
    for (const [name, value] of Object.entries(headers)) expect(response.headers.get(name)).toBe(value);
    expect(response.headers.get("X-Private-Upstream")).toBeNull();
    if (useBinding) {
      const request = binding.fetch.mock.calls[0][0];
      expect(request.headers.get("If-None-Match")).toBe(headers.ETag);
      expect(request.headers.get("If-Modified-Since")).toBe(headers.Date);
      expect(networkFetch).not.toHaveBeenCalled();
    } else {
      expect(networkFetch).toHaveBeenCalledOnce();
    }
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it.each(["fresh", "stale", "unknown"])("forwards the complete exposed freshness contract for %s evidence", async (freshness) => {
    const headers = {
      "Cache-Control": "no-store",
      "X-Data-Age": freshness === "unknown" ? "unavailable" : "120",
      "X-Data-Updated-At": "1792300000",
      "X-Data-Freshness": freshness,
      "X-Data-Freshness-Reason": freshness === "fresh" ? "within-budget" : "source-unavailable",
      "X-Data-Assessed-At": "1792300120",
      "X-Data-Freshness-Budget": "60",
      "X-Safety-Score-Status": "held",
      "X-Safety-Score-Updated-At": "1792200000",
      "X-Safety-Score-Generation": "retained-generation",
      "X-Safety-Score-Assessed-At": "1792300120",
      "X-Safety-Score-Freshness-Budget": "86400",
      Warning: '110 - "Response is stale"',
      "Retry-After": "60",
    };
    const exposed = Object.keys(headers).filter((name) => name !== "Cache-Control");
    siteApi.json("/api/stablecoins", { ok: true }, 200, {
      ...headers,
      "Access-Control-Expose-Headers": exposed.join(", "),
      "X-Private-Upstream": "not-forwarded",
    });
    const response = await onRequest(siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
      headers: { Origin: "https://pharos.watch" },
    })));
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe(exposed.join(", "));
    for (const [name, value] of Object.entries(headers)) {
      expect(response.headers.get(name)).toBe(value);
    }
    expect(response.headers.get("X-Private-Upstream")).toBeNull();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("uses the service binding with canonical host, secret, query and attribution without resetting clocks", async () => {
    const networkFetch = mockFetch([], { requireMatch: true });
    const upstreamHeaders = {
      Age: "299",
      Date: "Mon, 15 Jun 2026 09:55:01 GMT",
      ETag: '"generation-1"',
      "Cache-Control": "public, max-age=60, s-maxage=300",
      "X-Data-Freshness": "stale",
      "X-Data-Assessed-At": "1792300120",
      "X-Data-Freshness-Budget": "60",
    };
    const binding = {
      fetch: vi.fn(async (_request: Request) => new Response('{"ok":true}', { headers: upstreamHeaders })),
    };
    const db = makeTestD1Database();
    const response = await onRequest(siteDataContext(new Request(
      "https://pharos.watch/_site-data/stablecoin-summary/usdt-tether?range=7d",
      { headers: { Origin: "https://pharos.watch", Accept: "application/json", "If-None-Match": '"generation-0"' } },
    ), makeEnv(db, { SITE_API: binding })));

    expect(binding.fetch).toHaveBeenCalledOnce();
    const request = binding.fetch.mock.calls[0][0];
    expect(request.url).toBe("https://site-api.pharos.watch/api/stablecoin-summary/usdt-tether?range=7d");
    expect(request.method).toBe("GET");
    expect(request.redirect).toBe("manual");
    expect(request.headers.get("X-Pharos-Site-Proxy-Secret")).toBe("shared-secret");
    expect(request.headers.get("If-None-Match")).toBe('"generation-0"');
    expect(request.headers.get("Accept")).toBe("application/json");
    expect(request.headers.get("Origin")).toBeNull();
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    for (const [name, value] of Object.entries(upstreamHeaders)) {
      expect(response.headers.get(name)).toBe(value);
    }
    expectAttribution(db, "stablecoin-summary", "/api/stablecoin-summary/:id");
    expect(networkFetch).not.toHaveBeenCalled();
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it.each([
    ["/_site-data/status", {}, 404],
    ["/_site-data/stablecoins", { SITE_API_ORIGIN: "https://api.pharos.watch" }, 500],
    ["/_site-data/stablecoins", { SITE_API_SHARED_SECRET: "" }, 500],
  ])("keeps binding requests behind admission for %s", async (path, overrides, status) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const networkFetch = mockFetch([], { requireMatch: true });
    const binding = { fetch: vi.fn(async (_request: Request) => new Response("{}")) };
    const response = await onRequest(siteDataContext(new Request(`https://pharos.watch${path}`, {
      headers: { Origin: "https://pharos.watch" },
    }), makeEnv(undefined, { ...overrides, SITE_API: binding })));
    expect(response.status).toBe(status);
    expect(binding.fetch).not.toHaveBeenCalled();
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("does not retry a failed binding through the public network", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const networkFetch = mockFetch([], { requireMatch: true });
    const binding = { fetch: vi.fn(async (_request: Request): Promise<Response> => { throw new Error("binding unavailable"); }) };
    const db = makeTestD1Database();
    const response = await onRequest(siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
      headers: { Origin: "https://pharos.watch" },
    }), makeEnv(db, { SITE_API: binding })));
    expect(response.status).toBe(502);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expectAttribution(db, "stablecoins", "/api/stablecoins", "pages-upstream-error");
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("preserves unavailable producer evidence without caching the response", async () => {
    siteApi.json("/api/blacklist", { events: [], total: 0 }, 200, {
      "Cache-Control": "no-store",
      "X-Data-Age": "unavailable",
      "X-Data-Freshness": "unknown",
      "X-Data-Freshness-Reason": "freshness-lookup-failed",
    });
    const response = await onRequest(siteDataContext(new Request("https://pharos.watch/_site-data/blacklist", {
      headers: { Origin: "https://pharos.watch" },
    })));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Data-Age")).toBe("unavailable");
    expect(response.headers.get("X-Data-Freshness")).toBe("unknown");
    expect(response.headers.get("X-Data-Freshness-Reason")).toBe("freshness-lookup-failed");
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("preserves held Safety Score status and forbids caching on the browser graph lane", async () => {
    siteApi.json("/api/dependency-graph/v1", { publicationStatus: "held" }, 200, {
      "Cache-Control": "no-store",
      "X-Safety-Score-Status": "held",
    });
    const response = await onRequest(siteDataContext(new Request("https://pharos.watch/_site-data/dependency-graph/v1", {
      headers: { Origin: "https://pharos.watch" },
    })));
    expect(response.headers.get("X-Safety-Score-Status")).toBe("held");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(cachePut).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ publicationStatus: "held" });
  });

  it.each(["https://pharos.watch", "https://preview.stablecoin-dashboard.pages.dev"])(
    "denies internal bulk inputs even with a spoofed allowed origin %s", async (origin) => {
      const fetch = mockFetch([], { requireMatch: true });
      const response = await onRequest(siteDataContext(new Request(
        "https://pharos.watch/_site-data/stablecoin-detail-snapshot-inputs?ids=usdt-tether%2Cusdc-circle",
        { headers: { Origin: origin } },
      )));
      expect(response.status).toBe(404);
      expect(fetch).not.toHaveBeenCalled();
      expect(cachePut).not.toHaveBeenCalled();
    },
  );

  it("rejects requests without Origin or Referer", async () => {
    const response = await onRequest(siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins")));

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
    siteApi.json("/api/stablecoins", { ok: true }, 200, {
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

  it.each([
    ["If-None-Match", '"stablecoins-v1"'],
    ["If-Modified-Since", "Mon, 15 Jun 2026 09:55:01 GMT"],
  ])("forwards %s without consulting a Pages cache", async (header, value) => {
    const fetchSpy = siteApi.response(
      "/api/stablecoins",
      new Response(null, {
        status: 304,
        headers: { ETag: '"stablecoins-v1"' },
      }),
    );

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { [header]: value, Origin: "https://pharos.watch" },
      })),
    );

    expect(response.status).toBe(304);
    expect(fetchSpy.getHistory()[0]?.headers[header.toLowerCase()]).toBe(value);
    expect(response.headers.get("ETag")).toBe('"stablecoins-v1"');
    expect(await response.text()).toBe("");
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("proxies allowlisted requests to the site API with the shared secret and records an upstream fetch", async () => {
    const fetchSpy = siteApi.json("/api/stablecoin-summary/usdt-tether", { ok: true }, 200, {
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
    expectAttribution(db, "stablecoin-summary", "/api/stablecoin-summary/:id");
  });

  it.each<Record<string, string>>([
    { "Cache-Control": "public, max-age=60", Warning: '110 - "Response is stale"' },
  ])("preserves cache headers without Pages caching: %j", async (headers) => {
    siteApi.json("/api/stablecoins", { ok: true }, 200, headers);

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      })),
    );

    expect(response.status).toBe(200);
    for (const [name, value] of Object.entries(headers)) {
      expect(response.headers.get(name)).toBe(value);
    }
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });


  it("preserves upstream Retry-After headers on site-data rate limits", async () => {
    siteApi.json("/api/stablecoins", { error: "Rate limit exceeded" }, 429, {
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
    siteApi.error("/api/stablecoins", new Error("network down"));
    const db = makeTestD1Database();

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }), makeEnv(db)),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "Site API upstream fetch failed" });
    expectAttribution(db, "stablecoins", "/api/stablecoins", "pages-upstream-error");
    expect(warn).toHaveBeenCalledWith("[site-data-proxy] upstream fetch failed (Error): network down");
  });

  it("keeps the upstream response when site-data attribution recording fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const record = vi.spyOn(requestAttribution, "recordSiteDataRequest")
      .mockRejectedValueOnce(new Error("attribution unavailable"));
    siteApi.json("/api/stablecoins", { ok: true });

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }), makeEnv(makeTestD1Database())),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(record).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[site-data-proxy] Failed to record site-data attribution:",
      expect.any(Error),
    );
  });

  it.each(["fetch", "binding"])("attributes a stalled %s body to timeout only after the deadline and cancels it", async (transport) => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cancel = vi.fn();
    const upstream = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const binding = { fetch: vi.fn(async (_request: Request) => upstream) };
    if (transport === "fetch") siteApi.response("/api/stablecoins", upstream);
    const db = makeTestD1Database();
    const ctx = makeWaitUntil();
    let settled = false;
    const pending = onRequest(siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
      headers: { Origin: "https://pharos.watch" },
    }), makeEnv(db, transport === "binding" ? { SITE_API: binding } : {}), ctx.waitUntil)).then((response) => {
      settled = true;
      return response;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).status).toBe(504);
    expect(cancel).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    await ctx.flush();
    expectAttribution(db, "stablecoins", "/api/stablecoins", "pages-upstream-timeout");
  });

  it("returns 500 when the site-proxy secret is missing", async () => {
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
