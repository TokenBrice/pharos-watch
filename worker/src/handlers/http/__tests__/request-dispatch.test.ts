import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeExecutionContext } from "../../../test-helpers/__shared/auth";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { buildFreshnessMeta } from "../../../lib/api-freshness";
import { handleHomepageHistory } from "../../../api/homepage";

const homepageOwners = vi.hoisted(() => ({ charts: vi.fn(), supply: vi.fn() }));
vi.mock("../../../api/cache-handlers", () => ({ handleStablecoinCharts: homepageOwners.charts, handleStablecoins: vi.fn() }));
vi.mock("../../../api/supply-history", () => ({ handleSupplyHistory: homepageOwners.supply }));

const mocks = vi.hoisted(() => ({
  resolveRoute: vi.fn(),
  route: vi.fn(),
  createRequestSourceRecorder: vi.fn(),
  recordRequestSource: vi.fn(),
  addCorsHeaders: vi.fn((response: Response) => response),
  handleCorsPreflight: vi.fn(),
  resolveCorsOrigin: vi.fn(),
  buildRouteContext: vi.fn(),
  createEdgeCacheContext: vi.fn(),
  readEdgeCache: vi.fn(),
  writeEdgeCache: vi.fn(),
  isApiKeyRequestAttributionDisabled: vi.fn(() => false),
  isRequestSourceAttributionDisabled: vi.fn(() => false),
  checkCachedPublicApiReadFastRateLimit: vi.fn(),
  evaluateAccessGate: vi.fn(),
  evaluateCachedPublicApiReadFastGate: vi.fn(),
  handleMaintenanceMode: vi.fn(),
  notFoundResponse: vi.fn(),
  warnWorkerEnvIssuesOnce: vi.fn(),
  evaluateTelegramIngressAbuseGate: vi.fn(),
  recordTelegramIngressHandlerResponse: vi.fn(),
}));

vi.mock("../../../router", () => ({
  resolveRoute: mocks.resolveRoute,
  route: mocks.route,
}));

vi.mock("../request-source", () => ({
  createRequestSourceRecorder: mocks.createRequestSourceRecorder,
  isApiKeyRequestAttributionDisabled: mocks.isApiKeyRequestAttributionDisabled,
  isRequestSourceAttributionDisabled: mocks.isRequestSourceAttributionDisabled,
}));

vi.mock("../cors", () => ({
  addCorsHeaders: mocks.addCorsHeaders,
  handleCorsPreflight: mocks.handleCorsPreflight,
  resolveCorsOrigin: mocks.resolveCorsOrigin,
}));

vi.mock("../context", () => ({
  buildRouteContext: mocks.buildRouteContext,
}));

vi.mock("../edge-cache", () => ({
  createEdgeCacheContext: mocks.createEdgeCacheContext,
  readEdgeCache: mocks.readEdgeCache,
  writeEdgeCache: mocks.writeEdgeCache,
}));

vi.mock("../gates", () => ({
  checkCachedPublicApiReadFastRateLimit: mocks.checkCachedPublicApiReadFastRateLimit,
  evaluateAccessGate: mocks.evaluateAccessGate,
  evaluateCachedPublicApiReadFastGate: mocks.evaluateCachedPublicApiReadFastGate,
  handleMaintenanceMode: mocks.handleMaintenanceMode,
  notFoundResponse: mocks.notFoundResponse,
  warnWorkerEnvIssuesOnce: mocks.warnWorkerEnvIssuesOnce,
}));

vi.mock("../../../telegram/webhook/telegram-ingress-abuse", () => ({
  evaluateTelegramIngressAbuseGate: mocks.evaluateTelegramIngressAbuseGate,
  recordTelegramIngressHandlerResponse: mocks.recordTelegramIngressHandlerResponse,
}));

import { handleHttpRequestImpl } from "../request-dispatch";
import { createWorkerEnv } from "../../../test-helpers/__shared/worker-env";

function makeEnv(overrides: Parameters<typeof createWorkerEnv>[0] = {}) {
  return createWorkerEnv(overrides);
}

