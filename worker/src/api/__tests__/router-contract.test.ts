import { describe, expect, it, vi } from "vitest";
import { ENDPOINT_DEFINITIONS } from "../../../../src/lib/api-endpoints";
import { STRICT_CONTRACT_PATHS_LIST } from "../../../../src/lib/strict-contract-paths";
import { route, ROUTER_STATIC_PATHS } from "../../router";
import worker from "../../index";
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
const ctx = {
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const env = {
  DB: db,
  CORS_ORIGIN: "https://pharos.watch",
  ADMIN_KEY: "test-admin",
} as const;

describe("router contract: strict frontend paths are routable", () => {
  it("routes all strict contract paths", async () => {
    for (const path of STRICT_CONTRACT_PATHS_LIST) {
      const result = route(new URL(`https://api.pharos.watch${path}`), db, ctx);
      expect(result, `expected route for ${path}`).not.toBeNull();

      const response = await result!;
      expect(response.status, `unexpected 404 for ${path}`).not.toBe(404);
      expect(response.status, `unexpected 500 for ${path}`).not.toBe(500);
    }
  });

  it("returns null for unknown paths", () => {
    const result = route(new URL("https://api.pharos.watch/api/definitely-not-real"), db, ctx);
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
        const allowAuditDryRunGet =
          endpoint.path === "/api/audit-depeg-history" &&
          method === "GET" &&
          path.includes("dry-run=true");

        if (endpoint.routerHandled === false) {
          const response = await worker.fetch(
            request,
            env as never,
            ctx,
          );
          if (method === "GET" && endpoint.mutatingAdmin && !allowAuditDryRunGet) {
            expect(response.status).toBe(405);
          } else if (endpoint.adminRequired) {
            expect(response.status).toBe(401);
          } else {
            expect([200, 400, 502, 503]).toContain(response.status);
          }
        } else {
          const response = await route(
            new URL(`https://api.pharos.watch${path}`),
            db,
            ctx,
            request,
            env.ADMIN_KEY,
            null,
          );
          expect(response, `expected route for ${method} ${path}`).not.toBeNull();

          if (method === "GET" && endpoint.mutatingAdmin && !allowAuditDryRunGet) {
            expect(response!.status).toBe(405);
          } else if (endpoint.adminRequired) {
            expect(response!.status).toBe(401);
          } else {
            expect([200, 400, 502, 503]).toContain(response!.status);
          }
        }
      }
    }
  });

  it("enforces mutating admin GET restrictions with audit dry-run exception", async () => {
    for (const endpoint of ENDPOINT_DEFINITIONS.filter((item) => item.mutatingAdmin)) {
      const path = endpoint.path;
      const getResult = await route(
        new URL(`https://api.pharos.watch${path}`),
        db,
        ctx,
        new Request(`https://api.pharos.watch${path}`, { method: "GET" }),
      );
      expect(getResult, `expected GET route resolution for ${path}`).not.toBeNull();

      if (path === "/api/audit-depeg-history") {
        expect(getResult!.status).toBe(405);
        const dryRun = await route(
          new URL("https://api.pharos.watch/api/audit-depeg-history?dry-run=true"),
          db,
          ctx,
          new Request("https://api.pharos.watch/api/audit-depeg-history?dry-run=true", { method: "GET" }),
        );
        expect(dryRun).not.toBeNull();
        expect(dryRun!.status).not.toBe(405);
      } else {
        expect(getResult!.status).toBe(405);
      }

      if (endpoint.methods.includes("POST")) {
        if (endpoint.routerHandled === false) {
          const postResponse = await worker.fetch(
            new Request(`https://api.pharos.watch${path}`, { method: "POST" }),
            env as never,
            ctx,
          );
          expect(postResponse.status).not.toBe(404);
          expect(postResponse.status).not.toBe(405);
        } else {
          const postResult = await route(
            new URL(`https://api.pharos.watch${path}`),
            db,
            ctx,
            new Request(`https://api.pharos.watch${path}`, { method: "POST" }),
          );
          expect(postResult).not.toBeNull();
          expect(postResult!.status).not.toBe(405);
        }
      }
    }
  });
});
