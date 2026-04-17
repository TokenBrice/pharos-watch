import { describe, expect, it } from "vitest";
import { logAdminAction, DETAILS_MAX_LEN } from "../admin-action-audit";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

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

  it("records actor as 'internal' when no CF Access header is present", async () => {
    const db = makeAuditMockDb();

    await logAdminAction(db, { action: "reset-blacklist-sync", result: "ok" });

    const insert = lastInsert(db);
    expect(insert.binds[1]).toBe("internal");
  });

  it("falls back to 'internal' when the request lacks the CF Access header", async () => {
    const db = makeAuditMockDb();
    const req = new Request("https://ops-api.pharos.watch/api/reset-blacklist-sync", {
      method: "POST",
      headers: { "X-Pharos-Admin": "1" },
    });

    await logAdminAction(db, { action: "reset-blacklist-sync", result: "ok" }, req);

    const insert = lastInsert(db);
    expect(insert.binds[1]).toBe("internal");
  });

  it("caps details_json at DETAILS_MAX_LEN (4096) characters", async () => {
    const db = makeAuditMockDb();
    const huge = { blob: "x".repeat(10_000) };

    await logAdminAction(db, { action: "backfill", result: "ok", details: huge });

    const insert = lastInsert(db);
    const detailsJson = insert.binds[6];
    expect(typeof detailsJson).toBe("string");
    expect((detailsJson as string).length).toBeLessThanOrEqual(DETAILS_MAX_LEN);
    expect((detailsJson as string).length).toBe(DETAILS_MAX_LEN);
  });
});
