import { fileURLToPath, URL as NodeURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import type { FullRouteContext } from "../shared";

const loads = vi.hoisted(() => ({
  health: vi.fn(), requestDispatch: vi.fn(), scheduled: vi.fn(),
  apiUtils: vi.fn(), freshness: vi.fn(), canary: vi.fn(), apiKeyAdmin: vi.fn(),
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
vi.mock("../../lib/status/cache-freshness", async (importOriginal) => {
  loads.freshness();
  return importOriginal();
});
vi.mock("../../lib/canary-checks", async (importOriginal) => {
  loads.canary();
  return importOriginal();
});
vi.mock("../../lib/api-key-admin", async (importOriginal) => {
  loads.apiKeyAdmin();
  return importOriginal();
});

describe("lazy route loading", () => {

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
      import("../../telegram/webhook/telegram-ingress-abuse"), import("../../lib/api-key-core"),
      import("../../lib/auth"), import("../../lib/idempotency"), import("../../lib/route-wrappers"),
    ]);
    expect(loads.apiUtils).not.toHaveBeenCalled();
  });

  it("keeps lightweight response, dependency and gate modules free of their heavy implementations", async () => {
    for (const [load, forbidden] of [
      [() => import("../../lib/api-response"), loads.freshness],
      [() => import("../dependency-hydrators"), loads.canary],
      [() => import("../../handlers/http/gates"), loads.apiKeyAdmin],
    ] as const) {
      vi.resetModules();
      forbidden.mockClear();
      await load();
      expect(forbidden).not.toHaveBeenCalled();
    }
  });

  it("keeps the detail snapshot-inputs route graph free of the full stablecoin catalog", async () => {
    // Bundle-level graph, static and dynamic edges: a reachable #pharos-full-catalog
    // resolves to full-catalog.ts through the package imports map (or fails the build).
    const { metafile } = await build({
      absWorkingDir: fileURLToPath(new NodeURL("../../../../", import.meta.url)),
      entryPoints: ["worker/src/api/stablecoin-detail/snapshot-inputs.ts"], tsconfig: "worker/tsconfig.json",
      bundle: true, write: false, metafile: true, format: "esm", platform: "neutral",
      mainFields: ["module", "main"], external: ["node:*"], logLevel: "silent",
    });
    expect(Object.keys(metafile.inputs)).not.toContain("shared/lib/stablecoins/full-catalog.ts");
  });
});
