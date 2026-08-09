import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { computeReserveCompositionOverview, resolveReserveResult } from "../../lib/live-reserves-store";
import { breakerKeyForConfig, type ConfiguredCoin } from "../sync-live-reserves-shared";
import {
  clearCursorStateIfComplete,
  loadLiveReserveCursorState,
  recordDeferredTail,
  selectConfiguredCoinRunQueue,
} from "../sync-live-reserves-run-state";
import { LIVE_RESERVE_RUN_CURSOR_CACHE_KEY } from "../../lib/operational-cache-keys";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

function makeCoin(id: string): ConfiguredCoin {
  return {
    id,
    liveReservesConfig: {
      adapter: "test-adapter",
      version: 1,
      semantics: "dynamic-mix",
      evidence: "independent",
      inputs: {
        primary: { kind: "static-json", value: {} },
      },
    },
  } as unknown as ConfiguredCoin;
}

function createDeferredStateHarness() {
  const sqlite = createLatestSchemaSqlite().sqlite;
  return { sqlite, db: createSqliteD1(sqlite) };
}

function makeBatchRecordingDb(batchSizes: number[], history: Array<{ sql: string; binds: unknown[] }> = []): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        sql,
        binds,
        run: async () => {
          history.push({ sql, binds });
          return { success: true, meta: { changes: 1 } };
        },
        first: async () => {
          history.push({ sql, binds });
          return null;
        },
      }),
    }),
    batch: async (statements: D1PreparedStatement[]) => {
      batchSizes.push(statements.length);
      for (const statement of statements as unknown as Array<{ sql: string; binds: unknown[] }>) {
        history.push({ sql: statement.sql, binds: statement.binds });
      }
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

function parseCursorWrite(entry: { binds: unknown[] } | undefined): Record<string, unknown> | null {
  const value = entry?.binds[1];
  return typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : null;
}

describe("selectConfiguredCoinRunQueue", () => {
  it("starts from the saved cursor when the coin is still configured", () => {
    const coins = [makeCoin("coin-a"), makeCoin("coin-b"), makeCoin("coin-c")];

    expect(selectConfiguredCoinRunQueue(coins, "coin-b").map((coin) => coin.id)).toEqual(["coin-b", "coin-c"]);
  });

  it("falls back to the full queue when the cursor is absent or stale", () => {
    const coins = [makeCoin("coin-a"), makeCoin("coin-b")];

    expect(selectConfiguredCoinRunQueue(coins, null).map((coin) => coin.id)).toEqual(["coin-a", "coin-b"]);
    expect(selectConfiguredCoinRunQueue(coins, "missing-coin").map((coin) => coin.id)).toEqual(["coin-a", "coin-b"]);
  });
});

describe("recordDeferredTail", () => {
  it("chunks deferred tail writes through the shared D1 batch executor", async () => {
    const batchSizes: number[] = [];
    const db = makeBatchRecordingDb(batchSizes);
    const coins = Array.from({ length: 61 }, (_value, index) => makeCoin(`coin-${index}`));

    const result = await recordDeferredTail(db, coins, 1_700_000_000);

    expect(result).toEqual({
      deferredCoins: 61,
      nextCursorStablecoinId: "coin-0",
      cursorTailState: "complete",
      cursorRecordedAt: 1_700_000_000,
      cursorTailCompletedAt: expect.any(Number),
      cursorTailFailedAt: null,
      cursorTailError: null,
      runBudgetTruncationCount: 1,
      additionalBreakerKeys: expect.any(Set),
    });
    expect(result.additionalBreakerKeys.size).toBe(1);
    expect(batchSizes).toEqual([100, 22]);
  });

  it("persists the cursor before deferred row batches and marks it complete after rows record", async () => {
    const batchSizes: number[] = [];
    const history: Array<{ sql: string; binds: unknown[] }> = [];
    const db = makeBatchRecordingDb(batchSizes, history);

    await recordDeferredTail(db, [makeCoin("coin-a"), makeCoin("coin-b")], 1_700_000_000);

    const cursorWrites = history.filter((entry) => (
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === LIVE_RESERVE_RUN_CURSOR_CACHE_KEY
    ));
    const firstDeferredRowIndex = history.findIndex((entry) => (
      entry.sql.includes("INSERT INTO reserve_sync_state")
      && entry.binds[0] === "coin-a"
    ));
    const firstCursorIndex = history.indexOf(cursorWrites[0]!);
    const lastCursorIndex = history.indexOf(cursorWrites[cursorWrites.length - 1]!);

    expect(cursorWrites).toHaveLength(2);
    expect(firstCursorIndex).toBeGreaterThanOrEqual(0);
    expect(firstCursorIndex).toBeLessThan(firstDeferredRowIndex);
    expect(lastCursorIndex).toBeGreaterThan(firstDeferredRowIndex);
    expect(parseCursorWrite(cursorWrites[0])).toMatchObject({
      nextStablecoinId: "coin-a",
      deferredCount: 2,
      deferredAt: 1_700_000_000,
      reason: "run-budget-exhausted",
      cursorRecordedAt: 1_700_000_000,
      tailState: "recording",
    });
    expect(parseCursorWrite(cursorWrites[1])).toMatchObject({
      nextStablecoinId: "coin-a",
      deferredCount: 2,
      tailState: "complete",
    });
    expect(typeof parseCursorWrite(cursorWrites[1])?.tailCompletedAt).toBe("number");
  });

  it("keeps a recent authoritative snapshot fresh while recording deferral without inventing bootstrap authority", async () => {
    const { sqlite, db } = createDeferredStateHarness();
    try {
      const authoritativeCoin = ACTIVE_STABLECOINS.find((coin) => coin.id === "iusd-infinifi");
      expect(authoritativeCoin?.liveReservesConfig).toBeDefined();
      const configuredCoin = authoritativeCoin as ConfiguredCoin;
      const config = configuredCoin.liveReservesConfig!;
      const breakerKey = breakerKeyForConfig(config);
      const successAt = 1_700_000_000;
      const deferredAt = successAt + 60 * 60;
      const successAttemptId = "iusd-infinifi:success";

      sqlite.prepare(
        `INSERT INTO reserve_sync_state (
           stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_success_at,
           last_status, warning_count, metadata, last_attempt_id, pending_attempt_id,
           last_success_attempt_id
         ) VALUES (?, ?, ?, ?, ?, 'ok', 0, '{}', ?, NULL, ?)`,
      ).run(
        configuredCoin.id,
        config.adapter,
        breakerKey,
        successAt,
        successAt,
        successAttemptId,
        successAttemptId,
      );
      sqlite.prepare(
        `INSERT INTO reserve_composition (
           stablecoin_id, slices, fetched_at, source, attempt_id, metadata,
           warning_count, adapter_source_model, adapter_evidence_class
         ) VALUES (?, ?, ?, ?, ?, ?, 0, 'dynamic-mix', 'independent')`,
      ).run(
        configuredCoin.id,
        JSON.stringify([{ name: "Verified reserves", pct: 100, risk: "low" }]),
        successAt,
        config.adapter,
        successAttemptId,
        JSON.stringify({ freshnessMode: "not-applicable" }),
      );

      await recordDeferredTail(
        db,
        [configuredCoin, makeCoin("bootstrap-coin")],
        deferredAt,
      );

      expect(sqlite.prepare(
        `SELECT last_attempted_at, last_success_at, last_status, last_attempt_id,
                pending_attempt_id, last_success_attempt_id
           FROM reserve_sync_state
          WHERE stablecoin_id = ?`,
      ).get(configuredCoin.id)).toEqual({
        last_attempted_at: successAt,
        last_success_at: successAt,
        last_status: "ok",
        last_attempt_id: successAttemptId,
        pending_attempt_id: null,
        last_success_attempt_id: successAttemptId,
      });
      expect(sqlite.prepare(
        `SELECT last_attempted_at, last_success_at, last_status, last_attempt_id,
                pending_attempt_id, last_success_attempt_id
           FROM reserve_sync_state
          WHERE stablecoin_id = 'bootstrap-coin'`,
      ).get()).toEqual({
        last_attempted_at: deferredAt,
        last_success_at: null,
        last_status: "skipped",
        last_attempt_id: null,
        pending_attempt_id: null,
        last_success_attempt_id: null,
      });
      expect(sqlite.prepare(
        "SELECT stablecoin_id, attempted_at, status, last_error FROM reserve_sync_attempt_history ORDER BY rowid",
      ).all()).toEqual([
        {
          stablecoin_id: configuredCoin.id,
          attempted_at: deferredAt,
          status: "skipped",
          last_error: "run-budget-exhausted",
        },
        {
          stablecoin_id: "bootstrap-coin",
          attempted_at: deferredAt,
          status: "skipped",
          last_error: "run-budget-exhausted",
        },
      ]);

      const resolved = await resolveReserveResult(db, configuredCoin.id, deferredAt + 60);
      expect(resolved).toMatchObject({
        mode: "live",
        liveAt: successAt,
        provenance: { scoringEligible: true },
        sync: {
          status: "ok",
          stale: false,
          lastAttemptedAt: successAt,
          lastSuccessAt: successAt,
        },
      });
      const overview = await computeReserveCompositionOverview(db, deferredAt + 60);
      expect(overview).toMatchObject({
        freshCoins: 1,
        independentFreshEligible: 1,
        deferredCoins: 2,
        runBudgetTruncated: true,
        nextCursorStablecoinId: configuredCoin.id,
        cursorTailState: "complete",
      });
    } finally {
      sqlite.close();
    }
  });

  it("retries cursor cache writes on transient D1 overload", async () => {
    const history: Array<{ sql: string; binds: unknown[] }> = [];
    let cursorWriteAttempts = 0;
    const db = {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          sql,
          binds,
          run: async () => {
            if (
              sql.includes("INSERT OR REPLACE INTO cache")
              && binds[0] === LIVE_RESERVE_RUN_CURSOR_CACHE_KEY
              && cursorWriteAttempts === 0
            ) {
              cursorWriteAttempts++;
              throw new Error("D1 DB is overloaded");
            }
            cursorWriteAttempts += sql.includes("INSERT OR REPLACE INTO cache") && binds[0] === LIVE_RESERVE_RUN_CURSOR_CACHE_KEY
              ? 1
              : 0;
            history.push({ sql, binds });
            return { success: true, meta: { changes: 1 } };
          },
          first: async () => {
            history.push({ sql, binds });
            return null;
          },
        }),
      }),
      batch: async (statements: D1PreparedStatement[]) => {
        for (const statement of statements as unknown as Array<{ sql: string; binds: unknown[] }>) {
          history.push({ sql: statement.sql, binds: statement.binds });
        }
        return statements.map(() => ({ success: true, meta: { changes: 1 } }));
      },
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    const result = await recordDeferredTail(db, [makeCoin("coin-a")], 1_700_000_000);

    expect(result.cursorTailState).toBe("complete");
    expect(cursorWriteAttempts).toBe(3);
    const cursorWrites = history.filter((entry) => (
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === LIVE_RESERVE_RUN_CURSOR_CACHE_KEY
    ));
    expect(cursorWrites).toHaveLength(2);
  });

  it("does not write a deferred cursor when the signal is already aborted", async () => {
    const history: Array<{ sql: string; binds: unknown[] }> = [];
    const db = makeBatchRecordingDb([], history);
    const controller = new AbortController();
    controller.abort(new Error("cron timed out"));

    await expect(recordDeferredTail(db, [makeCoin("coin-a")], 1_700_000_000, controller.signal))
      .rejects.toThrow("cron timed out");

    expect(history.some((entry) => entry.binds[0] === LIVE_RESERVE_RUN_CURSOR_CACHE_KEY)).toBe(false);
  });

  it("records a durable event when previous cursor state cannot be read", async () => {
    const batchSizes: number[] = [];
    const history: Array<{ sql: string; binds: unknown[] }> = [];
    let cursorReadFailed = false;
    const db = {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          sql,
          binds,
          run: async () => {
            history.push({ sql, binds });
            return { success: true, meta: { changes: 1 } };
          },
          first: async () => {
            history.push({ sql, binds });
            if (!cursorReadFailed && sql.includes("SELECT value, updated_at FROM cache")) {
              cursorReadFailed = true;
              throw new Error("cache read unavailable");
            }
            return null;
          },
        }),
      }),
      batch: async (statements: D1PreparedStatement[]) => {
        batchSizes.push(statements.length);
        for (const statement of statements as unknown as Array<{ sql: string; binds: unknown[] }>) {
          history.push({ sql: statement.sql, binds: statement.binds });
        }
        return statements.map(() => ({ success: true, meta: { changes: 1 } }));
      },
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    await recordDeferredTail(db, [makeCoin("coin-a")], 1_700_000_000);

    expect(batchSizes).toEqual([2]);
    const cursorReadEvent = history.find((entry) => (
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === "cron:event:sync-live-reserves:live-reserve-cursor-read-failed"
    ));
    expect(cursorReadEvent).toBeDefined();
    const eventRecord = JSON.parse(cursorReadEvent?.binds[1] as string) as {
      metadata?: { error?: string };
    };
    expect(eventRecord.metadata?.error).toBe("cache read unavailable");
  });

  it("keeps the cursor advanced and marks it incomplete when deferred row batching fails", async () => {
    const history: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          sql,
          binds,
          run: async () => {
            history.push({ sql, binds });
            return { success: true, meta: { changes: 1 } };
          },
          first: async () => {
            history.push({ sql, binds });
            return null;
          },
        }),
      }),
      batch: async (statements: D1PreparedStatement[]) => {
        for (const statement of statements as unknown as Array<{ sql: string; binds: unknown[] }>) {
          history.push({ sql: statement.sql, binds: statement.binds });
        }
        throw new Error("batch unavailable");
      },
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
    } as unknown as D1Database;

    await expect(recordDeferredTail(db, [makeCoin("coin-a")], 1_700_000_000))
      .rejects.toThrow("Failed to record deferred reserve tail state: batch unavailable");

    const cursorWrites = history.filter((entry) => (
      entry.sql.includes("INSERT OR REPLACE INTO cache")
      && entry.binds[0] === LIVE_RESERVE_RUN_CURSOR_CACHE_KEY
    ));
    expect(cursorWrites).toHaveLength(2);
    expect(parseCursorWrite(cursorWrites[0])).toMatchObject({
      nextStablecoinId: "coin-a",
      tailState: "recording",
    });
    expect(parseCursorWrite(cursorWrites[1])).toMatchObject({
      nextStablecoinId: "coin-a",
      tailState: "incomplete",
      tailError: "batch unavailable",
    });
  });
});

