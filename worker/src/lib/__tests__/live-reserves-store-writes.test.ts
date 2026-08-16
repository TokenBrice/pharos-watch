import { describe, expect, it } from "vitest";
import { mockD1 as createMockD1, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import {
  beginReserveSyncAttempt,
  finalizeReserveSyncSuccess,
  pruneLiveReserveHistory,
} from "../live-reserves-store";



const LIVE_SLICES = [{ name: "Test Farm", pct: 100, risk: "low" as const }];

const RESERVE_DEFAULT_TABLES: MockTableConfig[] = [
  { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
  { match: "FROM reserve_sync_state", rows: [] },
  { match: "FROM reserve_composition", rows: [] },
  { match: "INSERT INTO reserve_sync_state", rows: [] },
  { match: "INSERT INTO reserve_composition", rows: [] },
  { match: "UPDATE reserve_sync_state", rows: [] },
  { match: "INSERT OR IGNORE INTO reserve_composition_history", rows: [] },
  { match: "INSERT OR IGNORE INTO reserve_sync_attempt_history", rows: [] },
  {
    match: "SELECT 1 AS finalized FROM reserve_composition c JOIN reserve_sync_state",
    rows: [],
    first: null,
  },
];

function mockD1(tables: MockTableConfig[] = []) {
  return createMockD1([...tables, ...RESERVE_DEFAULT_TABLES]);
}

/**
 * mockD1 wired for the reserve_composition + reserve_sync_state pair every store
 * read issues. `null` models a missing row; an object is merged over the default
 * row so each case shows only the columns it actually varies.
 */


describe("live-reserves-store", () => {
  it("persists reserve composition and sync state together for successful snapshots", async () => {
    const db = mockD1();
    const attemptId = "attempt-1";

    await beginReserveSyncAttempt(db, {
      stablecoinId: "iusd-infinifi",
      adapterKey: "infinifi",
      breakerKey: "live-reserves:infinifi",
      attemptedAt: 1_000,
      attemptId,
    });

    const { finalized, historyRecorded } = await finalizeReserveSyncSuccess(
      db,
      {
        stablecoinId: "iusd-infinifi",
        slices: LIVE_SLICES,
        fetchedAt: 1_000,
        source: "infinifi",
        attemptId,
        metadata: {},
        warningCount: 0,
        warnings: [],
        adapterSourceModel: "dynamic-mix",
        adapterEvidenceClass: "independent",
      },
      {
        stablecoinId: "iusd-infinifi",
        adapterKey: "infinifi",
        breakerKey: "live-reserves:infinifi",
        lastAttemptedAt: 1_000,
        lastSuccessAt: 1_000,
        lastStatus: "ok",
        warningCount: 0,
        warnings: [],
        lastError: null,
        metadata: {},
        lastAttemptId: attemptId,
        pendingAttemptId: attemptId,
        lastSuccessAttemptId: attemptId,
      },
      Date.now() + 30_000,
    );

    expect(finalized).toBe(true);
    expect(historyRecorded).toBe(true);
    const history = db.getHistory().map((entry) => entry.sql);
    expect(history.some((sql) => sql.includes("INSERT INTO reserve_composition ("))).toBe(true);
    expect(history.some((sql) => sql.includes("INSERT OR IGNORE INTO reserve_composition_history"))).toBe(true);
    expect(history.some((sql) => sql.includes("UPDATE reserve_sync_state"))).toBe(true);
    expect(history.some((sql) => sql.includes("INSERT OR IGNORE INTO reserve_sync_attempt_history"))).toBe(true);
  });

  it("inserts both history rows only when composition and finalize both apply", async () => {
    const db = mockD1();
    const attemptId = "attempt-both";

    const result = await finalizeReserveSyncSuccess(
      db,
      {
        stablecoinId: "iusd-infinifi",
        slices: LIVE_SLICES,
        fetchedAt: 1_000,
        source: "infinifi",
        attemptId,
        metadata: {},
        warningCount: 0,
        warnings: [],
        adapterSourceModel: "dynamic-mix",
        adapterEvidenceClass: "independent",
      },
      {
        stablecoinId: "iusd-infinifi",
        adapterKey: "infinifi",
        breakerKey: "live-reserves:infinifi",
        lastAttemptedAt: 1_000,
        lastSuccessAt: 1_000,
        lastStatus: "ok",
        warningCount: 0,
        warnings: [],
        lastError: null,
        metadata: {},
        lastAttemptId: attemptId,
        pendingAttemptId: attemptId,
        lastSuccessAttemptId: attemptId,
      },
      Date.now() + 30_000,
    );

    expect(result.finalized).toBe(true);
    expect(result.historyRecorded).toBe(true);
    const historySqls = db.getHistory().map((entry) => entry.sql);
    expect(historySqls.some((sql) => sql.includes("INSERT OR IGNORE INTO reserve_composition_history"))).toBe(true);
    expect(historySqls.some((sql) => sql.includes("INSERT OR IGNORE INTO reserve_sync_attempt_history"))).toBe(true);
  });

  it("uses idempotent INSERT OR IGNORE statements for attempt-stamped reserve history", async () => {
    const db = mockD1();
    const attemptId = "attempt-idempotent-history";

    await finalizeReserveSyncSuccess(
      db,
      {
        stablecoinId: "iusd-infinifi",
        slices: LIVE_SLICES,
        fetchedAt: 1_000,
        source: "infinifi",
        attemptId,
        metadata: {},
        warningCount: 0,
        warnings: [],
        adapterSourceModel: "dynamic-mix",
        adapterEvidenceClass: "independent",
      },
      {
        stablecoinId: "iusd-infinifi",
        adapterKey: "infinifi",
        breakerKey: "live-reserves:infinifi",
        lastAttemptedAt: 1_000,
        lastSuccessAt: 1_000,
        lastStatus: "ok",
        warningCount: 0,
        warnings: [],
        lastError: null,
        metadata: {},
        lastAttemptId: attemptId,
        pendingAttemptId: attemptId,
        lastSuccessAttemptId: attemptId,
      },
      Date.now() + 30_000,
    );

    const history = db.getHistory();
    const compositionHistory = history.find((entry) =>
      entry.sql.includes("INSERT OR IGNORE INTO reserve_composition_history")
    );
    const attemptHistory = history.find((entry) =>
      entry.sql.includes("INSERT OR IGNORE INTO reserve_sync_attempt_history")
    );
    expect(compositionHistory).toBeDefined();
    expect(attemptHistory).toBeDefined();
    expect(compositionHistory?.binds).toContain(attemptId);
    expect(attemptHistory?.binds).toContain(attemptId);
  });

  it("prunes reserve history tables by retention cutoff", async () => {
    const db = mockD1([
      {
        match: "DELETE FROM reserve_composition_history",
        rows: [],
        runMeta: { changes: 3 },
      },
      {
        match: "DELETE FROM reserve_sync_attempt_history",
        rows: [],
        runMeta: { changes: 7 },
      },
    ]);

    const result = await pruneLiveReserveHistory(db, 10_000, 1_000);
    expect(result).toEqual({
      cutoff: 9_000,
      compositionHistoryDeleted: 3,
      attemptHistoryDeleted: 7,
    });

    // Each DELETE is paginated; single iteration when deleted < batchSize.
    const history = db.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0]?.binds[0]).toBe(9_000);
    expect(history[0]?.binds[history[0].binds.length - 1]).toBe(5000);
    expect(history[1]?.binds[0]).toBe(9_000);
    expect(history[1]?.binds[history[1].binds.length - 1]).toBe(5000);
    // Rows referenced by the current attempt closure must survive the age cutoff.
    for (const entry of history) {
      expect(entry.sql).toContain("NOT EXISTS");
      expect(entry.sql).toContain("FROM reserve_composition c");
      expect(entry.sql).toContain("FROM reserve_sync_state s");
    }
  });

  it("paginates large prunes into multiple capped DELETE statements", async () => {
    // Each DELETE call returns `batchSize` until the table drains, then a final
    // partial batch signals completion. Total 650 composition rows + 230 attempt rows.
    const compositionCounts = [100, 100, 100, 100, 100, 100, 50];
    const attemptCounts = [100, 100, 30];
    let compositionIdx = 0;
    let attemptIdx = 0;
    const history: Array<{ sql: string; binds: unknown[] }> = [];

    const db = {
      prepare: (sql: string) => ({
        sql,
        bind: (...binds: unknown[]) => ({
          run: async () => {
            history.push({ sql, binds });
            if (sql.includes("reserve_composition_history")) {
              const changes = compositionCounts[compositionIdx++] ?? 0;
              return { success: true, meta: { changes } };
            }
            if (sql.includes("reserve_sync_attempt_history")) {
              const changes = attemptCounts[attemptIdx++] ?? 0;
              return { success: true, meta: { changes } };
            }
            return { success: true, meta: { changes: 0 } };
          },
        }),
      }),
    } as unknown as D1Database;

    const result = await pruneLiveReserveHistory(db, 10_000, 1_000, 100);
    expect(result.compositionHistoryDeleted).toBe(650);
    expect(result.attemptHistoryDeleted).toBe(230);
    expect(history.length).toBe(compositionCounts.length + attemptCounts.length);
    for (const entry of history) {
      expect(entry.binds[entry.binds.length - 1]).toBe(100);
    }
  });
});