function makeCtx() {
  return makeExecutionContext().ctx as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };
}

describe("handleHttpRequestImpl", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.resolveCorsOrigin.mockReturnValue("https://pharos.watch");
    mocks.handleCorsPreflight.mockReturnValue(null);
    mocks.handleMaintenanceMode.mockReturnValue(null);
    mocks.evaluateTelegramIngressAbuseGate.mockImplementation(async (request: Request) => ({
      request,
      response: null,
    }));
    mocks.checkCachedPublicApiReadFastRateLimit.mockReturnValue(null);
    mocks.evaluateCachedPublicApiReadFastGate.mockResolvedValue(null);
    mocks.evaluateAccessGate.mockResolvedValue({
      isAdmin: false,
      isSiteProxy: false,
      apiKey: null,
      requestLane: "public-api",
      response: null,
    });
    mocks.createRequestSourceRecorder.mockReturnValue(mocks.recordRequestSource);
    mocks.isApiKeyRequestAttributionDisabled.mockReturnValue(false);
    mocks.isRequestSourceAttributionDisabled.mockReturnValue(false);
    mocks.createEdgeCacheContext.mockReturnValue({
      cacheKey: new Request("https://api.pharos.watch/api/stablecoins"),
      skipCache: false,
    });
    mocks.readEdgeCache.mockResolvedValue(null);
    mocks.resolveRoute.mockReturnValue({
      methodValidation: null,
      routeMatch: { dependencies: ["coingeckoApiKey"], methods: ["GET"], handle: vi.fn() },
    });
    mocks.buildRouteContext.mockReturnValue({ routeContext: true });
    mocks.route.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    mocks.notFoundResponse.mockImplementation(
      () =>
        new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    );
    mocks.addCorsHeaders.mockImplementation((response: Response) => response);
  });

  it.each([false, true])("returns conditional 304 after auth on both cached lanes (fast=%s)", async (fast) => {
    const etag = 'W/"cached-generation"';
    const cached = new Response('{"ok":true}', { headers: {
      ETag: etag, "Cache-Control": "public, max-age=60",
      Date: new Date().toUTCString(), Age: "2", "X-Data-Updated-At": "1792300000",
    } });
    mocks.readEdgeCache.mockResolvedValue(cached);
    if (fast) mocks.evaluateCachedPublicApiReadFastGate.mockResolvedValue({
      isAdmin: false, isSiteProxy: true, apiKey: null, requestLane: "site-api",
    });
    mocks.addCorsHeaders.mockImplementation((response: Response) => {
      response.headers.set("Access-Control-Allow-Origin", "https://pharos.watch");
      return response;
    });
    const response = await handleHttpRequestImpl(new Request("https://site-api.pharos.watch/api/stablecoins", {
      headers: { "If-None-Match": etag },
    }), makeEnv(), makeCtx());
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(response.headers.get("ETag")).toBe(etag);
    expect(response.headers.get("Age")).toBe("2");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://pharos.watch");
    expect(mocks.recordRequestSource).toHaveBeenCalledOnce();
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it("evaluates a handler validator only after queuing the full 200 for cache admission", async () => {
    const makeResponse = () => new Response('{"ok":true}', { headers: {
      ETag: 'W/"producer-generation"', "Cache-Control": "public, max-age=60",
    } });
    mocks.route.mockImplementation(async () => makeResponse());
    const url = "https://api.pharos.watch/api/stablecoins";
    const initial = await handleHttpRequestImpl(new Request(url), makeEnv(), makeCtx());
    const etag = initial.headers.get("ETag")!;
    const result = await handleHttpRequestImpl(new Request(url, {
      headers: { "If-None-Match": etag },
    }), makeEnv(), makeCtx());
    expect(result.status).toBe(304);
    expect(result.body).toBeNull();
    expect(mocks.writeEdgeCache.mock.calls[1][1].status).toBe(200);
    expect(mocks.writeEdgeCache.mock.calls[1][1].headers.get("ETag")).toBe(etag);
  });

  it("does not return 304 when delayed homepage composition crosses a producer deadline", async () => {
    const now = 1_800_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    try {
      const source = (key: string, maxAge: number) => new Response("[]", { headers: {
        "X-Data-Updated-At": String(now - buildFreshnessMeta(now, maxAge, key).freshBudgetSec + 1),
      } });
      homepageOwners.supply.mockImplementation(async () => source("supply-history", API_FRESHNESS_MAX_AGE_SEC.supplyHistory));
      homepageOwners.charts.mockImplementation(async () => {
        const response = source("stablecoin-charts", API_FRESHNESS_MAX_AGE_SEC.stablecoinCharts);
        clock.mockReturnValue((now + 2) * 1000);
        return response;
      });
      mocks.route.mockImplementation(async () => handleHomepageHistory(makeEnv().DB));
      const response = await handleHttpRequestImpl(new Request("https://site-api.pharos.watch/api/homepage-history", {
        headers: { "If-None-Match": "*" },
      }), makeEnv(), makeCtx());
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.has("ETag")).toBe(false);
    } finally { clock.mockRestore(); }
  });

  it("short-circuits CORS preflights before the access gate", async () => {
    const preflightResponse = new Response(null, { status: 204 });
    mocks.handleCorsPreflight.mockReturnValue(preflightResponse);

    const response = await handleHttpRequestImpl(
      new Request("https://api.pharos.watch/api/stablecoins", { method: "OPTIONS" }),
      makeEnv(),
      makeCtx(),
    );

    expect(response).toBe(preflightResponse);
    expect(mocks.warnWorkerEnvIssuesOnce).toHaveBeenCalledOnce();
    expect(mocks.handleMaintenanceMode).not.toHaveBeenCalled();
    expect(mocks.evaluateAccessGate).not.toHaveBeenCalled();
    expect(mocks.createRequestSourceRecorder).not.toHaveBeenCalled();
  });

  it("wraps maintenance-mode responses with CORS headers", async () => {
    const maintenanceResponse = new Response(JSON.stringify({ error: "maintenance" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
    mocks.handleMaintenanceMode.mockReturnValue(maintenanceResponse);

    const response = await handleHttpRequestImpl(
      new Request("https://api.pharos.watch/api/stablecoins"),
      makeEnv(),
      makeCtx(),
    );

    expect(response).toBe(maintenanceResponse);
    expect(mocks.addCorsHeaders).toHaveBeenCalledWith(maintenanceResponse, "https://pharos.watch");
    expect(mocks.evaluateAccessGate).not.toHaveBeenCalled();
  });

  it("short-circuits Telegram ingress abuse rejections before access, D1 attribution, and routing", async () => {
    const gateResponse = new Response(JSON.stringify({ error: "rate limited" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
    mocks.evaluateTelegramIngressAbuseGate.mockImplementation(async (request: Request) => ({
      request,
      response: gateResponse,
    }));

    const response = await handleHttpRequestImpl(
      new Request("https://api.pharos.watch/api/telegram-mini-app/session", {
        method: "POST",
        body: "{}",
      }),
      makeEnv(),
      makeCtx(),
    );

    expect(response).toBe(gateResponse);
    expect(mocks.evaluateAccessGate).not.toHaveBeenCalled();
    expect(mocks.createRequestSourceRecorder).not.toHaveBeenCalled();
    expect(mocks.resolveRoute).not.toHaveBeenCalled();
    expect(mocks.route).not.toHaveBeenCalled();
    expect(mocks.recordTelegramIngressHandlerResponse).not.toHaveBeenCalled();
  });

  it("routes the rebuilt bounded Telegram request and observes handler rejections", async () => {
    const originalRequest = new Request("https://api.pharos.watch/api/telegram-mini-app/mutate", {
      method: "POST",
      headers: { "Content-Length": "2" },
      body: "{}",
    });
    const boundedRequest = new Request(originalRequest.url, {
      method: "POST",
      body: "{}",
    });
    const handlerResponse = new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
    mocks.evaluateTelegramIngressAbuseGate.mockResolvedValue({
      request: boundedRequest,
      response: null,
    });
    mocks.route.mockResolvedValue(handlerResponse);

    const response = await handleHttpRequestImpl(originalRequest, makeEnv(), makeCtx());

    expect(response).toBe(handlerResponse);
    expect(mocks.evaluateAccessGate).toHaveBeenCalledWith(
      boundedRequest,
      new URL(originalRequest.url),
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.buildRouteContext).toHaveBeenCalledWith(expect.objectContaining({
      request: boundedRequest,
    }));
    expect(mocks.recordTelegramIngressHandlerResponse).toHaveBeenCalledWith(
      boundedRequest,
      new URL(originalRequest.url),
      handlerResponse,
    );
  });

  it("records request source and returns the access-gate response on rejection", async () => {
    const gateResponse = new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
    mocks.evaluateAccessGate.mockResolvedValue({
      isAdmin: false,
      isSiteProxy: false,
      apiKey: null,
      requestLane: "public-api",
      response: gateResponse,
    });

    const response = await handleHttpRequestImpl(
      new Request("https://api.pharos.watch/api/stablecoins"),
      makeEnv(),
      makeCtx(),
    );

    expect(response).toBe(gateResponse);
    expect(mocks.recordRequestSource).toHaveBeenCalledOnce();
    expect(mocks.readEdgeCache).not.toHaveBeenCalled();
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it("returns edge-cache hits before route lookup and records attribution", async () => {
    const cachedResponse = new Response(JSON.stringify({ cached: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    mocks.readEdgeCache.mockResolvedValue(cachedResponse);

    const response = await handleHttpRequestImpl(
      new Request("https://api.pharos.watch/api/stablecoins"),
      makeEnv(),
      makeCtx(),
    );

    expect(response).toBe(cachedResponse);
    expect(mocks.recordRequestSource).toHaveBeenCalledOnce();
    expect(mocks.resolveRoute).not.toHaveBeenCalled();
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it.each([false, true])("enforces the fast limiter before serving authenticated cache hits (blocked=%s)", async (blocked) => {
    const cached = new Response("cached");
    const rejection = new Response("limited", { status: 429 });
    mocks.evaluateCachedPublicApiReadFastGate.mockResolvedValue({
      isAdmin: false, isSiteProxy: false,
      apiKey: { id: 123, trafficClass: "external", rateLimitPerMinute: 120 },
      requestLane: "public-api", response: null,
    });
    mocks.readEdgeCache.mockResolvedValue(cached);
    mocks.checkCachedPublicApiReadFastRateLimit.mockReturnValue(blocked ? rejection : null);
    mocks.addCorsHeaders.mockImplementation((response: Response) => {
      response.headers.set("Access-Control-Allow-Origin", "https://pharos.watch");
      return response;
    });

    const response = await handleHttpRequestImpl(
      new Request("https://api.pharos.watch/api/stablecoins", { headers: { "X-API-Key": "cached-key" } }),
      makeEnv(), makeCtx(),
    );

    expect(response.status).toBe(blocked ? 429 : 200);
    await expect(response.text()).resolves.toBe(blocked ? "limited" : "cached");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://pharos.watch");
    expect(mocks.checkCachedPublicApiReadFastRateLimit).toHaveBeenCalledOnce();
    expect(mocks.recordRequestSource).toHaveBeenCalledOnce();
    expect(mocks.addCorsHeaders).toHaveBeenCalledOnce();
    expect(mocks.evaluateAccessGate).not.toHaveBeenCalled();
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it("does not probe edge cache twice after a fast-gate cache miss", async () => {
    const routedResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const edgeCacheContext = { cacheKey: new Request("https://api.pharos.watch/api/stablecoins"), skipCache: false };
    mocks.evaluateCachedPublicApiReadFastGate.mockResolvedValue({
      isAdmin: false,
      isSiteProxy: false,
      apiKey: { id: 123, trafficClass: "external", rateLimitPerMinute: 120 },
      requestLane: "public-api",
      response: null,
    });
    mocks.readEdgeCache.mockResolvedValue(null);
    mocks.createEdgeCacheContext.mockReturnValue(edgeCacheContext);
    mocks.route.mockResolvedValue(routedResponse);

    const response = await handleHttpRequestImpl(
      new Request("https://api.pharos.watch/api/stablecoins", {
        headers: { "X-API-Key": "ph_live_0123456789abcdef_mockSecretValue1234567890" },
      }),
      makeEnv(),
      makeCtx(),
    );

    expect(response).toBe(routedResponse);
    expect(mocks.readEdgeCache).toHaveBeenCalledOnce();
    expect(mocks.readEdgeCache).toHaveBeenCalledWith(edgeCacheContext);
    expect(mocks.evaluateAccessGate).toHaveBeenCalledOnce();
    expect(mocks.route).toHaveBeenCalledOnce();
    expect(mocks.checkCachedPublicApiReadFastRateLimit).not.toHaveBeenCalled();
    expect(mocks.recordRequestSource).toHaveBeenCalledOnce();
  });

  it("returns 404 when no route dependencies are registered for the path", async () => {
    mocks.resolveRoute.mockReturnValue(null);

    const response = await handleHttpRequestImpl(
      new Request("https://api.pharos.watch/api/not-real"),
      makeEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(404);
    expect(mocks.recordRequestSource).toHaveBeenCalledOnce();
    expect(mocks.notFoundResponse).toHaveBeenCalledOnce();
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it.each(["GET", "HEAD"])("redirects a %s of the bare public API host to the API docs", async (method) => {
    mocks.resolveRoute.mockReturnValue(null);

    const response = await handleHttpRequestImpl(
      new Request("https://api.pharos.watch/", { method }),
      makeEnv(),
      makeCtx(),
    );

    expect(response.status).toBe(301);
    expect(response.headers.get("Location")).toBe("https://pharos.watch/api/");
    expect(mocks.notFoundResponse).not.toHaveBeenCalled();
    expect(mocks.recordRequestSource).toHaveBeenCalledOnce();
  });

  it.each([
    ["https://api.pharos.watch/", "POST"],
    ["https://site-api.pharos.watch/", "GET"],
    ["https://api.pharos.watch/robots.txt", "GET"],
  ])("keeps the 404 for %s %s", async (url, method) => {
    mocks.resolveRoute.mockReturnValue(null);

    const response = await handleHttpRequestImpl(new Request(url, { method }), makeEnv(), makeCtx());

    expect(response.status).toBe(404);
    expect(mocks.notFoundResponse).toHaveBeenCalledOnce();
  });

  it("records attribution and writes edge cache on successful routing", async () => {
    const routedResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const edgeCacheContext = { cacheKey: new Request("https://api.pharos.watch/api/stablecoins"), skipCache: false };
    const routeContext = { hydrated: true };
    const resolvedRoute = {
      methodValidation: null,
      routeMatch: { dependencies: ["coingeckoApiKey"], methods: ["GET"], handle: vi.fn() },
    };
    const ctx = makeCtx();
    const request = new Request("https://api.pharos.watch/api/stablecoins");
    const env = makeEnv();

    mocks.createEdgeCacheContext.mockReturnValue(edgeCacheContext);
    mocks.buildRouteContext.mockReturnValue(routeContext);
    mocks.resolveRoute.mockReturnValue(resolvedRoute);
    mocks.route.mockResolvedValue(routedResponse);

    const response = await handleHttpRequestImpl(request, env, ctx);

    expect(response).toBe(routedResponse);
    expect(mocks.route).toHaveBeenCalledWith(routeContext, resolvedRoute);
    // The dispatcher no longer schedules anything itself: rate-limit prunes are
    // handed to `waitUntil` by the limiters, and the edge-cache write forwards
    // the same ctx (mocked here).
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(mocks.recordRequestSource).toHaveBeenCalledOnce();
    expect(mocks.writeEdgeCache).toHaveBeenCalledWith(edgeCacheContext, routedResponse, ctx);
    expect(mocks.addCorsHeaders).toHaveBeenCalledWith(routedResponse, "https://pharos.watch");
  });
});
