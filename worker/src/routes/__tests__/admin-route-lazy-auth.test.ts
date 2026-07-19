import { describe, expect, it, vi } from "vitest";
import { ADMIN_STATIC_ROUTES } from "../admin-routes";
import type { FullRouteContext, StaticRouteDefinition } from "../shared";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

const moduleLoads = vi.hoisted(() => ({
  auditDepegHistory: vi.fn(),
  backfillDepegs: vi.fn(),
  reserveFaultInjection: vi.fn(),
}));

vi.mock("../../api/audit-depeg-history", () => {
  moduleLoads.auditDepegHistory();
  return {
    handleAuditDepegHistoryTrusted: vi.fn(async () => new Response("ok")),
  };
});

vi.mock("../../api/backfill-depegs", () => {
  moduleLoads.backfillDepegs();
  return {
    handleBackfillDepegsTrusted: vi.fn(async () => new Response("ok")),
  };
});

vi.mock("../../api/admin-reserve-recovery-fault-injection", () => {
  moduleLoads.reserveFaultInjection();
  return {
    handleArmReserveRecoveryFaultInjection: vi.fn(async () => new Response("ok")),
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
    const route = findRoute(ADMIN_STATIC_ROUTES, "backfill-depegs");

    const response = await route.handler(makeContext(route.endpoint.path, "POST"));

    expect(response.status).toBe(401);
    expect(moduleLoads.backfillDepegs).not.toHaveBeenCalled();
  });

  it("rejects a conditional-idempotency route before importing its endpoint module", async () => {
    const route = findRoute(ADMIN_STATIC_ROUTES, "audit-depeg-history");

    const response = await route.handler(makeContext(route.endpoint.path, "POST"));

    expect(response.status).toBe(401);
    expect(moduleLoads.auditDepegHistory).not.toHaveBeenCalled();
  });

  it("rejects reserve fault injection before importing its endpoint module", async () => {
    const route = findRoute(ADMIN_STATIC_ROUTES, "reserve-recovery-fault-injection");

    const response = await route.handler(makeContext(route.endpoint.path, "POST"));

    expect(response.status).toBe(401);
    expect(moduleLoads.reserveFaultInjection).not.toHaveBeenCalled();
  });

});
