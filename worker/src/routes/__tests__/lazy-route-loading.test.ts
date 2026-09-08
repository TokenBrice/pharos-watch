import { describe, expect, it, vi } from "vitest";
import { defineLazyStaticRoute, type FullRouteContext } from "../shared";

const loads = vi.hoisted(() => ({
  health: vi.fn(), requestDispatch: vi.fn(), scheduled: vi.fn(),
  apiUtils: vi.fn(), freshness: vi.fn(), canary: vi.fn(), apiKeys: vi.fn(),
}));
vi.mock("../../api/health", () => {
  loads.health();
  return { handleHealth: async () => new Response("health-loaded") };
});
vi.mock("../../handlers/http/request-dispatch", () => {
  loads.requestDispatch();
  return { dispatchHttpRequest: vi.fn() };
});
vi.mock("../../handlers/scheduled", () => {
  loads.scheduled();
  return { handleScheduled: vi.fn() };
});
vi.mock("../../lib/api-utils", async (importOriginal) => {
  loads.apiUtils();
  return importOriginal();
});
vi.mock("../../lib/api-freshness", async (importOriginal) => {
  loads.freshness();
  return importOriginal();
});
vi.mock("../../lib/canary-checks", async (importOriginal) => {
  loads.canary();
  return importOriginal();
});
vi.mock("../../lib/api-keys", async (importOriginal) => {
  loads.apiKeys();
  return importOriginal();
});

describe("lazy route loading", () => {
  it("does not load a static endpoint module until the route is invoked", async () => {
    const response = new Response("ok");
    const handler = vi.fn(async () => response);
    const loadHandler = vi.fn(async () => handler);
    const route = defineLazyStaticRoute("health", loadHandler);
    expect(loadHandler).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    await expect(route.handler({} as FullRouteContext)).resolves.toBe(response);
    expect(loadHandler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("cold-loads the Worker and route catalogs without loading handlers, then loads the selected endpoint", async () => {
    vi.resetModules();
    // Dynamic imports intentionally exercise the cold module-loading boundary.
    await import("../../index");
    await Promise.all([
      import("../admin-routes"), import("../dynamic-routes"), import("../messaging-routes"), import("../ops-routes"),
    ]);
    const { PUBLIC_STATIC_ROUTES } = await import("../public-routes");
    expect(loads.health).not.toHaveBeenCalled();
    expect(loads.requestDispatch).not.toHaveBeenCalled();
    expect(loads.scheduled).not.toHaveBeenCalled();
    const route = PUBLIC_STATIC_ROUTES.find((candidate) => candidate.endpoint.key === "health")!;
    const response = await route.handler({ db: {} as D1Database } as FullRouteContext);
    expect(await response.text()).toBe("health-loaded");
    expect(loads.health).toHaveBeenCalledOnce();
    expect(loads.requestDispatch).not.toHaveBeenCalled();
    expect(loads.scheduled).not.toHaveBeenCalled();
  });

  it("loads HTTP roots without the API utility barrel", async () => {
    vi.resetModules();
    loads.apiUtils.mockClear();
    // Static imports would warm the module graph before the factory assertions.
    await Promise.all([
      import("../../router"), import("../../handlers/http/gates"),
      import("../../handlers/http/telegram-ingress-abuse"), import("../../lib/api-key-core"),
      import("../../lib/auth"), import("../../lib/idempotency"), import("../../lib/route-wrappers"),
    ]);
    expect(loads.apiUtils).not.toHaveBeenCalled();
  });

  it("keeps lightweight response, dependency and gate modules free of their heavy implementations", async () => {
    for (const [load, forbidden] of [
      [() => import("../../lib/api-response"), loads.freshness],
      [() => import("../dependency-hydrators"), loads.canary],
      [() => import("../../handlers/http/gates"), loads.apiKeys],
    ] as const) {
      vi.resetModules();
      forbidden.mockClear();
      await load();
      expect(forbidden).not.toHaveBeenCalled();
    }
  });
});
