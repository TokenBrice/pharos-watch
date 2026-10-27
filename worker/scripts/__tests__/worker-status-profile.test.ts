import { describe, expect, it, vi } from "vitest";
import { createReadOnlyProfileDb, profileStatusRoute } from "../worker-status-profile.mjs";

describe("read-only status profiling", () => {
  it("rejects mutation even through batch and preserves first() receipts", async () => {
    const receipts: object[] = [];
    const query = vi.fn().mockResolvedValue({ success: true, results: [{ count: 4 }], meta: { rows_read: 5, duration: 1 } });
    const db = createReadOnlyProfileDb(query, receipts);
    expect(() => db.prepare("UPDATE cache SET value = 'secret'")).toThrow("read-only");
    expect(() => db.prepare("WITH x AS (SELECT 1) DELETE FROM cache")).toThrow("read-only");
    expect(() => db.prepare("SELECT 1; DELETE FROM cache")).toThrow("read-only");
    expect(await db.prepare("SELECT '?' AS count WHERE id = ?").bind("safe").first("count")).toBe(4);
    expect(receipts).toEqual([{ rows_read: 5, duration: 1 }]);
    expect(query.mock.calls[0][1]).toEqual(["safe"]);
  });

  it("reports missing D1 metadata as unavailable, not zero measured cost", async () => {
    const result = await profileStatusRoute({
      query: async () => ({ results: [] }),
      handler: async ({ db }: { db: { prepare(sql: string): { all(): Promise<unknown> } } }) => {
        await db.prepare("SELECT 1").all();
        return new Response(JSON.stringify({ sectionErrors: {} }));
      },
      trackerFactory: (db: unknown) => ({ db, snapshot: () => ({ queries: 1, reasons: [] }) }),
    });
    expect(result.rowsRead).toBeNull();
    expect(result.sqlDurationMs).toBeNull();
    expect(result.coverage).toBe("partial");
    expect(result.selfCheck.coverage).toBe("unavailable");
  });
});
