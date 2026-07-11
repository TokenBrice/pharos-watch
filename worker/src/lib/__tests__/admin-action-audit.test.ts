import { describe, expect, it, vi } from "vitest";
import { logAdminAction, DETAILS_MAX_LEN } from "../admin-action-audit";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

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
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => ({ success: false, meta: { changes: 0 } }),
        }),
      }),
    } as unknown as D1Database;

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

  it("stores valid JSON with a truncation sentinel when details exceed DETAILS_MAX_LEN", async () => {
    const db = makeAuditMockDb();
    const huge = { blob: "x".repeat(10_000) };

    await logAdminAction(db, { action: "backfill", result: "ok", details: huge });

    const insert = lastInsert(db);
    const detailsJson = insert.binds[6];
    expect(typeof detailsJson).toBe("string");
    expect((detailsJson as string).length).toBeLessThanOrEqual(DETAILS_MAX_LEN);
    expect(JSON.parse(detailsJson as string)).toEqual({
      _truncated: true,
      maxSize: DETAILS_MAX_LEN,
      originalSize: JSON.stringify(huge).length,
    });
  });

  it("uses the unique intent insert only for canonical deduplicated rows", async () => {
    const db = mockD1([
      {
        match: "INSERT OR IGNORE INTO admin_action_audit",
        rows: [],
        runMeta: { changes: 1 },
      },
    ]);

    await logAdminAction(db, {
      action: "backfill-depegs",
      result: "ok",
      intentKey: "catalog:v1:opaque-hash",
    });

    const insert = db.getHistory().find((row) => row.sql.startsWith("INSERT OR IGNORE INTO admin_action_audit"));
    expect(insert?.binds[7]).toBe("catalog:v1:opaque-hash");
  });

  it("uses an upsert for an authoritative original outcome", async () => {
    const db = mockD1([
      {
        match: "ON CONFLICT(action, intent_key)",
        rows: [],
        runMeta: { changes: 1 },
      },
    ]);

    await logAdminAction(db, {
      action: "backfill-depegs",
      result: "ok",
      intentKey: "catalog:v1:opaque-hash",
      intentWriteMode: "authoritative",
    });

    expect(db.getHistory()[0]?.sql).toContain("DO UPDATE SET");
  });
});
