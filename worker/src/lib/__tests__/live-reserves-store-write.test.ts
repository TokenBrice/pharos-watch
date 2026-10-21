import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "../collections";
import {
  beginReserveSyncAttempt,
  cleanupStaleLiveReserveArtifacts,
  didReserveSyncAttemptBecomeAuthoritative,
  finalizeReserveSyncAttempt,
  pruneLiveReserveHistory,
} from "../live-reserves/store-write";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { finalizeReserveSuccess, reserveSyncAttemptInput, reserveSyncStateInput } from "./live-reserves-store.test-support";

describe("cleanupStaleLiveReserveArtifacts", () => {
  it("chunks stale artifact deletes under the D1 IN-clause bind limit", async () => {
    const staleIds = Array.from({ length: D1_SAFE_IN_CLAUSE_BIND_LIMIT + 11 }, (_, index) => `stale-${index}`);
    const staleBreakerKeys = staleIds.map((id) => `circuit:live-reserves:${id}`);
    const db = mockD1([
      {
        match: "SELECT stablecoin_id FROM reserve_sync_state",
        rows: staleIds.map((stablecoin_id) => ({ stablecoin_id })),
      },
      {
        match: "SELECT stablecoin_id FROM reserve_composition",
        rows: staleIds.map((stablecoin_id) => ({ stablecoin_id })),
      },
      {
        match: "SELECT key FROM cache WHERE key LIKE 'circuit:live-reserves:%'",
        rows: staleBreakerKeys.map((key) => ({ key })),
      },
      { match: "DELETE FROM reserve_sync_state", rows: [], runMeta: { changes: 1 } },
      { match: "DELETE FROM reserve_composition", rows: [], runMeta: { changes: 1 } },
      { match: "DELETE FROM cache WHERE key", rows: [], runMeta: { changes: 1 } },
    ]);

    const result = await cleanupStaleLiveReserveArtifacts(db, [], new Set());

    expect(result).toEqual({
      syncStateDeleted: 2,
      compositionDeleted: 2,
      breakerCacheDeleted: 2,
    });

    const deleteRows = db.getHistory().filter((entry) => entry.sql.includes("DELETE FROM"));
    expect(deleteRows).toHaveLength(6);
    expect(Math.max(...deleteRows.map((entry) => entry.binds.length))).toBeLessThanOrEqual(
      D1_SAFE_IN_CLAUSE_BIND_LIMIT,
    );
  });

  it("retains active asset state and breaker caches while deleting only stale identities", async () => {
    const db = mockD1([
      { match: "SELECT stablecoin_id FROM reserve_sync_state", rows: [{ stablecoin_id: "active" }, { stablecoin_id: "stale" }] },
      { match: "SELECT stablecoin_id FROM reserve_composition", rows: [{ stablecoin_id: "active" }, { stablecoin_id: "stale" }] },
      { match: "SELECT key FROM cache WHERE key LIKE", rows: [
        { key: "circuit:live-reserves:active" }, { key: "circuit:live-reserves:stale" },
      ] },
      { match: "DELETE FROM reserve_sync_state", rows: [], runMeta: { changes: 1 } },
      { match: "DELETE FROM reserve_composition", rows: [], runMeta: { changes: 1 } },
      { match: "DELETE FROM cache WHERE key", rows: [], runMeta: { changes: 1 } },
    ]);

    expect(await cleanupStaleLiveReserveArtifacts(db, ["active"], new Set(["live-reserves:active"])))
      .toEqual({ syncStateDeleted: 1, compositionDeleted: 1, breakerCacheDeleted: 1 });
    expect(db.getHistory().filter(({ sql }) => sql.includes("DELETE FROM")).map(({ binds }) => binds))
      .toEqual([["stale"], ["stale"], ["circuit:live-reserves:stale"]]);
  });
});

describe("pruneLiveReserveHistory limits", () => {
  it.each(["deadline", "batch-budget"] as const)(
    "preserves unprocessed history at the %s boundary and can resume it",
    async (limit) => {
      const { sqlite, db } = createLatestSchemaSqlite();
      try {
        sqlite.exec(`
          INSERT INTO reserve_composition_history
            (stablecoin_id, fetched_at, adapter_key, slices, attempt_id)
            VALUES ('usdo-openeden', 1000, 'adapter', '[]', 'old-1'),
                   ('usdo-openeden', 1001, 'adapter', '[]', 'old-2');
          INSERT INTO reserve_sync_attempt_history
            (stablecoin_id, attempted_at, adapter_key, breaker_key, status, attempt_id)
            VALUES ('usdo-openeden', 1000, 'adapter', 'adapter', 'ok', 'old-1'),
                   ('usdo-openeden', 1001, 'adapter', 'adapter', 'ok', 'old-2');
        `);
        const deleted = limit === "deadline" ? 0 : 1;
        expect(await pruneLiveReserveHistory(db, 10_000, {
          retentionSec: 1_000, batchSize: 1, maxBatches: 1,
          ...(limit === "deadline" ? { deadlineMs: Date.now() - 1 } : {}),
        })).toEqual({
          cutoff: 9_000, compositionHistoryDeleted: deleted,
          attemptHistoryDeleted: deleted, truncated: true,
        });
        expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_composition_history").get())
          .toEqual({ count: 2 - deleted });
        expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_sync_attempt_history").get())
          .toEqual({ count: 2 - deleted });

        expect(await pruneLiveReserveHistory(db, 10_000, {
          retentionSec: 1_000, batchSize: 1, maxBatches: 3,
        })).toEqual({
          cutoff: 9_000, compositionHistoryDeleted: 2 - deleted,
          attemptHistoryDeleted: 2 - deleted, truncated: false,
        });
        expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_composition_history").get())
          .toEqual({ count: 0 });
        expect(sqlite.prepare("SELECT COUNT(*) AS count FROM reserve_sync_attempt_history").get())
          .toEqual({ count: 0 });
      } finally {
        sqlite.close();
      }
    },
  );
});

describe("reserve attempt authoritative readback", () => {
  it("requires a matching published snapshot, not merely a pending or failed attempt", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      await beginReserveSyncAttempt(db, reserveSyncAttemptInput("failed-attempt"));
      expect(await didReserveSyncAttemptBecomeAuthoritative(db, "iusd-infinifi", "failed-attempt")).toBe(false);

      expect(await finalizeReserveSyncAttempt(db, reserveSyncStateInput("failed-attempt", {
        lastStatus: "error", lastError: "adapter unavailable",
      }))).toEqual({ finalized: true });
      expect(await didReserveSyncAttemptBecomeAuthoritative(db, "iusd-infinifi", "failed-attempt")).toBe(false);
      expect(sqlite.prepare("SELECT pending_attempt_id, last_status FROM reserve_sync_state").get())
        .toEqual({ pending_attempt_id: null, last_status: "error" });

      await beginReserveSyncAttempt(db, reserveSyncAttemptInput("successful-attempt"));
      expect(await finalizeReserveSuccess(db, "successful-attempt")).toEqual({ finalized: true });
      expect(await didReserveSyncAttemptBecomeAuthoritative(db, "iusd-infinifi", "successful-attempt")).toBe(true);
      expect(await didReserveSyncAttemptBecomeAuthoritative(db, "iusd-infinifi", "failed-attempt")).toBe(false);
      expect(await didReserveSyncAttemptBecomeAuthoritative(db, "usdo-openeden", "successful-attempt")).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});
