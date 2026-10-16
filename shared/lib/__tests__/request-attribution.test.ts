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
