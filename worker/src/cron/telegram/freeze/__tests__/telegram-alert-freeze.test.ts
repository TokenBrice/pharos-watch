import { describe, expect, it, vi } from "vitest";
import { loadFreshFreezeAlerts } from "../telegram-alert-freeze";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { makeNoopD1 } from "../../../../test-helpers/noop-d1";

function db(rows: unknown[], latestRun: number | null): D1Database {
  return makeNoopD1({
    prepare(sql: string) {
      return {
        bind() { return this; },
        first: async () => sql.includes("cron_runs")
          ? (latestRun == null ? null : { started_at: latestRun })
          : sql.includes("MAX(id)")
            ? ((rows[rows.length - 1] as { id?: number } | undefined)?.id == null ? null : { id: (rows[rows.length - 1] as { id: number }).id })
            : null,
        all: async () => ({ results: rows }),
      };
    },
  });
}
function createPoisonFreezeTape() {
  const sqlite = createLatestSchemaSqlite().sqlite;
  const now = 2_000_000_000;
  sqlite.prepare(
    "INSERT INTO cron_runs (job, started_at, duration_ms, status) VALUES ('project-tape', ?, 1, 'ok')",
  ).run(now - 5);
  sqlite.prepare(
    `INSERT INTO tape_events (
       event_id, type, severity, ts, title, summary, payload_json,
       source_table, source_row_id, transition, created_at
     ) VALUES ('freeze-poison', 'freeze.blocked', 'warning', ?, 'x', 'x', ?,
       'blacklist_events', 'blacklist-poison', 'opened', ?)`,
  ).run(
    now * 1000,
    JSON.stringify({
      stablecoin: "NOT_TRACKED",
      chainName: "Ethereum",
      sourceEventId: "blacklist-poison",
    }),
    now,
  );
  const row = sqlite.prepare("SELECT id FROM tape_events WHERE event_id = 'freeze-poison'").get() as { id: number };
  return { sqlite, database: createSqliteD1(sqlite), now, rowId: row.id };
}


describe("freeze Telegram source gate", () => {
  it("fails closed when the tape projector is stale", async () => {
    const result = await loadFreshFreezeAlerts(db([], 100), 5, 4_000);
    expect(result).toEqual({ state: "stale", alerts: [], cursor: 5 });
  });

  it("cold-seeds before delivery and retains immutable tape/blacklist identities", async () => {
    const rows = [{
      id: 42,
      event_id: "1000-freeze.blocked-deadbeef",
      type: "freeze.blocked",
      ts: 3_990 * 1000,
      payload_json: JSON.stringify({
        stablecoin: "USDC",
        chainName: "Ethereum",
        amountUsdAtEvent: 1_000_000,
        sourceEventId: "blacklist-row-42",
      }),
    }];
    const source = db(rows, 3_990);
    const seeded = await loadFreshFreezeAlerts(source, null, 4_000);
    expect(seeded).toEqual({ state: "unseeded", alerts: [], cursor: 42 });

    const observed = await loadFreshFreezeAlerts(source, 41, 4_000);
    expect(observed.state).toBe("ok");
    expect(observed.cursor).toBe(42);
    expect(observed.alerts[0]).toMatchObject({
      stablecoinId: "usdc-circle",
      eventType: "blacklist",
      tapeEventId: "1000-freeze.blocked-deadbeef",
      sourceEventId: "blacklist-row-42",
    });
  });

  it("cold-seeds beyond the page limit without leaking historical tape rows", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({ id: index + 1 }));
    const seeded = await loadFreshFreezeAlerts(db(rows, 3_990), null, 4_000);
    expect(seeded).toEqual({ state: "unseeded", alerts: [], cursor: 501 });
  });
  it("holds below an unparseable row so the next run retries that row", async () => {
    const { sqlite, database, now, rowId } = createPoisonFreezeTape();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await loadFreshFreezeAlerts(database, rowId - 1, now);
      const retried = await loadFreshFreezeAlerts(database, first.cursor, now + 1);

      expect(first).toMatchObject({ cursor: rowId - 1, droppedUnparsed: 1 });
      expect(retried).toMatchObject({ cursor: rowId - 1, droppedUnparsed: 1 });
      expect(JSON.parse(String(sqlite.prepare(
        "SELECT value FROM cache WHERE key = 'alert:freeze-tape-row-hold'",
      ).get()?.value))).toEqual({ rowId, attempts: 2 });
    } finally {
      warn.mockRestore();
      sqlite.close();
    }
  });

  it("dead-letters a poison row and advances after the bounded retry limit", async () => {
    const { sqlite, database, now, rowId } = createPoisonFreezeTape();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = await loadFreshFreezeAlerts(database, rowId - 1, now);
      const second = await loadFreshFreezeAlerts(database, first.cursor, now + 1);
      const escalated = await loadFreshFreezeAlerts(database, second.cursor, now + 2);

      expect(escalated).toMatchObject({
        cursor: rowId,
        droppedUnparsed: 1,
        deadLetteredUnparsed: 1,
      });
      expect(sqlite.prepare(
        "SELECT value FROM cache WHERE key = 'alert:freeze-tape-row-hold'",
      ).get()).toBeUndefined();
      expect(error).toHaveBeenCalledOnce();
      expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
        level: "error",
        action: "freeze-row-dead-lettered",
        failureKind: "poison-row",
        reason: "unknown-coin",
        attempts: 3,
      });
    } finally {
      error.mockRestore();
      warn.mockRestore();
      sqlite.close();
    }
  });

});