describe("clearCursorStateIfComplete", () => {
  it("keeps the cursor when a run still has a deferred tail", async () => {
    const history: Array<{ sql: string; binds: unknown[] }> = [];
    const db = makeBatchRecordingDb([], history);

    await clearCursorStateIfComplete(db, 2, "coin-a");

    expect(history).toEqual([]);
  });

  it("deletes the cursor after a complete run", async () => {
    const history: Array<{ sql: string; binds: unknown[] }> = [];
    const db = makeBatchRecordingDb([], history);

    await clearCursorStateIfComplete(db, 0, null);

    expect(history).toContainEqual({
      sql: "DELETE FROM cache WHERE key = ?",
      binds: [LIVE_RESERVE_RUN_CURSOR_CACHE_KEY],
    });
  });
});

describe("loadLiveReserveCursorState", () => {
  it("loads legacy cursor JSON without tail metadata", async () => {
    const db = {
      prepare: (_sql: string) => ({
        bind: (..._binds: unknown[]) => ({
          first: async () => ({
            value: JSON.stringify({
              nextStablecoinId: "legacy-coin",
              deferredCount: 3,
              deferredAt: 1_700_000_000,
              reason: "run-budget-exhausted",
            }),
            updated_at: 1_700_000_000,
          }),
        }),
      }),
    } as unknown as D1Database;

    await expect(loadLiveReserveCursorState(db)).resolves.toEqual({
      nextStablecoinId: "legacy-coin",
      deferredCount: 3,
      deferredAt: 1_700_000_000,
      tailState: null,
      cursorRecordedAt: null,
      tailCompletedAt: null,
      tailFailedAt: null,
      tailError: null,
      runBudgetTruncationCount: 1,
    });
  });

  it("loads partial-tail cursor diagnostics", async () => {
    const db = {
      prepare: (_sql: string) => ({
        bind: (..._binds: unknown[]) => ({
          first: async () => ({
            value: JSON.stringify({
              nextStablecoinId: "coin-a",
              deferredCount: 8,
              deferredAt: 1_700_000_000,
              reason: "run-budget-exhausted",
              tailState: "incomplete",
              tailError: "batch unavailable",
              cursorRecordedAt: 1_700_000_000,
              tailFailedAt: 1_700_000_005,
              runBudgetTruncationCount: 3,
            }),
            updated_at: 1_700_000_005,
          }),
        }),
      }),
    } as unknown as D1Database;

    await expect(loadLiveReserveCursorState(db)).resolves.toEqual({
      nextStablecoinId: "coin-a",
      deferredCount: 8,
      deferredAt: 1_700_000_000,
      tailState: "incomplete",
      cursorRecordedAt: 1_700_000_000,
      tailCompletedAt: null,
      tailFailedAt: 1_700_000_005,
      tailError: "batch unavailable",
      runBudgetTruncationCount: 3,
    });
  });
});
