import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createD1CostTracker } from "../d1-cost";

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
const unobservedServer = {
  sqlDurationMs: null,
  sqlDurationResults: 0,
  servedByRegion: null,
  servedByRegionMixed: false,
  servedByRegionResults: 0,
  servedByPrimaryResults: 0,
  servedByReplicaResults: 0,
};

beforeEach(() => {
  vi.spyOn(performance, "now").mockReturnValue(0);
});
afterEach(() => vi.restoreAllMocks());


describe("createD1CostTracker", () => {
  it("accumulates bound statements and batched results without changing receivers or counting twice", async () => {
    const database = mockD1();
    vi.mocked(performance.now)
      .mockReturnValueOnce(0).mockReturnValueOnce(10)
      .mockReturnValueOnce(10).mockReturnValueOnce(30)
      .mockReturnValueOnce(30).mockReturnValueOnce(60);
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
    expect(tracker.snapshot()).toEqual({
      ...unobservedServer, sqlDurationMs: 4, sqlDurationResults: 4,
      queries: 4, rowsRead: 24, rowsWritten: 6, bindingCalls: 3, batchCalls: 1, awaitElapsedMs: 60,
      coverage: "complete", reasons: [],
    });
    expect(createD1CostTracker(database).snapshot().queries).toBe(0);
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
    expect(tracker.snapshot()).toEqual({
      ...unobservedServer, queries: 2, rowsRead: 0, rowsWritten: 0,
      bindingCalls: 2, batchCalls: 0, awaitElapsedMs: 0,
      coverage: "partial", reasons: ["first-no-meta", "raw-no-meta"],
    });
  });

  it("counts exec statements and preserves explicit scope exclusions", async () => {
    const database = mockD1();
    const executed = { count: 2, duration: 1 };
    database.exec = vi.fn().mockResolvedValueOnce(executed).mockResolvedValueOnce({ count: 0, duration: 0 });
    const tracker = createD1CostTracker(database, ["outer-queries-excluded"]);
    expect(await tracker.db.exec("SELECT 1; SELECT 2")).toBe(executed);
    await tracker.db.exec("");
    expect(tracker.snapshot()).toEqual({
      ...unobservedServer, bindingCalls: 2, batchCalls: 0, awaitElapsedMs: 0,
      queries: 2, rowsRead: 0, rowsWritten: 0, coverage: "partial", reasons: ["exec-no-meta", "outer-queries-excluded"],
    });
  });

  it("passes through terminal errors unchanged and counts automatic retries without inventing row costs", async () => {
    const database = mockD1();
    vi.mocked(performance.now)
      .mockReturnValueOnce(0).mockReturnValueOnce(40)
      .mockReturnValueOnce(40).mockReturnValueOnce(100);
    const statement = database.prepare("SELECT 1");
    const failure = new Error("query failed");
    statement.run = vi.fn().mockRejectedValue(failure);
    statement.all = vi.fn().mockResolvedValue(result(8, 0, 3));
    database.prepare = vi.fn(() => statement);
    const tracker = createD1CostTracker(database);
    await expect(tracker.db.prepare("SELECT 1").run()).rejects.toBe(failure);
    await tracker.db.prepare("SELECT 1").all();
    expect(tracker.snapshot()).toEqual({
      ...unobservedServer, sqlDurationMs: 1, sqlDurationResults: 1,
      bindingCalls: 2, batchCalls: 0, awaitElapsedMs: 100,
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
    expect(tracker.snapshot()).toEqual({
      ...unobservedServer, sqlDurationMs: 2, sqlDurationResults: 2,
      queries: 2, rowsRead: 7, rowsWritten: 1, bindingCalls: 2, batchCalls: 1, awaitElapsedMs: 0,
      coverage: "complete", reasons: [],
    });
    statement.all = vi.fn().mockResolvedValue({ results: [] });
    await trackedSession.prepare("SELECT 1").all();
    expect(tracker.snapshot()).toEqual({
      ...unobservedServer, sqlDurationMs: 2, sqlDurationResults: 2,
      queries: 3, rowsRead: 7, rowsWritten: 1, bindingCalls: 3, batchCalls: 1, awaitElapsedMs: 0,
      coverage: "partial", reasons: ["result-meta-unavailable"],
    });
  });

  it("counts a multi-statement batch as one observed binding call", async () => {
    const database = mockD1();
    const statement = database.prepare("SELECT 1");
    statement.bind = vi.fn(() => statement);
    const results = Array.from({ length: 3_001 }, () => result(1, 0));
    database.batch = vi.fn().mockImplementation(async (statements: D1PreparedStatement[]) => {
      expect(statements).toHaveLength(3_001);
      expect(statements.every((entry) => entry === statement)).toBe(true);
      return results;
    });
    database.prepare = vi.fn(() => statement);
    const tracker = createD1CostTracker(database);
    const bound = tracker.db.prepare("SELECT 1").bind();
    expect(await tracker.db.batch(Array.from({ length: 3_001 }, () => bound))).toBe(results);
    expect(tracker.snapshot()).toEqual({
      ...unobservedServer, sqlDurationMs: 3_001, sqlDurationResults: 3_001,
      queries: 3_001, rowsRead: 3_001, rowsWritten: 0, bindingCalls: 1, batchCalls: 1, awaitElapsedMs: 0,
      coverage: "complete", reasons: [],
    });
  });

  it("counts explicit retries and failed batches without changing errors", async () => {
    const database = mockD1();
    const statement = database.prepare("SELECT 1");
    const failure = new Error("D1 DB is overloaded");
    const results = [result(2, 0)];
    database.batch = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(results);
    const tracker = createD1CostTracker(database);
    await expect(tracker.db.batch([statement])).rejects.toBe(failure);
    expect(await tracker.db.batch([statement])).toBe(results);
    expect(tracker.snapshot()).toEqual({
      ...unobservedServer, sqlDurationMs: 1, sqlDurationResults: 1,
      queries: 2, rowsRead: 2, rowsWritten: 0, bindingCalls: 2, batchCalls: 2, awaitElapsedMs: 0,
      coverage: "partial", reasons: ["failed-attempt-rows-unavailable"],
    });
  });

  it("keeps missing or invalid server timing unknown and preserves measured zero", async () => {
    const database = mockD1();
    const statement = database.prepare("SELECT 1");
    const withMeta = (meta: Record<string, unknown>): D1Result => {
      const base = result(0, 0);
      return { ...base, meta: { ...base.meta, ...meta } };
    };
    const invalid = [undefined, null, NaN, Infinity, -1].map((duration) => withMeta({ duration }));
    statement.all = vi.fn().mockResolvedValueOnce({ results: [] });
    for (const response of invalid) vi.mocked(statement.all).mockResolvedValueOnce(response);
    vi.mocked(statement.all)
      .mockResolvedValueOnce(withMeta({ duration: 999, timings: { sql_duration_ms: 0 } }))
      .mockResolvedValueOnce(withMeta({ duration: 2, timings: { sql_duration_ms: NaN } }))
      .mockResolvedValueOnce(withMeta({ duration: 3 }));
    database.prepare = vi.fn(() => statement);
    const tracker = createD1CostTracker(database);
    for (let index = 0; index < 6; index++) await tracker.db.prepare("SELECT 1").all();
    expect(tracker.snapshot()).toMatchObject({ sqlDurationMs: null, sqlDurationResults: 0 });
    await tracker.db.prepare("SELECT 1").all();
    expect(tracker.snapshot()).toMatchObject({ sqlDurationMs: 0, sqlDurationResults: 1 });
    await tracker.db.prepare("SELECT 1").all();
    await tracker.db.prepare("SELECT 1").all();
    expect(tracker.snapshot()).toMatchObject({
      sqlDurationMs: 5, sqlDurationResults: 3, bindingCalls: 9,
      coverage: "partial", reasons: ["result-meta-unavailable"],
    });
  });

  it("aggregates bounded database region and role observations without guessing missing values", async () => {
    const database = mockD1();
    const statement = database.prepare("SELECT 1");
    const withMeta = (meta: Record<string, unknown>): D1Result => {
      const base = result(0, 0);
      return { ...base, meta: { ...base.meta, ...meta } };
    };
    statement.all = vi.fn()
      .mockResolvedValueOnce(result(0, 0))
      .mockResolvedValueOnce(withMeta({ served_by_region: "EEUR", served_by_primary: true }))
      .mockResolvedValueOnce(withMeta({ served_by_region: "EEUR", served_by_primary: true }))
      .mockResolvedValueOnce(withMeta({ served_by_region: "WEUR", served_by_primary: false }))
      .mockResolvedValueOnce(withMeta({ served_by_region: "EEUR" }))
      .mockResolvedValueOnce(withMeta({ served_by_region: "x".repeat(65), served_by_primary: null }));
    database.prepare = vi.fn(() => statement);
    const tracker = createD1CostTracker(database);
    await tracker.db.prepare("SELECT 1").all();
    expect(tracker.snapshot()).toMatchObject({
      servedByRegion: null, servedByRegionMixed: false, servedByRegionResults: 0,
      servedByPrimaryResults: 0, servedByReplicaResults: 0,
    });
    await tracker.db.prepare("SELECT 1").all();
    await tracker.db.prepare("SELECT 1").all();
    expect(tracker.snapshot()).toMatchObject({
      servedByRegion: "EEUR", servedByRegionMixed: false, servedByRegionResults: 2,
      servedByPrimaryResults: 2, servedByReplicaResults: 0,
    });
    await tracker.db.prepare("SELECT 1").all();
    await tracker.db.prepare("SELECT 1").all();
    await tracker.db.prepare("SELECT 1").all();
    expect(tracker.snapshot()).toMatchObject({
      servedByRegion: null, servedByRegionMixed: true, servedByRegionResults: 4,
      servedByPrimaryResults: 2, servedByReplicaResults: 1,
    });
  });

  it("meters dump without inventing SQL statements or changing its result", async () => {
    const database = mockD1();
    const dumped = new ArrayBuffer(8);
    const failure = new Error("dump failed");
    database.dump = vi.fn().mockResolvedValueOnce(dumped).mockRejectedValueOnce(failure);
    vi.mocked(performance.now)
      .mockReturnValueOnce(0).mockReturnValueOnce(20)
      .mockReturnValueOnce(20).mockReturnValueOnce(50);
    const tracker = createD1CostTracker(database);
    expect(await tracker.db.dump()).toBe(dumped);
    await expect(tracker.db.dump()).rejects.toBe(failure);
    expect(tracker.snapshot()).toEqual({
      ...unobservedServer, queries: 0, rowsRead: 0, rowsWritten: 0,
      bindingCalls: 2, batchCalls: 0, awaitElapsedMs: 50,
      coverage: "partial", reasons: ["dump-no-meta", "failed-attempt-rows-unavailable"],
    });
  });

  it("keeps concurrent call elapsed as a sum rather than run wall time", async () => {
    const database = mockD1();
    const statement = database.prepare("SELECT 1");
    let finishFirst!: (value: D1Result) => void;
    let finishSecond!: (value: D1Result) => void;
    statement.all = vi.fn()
      .mockReturnValueOnce(new Promise<D1Result>((resolve) => { finishFirst = resolve; }))
      .mockReturnValueOnce(new Promise<D1Result>((resolve) => { finishSecond = resolve; }));
    database.prepare = vi.fn(() => statement);
    let nowMs = 0;
    vi.mocked(performance.now).mockImplementation(() => nowMs);
    const tracker = createD1CostTracker(database);
    const first = tracker.db.prepare("SELECT 1").all();
    const second = tracker.db.prepare("SELECT 1").all();
    nowMs = 100;
    finishFirst(result(1, 0));
    finishSecond(result(1, 0));
    await Promise.all([first, second]);
    expect(tracker.snapshot()).toMatchObject({ bindingCalls: 2, queries: 2, awaitElapsedMs: 200 });
  });
});
