import { describe, expect, it, vi } from "vitest";
import {
  finalizeReserveSuccess,
  reserveSyncAttemptInput,
  reserveSyncStateInput,
} from "./live-reserves-store.test-support";
import {
  beginReserveSyncAttempt,
  finalizeReserveSyncAttempt,
  pruneLiveReserveHistory,
} from "../live-reserves/store";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { createD1CostTracker } from "../d1-cost";
import { beginLiveReserveCheckpoint, loadLiveReserveCheckpoint } from "../scheduled-recovery-checkpoint";

describe("live-reserves-store", () => {
  it("requires a pending attempt and records repeated finalization exactly once", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const attemptId = "attempt-idempotent-history";
      await expect(finalizeReserveSuccess(db, attemptId)).resolves.toEqual({ finalized: false });
      expect(sqlite.prepare("SELECT * FROM reserve_composition").all()).toEqual([]);
      expect(sqlite.prepare("SELECT * FROM reserve_composition_history").all()).toEqual([]);
      expect(sqlite.prepare("SELECT * FROM reserve_sync_attempt_history").all()).toEqual([]);
      await beginReserveSyncAttempt(db, reserveSyncAttemptInput(attemptId));
      for (let pass = 0; pass < 2; pass++) {
        await expect(finalizeReserveSuccess(db, attemptId)).resolves.toEqual({ finalized: true });
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

  it("persists configuration identity and excludes diagnostics from change detection", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const config = ACTIVE_STABLECOINS.find((coin) => coin.id === "iusd-infinifi")!.liveReservesConfig!;
      const fingerprint = computeLiveReserveConfigFingerprint(config);
      for (const [index, durationMs] of [10, 999].entries()) {
        const attemptId = `diag-${index}`;
        await beginReserveSyncAttempt(db, reserveSyncAttemptInput(attemptId));
        expect(sqlite.prepare("SELECT config_fingerprint FROM reserve_sync_state").get())
          .toEqual({ config_fingerprint: fingerprint });
        await finalizeReserveSuccess(db, attemptId, {
          composition: { fetchedAt: 1000 + index, metadata: { diag: { durationMs } } },
          syncState: { lastSuccessAt: 1000 + index },
        });
      }
      expect(sqlite.prepare("SELECT config_fingerprint FROM reserve_composition").get())
        .toEqual({ config_fingerprint: fingerprint });
      expect(sqlite.prepare("SELECT COUNT(DISTINCT payload_sha256) AS count FROM reserve_composition_history").get())
        .toEqual({ count: 1 });
      await beginReserveSyncAttempt(db, reserveSyncAttemptInput("failure"));
      await finalizeReserveSyncAttempt(db, reserveSyncStateInput("failure", { lastStatus: "error" }));
      expect(sqlite.prepare("SELECT config_fingerprint FROM reserve_sync_state").get())
        .toEqual({ config_fingerprint: fingerprint });
      expect(sqlite.prepare("SELECT status FROM reserve_sync_attempt_history WHERE attempt_id = 'failure'").get())
        .toEqual({ status: "error" });
    } finally {
      sqlite.close();
    }
  });

  it("rejects stale checkpoint owners and expired starts without stealing the pending fence", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const checkpoint = {
        scheduleKey: "fourHourlyReserveSync", slotStartedAt: 1000, job: "sync-live-reserves",
        attemptNo: 1, executionGeneration: 2, invocationId: "owner",
      };
      sqlite.exec(`INSERT INTO worker_scheduled_checkpoints (
        schedule_key, slot_started_at, job, attempt_no, execution_generation, invocation_id,
        queue_hash, state, next_item_key, current_domain_attempt_id, items_done, items_total,
        child_dispositions_json, created_at, updated_at
      ) VALUES ('fourHourlyReserveSync',1000,'sync-live-reserves',1,2,'owner',
        'queue','running','iusd-infinifi','owned',0,1,'{}',1000,1000)`);
      await beginReserveSyncAttempt(db, { ...reserveSyncAttemptInput("owned"), checkpoint });
      for (const denied of [
        { ...checkpoint, executionGeneration: 1 },
        { ...checkpoint, invocationId: "stale-owner" },
        checkpoint,
      ]) {
        await expect(beginReserveSyncAttempt(db, {
          ...reserveSyncAttemptInput("intruder"), checkpoint: denied,
        })).rejects.toThrow("ownership");
      }
      await expect(beginReserveSyncAttempt(db, {
        ...reserveSyncAttemptInput("expired"), deadlineMs: Date.now() - 1000,
      })).rejects.toThrow("deadline");
      expect(sqlite.prepare("SELECT pending_attempt_id FROM reserve_sync_state").get())
        .toEqual({ pending_attempt_id: "owned" });
    } finally {
      sqlite.close();
    }
  });

  it("uses two binding calls per scheduled success while checkpointing before pending state", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const checkpoint = await beginLiveReserveCheckpoint(db, {
        slotStartedAt: 1000, invocationId: "owner",
      });
      const cost = createD1CostTracker(db);
      await beginReserveSyncAttempt(cost.db, {
        ...reserveSyncAttemptInput("batched"), checkpoint,
        checkpointProgress: { itemsDone: 0, itemsTotal: 1 },
        deadlineMs: Date.now() + 30_000,
      });
      expect(cost.snapshot()).toMatchObject({ bindingCalls: 1, batchCalls: 1, queries: 2 });
      expect(await loadLiveReserveCheckpoint(db, checkpoint)).toMatchObject({
        currentDomainAttemptId: "batched", currentItemKey: "iusd-infinifi", itemsDone: 0,
      });
      expect(sqlite.prepare("SELECT pending_attempt_id FROM reserve_sync_state").get())
        .toEqual({ pending_attempt_id: "batched" });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_composition").get()).toEqual({ count: 0 });
      await expect(finalizeReserveSuccess(cost.db, "batched")).resolves.toEqual({ finalized: true });
      expect(cost.snapshot()).toMatchObject({ bindingCalls: 2, batchCalls: 2, queries: 6 });
      expect(sqlite.prepare("SELECT fetched_at, attempt_id FROM reserve_composition").get())
        .toEqual({ fetched_at: 1000, attempt_id: "batched" });
    } finally { sqlite.close(); }
  });

  it("rolls back checkpoint and begin together, and rejects stale generation/owner and expired batches", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const checkpoint = await beginLiveReserveCheckpoint(db, {
        slotStartedAt: 1000, invocationId: "owner",
      });
      const start = { ...reserveSyncAttemptInput("batched"), checkpoint,
        checkpointProgress: { itemsDone: 0, itemsTotal: 1 }, deadlineMs: Date.now() + 30_000 };
      sqlite.exec(`CREATE TRIGGER reject_begin BEFORE INSERT ON reserve_sync_state
        BEGIN SELECT RAISE(ABORT, 'begin unavailable'); END`);
      await expect(beginReserveSyncAttempt(db, start)).rejects.toThrow("begin unavailable");
      expect(await loadLiveReserveCheckpoint(db, checkpoint)).toMatchObject({ currentDomainAttemptId: null });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_sync_state").get()).toEqual({ count: 0 });
      sqlite.exec("DROP TRIGGER reject_begin");
      for (const denied of [
        { ...checkpoint, invocationId: "late-owner" },
        { ...checkpoint, executionGeneration: checkpoint.executionGeneration + 1 },
      ]) {
        await expect(beginReserveSyncAttempt(db, { ...start, checkpoint: denied })).rejects.toThrow();
      }
      await expect(beginReserveSyncAttempt(db, { ...start, deadlineMs: Date.now() - 1 })).rejects.toThrow("deadline");
      expect(await loadLiveReserveCheckpoint(db, checkpoint)).toMatchObject({ currentDomainAttemptId: null });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_sync_state").get()).toEqual({ count: 0 });
    } finally { sqlite.close(); }
  });

  it("never exposes untracked pending state when the domain begin is a no-op after checkpoint CAS", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const checkpoint = await beginLiveReserveCheckpoint(db, { slotStartedAt: 1000, invocationId: "owner" });
      sqlite.exec(`CREATE TRIGGER ignore_begin BEFORE INSERT ON reserve_sync_state
        BEGIN SELECT RAISE(IGNORE); END`);
      await expect(beginReserveSyncAttempt(db, {
        ...reserveSyncAttemptInput("not-started"), checkpoint,
        checkpointProgress: { itemsDone: 0, itemsTotal: 1 },
      })).rejects.toThrow("Reserve attempt start lost checkpoint ownership or deadline");
      // As with the old crash between checkpoint and begin, the only possible
      // partial state is a harmless frontier reference, never an orphan pending.
      expect(await loadLiveReserveCheckpoint(db, checkpoint)).toMatchObject({ currentDomainAttemptId: "not-started" });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_sync_state").get()).toEqual({ count: 0 });
    } finally { sqlite.close(); }
  });

  it("keeps an ambiguously acknowledged begin exactly linked for crash recovery, without publishing success", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const checkpoint = await beginLiveReserveCheckpoint(db, {
        slotStartedAt: 1000, invocationId: "owner",
      });
      const batch = db.batch.bind(db);
      vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
        await batch(statements);
        throw new Error("ack lost after commit");
      });
      await expect(beginReserveSyncAttempt(db, {
        ...reserveSyncAttemptInput("ambiguous"), checkpoint,
        checkpointProgress: { itemsDone: 0, itemsTotal: 1 },
      })).rejects.toThrow("ack lost after commit");
      expect(await loadLiveReserveCheckpoint(db, checkpoint)).toMatchObject({ currentDomainAttemptId: "ambiguous" });
      expect(sqlite.prepare("SELECT pending_attempt_id, last_success_at FROM reserve_sync_state").get())
        .toEqual({ pending_attempt_id: "ambiguous", last_success_at: null });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_composition").get()).toEqual({ count: 0 });
    } finally { vi.restoreAllMocks(); sqlite.close(); }
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

    const result = await pruneLiveReserveHistory(db, 10_000, {
      retentionSec: 1_000,
      batchSize: 100,
      maxBatches: 10,
    });
    expect(result.compositionHistoryDeleted).toBe(650);
    expect(result.attemptHistoryDeleted).toBe(230);
    expect(result.truncated).toBe(false);
    expect(history.length).toBe(compositionCounts.length + attemptCounts.length);
    for (const entry of history) {
      expect(entry.binds[entry.binds.length - 1]).toBe(100);
    }
  });

  it("stops at the configured batch budget and reports truncation", async () => {
    const db = makeNoopD1({
      prepare: (sql: string) => ({
        bind: () => ({
          run: async () => ({
            success: true,
            meta: { changes: sql.includes("reserve_") ? 100 : 0 },
          }),
        }),
      }),
    });

    const result = await pruneLiveReserveHistory(db, 10_000, {
      retentionSec: 1_000,
      batchSize: 100,
      maxBatches: 2,
    });

    expect(result).toMatchObject({
      compositionHistoryDeleted: 200,
      attemptHistoryDeleted: 200,
      truncated: true,
    });
  });
});
