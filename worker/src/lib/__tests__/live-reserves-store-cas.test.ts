import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
  beginReserveSyncAttempt,
  pruneLiveReserveHistory,
} from "../live-reserves-store";
import { buildReserveSyncRecordDeferredStatement } from "../live-reserves-store-statements";
import {
  finalizeReserveSuccess,
  mockReserveD1 as mockD1,
  reserveSyncAttemptInput,
} from "./live-reserves-store.test-support";

describe("live-reserves-store", () => {
  it("fences the composition upsert so a late attempt cannot overwrite a newer row", async () => {
    const db = mockD1();
    const attemptId = "attempt-late";

    await finalizeReserveSuccess(db, attemptId);

    const upsert = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO reserve_composition ("));
    expect(upsert).toBeDefined();
    // Fence must reject strictly older fetchedAt, and same fetchedAt only when the stored row has no attempt_id.
    expect(upsert!.sql).toMatch(/reserve_composition\.fetched_at\s*<\s*excluded\.fetched_at/);
    expect(upsert!.sql).toMatch(/reserve_composition\.attempt_id\s+IS\s+NULL/);
  });

  it("returns finalized=false and writes no history rows when the composition upsert no-ops", async () => {
    const db = mockD1([
      {
        match: "INSERT INTO reserve_composition (",
        rows: [],
        runMeta: { changes: 0 },
      },
    ]);
    const attemptId = "attempt-no-op";

    const result = await finalizeReserveSuccess(db, attemptId);

    expect(result.finalized).toBe(false);
    expect(result.historyRecorded).toBe(false);
    const history = db.getHistory().map((entry) => entry.sql);
    expect(history.some((sql) => sql.includes("INSERT OR IGNORE INTO reserve_composition_history"))).toBe(false);
    expect(history.some((sql) => sql.includes("INSERT OR IGNORE INTO reserve_sync_attempt_history"))).toBe(false);
    expect(history.some((sql) => sql.includes("JOIN reserve_sync_state"))).toBe(true);
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
    expect(result.historyRecorded).toBe(true);
    const history = db.getHistory();
    const readback = history.find((entry) => entry.sql.includes("JOIN reserve_sync_state"));
    expect(readback?.binds).toEqual(["iusd-infinifi", 1_000, attemptId]);
    expect(history.some((entry) => entry.sql.includes("INSERT OR IGNORE INTO reserve_composition_history"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("INSERT OR IGNORE INTO reserve_sync_attempt_history"))).toBe(true);
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
    expect(result.historyRecorded).toBe(true);
    const history = db.getHistory().map((entry) => entry.sql);
    expect(history.some((sql) => sql.includes("JOIN reserve_sync_state"))).toBe(true);
    expect(history.some((sql) => sql.includes("INSERT OR IGNORE INTO reserve_composition_history"))).toBe(true);
    expect(history.some((sql) => sql.includes("INSERT OR IGNORE INTO reserve_sync_attempt_history"))).toBe(true);
  });

  it("clears non-authoritative attempt fencing but guards an existing canonical success during deferral", async () => {
    const db = mockD1();

    await buildReserveSyncRecordDeferredStatement(db, {
      stablecoinId: "iusd-infinifi",
      adapterKey: "infinifi",
      breakerKey: "live-reserves:infinifi",
      attemptedAt: 1_700_000_000,
      reason: "run-budget-exhausted",
    }).run();

    const statement = db.getHistory().find((entry) => entry.sql.includes("INSERT INTO reserve_sync_state"));
    expect(statement).toBeDefined();
    expect(statement!.sql).toContain("last_attempt_id = NULL");
    expect(statement!.sql).toContain("pending_attempt_id = NULL");
    expect(statement!.sql).toContain("WHERE NOT EXISTS");
    expect(statement!.sql).toContain("reserve_sync_state.last_attempt_id = c.attempt_id");
    expect(statement!.sql).toContain("reserve_sync_state.last_success_attempt_id = c.attempt_id");
  });

  it("keeps authoritative success when non-authoritative history writes fail", async () => {
    const db = mockD1([
      {
        match: "INSERT OR IGNORE INTO reserve_composition_history",
        rows: [],
        throwError: new Error("history unavailable"),
      },
    ]);
    const attemptId = "attempt-history-failure";

    await beginReserveSyncAttempt(db, reserveSyncAttemptInput(attemptId));

    const result = await finalizeReserveSuccess(db, attemptId);

    expect(result.finalized).toBe(true);
    expect(result.historyRecorded).toBe(false);
    expect(result.historyError).toContain("history unavailable");
  });

  it("preserves history rows referenced by the current attempt closure past the age cutoff", async () => {
    const { createSqliteD1 } = await import("../../test-helpers/sqlite-d1");
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

      const result = await pruneLiveReserveHistory(createSqliteD1(sqlite), 10_000, 1_000);

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
