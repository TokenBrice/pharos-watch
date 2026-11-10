import { describe, expect, it } from "vitest";
import { handleResetBlacklistSync } from "../admin-actions";
import { mockD1 } from "@shared/test-utils/mock-d1";

describe("admin mutation auth — custom header required for mutating methods", () => {
  it("rewinds both cursor columns and invalidates active generations", async () => {
    const db = mockD1([
      { match: "UPDATE blacklist_sync_state", rows: [], runMeta: { changes: 1 } },
    ]);
    const req = new Request("https://ops-api.pharos.watch/api/reset-blacklist-sync", {
      method: "POST",
      headers: { "X-Pharos-Admin": "1" },
    });

    const res = await handleResetBlacklistSync({ db, request: req, trustedAdmin: true });

    expect(res.status).toBe(200);
    const writes = db.getHistory().filter((entry) => entry.sql.includes("UPDATE blacklist_sync_state"));
    expect(writes).toHaveLength(2);
    expect(writes.every((entry) => entry.sql.includes("cursor_value ="))).toBe(true);
    expect(writes.every((entry) => entry.sql.includes("attempt_generation = attempt_generation + 1"))).toBe(true);
  });

});
