import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "../sqlite-d1";

const connections: DatabaseSync[] = [];
afterEach(() => connections.splice(0).forEach((sqlite) => sqlite.close()));

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  connections.push(sqlite);
  sqlite.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)");
  return createSqliteD1(sqlite);
}

describe("SQLite D1 contracts", () => {
  it("returns rows, scalar columns, null for no row, and rejects missing columns", async () => {
    const db = fixture();
    await db.prepare("INSERT INTO items VALUES (?, ?)").bind(1, "one").run();
    expect(await db.prepare("SELECT * FROM items").first()).toEqual({ id: 1, value: "one" });
    expect(await db.prepare("SELECT * FROM items").first("value")).toBe("one");
    expect(await db.prepare("SELECT * FROM items WHERE id = 2").first("value")).toBeNull();
    await expect(db.prepare("SELECT * FROM items").first("missing")).rejects.toThrow(/column/i);
  });

  it("preserves mixed batch read and returning rows with write metadata", async () => {
    const db = fixture();
    const results = await db.batch([
      db.prepare("INSERT INTO items VALUES (1, 'one')"),
      db.prepare("INSERT INTO items VALUES (2, 'two') RETURNING id, value"),
      db.prepare("SELECT * FROM items ORDER BY id"),
    ]);
    expect(results[0]).toMatchObject({ results: [], meta: { changes: 1, rows_written: 1 } });
    expect(results[1]).toMatchObject({ results: [{ id: 2, value: "two" }], meta: { changes: 1 } });
    expect(results[2]).toMatchObject({ results: [{ id: 1, value: "one" }, { id: 2, value: "two" }] });
  });

  it("orders standalone operations after an already submitted batch", async () => {
    const db = fixture();
    const batch = db.batch([db.prepare("INSERT INTO items VALUES (?, ?)").bind(1, "initial")]);
    const update = db.prepare("UPDATE items SET value = 'updated' WHERE id = 1").run();
    const first = db.prepare("SELECT value FROM items WHERE id = 1").first("value");
    const rows = db.prepare("SELECT value FROM items WHERE id = 1").all();
    const exec = db.exec("UPDATE items SET value = 'executed' WHERE id = 1");
    await Promise.all([batch, update, exec]);
    expect(await first).toBe("updated");
    expect((await rows).results).toEqual([{ value: "updated" }]);
    expect(await db.prepare("SELECT value FROM items WHERE id = 1").first("value")).toBe("executed");
  });

  it.each(["run", "exec"] as const)("isolates standalone %s and reads from a failed batch, then recovers", async (operation) => {
    const db = fixture();
    const failed = db.batch([
      db.prepare("INSERT INTO items VALUES (1, 'uncommitted')"),
      db.prepare("INSERT INTO items VALUES (1, 'duplicate')"),
    ]);
    const rejected = expect(failed).rejects.toThrow();
    // The old batch yields after its first write, leaving its transaction open.
    await Promise.resolve();
    const rows = db.prepare("SELECT * FROM items").all();
    const first = db.prepare("SELECT * FROM items").first();
    const independent = operation === "run"
      ? db.prepare("INSERT INTO items VALUES (2, 'independent')").run()
      : db.exec("INSERT INTO items VALUES (2, 'independent')");
    await rejected;
    expect((await rows).results).toEqual([]);
    expect(await first).toBeNull();
    await independent;
    await db.batch([db.prepare("INSERT INTO items VALUES (3, 'recovered')")]);
    expect((await db.prepare("SELECT id FROM items ORDER BY id").all()).results).toEqual([{ id: 2 }, { id: 3 }]);
  });
});
