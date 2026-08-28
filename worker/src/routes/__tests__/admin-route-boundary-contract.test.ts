import { describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import type { FullRouteContext, StaticRouteDefinition } from "../shared";

const handlers = vi.hoisted(() => ({
  auditDepegHistory: vi.fn(async () => Response.json({ ok: true })),
  backfillDepegs: vi.fn(async () => Response.json({ ok: true })),
  backfillMintBurn: vi.fn(async () => Response.json({ ok: true })),
  backfillYieldHistory: vi.fn(async () => Response.json({ ok: true })),
}));

vi.mock("../../api/audit-depeg-history", () => ({
  handleAuditDepegHistoryTrusted: handlers.auditDepegHistory,
}));

vi.mock("../../api/backfill-depegs", () => ({
  handleBackfillDepegsTrusted: handlers.backfillDepegs,
}));

vi.mock("../../api/backfill-mint-burn", async () => {
  const { runAdminJob } = await import("../../lib/admin-job");
  return {
    handleBackfillMintBurn: ({ request, url }: { request?: Request; url: URL }) =>
      runAdminJob({ request, url, parseBody: true }, () => handlers.backfillMintBurn()),
  };
});

vi.mock("../../api/backfill-yield-history", () => ({
  handleBackfillYieldHistory: handlers.backfillYieldHistory,
}));

import { ADMIN_STATIC_ROUTES } from "../admin-routes";

const execCtx = {
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const unusedDb = {} as D1Database;

function findRoute(key: string): StaticRouteDefinition {
  const route = ADMIN_STATIC_ROUTES.find((candidate) => candidate.endpoint.key === key);
  if (!route) throw new Error(`Missing route ${key}`);
  return route;
}

function makeContext(
  route: StaticRouteDefinition,
  options: {
    db?: D1Database;
    method?: "GET" | "POST";
    trustedAdmin?: boolean;
    adminHeader?: boolean;
    idempotencyKey?: string;
    body?: string;
  } = {},
): FullRouteContext {
  const method = options.method ?? "POST";
  const headers = new Headers();
  if (method === "POST" && options.adminHeader !== false) headers.set("X-Pharos-Admin", "1");
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  if (options.body != null) headers.set("Content-Type", "application/json");
  const url = new URL(`https://ops-api.pharos.watch${route.endpoint.path}`);
  return {
    db: options.db ?? unusedDb,
    execCtx,
    request: new Request(url, { method, headers, body: options.body }),
    trustedAdmin: options.trustedAdmin ?? false,
    url,
  };
}

async function expectNoStoreJson(response: Response, status: number, body: unknown): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual(body);
}

describe("admin route boundary contract", () => {
  it.each([
    ["always-idempotent", "backfill-depegs", "POST"],
    ["conditional-idempotency mutation", "audit-depeg-history", "POST"],
    ["conditional-idempotency read", "audit-depeg-history", "GET"],
  ] as const)("preserves the exact unauthorized response for %s routes", async (_routeClass, key, method) => {
    const route = findRoute(key);

    const response = await route.handler(makeContext(route, { method }));

    await expectNoStoreJson(response, 401, { error: "Unauthorized" });
  });

  it("rejects a mutation missing the admin header before loading its handler", async () => {
    const route = findRoute("backfill-depegs");
    const callsBefore = handlers.backfillDepegs.mock.calls.length;

    const response = await route.handler(makeContext(route, { trustedAdmin: true, adminHeader: false }));

    await expectNoStoreJson(response, 403, {
      error: "Missing required X-Pharos-Admin header; refusing mutation.",
    });
    expect(handlers.backfillDepegs).toHaveBeenCalledTimes(callsBefore);
  });

  // The mocked handler lazily imports the real admin-job module graph on first
  // invocation; under a loaded full-suite worker pool that import can exceed the
  // default 5s budget even though the behavior under test is deterministic.
  it("owns malformed-body handling and no-store headers for parsed admin jobs", { timeout: 30_000 }, async () => {
    const route = findRoute("backfill-mint-burn");

    const response = await route.handler(makeContext(route, { trustedAdmin: true, body: "{" }));

    await expectNoStoreJson(response, 400, { error: "Invalid JSON body" });
    expect(handlers.backfillMintBurn).not.toHaveBeenCalled();
  });

  it("owns the thrown-error boundary and no-store header", async () => {
    const route = findRoute("backfill-yield-history");
    handlers.backfillYieldHistory.mockRejectedValueOnce(new Error("sensitive database detail"));

    const response = await route.handler(makeContext(route, { trustedAdmin: true }));

    await expectNoStoreJson(response, 500, { error: "Internal Server Error" });
  });

  it("replays an always-idempotent route without invoking its handler twice", async () => {
    const route = findRoute("backfill-depegs");
    const { db } = createLatestSchemaSqlite();
    const callsBefore = handlers.backfillDepegs.mock.calls.length;
    const options = { db, trustedAdmin: true, idempotencyKey: "route-replay-contract" } as const;

    const first = await route.handler(makeContext(route, options));
    const replay = await route.handler(makeContext(route, options));

    expect(first.status).toBe(200);
    expect(first.headers.get("X-Idempotent-Replay")).toBe("false");
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(replay.status).toBe(200);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(replay.headers.get("Cache-Control")).toBe("no-store");
    expect(handlers.backfillDepegs).toHaveBeenCalledTimes(callsBefore + 1);
  });

  it("applies no-store to successful conditional-idempotency reads", async () => {
    const route = findRoute("audit-depeg-history");

    const response = await route.handler(makeContext(route, { method: "GET", trustedAdmin: true }));

    await expectNoStoreJson(response, 200, { ok: true });
  });
});
