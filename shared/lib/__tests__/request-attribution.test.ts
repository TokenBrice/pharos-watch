import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBufferedAttributionRecorder,
  type AttributionDb,
  type BufferedAttributionEntry,
  type CreateBufferedAttributionRecorderOptions,
} from "../request-attribution";

interface TestEntry extends BufferedAttributionEntry {
  source: string;
}

function makeEntry(routeKey: string): TestEntry {
  return {
    bucketStart: 1_700_000_000,
    route: { routeKey, routePath: `/api/${routeKey}` },
    requestCount: 1,
    source: "site",
  };
}

function createRecorder(overrides: Partial<CreateBufferedAttributionRecorderOptions<TestEntry>> = {}) {
  return createBufferedAttributionRecorder<TestEntry>({
    batchSize: 1,
    flushDelayMs: 100,
    pruneIntervalSec: 3_600,
    retentionSec: 86_400,
    insertSql: "INSERT test attribution",
    pruneSql: [],
    logLabel: "test",
    buildKey: (entry) => `${entry.bucketStart}:${entry.route.routeKey}:${entry.source}`,
    bindInsertParams: (entry) => [entry.bucketStart, entry.route.routeKey, entry.requestCount],
    mergeBuffered: (existing, incoming) => {
      existing.requestCount += incoming.requestCount;
    },
    ...overrides,
  });
}

function persistedDb(beforeCommit: () => Promise<void> = async () => {}) {
  const rows: unknown[][] = [];
  const db: AttributionDb = {
    prepare: () => ({
      bind: (...values: unknown[]) => ({ values, run: async () => ({}) }),
    }),
    batch: async (statements) => {
      await beforeCommit();
      rows.push(...(statements as unknown as { values: unknown[] }[]).map((statement) => statement.values));
      return [];
    },
  };
  return { db, rows };
}

describe("createBufferedAttributionRecorder", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries only the failed and unattempted entries after an atomic batch rejection", async () => {
    vi.useFakeTimers();
    const attemptedRouteKeys: string[] = [];
    let batchAttempt = 0;
    const db: AttributionDb = {
      prepare: () => ({
        bind: (...values: unknown[]) => ({
          values,
          run: async () => ({}),
        }),
      }),
      batch: async (statements: never[]) => {
        batchAttempt += 1;
        const statement = statements[0] as unknown as { values: unknown[] };
        attemptedRouteKeys.push(String(statement.values[1]));
        if (batchAttempt === 2) throw new Error("D1 batch rejected");
        return [];
      },
    };
    const recorder = createRecorder();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const records = Promise.all([
      recorder.record(db, makeEntry("first"), 1_700_000_000),
      recorder.record(db, makeEntry("second"), 1_700_000_000),
      recorder.record(db, makeEntry("third"), 1_700_000_000),
    ]);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await records;

    expect(attemptedRouteKeys).toEqual(["first", "second", "second", "third"]);
    expect(warnSpy).toHaveBeenCalledWith(
      "[request-attribution] test attribution flush failed:",
      expect.any(Error),
    );
  });

  it("stops automatic retries after one delayed attempt when the database remains unavailable", async () => {
    vi.useFakeTimers();
    const batch = vi.fn(async () => {
      throw new Error("D1 unavailable");
    });
    const db: AttributionDb = {
      prepare: () => ({
        bind: (...values: unknown[]) => ({ values, run: async () => ({}) }),
      }),
      batch,
    };
    const recorder = createRecorder();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const record = recorder.record(db, makeEntry("first"), 1_700_000_000);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await record;
    await vi.advanceTimersByTimeAsync(9_800);

    expect(batch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes rows recorded while the preceding flush is finalizing its prune", async () => {
    vi.useFakeTimers();
    let finishPrune: (() => void) | undefined;
    const prunePending = new Promise<void>((resolve) => {
      finishPrune = resolve;
    });
    const attemptedRouteKeys: string[] = [];
    const db: AttributionDb = {
      prepare: (sql) => ({
        bind: (...values: unknown[]) => ({
          values,
          run: async () => {
            if (sql === "PRUNE test attribution") await prunePending;
            return {};
          },
        }),
      }),
      batch: async (statements: never[]) => {
        const statement = statements[0] as unknown as { values: unknown[] };
        attemptedRouteKeys.push(String(statement.values[1]));
        return [];
      },
    };
    const recorder = createRecorder({ pruneSql: ["PRUNE test attribution"] });

    const firstRecord = recorder.record(db, makeEntry("first"), 1_700_000_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(attemptedRouteKeys).toEqual(["first"]);

    const lateRecord = recorder.record(db, makeEntry("late"), 1_700_000_001);
    finishPrune?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await firstRecord;
    await lateRecord;

    expect(attemptedRouteKeys).toEqual(["first", "late"]);
  });

  it("coalesces same-key traffic into one persisted count", async () => {
    vi.useFakeTimers();
    const { db, rows } = persistedDb();
    const recorder = createRecorder();
    const records = [1, 3].map((requestCount) =>
      recorder.record(db, { ...makeEntry("same"), requestCount }, 1_700_000_000));
    await vi.runAllTimersAsync();
    await Promise.all(records);
    expect(rows).toEqual([[1_700_000_000, "same", 4]]);
  });

  it("merges newer same-key traffic into a failed atomic chunk without replaying committed chunks", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const recorder = createRecorder({ batchSize: 2 });
    let attempt = 0;
    let lateRecord: Promise<void> | undefined;
    const { db, rows } = persistedDb(async () => {
      if (++attempt === 2) {
        lateRecord = recorder.record(db, { ...makeEntry("third"), requestCount: 5 }, 1_700_000_001);
        throw new Error("atomic rejection");
      }
    });
    const records = ["first", "second", "third", "fourth", "fifth"].map((key) =>
      recorder.record(db, makeEntry(key), 1_700_000_000));
    await vi.runAllTimersAsync();
    await Promise.all([...records, lateRecord]);
    expect(rows).toEqual([
      [1_700_000_000, "first", 1], [1_700_000_000, "second", 1],
      [1_700_000_000, "third", 6], [1_700_000_000, "fourth", 1],
      [1_700_000_000, "fifth", 1],
    ]);
  });

  it("discards the old generation before its scheduled callback", async () => {
    vi.useFakeTimers();
    const { db, rows } = persistedDb();
    const recorder = createRecorder();
    const old = recorder.record(db, { ...makeEntry("same"), requestCount: 9 }, 1_700_000_000);
    recorder.reset();
    const current = recorder.record(db, makeEntry("same"), 1_700_000_001);
    await vi.runAllTimersAsync();
    await Promise.all([old, current]);
    expect(rows).toEqual([[1_700_000_000, "same", 1]]);
  });

  it("retains exhausted counts until new traffic restarts flushing", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let unavailable = true;
    const { db, rows } = persistedDb(async () => {
      if (unavailable) throw new Error("unavailable");
    });
    const recorder = createRecorder();
    const old = recorder.record(db, { ...makeEntry("same"), requestCount: 3 }, 1_700_000_000);
    await vi.runAllTimersAsync();
    await old;
    expect(rows).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    unavailable = false;
    const current = recorder.record(db, makeEntry("same"), 1_700_000_001);
    await vi.runAllTimersAsync();
    await current;
    expect(rows).toEqual([[1_700_000_000, "same", 4]]);
  });
});
