import { describe, expect, it } from "vitest";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { STATUS_RAW_SNAPSHOT_CACHE_KEY, writeStatusRawSnapshot } from "../raw-snapshot";

describe("writeStatusRawSnapshot", () => {
  it("does not overwrite newer cache rows", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO cache",
        rows: [],
        runMeta: { changes: 0 },
      },
    ], { requireMatch: true });
    const raw = { rawOverallStatus: "healthy" } as Parameters<typeof writeStatusRawSnapshot>[2];

    const written = await writeStatusRawSnapshot(db, 1_777_000_000, raw);

    expect(written).toBe(false);
    const write = db.getHistory()[0];
    expect(write.sql).toContain("ON CONFLICT(key) DO UPDATE");
    expect(write.sql).toContain("WHERE cache.updated_at <= excluded.updated_at");
    expect(write.binds[0]).toBe(STATUS_RAW_SNAPSHOT_CACHE_KEY);
    expect(write.binds[2]).toBe(1_777_000_000);
  });
});
