import { describe, expect, it } from "vitest";
import {
  handleDebugSyncState,
  handleResetBlacklistSync,
} from "../admin-actions";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

describe("admin mutation auth — custom header required for mutating methods", () => {
  it("rejects POST without X-Pharos-Admin header", async () => {
    const req = new Request("https://ops-api.pharos.watch/api/reset-blacklist-sync", {
      method: "POST",
    });
    const res = await handleResetBlacklistSync({
      db: mockD1(),
      request: req,
      trustedAdmin: true,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/admin header/i);
  });

  it("accepts POST with X-Pharos-Admin: 1", async () => {
    const req = new Request("https://ops-api.pharos.watch/api/reset-blacklist-sync", {
      method: "POST",
      headers: { "X-Pharos-Admin": "1" },
    });
    const res = await handleResetBlacklistSync({
      db: mockD1([
        {
          match: "UPDATE blacklist_sync_state",
          rows: [],
          runMeta: { changes: 0 },
        },
      ]),
      request: req,
      trustedAdmin: true,
    });
    expect(res.status).toBe(200);
  });

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

  it("does not require header on GET admin endpoints", async () => {
    const req = new Request("https://ops-api.pharos.watch/api/debug-sync-state", {
      method: "GET",
    });
    const res = await handleDebugSyncState({
      db: mockD1([
        { match: "FROM blacklist_sync_state", rows: [] },
      ]),
      request: req,
      trustedAdmin: true,
    });
    expect(res.status).not.toBe(403);
  });
});
