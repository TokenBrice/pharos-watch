import { describe, expect, it, vi } from "vitest";
import { assertAllD1MatchesUsed, mockD1, mockD1Strict, type MockD1Database } from "@shared/test-utils/mock-d1";
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
      { strictSql: true },
    );

    const result = await db.prepare("SELECT   value   FROM   sample WHERE id = ?").bind(1).all<{ value: string }>();
    expect(result.results[0]?.value).toBe("one");
    expect(() => db.assertAllMatchesUsed()).not.toThrow();
  });

  it("supports strict mode as exact SQL matching", async () => {
    const db = mockD1Strict([
      { match: "SELECT value FROM sample WHERE id = ?", rows: [{ value: "one" }] },
    ]);

    const result = await db.prepare("SELECT   value   FROM   sample WHERE id = ?").bind(1).all<{ value: string }>();
    expect(result.results).toEqual([{ value: "one" }]);

    await expect(
      db.prepare("SELECT value FROM sample WHERE id = ? ORDER BY value").bind(1).all(),
    ).rejects.toThrow("mockD1: no match for SQL: SELECT value FROM sample WHERE id = ? ORDER BY value");
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

  it("injects named statement failures", async () => {
    const db = mockD1(
      [{ match: "UPDATE sample", rows: [] }],
      { failOn: { match: "UPDATE sample", error: new Error("injected failure") } },
    );

    await expect(db.prepare("UPDATE sample SET value = 1").run()).rejects.toThrow("injected failure");
  });

  it("exposes a shared assertion helper for strict fixture usage", async () => {
    const db = mockD1Strict([
      { match: "SELECT value FROM sample", rows: [{ value: "one" }] },
    ]);

    await db.prepare("SELECT value FROM sample").all();

    expect(() => assertAllD1MatchesUsed(db)).not.toThrow();
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

  it("infers cache rows by bound key only when first is unspecified", async () => {
    const db = mockD1([{ match: "FROM cache", rows: [{ key: "a", value: 1 }, { key: "b", value: 2 }] }]);
    const statement = db.prepare("SELECT value FROM cache WHERE key = ?");

    expect(await statement.bind("b").first()).toEqual({ key: "b", value: 2 });
    expect(await statement.bind("absent").first()).toBeNull();
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

  it.each(["all", "first", "run", "raw"] as const)("preserves failure precedence and one history entry for %s", async (method: "all" | "first" | "run" | "raw") => {
    const invoke = (stmt: D1PreparedStatement) => (stmt as unknown as Record<typeof method, () => Promise<unknown>>)[method]();
    const sql = "SELECT value FROM sample WHERE id = ?";
    const db = mockD1([{ match: "FROM sample", rows: [], throwError: "fixture failure" }]);
    await expect(invoke(db.prepare(sql).bind(7))).rejects.toThrow("fixture failure");
    expect(db.getHistory()).toEqual([{ sql, binds: [7] }]);
    expect(() => db.assertAllMatchesUsed()).not.toThrow();

    const injected = mockD1([{ match: "FROM sample", rows: [], throwError: "fixture failure" }], {
      failOn: { match: "FROM sample", error: "injected failure" },
    });
    await expect(invoke(injected.prepare(sql).bind(7))).rejects.toThrow("injected failure");
    expect(injected.getHistory()).toEqual([{ sql, binds: [7] }]);
    expect(() => injected.assertAllMatchesUsed()).toThrow("unused table match(es)");
  });

  it.each(["all", "first", "run", "raw"] as const)("delays %s without changing its result shape or recording twice", async (method: "all" | "first" | "run" | "raw") => {
    vi.useFakeTimers();
    try {
      const sql = "SELECT value FROM sample";
      const db = mockD1([{ match: sql, rows: [{ value: 7 }], runMeta: { changes: 2 }, delayMs: 10 }]);
      let settled = false;
      const result = (db.prepare(sql) as unknown as Record<typeof method, () => Promise<unknown>>)[method]().then((value: unknown) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(9);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toEqual({
        all: { results: [{ value: 7 }], success: true, meta: {} },
        first: { value: 7 },
        run: { success: true, meta: { changes: 2 } },
        raw: [[7]],
      }[method]);
      expect(db.getHistory()).toEqual([{ sql, binds: [] }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
