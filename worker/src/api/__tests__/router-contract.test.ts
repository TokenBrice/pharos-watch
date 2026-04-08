import { describe, expect, it, vi } from "vitest";
import { ENDPOINT_DEFINITIONS } from "@shared/lib/api-endpoints";
import { STRICT_CONTRACT_PATHS_LIST } from "@shared/lib/api-endpoints";
import { isMutatingAdminGetAllowed } from "@shared/lib/api-endpoints/validation";
import { route, ROUTER_STATIC_PATHS } from "../../router";
import type { FullRouteContext } from "../../routes/shared";
import { mockD1 } from "./helpers/mock-d1";

vi.stubGlobal("fetch", vi.fn(async () => (
  new Response(JSON.stringify({
    tokens: [],
    prices: [],
    market_caps: [],
    tvl: [],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
)));

const db = mockD1();
const execCtx = {
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function makeRouteCtx(overrides: Partial<FullRouteContext> & { url: URL }): FullRouteContext {
  const defaultRequest = new Request(overrides.url.toString());
  return { db, execCtx, request: defaultRequest, trustedAdmin: false, ...overrides };
}

describe("router contract: strict frontend paths are routable", () => {
  it("routes all strict contract paths", async () => {
    for (const path of STRICT_CONTRACT_PATHS_LIST) {
      const result = route(makeRouteCtx({ url: new URL(`https://api.pharos.watch${path}`) }));
      expect(result, `expected route for ${path}`).not.toBeNull();

      const response = await result!;
      expect(response.status, `unexpected 404 for ${path}`).not.toBe(404);
      expect(response.status, `unexpected 500 for ${path}`).not.toBe(500);
    }
  });

  it("returns null for unknown paths", () => {
    const result = route(makeRouteCtx({ url: new URL("https://api.pharos.watch/api/definitely-not-real") }));
    expect(result).toBeNull();
  });

  it("keeps router static paths registered in endpoint definitions", () => {
    const registeredPaths = new Set(ENDPOINT_DEFINITIONS.map((endpoint) => endpoint.path));

    for (const path of ROUTER_STATIC_PATHS) {
      expect(
        registeredPaths.has(path),
        `expected ${path} to be present in ENDPOINT_DEFINITIONS`,
      ).toBe(true);
    }
  });

  it("keeps endpoint registry and router behavior aligned", async () => {
    for (const endpoint of ENDPOINT_DEFINITIONS) {
      const path = endpoint.probePath ?? endpoint.path;
      for (const method of endpoint.methods) {
        const request = new Request(`https://api.pharos.watch${path}`, { method });
        const expectedPublicStatuses =
          endpoint.path === "/api/telegram-webhook"
            ? [200, 400, 501, 502, 503]
            : endpoint.path === "/api/stablecoin-reserves/iusd-infinifi"
              ? [200, 400, 502, 503]
              : [200, 400, 502, 503];

        const response = await route(makeRouteCtx({
          url: new URL(`https://api.pharos.watch${path}`),
          request,
        }));
        expect(response, `expected route for ${method} ${path}`).not.toBeNull();

        if (
          method === "GET"
          && endpoint.mutatingAdmin
          && !isMutatingAdminGetAllowed(new URL(`https://api.pharos.watch${path}`))
        ) {
          expect(response!.status).toBe(405);
        } else if (endpoint.adminRequired) {
          expect(response!.status).toBe(401);
        } else {
          expect(expectedPublicStatuses).toContain(response!.status);
        }
      }
    }
  });

  it("enforces mutating admin GET restrictions with path-specific preview exceptions", async () => {
    for (const endpoint of ENDPOINT_DEFINITIONS.filter((item) => item.mutatingAdmin)) {
      const path = endpoint.path;
      const getResult = await route(makeRouteCtx({
        url: new URL(`https://api.pharos.watch${path}`),
        request: new Request(`https://api.pharos.watch${path}`, { method: "GET" }),
      }));
      expect(getResult, `expected GET route resolution for ${path}`).not.toBeNull();

      if (path === "/api/audit-depeg-history") {
        expect(getResult!.status).toBe(405);
        const dryRun = await route(makeRouteCtx({
          url: new URL("https://api.pharos.watch/api/audit-depeg-history?dry-run=true"),
          request: new Request("https://api.pharos.watch/api/audit-depeg-history?dry-run=true", { method: "GET" }),
        }));
        expect(dryRun).not.toBeNull();
        expect(dryRun!.status).not.toBe(405);
      } else if (path === "/api/backfill-dews") {
        expect(getResult!.status).not.toBe(405);
        const repairPreview = await route(makeRouteCtx({
          url: new URL("https://api.pharos.watch/api/backfill-dews?repair=refresh-current&dry-run=true"),
          request: new Request("https://api.pharos.watch/api/backfill-dews?repair=refresh-current&dry-run=true", { method: "GET" }),
        }));
        expect(repairPreview).not.toBeNull();
        expect(repairPreview!.status).not.toBe(405);

        const forbiddenRepairGet = await route(makeRouteCtx({
          url: new URL("https://api.pharos.watch/api/backfill-dews?repair=refresh-current"),
          request: new Request("https://api.pharos.watch/api/backfill-dews?repair=refresh-current", { method: "GET" }),
        }));
        expect(forbiddenRepairGet).not.toBeNull();
        expect(forbiddenRepairGet!.status).toBe(405);
      } else {
        expect(getResult!.status).toBe(405);
      }

      if (endpoint.methods.includes("POST")) {
        const postResult = await route(makeRouteCtx({
          url: new URL(`https://api.pharos.watch${path}`),
          request: new Request(`https://api.pharos.watch${path}`, { method: "POST" }),
        }));
        expect(postResult).not.toBeNull();
        expect(postResult!.status).not.toBe(405);
      }
    }
  });

  it("keeps the dynamic discovery dismiss route aligned with shared admin method/auth rules", async () => {
    const postPath = "https://api.pharos.watch/api/discovery-candidates/42/dismiss";
    const postResult = await route(makeRouteCtx({
      url: new URL(postPath),
      request: new Request(postPath, { method: "POST" }),
    }));
    expect(postResult).not.toBeNull();
    expect(postResult!.status).toBe(401);

    const getResult = await route(makeRouteCtx({
      url: new URL(postPath),
      request: new Request(postPath, { method: "GET" }),
    }));
    expect(getResult).not.toBeNull();
    expect(getResult!.status).toBe(405);
  });

  it("keeps the dynamic API key admin routes aligned with shared method/auth rules", async () => {
    const postPath = "https://api.pharos.watch/api/api-keys/7/rotate";
    const postResult = await route(makeRouteCtx({
      url: new URL(postPath),
      request: new Request(postPath, { method: "POST" }),
    }));
    expect(postResult).not.toBeNull();
    expect(postResult!.status).toBe(401);

    const getResult = await route(makeRouteCtx({
      url: new URL(postPath),
      request: new Request(postPath, { method: "GET" }),
    }));
    expect(getResult).not.toBeNull();
    expect(getResult!.status).toBe(405);
  });
});
