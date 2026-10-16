import { describe, expect, it } from "vitest";
import { assertAllD1MatchesUsed, mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { makeNoopD1 } from "../noop-d1";

describe("mockD1 helper", () => {
  it("supports bind-aware matching and tracks statement history", async () => {
    const db = mockD1([
      { match: "FROM sample", rows: [{ value: "fallback" }] },
      { match: "FROM sample", matchBinds: [1], rows: [{ value: "one" }] },
      { match: "FROM sample", matchBinds: [2], rows: [{ value: "two" }] },
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

  it.each([
    ["all", (db: MockD1Database) => db.prepare("SELECT * FROM missing_all").all()],
    ["first", (db: MockD1Database) => db.prepare("SELECT * FROM missing_first").first()],
    ["run", (db: MockD1Database) => db.prepare("UPDATE missing_run SET value = 1").run()],
    ["raw", (db: MockD1Database) => db.prepare("SELECT * FROM missing_raw").raw()],
  ])("fails closed by default for unmatched %s() SQL", async (_method, execute) => {
    const db = mockD1();

    await expect(execute(db)).rejects.toThrow(/mockD1: no match for SQL: .*missing_/);
  });

  it("provides an explicit no-op double that fails if a test touches D1", async () => {
    const db = makeNoopD1();

    expect(() => db.prepare("SELECT * FROM optional_table")).toThrow(
      "makeNoopD1: unexpected D1 access through prepare()",
    );
  });

  it.each([
    ["SELECT value FROM sample", [], null],
    ["SELECT value FROM cache WHERE key = ?", ["key"], null],
    ["SELECT value FROM cache WHERE key = ?", ["key"], { value: "override" }],
  ])("honors explicit first overrides before row inference: %s / %j / %j", async (sql, binds, first) => {
    const db = mockD1([{ match: sql, rows: [{ key: "key", value: "inferred" }], first }]);

    expect(await db.prepare(sql).bind(...binds).first()).toEqual(first);
    expect((await db.prepare(sql).bind(...binds).all()).results).toEqual([{ key: "key", value: "inferred" }]);
  });

  it.each([{ strict: true }, { strictSql: true }])("counts selected fixtures rather than SQL overlaps: %j", async (options) => {
    const db = mockD1([
      { match: "SELECT value FROM sample", rows: [{ value: "selected" }] },
      { match: "SELECT   value FROM sample", rows: [{ value: "shadowed" }] },
      { match: "SELECT value FROM optional", rows: [], allowUnused: true },
    ], options);

    expect((await db.prepare(" SELECT value FROM sample ").all()).results).toEqual([{ value: "selected" }]);
    expect(() => assertAllD1MatchesUsed(db)).toThrow("unused table match(es): SELECT   value FROM sample");
    await expect(db.prepare("SELECT value FROM sample LIMIT 1").all()).rejects.toThrow("no match");
  });

  it("exempts only allowUnused fixtures from selected-hit accounting", async () => {
    const db = mockD1([
      { match: "FROM sample", rows: [], allowUnused: true },
      { match: "FROM sample", matchBinds: [1], rows: [{ value: "specific" }] },
    ]);

    expect(() => db.assertAllMatchesUsed()).toThrow("unused table match(es): FROM sample");
    expect(await db.prepare("SELECT value FROM sample").bind(1).first()).toEqual({ value: "specific" });
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });
});
