import { describe, expect, it } from "vitest";
import {
  finalizeReserveSuccess,
  mockReserveD1 as mockD1,
  reserveSyncAttemptInput,
} from "./live-reserves-store.test-support";
import {
  beginReserveSyncAttempt,
  pruneLiveReserveHistory,
} from "../live-reserves-store";
import { makeNoopD1 } from "../../test-helpers/noop-d1";

describe("live-reserves-store", () => {
  it("persists reserve composition and sync state together for successful snapshots", async () => {
    const db = mockD1();
    const attemptId = "attempt-1";

    await beginReserveSyncAttempt(db, reserveSyncAttemptInput(attemptId));

    const { finalized, historyRecorded } = await finalizeReserveSuccess(db, attemptId);

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

    const result = await finalizeReserveSuccess(db, attemptId);

    expect(result.finalized).toBe(true);
    expect(result.historyRecorded).toBe(true);
    const historySqls = db.getHistory().map((entry) => entry.sql);
    expect(historySqls.some((sql) => sql.includes("INSERT OR IGNORE INTO reserve_composition_history"))).toBe(true);
    expect(historySqls.some((sql) => sql.includes("INSERT OR IGNORE INTO reserve_sync_attempt_history"))).toBe(true);
  });

  it("uses idempotent INSERT OR IGNORE statements for attempt-stamped reserve history", async () => {
    const db = mockD1();
    const attemptId = "attempt-idempotent-history";

    await finalizeReserveSuccess(db, attemptId);

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

    const db = makeNoopD1({
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
    });

    const result = await pruneLiveReserveHistory(db, 10_000, 1_000, 100);
    expect(result.compositionHistoryDeleted).toBe(650);
    expect(result.attemptHistoryDeleted).toBe(230);
    expect(history.length).toBe(compositionCounts.length + attemptCounts.length);
    for (const entry of history) {
      expect(entry.binds[entry.binds.length - 1]).toBe(100);
    }
  });
});
