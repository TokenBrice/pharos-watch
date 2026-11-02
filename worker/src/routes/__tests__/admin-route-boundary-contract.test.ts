import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import type { FullRouteContext, StaticRouteDefinition } from "../shared";
import { runAdminJob } from "../../lib/admin-job";

const handlers = vi.hoisted(() => ({
  dews: vi.fn(async () => Response.json({ ok: true })),
  remediate: vi.fn(async () => Response.json({ ok: true })),
}));
const moduleLoads = vi.hoisted(() => ({
  dews: vi.fn(),
  remediate: vi.fn(),
}));

vi.mock("../../api/backfill-dews", () => {
  moduleLoads.dews();
  return {
    handleBackfillDEWS: ({ request, url }: { request?: Request; url: URL }) =>
      runAdminJob({ request, url, parseBody: true }, () => handlers.dews()),
  };
});
vi.mock("../../api/remediate-blacklist-amount-gaps", () => {
  moduleLoads.remediate();
  return {
    handleRemediateBlacklistAmountGapsTrusted: handlers.remediate,
  };
});

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
  it("rejects an idempotent route before importing its endpoint module", async () => {
    vi.resetModules();
    moduleLoads.remediate.mockClear();
    const { ADMIN_STATIC_ROUTES } = await import("../admin-routes");
    const route = ADMIN_STATIC_ROUTES.find((candidate) => candidate.endpoint.key === "remediate-blacklist-amount-gaps");
    if (!route) throw new Error("Missing route remediate-blacklist-amount-gaps");

    const response = await route.handler(makeContext(route, { method: "POST" }));

    await expectNoStoreJson(response, 401, { error: "Unauthorized" });
    expect(moduleLoads.remediate).not.toHaveBeenCalled();
  });

  it("rejects a conditional-idempotency route before importing its endpoint module", async () => {
    vi.resetModules();
    moduleLoads.dews.mockClear();
    const { ADMIN_STATIC_ROUTES } = await import("../admin-routes");
    const route = ADMIN_STATIC_ROUTES.find((candidate) => candidate.endpoint.key === "backfill-dews");
    if (!route) throw new Error("Missing route backfill-dews");

    const response = await route.handler(makeContext(route, { method: "POST" }));

    await expectNoStoreJson(response, 401, { error: "Unauthorized" });
    expect(moduleLoads.dews).not.toHaveBeenCalled();
  });

  it.each([
    ["always-idempotent", "remediate-blacklist-amount-gaps", "POST"],
    ["conditional-idempotency mutation", "backfill-dews", "POST"],
    ["conditional-idempotency read", "backfill-dews", "GET"],
  ] as const)("preserves the exact unauthorized response for %s routes", async (_routeClass, key, method) => {
    const route = findRoute(key);

    const response = await route.handler(makeContext(route, { method }));

    await expectNoStoreJson(response, 401, { error: "Unauthorized" });
  });

  it("rejects a mutation missing the admin header before loading its handler", async () => {
    const route = findRoute("remediate-blacklist-amount-gaps");
    const callsBefore = handlers.remediate.mock.calls.length;

    const response = await route.handler(makeContext(route, { trustedAdmin: true, adminHeader: false }));

    await expectNoStoreJson(response, 403, {
      error: "Missing required X-Pharos-Admin header; refusing mutation.",
    });
    expect(handlers.remediate).toHaveBeenCalledTimes(callsBefore);
  });

  it("owns malformed-body handling and no-store headers for parsed admin jobs", async () => {
    const route = findRoute("backfill-dews");

    const response = await route.handler(makeContext(route, { trustedAdmin: true, body: "{" }));

    await expectNoStoreJson(response, 400, { error: "Invalid JSON body" });
    expect(handlers.dews).not.toHaveBeenCalled();
  });

  it("owns the thrown-error boundary and no-store header", async () => {
    const route = findRoute("remediate-blacklist-amount-gaps");
    handlers.remediate.mockRejectedValueOnce(new Error("sensitive database detail"));

    const response = await route.handler(makeContext(route, { trustedAdmin: true }));

    await expectNoStoreJson(response, 500, { error: "Internal Server Error" });
  });

  it("replays an always-idempotent route without invoking its handler twice", async () => {
    const route = findRoute("remediate-blacklist-amount-gaps");
    // `runIdempotentAction` touches only admin_idempotency_keys, so the replay
    // needs that table's schema rather than the full migration template.
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`CREATE TABLE admin_idempotency_keys (
        action TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_body TEXT NOT NULL,
        created_at INTEGER NOT NULL, reservation_owner TEXT, reservation_generation INTEGER NOT NULL DEFAULT 0, execution_started_at INTEGER,
        PRIMARY KEY (action, idempotency_key)
      )`);
      const db = createSqliteD1(sqlite);
      const callsBefore = handlers.remediate.mock.calls.length;
      const options = { db, trustedAdmin: true, idempotencyKey: "route-replay-contract" } as const;

      const first = await route.handler(makeContext(route, options));
      const replay = await route.handler(makeContext(route, options));

      expect(first.status).toBe(200);
      expect(first.headers.get("X-Idempotent-Replay")).toBe("false");
      expect(first.headers.get("Cache-Control")).toBe("no-store");
      expect(replay.status).toBe(200);
      expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
      expect(replay.headers.get("Cache-Control")).toBe("no-store");
      expect(handlers.remediate).toHaveBeenCalledTimes(callsBefore + 1);
    } finally {
      sqlite.close();
    }
  });

  it("applies no-store to successful conditional-idempotency reads", async () => {
    const route = findRoute("backfill-dews");

    const response = await route.handler(makeContext(route, { method: "GET", trustedAdmin: true }));

    await expectNoStoreJson(response, 200, { ok: true });
  });
});
