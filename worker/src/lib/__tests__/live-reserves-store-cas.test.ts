import { describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import {
  beginReserveSyncAttempt,
  didReserveSyncSuccessBecomeAuthoritative,
  finalizeReserveSyncAttempt,
  getReserveSyncState,
  pruneLiveReserveHistory,
} from "../live-reserves/store";
import { hasConsistentSnapshotState } from "../live-reserves/store-snapshot-state";
import { buildReserveSyncRecordDeferredStatement } from "../live-reserves/store-statements";
import {
  finalizeReserveSuccess,
  mockReserveD1 as mockD1,
  reserveSyncAttemptInput,
  reserveSyncStateInput,
} from "./live-reserves-store.test-support";

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

  it("treats a success finalization batch no-op as finalized when authoritative readback matches the attempt", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO reserve_composition (",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "UPDATE reserve_sync_state",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "JOIN reserve_sync_state",
        rows: [],
        first: { finalized: 1 },
      },
    ]);
    const attemptId = "attempt-readback-no-op";

    const result = await finalizeReserveSuccess(db, attemptId);

    expect(result.finalized).toBe(true);
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
