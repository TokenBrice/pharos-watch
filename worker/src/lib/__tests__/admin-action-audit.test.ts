import { describe, expect, it, vi } from "vitest";
import { logAdminAction } from "../admin-action-audit";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeNoopD1 } from "../../test-helpers/noop-d1";

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
    const { db, sqlite } = createLatestSchemaSqlite();
    const req = new Request("https://ops-api.pharos.watch/api/reset-blacklist-sync", {
      method: "POST",
      headers: {
        "X-Pharos-Admin": "1",
        "Cf-Access-Authenticated-User-Email": "alice@pharos.watch",
      },
    });

    try {
      await expect(logAdminAction(db, {
        action: "reset-blacklist-sync", result: "ok", httpStatus: 200,
      }, req)).resolves.toBe(true);
      expect(sqlite.prepare("SELECT actor, action, result, http_status FROM admin_action_audit").all()).toEqual([{
        actor: "alice@pharos.watch", action: "reset-blacklist-sync", result: "ok", http_status: 200,
      }]);
    } finally {
      sqlite.close();
    }
  });

});
