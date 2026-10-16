import { describe, expect, it, vi } from "vitest";
import { logAdminAction } from "../admin-action-audit";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeNoopD1 } from "../../test-helpers/noop-d1";

function makeAuditMockDb() {
  return mockD1([
    {
      match: "INSERT INTO admin_action_audit",
      rows: [],
      runMeta: { changes: 1 },
    },
  ]);
}

function lastInsert(db: ReturnType<typeof mockD1>): { sql: string; binds: unknown[] } {
  const history = db.getHistory();
  const inserts = history.filter((row) => row.sql.startsWith("INSERT INTO admin_action_audit"));
  const last = inserts[inserts.length - 1];
  if (!last) throw new Error("No INSERT INTO admin_action_audit call recorded");
  return last;
}

describe("logAdminAction", () => {
  it("reports a resolved D1 write with success=false as an audit failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = makeNoopD1({
      prepare: () => ({
        bind: () => ({
          run: async () => ({ success: false, meta: { changes: 0 } }),
        }),
      }),
    });

    await expect(logAdminAction(db, { action: "backfill", result: "ok" })).resolves.toBe(false);
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });

  it("records actor from Cf-Access-Authenticated-User-Email header", async () => {
    const db = makeAuditMockDb();
    const req = new Request("https://ops-api.pharos.watch/api/reset-blacklist-sync", {
      method: "POST",
      headers: {
        "X-Pharos-Admin": "1",
        "Cf-Access-Authenticated-User-Email": "alice@pharos.watch",
      },
    });

    await logAdminAction(db, { action: "reset-blacklist-sync", result: "ok", httpStatus: 200 }, req);

    const insert = lastInsert(db);
    // Columns: created_at, actor, action, target, result, http_status, details_json
    expect(insert.binds[1]).toBe("alice@pharos.watch");
    expect(insert.binds[2]).toBe("reset-blacklist-sync");
    expect(insert.binds[4]).toBe("ok");
    expect(insert.binds[5]).toBe(200);
  });

});
