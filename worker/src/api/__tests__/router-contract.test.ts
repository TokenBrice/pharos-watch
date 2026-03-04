import { describe, expect, it } from "vitest";
import { ENDPOINT_DEFINITIONS } from "../../../../src/lib/api-endpoints";
import { STRICT_CONTRACT_PATHS_LIST } from "../../../../src/lib/strict-contract-paths";
import { route } from "../../router";
import worker from "../../index";
import { mockD1 } from "./helpers/mock-d1";

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
    }
  });

  it("returns null for unknown paths", () => {
    const result = route(new URL("https://api.pharos.watch/api/definitely-not-real"), db, ctx);
    expect(result).toBeNull();
  });

  it("keeps endpoint registry and router behavior aligned", async () => {
    for (const endpoint of ENDPOINT_DEFINITIONS) {
      const path = endpoint.probePath ?? endpoint.path;
      for (const method of endpoint.methods) {
        if (endpoint.routerHandled === false) {
          const response = await worker.fetch(
            new Request(`https://api.pharos.watch${path}`, { method }),
            env as never,
            ctx,
          );
          expect(response.status, `unexpected 404 for worker-handled ${method} ${path}`).not.toBe(404);
          continue;
        }

        const response = await route(
          new URL(`https://api.pharos.watch${path}`),
          db,
          ctx,
          new Request(`https://api.pharos.watch${path}`, { method }),
        );
        expect(response, `expected route for ${method} ${path}`).not.toBeNull();
        expect(response!.status, `unexpected 404 for ${method} ${path}`).not.toBe(404);
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
