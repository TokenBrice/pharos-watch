import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  flushPendingPrunes: vi.fn(() => Promise.resolve()),
  getRouteDependencies: vi.fn(),
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
  evaluateAccessGate: vi.fn(),
  handleMaintenanceMode: vi.fn(),
  notFoundResponse: vi.fn(),
  warnWorkerEnvIssuesOnce: vi.fn(),
}));

vi.mock("../../../lib/rate-limit", () => ({
  flushPendingPrunes: mocks.flushPendingPrunes,
}));

vi.mock("../../../router", () => ({
  getRouteDependencies: mocks.getRouteDependencies,
  route: mocks.route,
}));

vi.mock("../request-source", () => ({
  createRequestSourceRecorder: mocks.createRequestSourceRecorder,
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
  evaluateAccessGate: mocks.evaluateAccessGate,
  handleMaintenanceMode: mocks.handleMaintenanceMode,
  notFoundResponse: mocks.notFoundResponse,
  warnWorkerEnvIssuesOnce: mocks.warnWorkerEnvIssuesOnce,
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
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };
}

describe("handleHttpRequestImpl", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.resolveCorsOrigin.mockReturnValue("https://pharos.watch");
    mocks.handleCorsPreflight.mockReturnValue(null);
    mocks.handleMaintenanceMode.mockReturnValue(null);
    mocks.evaluateAccessGate.mockResolvedValue({
      isAdmin: false,
      isSiteProxy: false,
      apiKey: null,
      requestLane: "public-api",
      response: null,
    });
    mocks.createRequestSourceRecorder.mockReturnValue(mocks.recordRequestSource);
    mocks.createEdgeCacheContext.mockReturnValue({ cacheKey: new Request("https://api.pharos.watch/api/stablecoins"), skipCache: false });
    mocks.readEdgeCache.mockResolvedValue(null);
    mocks.getRouteDependencies.mockReturnValue(["coingeckoApiKey"]);
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
    expect(mocks.getRouteDependencies).not.toHaveBeenCalled();
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it("returns 404 when no route dependencies are registered for the path", async () => {
    mocks.getRouteDependencies.mockReturnValue(null);

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

  it("returns 404 when the router returns null after dependency hydration", async () => {
    mocks.route.mockResolvedValue(null);
    const ctx = makeCtx();
    const request = new Request("https://api.pharos.watch/api/stablecoins");
    const env = makeEnv();

    const response = await handleHttpRequestImpl(request, env, ctx);

    expect(response.status).toBe(404);
    expect(mocks.buildRouteContext).toHaveBeenCalledWith({
      request,
      url: new URL(request.url),
      env,
      execCtx: ctx,
      trustedAdmin: false,
      routeDependencies: ["coingeckoApiKey"],
    });
    expect(mocks.recordRequestSource).toHaveBeenCalledOnce();
    expect(mocks.flushPendingPrunes).not.toHaveBeenCalled();
    expect(mocks.writeEdgeCache).not.toHaveBeenCalled();
  });

  it("flushes pending prunes, records attribution, and writes edge cache on successful routing", async () => {
    const flushPromise = Promise.resolve();
    const routedResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const edgeCacheContext = { cacheKey: new Request("https://api.pharos.watch/api/stablecoins"), skipCache: false };
    const routeContext = { hydrated: true };
    const ctx = makeCtx();
    const request = new Request("https://api.pharos.watch/api/stablecoins");
    const env = makeEnv();

    mocks.flushPendingPrunes.mockReturnValue(flushPromise);
    mocks.createEdgeCacheContext.mockReturnValue(edgeCacheContext);
    mocks.buildRouteContext.mockReturnValue(routeContext);
    mocks.route.mockResolvedValue(routedResponse);

    const response = await handleHttpRequestImpl(request, env, ctx);

    expect(response).toBe(routedResponse);
    expect(mocks.route).toHaveBeenCalledWith(routeContext);
    expect(ctx.waitUntil).toHaveBeenCalledWith(flushPromise);
    expect(mocks.recordRequestSource).toHaveBeenCalledOnce();
    expect(mocks.writeEdgeCache).toHaveBeenCalledWith(edgeCacheContext, routedResponse, ctx);
    expect(mocks.addCorsHeaders).toHaveBeenCalledWith(routedResponse, "https://pharos.watch");
  });
});
