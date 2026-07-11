import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeExecutionContext } from "../../../test-helpers/__shared/auth";

const mocks = vi.hoisted(() => ({
  flushPendingApiKeyPrunes: vi.fn(() => Promise.resolve()),
  flushPendingPrunes: vi.fn(() => Promise.resolve()),
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

vi.mock("../../../lib/api-key-rate-limit", () => ({
  flushPendingApiKeyPrunes: mocks.flushPendingApiKeyPrunes,
}));

vi.mock("../../../lib/rate-limit", () => ({
  flushPendingPrunes: mocks.flushPendingPrunes,
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

vi.mock("../telegram-ingress-abuse", () => ({
  evaluateTelegramIngressAbuseGate: mocks.evaluateTelegramIngressAbuseGate,
  recordTelegramIngressHandlerResponse: mocks.recordTelegramIngressHandlerResponse,
}));

import { handleHttpRequestImpl } from "../request-dispatch";

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: {} as D1Database,
    CORS_ORIGIN: "https://pharos.watch",
    ...overrides,
  } as never;
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
    expect(mocks.flushPendingPrunes).toHaveBeenCalledOnce();
    expect(mocks.flushPendingApiKeyPrunes).toHaveBeenCalledOnce();
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
    expect(mocks.flushPendingPrunes).toHaveBeenCalledOnce();
    expect(mocks.flushPendingApiKeyPrunes).toHaveBeenCalledOnce();
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
    expect(mocks.flushPendingPrunes).toHaveBeenCalledOnce();
    expect(mocks.flushPendingApiKeyPrunes).toHaveBeenCalledOnce();
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
    expect(mocks.flushPendingPrunes).toHaveBeenCalledOnce();
    expect(mocks.flushPendingApiKeyPrunes).toHaveBeenCalledOnce();
  });

  it("flushes pending prunes, records attribution, and writes edge cache on successful routing", async () => {
    const flushPromise = Promise.resolve();
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

    mocks.flushPendingPrunes.mockReturnValue(flushPromise);
    mocks.flushPendingApiKeyPrunes.mockReturnValue(Promise.resolve());
    mocks.createEdgeCacheContext.mockReturnValue(edgeCacheContext);
    mocks.buildRouteContext.mockReturnValue(routeContext);
    mocks.resolveRoute.mockReturnValue(resolvedRoute);
    mocks.route.mockResolvedValue(routedResponse);

    const response = await handleHttpRequestImpl(request, env, ctx);

    expect(response).toBe(routedResponse);
    expect(mocks.route).toHaveBeenCalledWith(routeContext, resolvedRoute);
    expect(mocks.flushPendingPrunes).toHaveBeenCalledOnce();
    expect(mocks.flushPendingApiKeyPrunes).toHaveBeenCalledOnce();
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect(mocks.recordRequestSource).toHaveBeenCalledOnce();
    expect(mocks.writeEdgeCache).toHaveBeenCalledWith(edgeCacheContext, routedResponse, ctx);
    expect(mocks.addCorsHeaders).toHaveBeenCalledWith(routedResponse, "https://pharos.watch");
  });
});
