import { describe, expect, it } from "vitest";
import {
  finalizeReserveSuccess,
  reserveSyncAttemptInput,
} from "./live-reserves-store.test-support";
import {
  beginReserveSyncAttempt,
  pruneLiveReserveHistory,
} from "../live-reserves/store";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";

describe("live-reserves-store", () => {
  it("requires a pending attempt and records repeated finalization exactly once", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const attemptId = "attempt-idempotent-history";
      await expect(finalizeReserveSuccess(db, attemptId)).resolves.toEqual({ finalized: false, historyRecorded: false });
      expect(sqlite.prepare("SELECT * FROM reserve_composition").all()).toEqual([]);
      expect(sqlite.prepare("SELECT * FROM reserve_composition_history").all()).toEqual([]);
      expect(sqlite.prepare("SELECT * FROM reserve_sync_attempt_history").all()).toEqual([]);
      await beginReserveSyncAttempt(db, reserveSyncAttemptInput(attemptId));
      for (let pass = 0; pass < 2; pass++) {
        await expect(finalizeReserveSuccess(db, attemptId)).resolves.toEqual({ finalized: true, historyRecorded: true });
        expect(sqlite.prepare("SELECT attempt_id, fetched_at FROM reserve_composition").all())
          .toEqual([{ attempt_id: attemptId, fetched_at: 1_000 }]);
        expect(sqlite.prepare("SELECT last_status, last_success_attempt_id, pending_attempt_id FROM reserve_sync_state").all())
          .toEqual([{ last_status: "ok", last_success_attempt_id: attemptId, pending_attempt_id: null }]);
        expect(sqlite.prepare("SELECT attempt_id FROM reserve_composition_history").all()).toEqual([{ attempt_id: attemptId }]);
        expect(sqlite.prepare("SELECT attempt_id FROM reserve_sync_attempt_history").all()).toEqual([{ attempt_id: attemptId }]);
      }
    } finally {
      sqlite.close();
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
