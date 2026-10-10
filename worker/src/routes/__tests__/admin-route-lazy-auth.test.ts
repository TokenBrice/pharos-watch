import { describe, expect, it, vi } from "vitest";
import { ADMIN_STATIC_ROUTES } from "../admin-routes";
import type { FullRouteContext, StaticRouteDefinition } from "../shared";
import { mockD1 } from "@shared/test-utils/mock-d1";

const moduleLoads = vi.hoisted(() => ({
  auditDepegHistory: vi.fn(),
  backfillDepegs: vi.fn(),
}));

vi.mock("../../api/backfill-dews", () => {
  moduleLoads.auditDepegHistory();
  return {
    handleBackfillDEWS: vi.fn(async () => new Response("ok")),
  };
});

vi.mock("../../api/remediate-blacklist-amount-gaps", () => {
  moduleLoads.backfillDepegs();
  return {
    handleRemediateBlacklistAmountGapsTrusted: vi.fn(async () => new Response("ok")),
  };
});

const db = mockD1();
const execCtx = {
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function findRoute(routes: readonly StaticRouteDefinition[], key: string): StaticRouteDefinition {
  const route = routes.find((candidate) => candidate.endpoint.key === key);
  if (!route) throw new Error(`Missing route ${key}`);
  return route;
}

function makeContext(path: string, method: "GET" | "POST"): FullRouteContext {
  const url = new URL(`https://ops-api.pharos.watch${path}`);
  return {
    db,
    execCtx,
    request: new Request(url, {
      method,
      headers: method === "POST" ? { "X-Pharos-Admin": "1" } : undefined,
    }),
    trustedAdmin: false,
    url,
  };
}

describe("lazy admin route authentication", () => {
  it("rejects an idempotent route before importing its endpoint module", async () => {
    const route = findRoute(ADMIN_STATIC_ROUTES, "remediate-blacklist-amount-gaps");

    const response = await route.handler(makeContext(route.endpoint.path, "POST"));

    expect(response.status).toBe(401);
    expect(moduleLoads.backfillDepegs).not.toHaveBeenCalled();
  });

  it("rejects a conditional-idempotency route before importing its endpoint module", async () => {
    const route = findRoute(ADMIN_STATIC_ROUTES, "backfill-dews");

    const response = await route.handler(makeContext(route.endpoint.path, "POST"));

    expect(response.status).toBe(401);
    expect(moduleLoads.auditDepegHistory).not.toHaveBeenCalled();
  });

});
