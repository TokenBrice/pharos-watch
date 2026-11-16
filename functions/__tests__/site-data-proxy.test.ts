import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestD1Database, type MockD1Database } from "@shared/test-utils/mock-d1";
import { onRequest } from "../_site-data/[[path]].ts";
import { onRequest as sessionRequest, resetSiteSessionRateLimitStateForTests } from "../_site-data/session";
import { readSiteSessionCookie, verifySiteSessionToken } from "@shared/lib/site-session-token";
import * as requestAttribution from "../lib/request-attribution";
import { resetSiteDataRequestAttributionStateForTests } from "../lib/request-attribution";
import {
  SITE_DATA_RATE_LIMIT_MAX_PER_WINDOW,
  isSiteDataRateLimited,
  resetSiteDataRateLimitStateForTests,
} from "../lib/site-data-rate-limit";
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

/** Every website-data response is a machine read, never an indexable document. */
function expectNoindex(response: Response) {
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
}

function expectAttribution(
  db: MockD1Database,
  route: string,
  path: string,
  delivery = "pages-upstream-fetch",
) {
  const rows = db.getHistory().filter((entry) => entry.sql.includes("INSERT INTO site_data_request_samples"));
  const inverseRate = delivery === "pages-upstream-timeout" || delivery === "pages-upstream-error" ? 1 : 64;
  expect(rows.map((entry) => entry.binds.slice(1))).toEqual([[route, path, delivery, "site-api", inverseRate, 1]]);
}

