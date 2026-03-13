import { describe, expect, it } from "vitest";
import { mockD1 } from "./mock-d1";

describe("mockD1 helper", () => {
  it("supports bind-aware matching and tracks statement history", async () => {
    const db = mockD1([
      { match: "FROM sample", matchBinds: [1], rows: [{ value: "one" }] },
      { match: "FROM sample", matchBinds: [2], rows: [{ value: "two" }] },
      { match: "FROM sample", rows: [{ value: "fallback" }] },
    ]);

    const one = await db
      .prepare("SELECT value FROM sample WHERE id = ?")
      .bind(1)
      .all<{ value: string }>();
    const two = await db
      .prepare("SELECT value FROM sample WHERE id = ?")
      .bind(2)
      .all<{ value: string }>();
    const fallback = await db
      .prepare("SELECT value FROM sample WHERE id = ?")
      .bind(3)
      .all<{ value: string }>();

    expect(one.results[0]?.value).toBe("one");
    expect(two.results[0]?.value).toBe("two");
    expect(fallback.results[0]?.value).toBe("fallback");
    expect(db.getHistory()).toEqual([
      { sql: "SELECT value FROM sample WHERE id = ?", binds: [1] },
      { sql: "SELECT value FROM sample WHERE id = ?", binds: [2] },
      { sql: "SELECT value FROM sample WHERE id = ?", binds: [3] },
    ]);
  });

  it("propagates batch failures after attempting all statements", async () => {
    const db = mockD1([
      { match: "FROM bad_table", rows: [], throwError: new Error("boom") },
      { match: "FROM good_table", rows: [{ ok: true }] },
    ]);

    await expect(
      db.batch([
        db.prepare("SELECT * FROM bad_table WHERE id = ?").bind(1),
        db.prepare("SELECT * FROM good_table WHERE id = ?").bind(2),
      ]),
    ).rejects.toThrow("boom");

    expect(db.getHistory()).toEqual([
      { sql: "SELECT * FROM bad_table WHERE id = ?", binds: [1] },
      { sql: "SELECT * FROM good_table WHERE id = ?", binds: [2] },
    ]);
  });

  it("uses run() semantics for write statements in batch", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO cache",
        rows: [],
        runMeta: { changes: 2 },
      },
    ]);

    const [result] = await db.batch([
      db.prepare("INSERT INTO cache (key, value) VALUES (?, ?)").bind("k", "v"),
    ]);

    expect(result).toEqual({ success: true, meta: { changes: 2 } });
  });

  it("supports strict SQL matching and matched-entry assertions", async () => {
    const db = mockD1(
      [
        { match: "SELECT value FROM sample WHERE id = ?", rows: [{ value: "one" }] },
      ],
      { strictSql: true, requireMatch: true },
    );

    const result = await db.prepare("SELECT   value   FROM   sample WHERE id = ?").bind(1).all<{ value: string }>();
    expect(result.results[0]?.value).toBe("one");
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("throws when requireMatch is enabled and no configured SQL matches", async () => {
    const db = mockD1([], { requireMatch: true });

    await expect(
      db.prepare("SELECT * FROM missing").all(),
    ).rejects.toThrow("mockD1: no match for SQL: SELECT * FROM missing");
  });
});
