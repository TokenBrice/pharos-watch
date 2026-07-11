import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ENDPOINT_DEFINITIONS, getEndpointDefinitionByKey, getStatusPageActions } from "@shared/lib/api-endpoints";
import { route, type ResolvedRoute } from "../../router";
import { getCatalogActionAuditOwner } from "../../lib/catalog-action-audit";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { getRouteMatch } from "../registry";
import type { FullRouteContext } from "../shared";

function makeContext(db: D1Database, request: Request): FullRouteContext {
  return {
    db,
    request,
    url: new URL(request.url),
    trustedAdmin: true,
    execCtx: { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  };
}

describe("catalog action audit coverage", () => {
  it("assigns every catalog action to an audited Worker route", () => {
    const actionEndpoints = ENDPOINT_DEFINITIONS.filter((endpoint) => endpoint.statusPageAction);
    const catalogActions = getStatusPageActions();

    expect(catalogActions).toHaveLength(actionEndpoints.length);
    for (const action of catalogActions) {
      const pathname = new URL(action.path, "https://ops-api.pharos.watch").pathname;
      const routeMatch = getRouteMatch(pathname);
      expect(routeMatch?.endpoint?.statusPageAction, action.path).toBeTruthy();
      expect(getCatalogActionAuditOwner(routeMatch!.endpoint!), action.path).toMatch(/^(canonical|handler)$/u);
    }
  });

  it("runs canonical auditing at the shared router boundary", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE admin_action_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        result TEXT NOT NULL,
        http_status INTEGER,
        details_json TEXT,
        intent_key TEXT
      );
      CREATE UNIQUE INDEX idx_admin_action_audit_action_intent
        ON admin_action_audit (action, intent_key) WHERE intent_key IS NOT NULL;
    `);
    const db = createSqliteD1(sqlite);
    const endpoint = getEndpointDefinitionByKey("trigger-digest")!;
    const request = new Request("https://ops-api.pharos.watch/api/trigger-digest", {
      method: "POST",
      headers: { "Idempotency-Key": "router-intent" },
    });
    const resolvedRoute: ResolvedRoute = {
      methodValidation: null,
      routeMatch: {
        endpoint,
        dependencies: [],
        methods: endpoint.methods,
        handle: async () => Response.json({ accepted: true }, { status: 202 }),
      },
    };

    const response = await route(makeContext(db, request), resolvedRoute);

    expect(response.status).toBe(202);
    expect(sqlite.prepare("SELECT action, result, http_status FROM admin_action_audit").get()).toEqual({
      action: "trigger-digest",
      result: "ok",
      http_status: 202,
    });
  });

  it("returns a distinct recoverable failure when canonical audit persistence fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sqlite = new DatabaseSync(":memory:");
    const db = createSqliteD1(sqlite);
    const endpoint = getEndpointDefinitionByKey("trigger-digest")!;
    const request = new Request("https://ops-api.pharos.watch/api/trigger-digest", {
      method: "POST",
      headers: { "Idempotency-Key": "audit-failure-intent" },
    });
    const resolvedRoute: ResolvedRoute = {
      methodValidation: null,
      routeMatch: {
        endpoint,
        dependencies: [],
        methods: endpoint.methods,
        handle: async () =>
          Response.json(
            { accepted: true },
            { status: 202, headers: { "Idempotency-Key": "audit-failure-intent", "X-Idempotent-Replay": "false" } },
          ),
      },
    };

    const response = await route(makeContext(db, request), resolvedRoute);

    expect(response.status).toBe(503);
    expect(response.headers.get("Idempotency-Key")).toBe("audit-failure-intent");
    expect(response.headers.get("X-Idempotent-Replay")).toBe("false");
    expect(response.headers.get("X-Execution-Certainty")).toBe("audit-incomplete");
    await expect(response.json()).resolves.toMatchObject({ error: "audit_persistence_failed" });
    expect(warning).toHaveBeenCalled();
  });
});