describe("site-data proxy", () => {
  const cacheMatch = vi.fn();
  const cachePut = vi.fn(async () => undefined);

  beforeEach(() => {
    resetSiteDataRequestAttributionStateForTests();
    resetSiteDataRateLimitStateForTests();
    vi.spyOn(Math, "random").mockReturnValue(0);
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
    resetSiteDataRateLimitStateForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the response contract for site-data pass-through", async () => {
    siteApi.json("/api/stablecoins", { z: "last", a: "first" }, 200, {
      "Cache-Control": "public, max-age=60",
      "X-Data-Age": "12",
      "X-Data-Updated-At": "1700000000.125",
      "X-Robots-Tag": "index",
    });

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      })),
    );
    const observed = await observeHttpResponse(response, ["Cache-Control", "Content-Type", "X-Data-Age", "X-Data-Updated-At", "X-Robots-Tag"]);
    const expected: HttpResponseObservation = {
      status: 200,
      headers: {
        "cache-control": "public, max-age=60",
        "content-type": "application/json",
        "x-data-age": "12",
        "x-data-updated-at": "1700000000.125",
        "x-robots-tag": "noindex, nofollow",
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
    expectNoindex(response);
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
    expectNoindex(response);
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("forwards the edge-verified client IP for site-lane rate limiting", async () => {
    const fetchSpy = siteApi.json("/api/public-status-history?window=7d", { ok: true });

    const response = await onRequest(siteDataContext(new Request(
      "https://pharos.watch/_site-data/public-status-history?window=7d",
      { headers: { Origin: "https://pharos.watch", "CF-Connecting-IP": "203.0.113.9" } },
    )));

    expect(response.status).toBe(200);
    expect(fetchSpy.getHistory()[0]?.headers["x-pharos-client-ip"]).toBe("203.0.113.9");
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
    expectNoindex(response);
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
    expectNoindex(response);
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
    expectNoindex(response);
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
    expectNoindex(response);
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
    expectNoindex(response);
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
      expectNoindex(response);
      expect(fetch).not.toHaveBeenCalled();
      expect(cachePut).not.toHaveBeenCalled();
    },
  );

  it.each<[string, Record<string, string>]>([
    ["missing Origin and Referer", {}],
    ["foreign Origin", { Origin: "https://foreign.example" }],
    ["foreign Referer", { Referer: "https://foreign.example/stablecoin/usdc-circle/" }],
  ])("rejects requests with %s", async (_label, headers) => {
    const response = await onRequest(siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", { headers })));

    expect(response.status).toBe(404);
    expectNoindex(response);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it("rejects non-allowlisted paths", async () => {
    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/status", {
        headers: { Origin: "https://pharos.watch" },
      })),
    );

    expect(response.status).toBe(404);
    expectNoindex(response);
    expect(cacheMatch).not.toHaveBeenCalled();
  });

  it.each(["POST", "HEAD"])("enforces GET-only method rules for %s", async (method) => {
    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        method,
        headers: { Origin: "https://pharos.watch" },
      })),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expectNoindex(response);
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
    expectNoindex(response);
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
    expectAttribution(db, "stablecoin-summary", "/api/stablecoin-summary/:id");
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
    expectNoindex(response);
    await expect(response.json()).resolves.toEqual({ error: "Rate limit exceeded" });
    expect(cachePut).not.toHaveBeenCalled();
  });

  it.each([
    ["cookie-token", "header-token", "cookie-token"],
    [null, "header-token", null],
    [null, null, null],
  ])("forwards session cookie %s with header %s", async (cookie, header, expected) => {
    const fetchSpy = siteApi.json("/api/stablecoins", {}, 401, { "X-Pharos-Session": "required" });
    const headers = new Headers({
      Origin: "https://pharos.watch", "CF-Connecting-IP": "203.0.113.8",
      "X-Pharos-Site-Proxy-Secret": "spoof", "X-Pharos-Client-IP": "spoof", "X-API-Key": "spoof",
      "CF-Access-Client-Id": "spoof", "CF-Access-Client-Secret": "spoof",
      "Cf-Access-Jwt-Assertion": "spoof", "Cf-Access-Authenticated-User-Email": "spoof",
    });
    if (cookie) headers.set("Cookie", `other=value; __Secure-pharos-session=${cookie}`);
    if (header) headers.set("X-Pharos-Site-Session", header);
    const response = await onRequest(siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", { headers })));
    const forwarded = new Headers(fetchSpy.getHistory()[0]?.headers);
    expect(forwarded.get("X-Pharos-Site-Session")).toBe(expected);
    expect(forwarded.get("X-Pharos-Site-Proxy-Secret")).toBe("shared-secret");
    expect(forwarded.get("X-Pharos-Client-IP")).toBe("203.0.113.8");
    for (const name of ["Cookie", "X-API-Key", ...Array.from(headers.keys()).filter((key) => key.startsWith("cf-access-"))]) {
      expect(forwarded.has(name)).toBe(false);
    }
    expect(response.headers.get("X-Pharos-Session")).toBe("required");
  });

  it("returns 429 before the upstream fetch when one client-IP source exceeds the read ceiling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T12:00:00Z"));
    const headers = { Origin: "https://pharos.watch", "CF-Connecting-IP": "203.0.113.77" };
    for (let i = 0; i < SITE_DATA_RATE_LIMIT_MAX_PER_WINDOW; i++) {
      expect(await isSiteDataRateLimited(
        new Request("https://pharos.watch/_site-data/stablecoins", { headers }),
        makeEnv(),
      )).toBe(false);
    }
    const fetchSpy = siteApi.json("/api/stablecoins", { ok: true });

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", { headers })),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expectNoindex(response);
    await expect(response.json()).resolves.toEqual({ error: "Too many requests" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed on production site hosts when SITE_API_ORIGIN is unset", async () => {
    const fetchSpy = mockFetch([], { requireMatch: true });

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }), makeEnv(makeTestD1Database(), { SITE_API_ORIGIN: undefined })),
    );

    expect(response.status).toBe(500);
    expectNoindex(response);
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
    expectNoindex(response);
    await expect(response.json()).resolves.toEqual({ error: "Site API proxy is not configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cachePut).not.toHaveBeenCalled();
  });

  it("records upstream fetch errors through site-data attribution", async () => {
    vi.mocked(Math.random).mockReturnValue(0.9);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    siteApi.error("/api/stablecoins", new Error("network down"));
    const db = makeTestD1Database();

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      }), makeEnv(db)),
    );

    expect(response.status).toBe(502);
    expectNoindex(response);
    await expect(response.json()).resolves.toEqual({ error: "Site API upstream fetch failed" });
    expectAttribution(db, "stablecoins", "/api/stablecoins", "pages-upstream-error");
    expect(warn).toHaveBeenCalledWith("[site-data-proxy] upstream fetch failed (Error): network down");
  });

  it("rejects an oversized upstream body with a noindexed 502", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    siteApi.response("/api/stablecoins", new Response("{}", {
      headers: { "Content-Length": String(16 * 1024 * 1024 + 1) },
    }));

    const response = await onRequest(
      siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
        headers: { Origin: "https://pharos.watch" },
      })),
    );

    expect(response.status).toBe(502);
    expectNoindex(response);
    await expect(response.json()).resolves.toEqual({ error: "Site API upstream fetch failed" });
  });

  it.each([200, 503])("does not record unselected upstream HTTP %s responses", async (status) => {
    vi.mocked(Math.random).mockReturnValue(1 / 64);
    siteApi.json("/api/stablecoins", { status }, status);
    const db = makeTestD1Database();
    const ctx = makeWaitUntil();
    const response = await onRequest(siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
      headers: { Origin: "https://pharos.watch" },
    }), makeEnv(db), ctx.waitUntil));
    await ctx.flush();
    expect(response.status).toBe(status);
    expectNoindex(response);
    await expect(response.json()).resolves.toEqual({ status });
    expect(db.getHistory()).toEqual([]);
  });

  it("samples upstream HTTP errors as ordinary responses, not certain transport failures", async () => {
    siteApi.json("/api/stablecoins", { error: "upstream" }, 503);
    const db = makeTestD1Database();
    const response = await onRequest(siteDataContext(new Request("https://pharos.watch/_site-data/stablecoins", {
      headers: { Origin: "https://pharos.watch" },
    }), makeEnv(db)));
    expect(response.status).toBe(503);
    expectNoindex(response);
    expectAttribution(db, "stablecoins", "/api/stablecoins");
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
    expectNoindex(response);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(record).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[site-data-proxy] Failed to record site-data attribution:",
      expect.any(Error),
    );
  });

  it.each(["fetch", "binding"])("attributes a stalled %s body to timeout only after the deadline and cancels it", async (transport) => {
    vi.mocked(Math.random).mockReturnValue(0.9);
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
    const response = await pending;
    expect(response.status).toBe(504);
    expectNoindex(response);
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
    expectNoindex(response);
    await expect(response.json()).resolves.toEqual({ error: "Site API proxy is not configured" });
    expect(cacheMatch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("site-data session endpoint", () => {
  const env = { ...makeEnv(), SITE_SESSION_SIGNING_KEY: " signing-key\n", TURNSTILE_SECRET_KEY: "turnstile-secret" };
  const verified = { success: true, hostname: "pharos.watch", action: "site-data" };
  function context(body = '{"token":"challenge"}', headers: HeadersInit = {}, host = "pharos.watch", method = "POST") {
    return { env, request: new Request(`https://${host}/_site-data/session`, {
      method, headers: { Origin: `https://${host}`, "CF-Connecting-IP": "203.0.113.9", ...headers },
      ...(method === "POST" ? { body } : {}),
    }) };
  }
  beforeEach(() => resetSiteSessionRateLimitStateForTests());
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each(["pharos.watch", "ops.pharos.watch"])("issues a signed browser cookie on %s", async (host) => {
    const fetch = vi.fn(async () => Response.json({ ...verified, hostname: host }));
    vi.stubGlobal("fetch", fetch);
    const response = await sessionRequest(context(undefined, host === "ops.pharos.watch"
      ? { Origin: "", Referer: `https://${host}/page` } : {}, host));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expectNoindex(response);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const cookie = response.headers.get("Set-Cookie");
    expect(cookie).toContain("; Path=/_site-data; Secure; HttpOnly; SameSite=Strict; Max-Age=43200");
    const result = await verifySiteSessionToken({
      token: readSiteSessionCookie(cookie), keys: [env.SITE_SESSION_SIGNING_KEY], nowSec: Math.floor(Date.now() / 1_000),
    });
    expect(result).toMatchObject({ ok: true, payload: { kind: "browser" } });
    if (result.ok) expect(response.headers.get("X-Pharos-Session-Expires")).toBe(String(result.payload.exp));
    expect(fetch).toHaveBeenCalledWith("https://challenges.cloudflare.com/turnstile/v0/siteverify", expect.objectContaining({
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, redirect: "manual",
      signal: expect.any(AbortSignal), body: new URLSearchParams({ secret: "turnstile-secret", response: "challenge", remoteip: "203.0.113.9" }),
    }));
  });

  it.each([
    [{ success: false }, 403], [{ success: "true" }, 403], [{ hostname: "ops.pharos.watch" }, 403],
    [{ action: "other" }, 403], [null, 403],
    ["non-json", 503], ["unreachable", 503], ["http-error", 503],
  ])("rejects siteverify result %j with %s", async (override, status) => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (override === "unreachable") throw new Error("offline");
      if (override === "non-json") return new Response("<html>unavailable</html>");
      if (override === "http-error") return Response.json(verified, { status: 503 });
      return Response.json(override === null ? null : { ...verified, ...override as object });
    }));
    const response = await sessionRequest(context());
    expect(response.status).toBe(status);
    expect(response.headers.has("Set-Cookie")).toBe(false);
    expectNoindex(response);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    if (status === 503) expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toHaveProperty("error");
  });

  it.each<[ReturnType<typeof context>, number]>([
    [context(undefined, {}, "hash.stablecoin-dashboard.pages.dev"), 404],
    [context(undefined, {}, "stablecoin-dashboard.pages.dev"), 404],
    [context(undefined, {}, "foreign.example"), 404],
    [context(undefined, {}, "pharos.watch:8443"), 404],
    [context(undefined, { Origin: "https://foreign.example" }), 404],
    [context(undefined, { Origin: "", Referer: "https://pharos.watch/page" }, "pharos.watch", "GET"), 405],
    [context(undefined, { Origin: "" }), 404],
    [context("x".repeat(4_097)), 413], [context("{}", { "Content-Length": "4097" }), 413],
    ...["{", "null", "{}", '{"token":1}', '{"token":" "}'].map((body): [ReturnType<typeof context>, number] => [context(body), 400]),
    ...["SITE_SESSION_SIGNING_KEY", "TURNSTILE_SECRET_KEY"].map((key): [ReturnType<typeof context>, number] => [
      { ...context(), env: { ...env, [key]: " " } }, 500,
    ]),
  ])("rejects invalid session requests %# before siteverify", async (ctx, status) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const response = await sessionRequest(ctx);
    expect(response.status).toBe(status);
    expectNoindex(response);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.has("Set-Cookie")).toBe(false);
    if (status === 405) expect(response.headers.get("Allow")).toBe("POST");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["ipv6", "unknown"])("meters %s callers before parsing and resets the window", async (kind) => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
    for (let i = 0; i < 11; i++) {
      const response = await sessionRequest(context("{}", {
        "CF-Connecting-IP": kind === "ipv6" ? `2001:db8:1:2::${i + 1}` : "",
      }));
      expect(response.status).toBe(i < 10 ? 400 : 429);
      if (i === 10) expect(response.headers.get("Retry-After")).toBe("60");
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await sessionRequest(context("{}", { "CF-Connecting-IP": kind === "ipv6" ? "2001:db8:1:2::1" : "" }))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("times out siteverify body consumption and cancels the stream", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel }))));
    const pending = sessionRequest(context());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expectNoindex(response);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
