import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createD1CostTracker } from "../d1-cost";
import { runWithOverloadRetry } from "../d1-overload-retry";

function result(rowsRead: number, rowsWritten: number, totalAttempts = 1): D1Result {
  return {
    success: true,
    results: [{ id: "observed" }],
    meta: {
      duration: 1, size_after: 0, rows_read: rowsRead, rows_written: rowsWritten,
      last_row_id: 0, changed_db: rowsWritten > 0, changes: rowsWritten, total_attempts: totalAttempts,
    },
  };
}

describe("createD1CostTracker", () => {
  it("accumulates bound statements and batched results without changing receivers or counting twice", async () => {
    const database = mockD1();
    const readResult = result(10, 0);
    const writeResult = result(2, 3);
    const statement = database.prepare("SELECT id FROM example");
    statement.bind = vi.fn(function (this: D1PreparedStatement, ...values: unknown[]) {
      expect(this).toBe(statement);
      expect(values).toEqual(["coin"]);
      return statement;
    });
    statement.all = vi.fn().mockImplementation(async function (this: D1PreparedStatement) {
      expect(this).toBe(statement);
      return readResult;
    });
    statement.run = vi.fn().mockResolvedValue(writeResult);
    database.prepare = vi.fn(() => statement);
    database.batch = vi.fn().mockImplementation(async function (this: D1Database, statements: D1PreparedStatement[]) {
      expect(this).toBe(database);
      expect(statements).toEqual([statement, statement]);
      return [readResult, writeResult];
    });
    const tracker = createD1CostTracker(database);
    const bound = tracker.db.prepare("SELECT id FROM example WHERE id = ?").bind("coin");
    expect(await bound.all()).toBe(readResult);
    expect(await bound.run()).toBe(writeResult);
    expect(await tracker.db.batch([bound, bound])).toEqual([readResult, writeResult]);
    expect(statement.all).toHaveBeenCalledTimes(1);
    expect(statement.run).toHaveBeenCalledTimes(1);
    expect(tracker.snapshot()).toEqual({ queries: 4, rowsRead: 24, rowsWritten: 6, coverage: "complete", reasons: [] });
    expect(createD1CostTracker(database).snapshot().queries).toBe(0);
  });

  it("counts every overload-retried batch attempt and keeps unavailable failure costs explicit", async () => {
    vi.useFakeTimers();
    try {
      const database = mockD1();
      const failure = new Error("D1 DB is overloaded");
      database.batch = vi.fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce([result(5, 1), result(7, 2)]);
      const tracker = createD1CostTracker(database);
      const statements = [tracker.db.prepare("SELECT 1"), tracker.db.prepare("SELECT 2")];
      const pending = runWithOverloadRetry(() => tracker.db.batch(statements));
      await vi.runAllTimersAsync();
      await pending;
      expect(database.batch).toHaveBeenCalledTimes(2);
      expect(tracker.snapshot()).toEqual({
        queries: 4, rowsRead: 12, rowsWritten: 3, coverage: "partial", reasons: ["failed-attempt-rows-unavailable"],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves first/raw results and marks metadata-less calls as partial", async () => {
    const database = mockD1();
    const statement = database.prepare("SELECT id FROM example");
    const row = { id: "observed" };
    const raw = [["observed"]];
    statement.first = vi.fn().mockResolvedValue(row);
    statement.raw = vi.fn().mockResolvedValue(raw);
    database.prepare = vi.fn(() => statement);
    const tracker = createD1CostTracker(database);
    expect(await tracker.db.prepare("SELECT id FROM example").first()).toBe(row);
    expect(await tracker.db.prepare("SELECT id FROM example").raw({ columnNames: true })).toBe(raw);
    expect(statement.raw).toHaveBeenCalledWith({ columnNames: true });
    expect(tracker.snapshot()).toEqual({ queries: 2, rowsRead: 0, rowsWritten: 0, coverage: "partial", reasons: ["first-no-meta", "raw-no-meta"] });
  });

  it("counts exec statements and preserves explicit scope exclusions", async () => {
    const database = mockD1();
    const executed = { count: 2, duration: 1 };
    database.exec = vi.fn().mockResolvedValueOnce(executed).mockResolvedValueOnce({ count: 0, duration: 0 });
    const tracker = createD1CostTracker(database, ["outer-queries-excluded"]);
    expect(await tracker.db.exec("SELECT 1; SELECT 2")).toBe(executed);
    await tracker.db.exec("");
    expect(tracker.snapshot()).toEqual({
      queries: 2, rowsRead: 0, rowsWritten: 0, coverage: "partial", reasons: ["exec-no-meta", "outer-queries-excluded"],
    });
  });

  it("passes through terminal errors unchanged and counts automatic retries without inventing row costs", async () => {
    const database = mockD1();
    const statement = database.prepare("SELECT 1");
    const failure = new Error("query failed");
    statement.run = vi.fn().mockRejectedValue(failure);
    statement.all = vi.fn().mockResolvedValue(result(8, 0, 3));
    database.prepare = vi.fn(() => statement);
    const tracker = createD1CostTracker(database);
    await expect(tracker.db.prepare("SELECT 1").run()).rejects.toBe(failure);
    await tracker.db.prepare("SELECT 1").all();
    expect(tracker.snapshot()).toEqual({
      queries: 4, rowsRead: 8, rowsWritten: 0, coverage: "partial",
      reasons: ["automatic-retry-rows-unavailable", "failed-attempt-rows-unavailable"],
    });
  });

  it("meters sessions and never treats missing result metadata as a genuine zero", async () => {
    const database = mockD1();
    const statement = database.prepare("SELECT 1");
    statement.all = vi.fn().mockResolvedValue(result(3, 0));
    const session: D1DatabaseSession = {
      prepare: vi.fn(() => statement),
      batch: vi.fn().mockResolvedValue([result(4, 1)]),
      getBookmark: vi.fn(() => "bookmark"),
    };
    database.withSession = vi.fn(() => session);
    const tracker = createD1CostTracker(database);
    const trackedSession = tracker.db.withSession("first-primary");
    await trackedSession.prepare("SELECT 1").all();
    await trackedSession.batch([trackedSession.prepare("UPDATE example SET id = 1")]);
    expect(trackedSession.getBookmark()).toBe("bookmark");
    expect(database.withSession).toHaveBeenCalledWith("first-primary");
    expect(tracker.snapshot()).toEqual({ queries: 2, rowsRead: 7, rowsWritten: 1, coverage: "complete", reasons: [] });
    statement.all = vi.fn().mockResolvedValue({ results: [] });
    await trackedSession.prepare("SELECT 1").all();
    expect(tracker.snapshot()).toEqual({ queries: 3, rowsRead: 7, rowsWritten: 1, coverage: "partial", reasons: ["result-meta-unavailable"] });
  });
});
