import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBufferedAttributionRecorder,
  type AttributionDb,
  type BufferedAttributionEntry,
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

function createRecorder(flushDelayMs = 100) {
  return createBufferedAttributionRecorder<TestEntry>({
    batchSize: 1,
    flushDelayMs,
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
  });
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
    const recorder = createBufferedAttributionRecorder<TestEntry>({
      batchSize: 1,
      flushDelayMs: 100,
      pruneIntervalSec: 3_600,
      retentionSec: 86_400,
      insertSql: "INSERT test attribution",
      pruneSql: ["PRUNE test attribution"],
      logLabel: "test",
      buildKey: (entry) => `${entry.bucketStart}:${entry.route.routeKey}:${entry.source}`,
      bindInsertParams: (entry) => [entry.bucketStart, entry.route.routeKey, entry.requestCount],
      mergeBuffered: (existing, incoming) => {
        existing.requestCount += incoming.requestCount;
      },
    });

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
});
