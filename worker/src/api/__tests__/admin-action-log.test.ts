import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it } from "vitest";
import { handleAdminActionLog } from "../admin-action-log";
import { createLatestSchemaFixtureTracker } from "../../test-helpers/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function buildRequest(query = ""): { request: Request; url: URL } {
  const url = new URL(`https://ops-api.pharos.watch/api/admin-action-log${query}`);
  return { request: new Request(url, { method: "GET" }), url };
}

describe("handleAdminActionLog", () => {
  it("returns entries newest-first with deterministic ties and decoded fields", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO admin_action_audit (id, created_at, actor, action, target, result, http_status, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run(2, 2000, "alice@pharos.watch", "reset-blacklist-sync", null, "ok", 200, '{"note":"manual"}');
    insert.run(1, 1000, "internal", "trigger-digest", null, "error", 500, null);
    insert.run(3, 2000, "internal", "trigger-digest", "digest", "ok", 200, "{bad-json");
    const response = await handleAdminActionLog({ db, ...buildRequest(), trustedAdmin: true });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await readJsonResponse(response, 200);
    expect(body).toEqual({ entries: [
      { id: 3, at: 2000, actor: "internal", action: "trigger-digest", target: "digest", result: "ok", httpStatus: 200, details: null },
      { id: 2, at: 2000, actor: "alice@pharos.watch", action: "reset-blacklist-sync", target: null, result: "ok", httpStatus: 200, details: { note: "manual" } },
      { id: 1, at: 1000, actor: "internal", action: "trigger-digest", target: null, result: "error", httpStatus: 500, details: null },
    ] });
  });

  it.each([["", 50], ["?limit=9999", 200], ["?limit=0", 1]] as const)("bounds returned entries for %s", async (query, count) => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO admin_action_audit (id, created_at, actor, action, result) VALUES (?, ?, 'internal', 'trigger-digest', 'ok')");
    for (let id = 1; id <= 201; id++) insert.run(id, id);
    const response = await handleAdminActionLog({ db, ...buildRequest(query), trustedAdmin: true });
    const body = await readJsonResponse<{ entries: Array<{ id: number }> }>(response, 200);
    expect(body.entries.map((entry) => entry.id)).toEqual(Array.from({ length: count }, (_, index) => 201 - index));
  });
});
