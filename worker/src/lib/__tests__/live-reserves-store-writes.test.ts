import { describe, expect, it, vi } from "vitest";
import {
  finalizeReserveSuccess,
  mockReserveD1 as mockD1,
  reserveSyncAttemptInput,
  reserveSyncStateInput,
} from "./live-reserves-store.test-support";
import {
  beginReserveSyncAttempt,
  didReserveSyncSuccessBecomeAuthoritative,
  finalizeReserveSyncAttempt,
  getReserveSyncState,
  pruneLiveReserveHistory,
} from "../live-reserves/store";
import { hasConsistentSnapshotState } from "../live-reserves/store-snapshot-state";
import { buildReserveSyncRecordDeferredStatement } from "../live-reserves/store-statements";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { createD1CostTracker } from "../d1-cost";
import { beginLiveReserveCheckpoint, loadLiveReserveCheckpoint } from "../../cron/reserve-adapters/reserve-checkpoint";

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

describe("live-reserves-store", () => {

  it("fences late attempts by fetched timestamp and stored attempt identity", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      const db = createSqliteD1(sqlite);
      const readComposition = () =>
        sqlite
          .prepare("SELECT fetched_at, attempt_id FROM reserve_composition WHERE stablecoin_id = ?")
          .get("iusd-infinifi");
      const finalize = async (attemptId: string, fetchedAt: number) => {
        await beginReserveSyncAttempt(db, reserveSyncAttemptInput(attemptId));
        return finalizeReserveSuccess(db, attemptId, {
          composition: { fetchedAt },
          syncState: { lastSuccessAt: fetchedAt, lastSuccessAttemptId: attemptId },
        });
      };

      await expect(finalize("attempt-authoritative", 1_000)).resolves.toEqual({ finalized: true });
      for (const [attemptId, fetchedAt] of [["attempt-older", 900], ["attempt-equal", 1_000]] as const) {
        await expect(finalize(attemptId, fetchedAt)).resolves.toEqual({ finalized: false });
        expect(readComposition()).toEqual({ fetched_at: 1_000, attempt_id: "attempt-authoritative" });
      }
      await expect(finalize("attempt-newer", 1_100)).resolves.toEqual({ finalized: true });
      expect(readComposition()).toEqual({ fetched_at: 1_100, attempt_id: "attempt-newer" });
      sqlite.prepare("UPDATE reserve_composition SET attempt_id = NULL WHERE stablecoin_id = ?").run("iusd-infinifi");
      await expect(finalize("attempt-equal-legacy", 1_100)).resolves.toEqual({ finalized: true });
      expect(readComposition()).toEqual({ fetched_at: 1_100, attempt_id: "attempt-equal-legacy" });
    } finally {
      sqlite.close();
    }
  });


  it("accepts an ambiguous committed failure write only after readback", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      await beginReserveSyncAttempt(db, reserveSyncAttemptInput("attempt-ambiguous-failure"));
      const batch = db.batch.bind(db);
      vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
        await batch(statements);
        throw new Error("Network connection lost");
      });

      await expect(finalizeReserveSyncAttempt(
        db,
        reserveSyncStateInput("attempt-ambiguous-failure", {
          lastStatus: "error",
          lastError: "provider failed",
        }),
      )).resolves.toEqual({ finalized: true });

      expect(sqlite.prepare(
        "SELECT status, COUNT(*) AS n FROM reserve_sync_attempt_history WHERE attempt_id = ?",
      ).all("attempt-ambiguous-failure")).toEqual([{ status: "error", n: 1 }]);
      expect(sqlite.prepare(
        "SELECT pending_attempt_id, last_status FROM reserve_sync_state WHERE stablecoin_id = ?",
      ).get("iusd-infinifi")).toEqual({ pending_attempt_id: null, last_status: "error" });
    } finally {
      sqlite.close();
    }
  });

  it("publishes neither canonical row past the deadline and both rows inside it", async () => {
    const { createSqliteD1 } = await import("@shared/test-utils/sqlite-d1");

    const expiredSqlite = createLatestSchemaSqlite().sqlite;
    try {
      const expiredDb = createSqliteD1(expiredSqlite);
      const expiredAttemptId = "attempt-expired";
      await beginReserveSyncAttempt(expiredDb, reserveSyncAttemptInput(expiredAttemptId));

      const expiredResult = await finalizeReserveSuccess(expiredDb, expiredAttemptId, {
        finalizeDeadlineMs: Date.now() - 60_000,
      });

      expect(expiredResult).toEqual({ finalized: false });
      expect(
        expiredSqlite.prepare("SELECT attempt_id FROM reserve_composition WHERE stablecoin_id = ?")
          .get("iusd-infinifi"),
      ).toBeUndefined();
      expect(
        expiredSqlite.prepare(
          `SELECT last_success_at, last_success_attempt_id, last_attempt_id, pending_attempt_id
             FROM reserve_sync_state
            WHERE stablecoin_id = ?`,
        ).get("iusd-infinifi"),
      ).toEqual({
        last_success_at: null,
        last_success_attempt_id: null,
        last_attempt_id: expiredAttemptId,
        pending_attempt_id: expiredAttemptId,
      });
    } finally {
      expiredSqlite.close();
    }

    const timelySqlite = createLatestSchemaSqlite().sqlite;
    try {
      const timelyDb = createSqliteD1(timelySqlite);
      const timelyAttemptId = "attempt-timely";
      await beginReserveSyncAttempt(timelyDb, reserveSyncAttemptInput(timelyAttemptId));

      const timelyResult = await finalizeReserveSuccess(timelyDb, timelyAttemptId, {
        finalizeDeadlineMs: Date.now() + 60_000,
      });

      expect(timelyResult).toEqual({ finalized: true });
      expect(
        timelySqlite.prepare(
          `SELECT c.fetched_at, c.attempt_id,
                  s.last_success_at, s.last_success_attempt_id,
                  s.last_attempt_id, s.pending_attempt_id
             FROM reserve_composition c
             JOIN reserve_sync_state s ON s.stablecoin_id = c.stablecoin_id
            WHERE c.stablecoin_id = ?`,
        ).get("iusd-infinifi"),
      ).toEqual({
        fetched_at: 1_000,
        attempt_id: timelyAttemptId,
        last_success_at: 1_000,
        last_success_attempt_id: timelyAttemptId,
        last_attempt_id: timelyAttemptId,
        pending_attempt_id: null,
      });
    } finally {
      timelySqlite.close();
    }
  });

  it("keeps composition and its success linkage consistent when the deadline is crossed mid-batch", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    let sqlNowMs = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => sqlNowMs);
    sqlite.function("julianday", (_when: unknown) => sqlNowMs / 86_400_000 + 2_440_587.5);
    sqlite.function("advance_reserve_clock", () => {
      sqlNowMs += 60_000;
      return 0;
    });
    try {
      await beginReserveSyncAttempt(db, reserveSyncAttemptInput("attempt-before"));
      await expect(finalizeReserveSuccess(db, "attempt-before", {
        composition: { fetchedAt: 1_000 },
        syncState: { lastAttemptedAt: 1_000, lastSuccessAt: 1_000, lastSuccessAttemptId: "attempt-before" },
        finalizeDeadlineMs: sqlNowMs + 30_000,
      })).resolves.toEqual({ finalized: true });

      await beginReserveSyncAttempt(db, reserveSyncAttemptInput("attempt-late"));
      // The write costs enough wall-clock time to cross the finalize deadline
      // while the success batch is in flight.
      sqlite.exec(`CREATE TRIGGER advance_reserve_clock
        AFTER UPDATE ON reserve_composition
        BEGIN
          SELECT advance_reserve_clock();
        END`);

      const result = await finalizeReserveSuccess(db, "attempt-late", {
        composition: { fetchedAt: 2_000 },
        syncState: { lastAttemptedAt: 2_000, lastSuccessAt: 2_000, lastSuccessAttemptId: "attempt-late" },
        finalizeDeadlineMs: sqlNowMs + 30_000,
      });
      sqlite.exec("DROP TRIGGER advance_reserve_clock");

      const composition = sqlite
        .prepare("SELECT fetched_at, attempt_id FROM reserve_composition WHERE stablecoin_id = ?")
        .get("iusd-infinifi") as { fetched_at: number; attempt_id: string | null };
      const syncState = await getReserveSyncState(db, "iusd-infinifi");
      // Both success statements share one clock decision: composition can never
      // commit while its success linkage is gated off.
      expect(composition.attempt_id).toBe(syncState?.lastSuccessAttemptId ?? null);
      expect(composition.fetched_at).toBe(syncState?.lastSuccessAt ?? null);
      expect(hasConsistentSnapshotState(syncState, {
        fetchedAt: composition.fetched_at,
        attemptId: composition.attempt_id,
      })).toBe(true);
      if (!result.finalized) {
        expect(composition).toMatchObject({ fetched_at: 1_000, attempt_id: "attempt-before" });
      }
    } finally {
      vi.restoreAllMocks();
      sqlite.close();
    }
  });

  it("treats an ambiguous success finalization batch error as finalized when authoritative readback matches the attempt", async () => {
    const db = mockD1([
      {
        match: "UPDATE reserve_sync_state",
        rows: [],
        throwError: new Error("D1_ERROR: exceeded maximum duration"),
      },
      {
        match: "JOIN reserve_sync_state",
        rows: [],
        first: { finalized: 1 },
      },
    ]);
    const attemptId = "attempt-readback-error";

    const result = await finalizeReserveSuccess(db, attemptId);

    expect(result.finalized).toBe(true);
  });

  it("clears non-authoritative attempt fencing but guards an existing canonical success during deferral", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const defer = () => buildReserveSyncRecordDeferredStatement(db, {
        stablecoinId: "iusd-infinifi", adapterKey: "infinifi",
        breakerKey: "live-reserves:infinifi", attemptedAt: 2_000,
        reason: "run-budget-exhausted",
      }).run();
      await beginReserveSyncAttempt(db, reserveSyncAttemptInput("pending"));
      await defer();
      expect(sqlite.prepare("SELECT last_attempt_id, pending_attempt_id FROM reserve_sync_state").get())
        .toEqual({ last_attempt_id: null, pending_attempt_id: null });
      await beginReserveSyncAttempt(db, reserveSyncAttemptInput("canonical"));
      await expect(finalizeReserveSuccess(db, "canonical")).resolves.toEqual({ finalized: true });
      const before = sqlite.prepare("SELECT * FROM reserve_sync_state").get();
      const composition = sqlite.prepare("SELECT * FROM reserve_composition").get();
      await defer();
      expect(sqlite.prepare("SELECT * FROM reserve_sync_state").get()).toEqual(before);
      expect(sqlite.prepare("SELECT * FROM reserve_composition").get()).toEqual(composition);
    } finally {
      sqlite.close();
    }
  });

  it("rolls authority and both histories back when either history insert fails", async () => {
    for (const table of ["reserve_composition_history", "reserve_sync_attempt_history"]) {
      const { sqlite, db } = createLatestSchemaSqlite();
      try {
        await beginReserveSyncAttempt(db, reserveSyncAttemptInput("history-failure"));
        sqlite.exec(`CREATE TRIGGER reject_history BEFORE INSERT ON ${table}
          BEGIN SELECT RAISE(ABORT, 'history unavailable'); END`);
        await expect(finalizeReserveSuccess(db, "history-failure")).rejects.toThrow("history unavailable");
        expect(sqlite.prepare("SELECT * FROM reserve_composition").all()).toEqual([]);
        expect(sqlite.prepare("SELECT * FROM reserve_composition_history").all()).toEqual([]);
        expect(sqlite.prepare("SELECT * FROM reserve_sync_attempt_history").all()).toEqual([]);
        expect(sqlite.prepare("SELECT pending_attempt_id, last_success_at FROM reserve_sync_state").get())
          .toEqual({ pending_attempt_id: "history-failure", last_success_at: null });
      } finally {
        sqlite.close();
      }
    }
  });

  it("requires the complete authority invariant for ambiguous-write readback", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      await beginReserveSyncAttempt(db, reserveSyncAttemptInput("authoritative"));
      await finalizeReserveSuccess(db, "authoritative");
      const readback = () => didReserveSyncSuccessBecomeAuthoritative(db, "iusd-infinifi", 1000, "authoritative");
      expect(await readback()).toBe(true);
      for (const mutation of [
        "UPDATE reserve_sync_state SET last_success_at = 999",
        "UPDATE reserve_sync_state SET last_attempt_id = 'other'",
        "UPDATE reserve_sync_state SET last_success_attempt_id = 'other'",
        "UPDATE reserve_sync_state SET pending_attempt_id = 'other'",
        "UPDATE reserve_composition SET attempt_id = 'other'",
        "UPDATE reserve_composition SET fetched_at = 999",
      ]) {
        sqlite.exec("SAVEPOINT inconsistent");
        sqlite.exec(mutation);
        expect(await readback()).toBe(false);
        sqlite.exec("ROLLBACK TO inconsistent; RELEASE inconsistent");
      }
    } finally {
      sqlite.close();
    }
  });

  it("preserves history rows referenced by the current attempt closure past the age cutoff", async () => {
    const { createSqliteD1 } = await import("@shared/test-utils/sqlite-d1");
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
            // Suspended feed: current composition attempt is far older than the cutoff.
      sqlite.exec(`
        INSERT INTO reserve_composition (stablecoin_id, slices, fetched_at, source, attempt_id)
          VALUES ('usdo-openeden', '[]', 1000, 'adapter', 'attempt-old-current');
        INSERT INTO reserve_sync_state
          (stablecoin_id, adapter_key, breaker_key, last_status, last_attempt_id, pending_attempt_id)
          VALUES ('usdo-openeden', 'adapter', 'adapter', 'ok', 'attempt-old-current', NULL);
        INSERT INTO reserve_composition_history
          (stablecoin_id, fetched_at, adapter_key, slices, attempt_id)
          VALUES
            ('usdo-openeden', 1000, 'adapter', '[]', 'attempt-old-current'),
            ('usdo-openeden', 900, 'adapter', '[]', 'attempt-old-unreferenced');
        INSERT INTO reserve_sync_attempt_history
          (stablecoin_id, attempted_at, adapter_key, breaker_key, status, attempt_id)
          VALUES
            ('usdo-openeden', 1000, 'adapter', 'adapter', 'ok', 'attempt-old-current'),
            ('usdo-openeden', 900, 'adapter', 'adapter', 'ok', 'attempt-old-unreferenced'),
            ('usdo-openeden', 9500, 'adapter', 'adapter', 'ok', 'attempt-recent');
      `);

      const result = await pruneLiveReserveHistory(createSqliteD1(sqlite), 10_000, {
        retentionSec: 1_000,
      });

      expect(result.compositionHistoryDeleted).toBe(1);
      expect(result.attemptHistoryDeleted).toBe(1);
      const compositionLeft = sqlite
        .prepare("SELECT attempt_id FROM reserve_composition_history ORDER BY attempt_id")
        .all() as Array<{ attempt_id: string }>;
      expect(compositionLeft.map((row) => row.attempt_id)).toEqual(["attempt-old-current"]);
      const attemptsLeft = sqlite
        .prepare("SELECT attempt_id FROM reserve_sync_attempt_history ORDER BY attempt_id")
        .all() as Array<{ attempt_id: string }>;
      expect(attemptsLeft.map((row) => row.attempt_id)).toEqual(["attempt-old-current", "attempt-recent"]);
    } finally {
      sqlite.close();
    }
  });
});
