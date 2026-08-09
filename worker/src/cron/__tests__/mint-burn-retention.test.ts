import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  MINT_BURN_EVENT_RETENTION_SEC,
  MINT_BURN_HOURLY_RETENTION_SEC,
  pruneMintBurnRetention,
} from "../mint-burn/retention";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

const NOW_SEC = 1_800_000_000;
const HOUR_SEC = 3600;
const TAPE_CURSOR_KEY = "tape-projector:cursor:mint_burn.large_flow";

function setupDb(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = createLatestSchemaSqlite().sqlite;
  sqlite
    .prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
    .run(TAPE_CURSOR_KEY, String(NOW_SEC), NOW_SEC);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function hourFor(timestamp: number): number {
  return Math.floor(timestamp / HOUR_SEC) * HOUR_SEC;
}

function insertEvent(
  sqlite: DatabaseSync,
  input: {
    id: string;
    timestamp: number;
    amountUsd?: number | null;
    priceRepairStatus?: string | null;
    withHourly?: boolean;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO mint_burn_events
        (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
         tx_hash, block_number, timestamp, explorer_tx_url, price_repair_status)
       VALUES (?, 'usdc-circle', 'USDC', 'ethereum', 'mint', 1, ?, ?, 1, ?,
               'https://etherscan.io/tx/0x0', ?)`,
    )
    .run(
      input.id,
      input.amountUsd === undefined ? 1 : input.amountUsd,
      `0x${input.id}`,
      input.timestamp,
      input.priceRepairStatus ?? null,
    );
  if (input.withHourly !== false) {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO mint_burn_hourly
          (stablecoin_id, chain_id, hour_ts)
         VALUES ('usdc-circle', 'ethereum', ?)`,
      )
      .run(hourFor(input.timestamp));
  }
}

function eventIds(sqlite: DatabaseSync): string[] {
  return (sqlite.prepare("SELECT id FROM mint_burn_events ORDER BY id").all() as Array<{ id: string }>)
    .map((row) => row.id);
}

describe("mint/burn retention", () => {
  let openDb: DatabaseSync | null = null;

  afterEach(() => {
    openDb?.close();
    openDb = null;
  });

  it("honors cutoff boundaries and protects unpriced, unaggregated, and fresh event rows", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const eventCutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    const hourlyCutoff = NOW_SEC - MINT_BURN_HOURLY_RETENTION_SEC;
    const noHourlyTimestamp = eventCutoff - 2 * HOUR_SEC;

    insertEvent(sqlite, { id: "eligible-priced", timestamp: eventCutoff - 1 });
    insertEvent(sqlite, {
      id: "eligible-irreducible",
      timestamp: eventCutoff - 2,
      amountUsd: null,
      priceRepairStatus: "irreducible",
    });
    insertEvent(sqlite, {
      id: "protected-unpriced",
      timestamp: eventCutoff - 3,
      amountUsd: null,
    });
    insertEvent(sqlite, {
      id: "protected-pending-aggregate",
      timestamp: eventCutoff - 4,
      amountUsd: 123.45,
      priceRepairStatus: "pending_aggregate",
    });
    insertEvent(sqlite, {
      id: "protected-no-hourly",
      timestamp: noHourlyTimestamp,
      amountUsd: null,
      withHourly: false,
    });
    insertEvent(sqlite, { id: "boundary", timestamp: eventCutoff });
    insertEvent(sqlite, { id: "fresh", timestamp: eventCutoff + 1 });

    sqlite
      .prepare(
        `INSERT INTO mint_burn_hourly
          (stablecoin_id, chain_id, hour_ts)
         VALUES ('old-hourly', 'ethereum', ?), ('boundary-hourly', 'ethereum', ?)`,
      )
      .run(hourlyCutoff - HOUR_SEC, hourlyCutoff);

    const result = await pruneMintBurnRetention(db, NOW_SEC);

    expect(eventIds(sqlite)).toEqual([
      "boundary",
      "fresh",
      "protected-no-hourly",
      "protected-pending-aggregate",
      "protected-unpriced",
    ]);
    expect(result.eventRows).toMatchObject({
      cutoff: eventCutoff,
      deletedRows: 2,
      oldestRemainingAt: noHourlyTimestamp,
      oldestEligibleAt: null,
      cappedAtLimit: false,
      error: null,
    });
    expect(result.aggregationRepair).toMatchObject({
      cutoff: eventCutoff,
      repairedRows: 0,
      oldestRepairableAt: null,
      cappedAtLimit: false,
      error: null,
    });
    expect(result.hourlyRows).toMatchObject({
      cutoff: hourlyCutoff,
      deletedRows: 1,
      oldestRemainingAt: hourlyCutoff,
      oldestEligibleAt: null,
      cappedAtLimit: false,
      error: null,
    });
    expect(result.error).toBeNull();
    expect(MINT_BURN_EVENT_RETENTION_SEC).toBeGreaterThan(7 * 24 * HOUR_SEC);
  });

  it("never deletes an event ahead of the persisted tape watermark", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const cutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    sqlite
      .prepare("UPDATE cache SET value = ? WHERE key = ?")
      .run(String(cutoff - 2), TAPE_CURSOR_KEY);
    insertEvent(sqlite, { id: "projected", timestamp: cutoff - 3 });
    insertEvent(sqlite, { id: "not-projected", timestamp: cutoff - 1 });

    const result = await pruneMintBurnRetention(db, NOW_SEC);

    expect(eventIds(sqlite)).toEqual(["not-projected"]);
    expect(result.eventRows.deletedRows).toBe(1);
    expect(result.eventRows.oldestEligibleAt).toBeNull();
  });

  it("protects all event rows when the tape watermark is absent", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const cutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    sqlite.prepare("DELETE FROM cache WHERE key = ?").run(TAPE_CURSOR_KEY);
    insertEvent(sqlite, { id: "awaiting-projector-bootstrap", timestamp: cutoff - 1 });

    const result = await pruneMintBurnRetention(db, NOW_SEC);

    expect(eventIds(sqlite)).toEqual(["awaiting-projector-bootstrap"]);
    expect(result.eventRows.deletedRows).toBe(0);
    expect(result.eventRows.oldestEligibleAt).toBeNull();
  });

  it("continues in bounded batches and reports a remaining eligible backlog", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const cutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    for (let index = 0; index < 5; index += 1) {
      insertEvent(sqlite, {
        id: `eligible-${index}`,
        timestamp: cutoff - 100 + index,
      });
    }

    const first = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      eventBatchLimit: 2,
      eventRunLimit: 3,
      hourlyBatchLimit: 2,
      hourlyRunLimit: 2,
    });
    expect(first.eventRows.deletedRows).toBe(3);
    expect(first.eventRows.cappedAtLimit).toBe(true);
    expect(first.eventRows.oldestEligibleAt).not.toBeNull();
    expect(eventIds(sqlite)).toHaveLength(2);

    const second = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      eventBatchLimit: 2,
      eventRunLimit: 3,
      hourlyBatchLimit: 2,
      hourlyRunLimit: 2,
    });
    expect(second.eventRows.deletedRows).toBe(2);
    expect(second.eventRows.cappedAtLimit).toBe(false);
    expect(second.eventRows.oldestEligibleAt).toBeNull();
    expect(eventIds(sqlite)).toEqual([]);
  });

  it("keeps old hourly evidence until a capped raw-event backlog drains", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const oldTimestamp = NOW_SEC - MINT_BURN_HOURLY_RETENTION_SEC - HOUR_SEC;
    const oldHour = hourFor(oldTimestamp);
    for (let index = 0; index < 5; index += 1) {
      insertEvent(sqlite, {
        id: `old-eligible-${index}`,
        timestamp: oldTimestamp + index,
      });
    }

    const first = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      eventBatchLimit: 2,
      eventRunLimit: 3,
      hourlyBatchLimit: 2,
      hourlyRunLimit: 2,
    });

    expect(first.eventRows.deletedRows).toBe(3);
    expect(first.eventRows.cappedAtLimit).toBe(true);
    expect(first.hourlyRows.deletedRows).toBe(0);
    expect(first.hourlyRows.oldestEligibleAt).toBeNull();
    expect(eventIds(sqlite)).toHaveLength(2);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM mint_burn_hourly WHERE hour_ts = ?")
        .get(oldHour),
    ).toEqual({ count: 1 });

    const second = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      eventBatchLimit: 2,
      eventRunLimit: 3,
      hourlyBatchLimit: 2,
      hourlyRunLimit: 2,
    });

    expect(second.eventRows.deletedRows).toBe(2);
    expect(second.eventRows.cappedAtLimit).toBe(false);
    expect(second.hourlyRows.deletedRows).toBe(1);
    expect(second.hourlyRows.oldestEligibleAt).toBeNull();
    expect(eventIds(sqlite)).toEqual([]);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM mint_burn_hourly WHERE hour_ts = ?")
        .get(oldHour),
    ).toEqual({ count: 0 });
  });

  it("rebuilds missing terminal hourly evidence before pruning raw rows", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const oldTimestamp = NOW_SEC - MINT_BURN_HOURLY_RETENTION_SEC - HOUR_SEC;
    insertEvent(sqlite, {
      id: "stranded-terminal",
      timestamp: oldTimestamp,
      withHourly: false,
    });

    const result = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      repairCandidateEventLimit: 2,
      repairRunLimit: 1,
      eventBatchLimit: 2,
      eventRunLimit: 2,
      hourlyBatchLimit: 2,
      hourlyRunLimit: 2,
    });

    expect(result.aggregationRepair).toMatchObject({
      repairedRows: 1,
      oldestRepairableAt: null,
      cappedAtLimit: false,
      error: null,
    });
    expect(result.eventRows.deletedRows).toBe(1);
    expect(result.hourlyRows.deletedRows).toBe(1);
    expect(eventIds(sqlite)).toEqual([]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_hourly").get()).toEqual({
      count: 0,
    });
  });

  it("does not rebuild or prune a missing hour with unresolved price debt", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const oldTimestamp = NOW_SEC - MINT_BURN_HOURLY_RETENTION_SEC - HOUR_SEC;
    insertEvent(sqlite, {
      id: "terminal-sibling",
      timestamp: oldTimestamp,
      withHourly: false,
    });
    insertEvent(sqlite, {
      id: "unresolved-sibling",
      timestamp: oldTimestamp + 1,
      amountUsd: null,
      withHourly: false,
    });

    const result = await pruneMintBurnRetention(db, NOW_SEC);

    expect(result.aggregationRepair).toMatchObject({
      repairedRows: 0,
      oldestRepairableAt: null,
      cappedAtLimit: false,
      error: null,
    });
    expect(result.eventRows.deletedRows).toBe(0);
    expect(result.hourlyRows.deletedRows).toBe(0);
    expect(eventIds(sqlite)).toEqual(["terminal-sibling", "unresolved-sibling"]);
  });

  it("continues aggregation-evidence repair after its hourly limit is reached", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const oldTimestamp = NOW_SEC - MINT_BURN_HOURLY_RETENTION_SEC - 4 * HOUR_SEC;
    for (let index = 0; index < 3; index += 1) {
      insertEvent(sqlite, {
        id: `stranded-hour-${index}`,
        timestamp: oldTimestamp + index * HOUR_SEC,
        withHourly: false,
      });
    }

    const first = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      repairCandidateEventLimit: 3,
      repairRunLimit: 2,
      eventBatchLimit: 3,
      eventRunLimit: 3,
      hourlyBatchLimit: 3,
      hourlyRunLimit: 3,
    });

    expect(first.aggregationRepair.repairedRows).toBe(2);
    expect(first.aggregationRepair.cappedAtLimit).toBe(true);
    expect(first.aggregationRepair.oldestRepairableAt).not.toBeNull();
    expect(eventIds(sqlite)).toEqual(["stranded-hour-2"]);

    const second = await pruneMintBurnRetention(db, NOW_SEC, undefined, {
      repairCandidateEventLimit: 3,
      repairRunLimit: 2,
      eventBatchLimit: 3,
      eventRunLimit: 3,
      hourlyBatchLimit: 3,
      hourlyRunLimit: 3,
    });

    expect(second.aggregationRepair.repairedRows).toBe(1);
    expect(second.aggregationRepair.cappedAtLimit).toBe(false);
    expect(second.aggregationRepair.oldestRepairableAt).toBeNull();
    expect(eventIds(sqlite)).toEqual([]);
  });

  it("reports a family cleanup error without preventing the other family", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const failingDb = {
      ...db,
      prepare(sql: string) {
        if (!sql.includes("pharos:mint-burn:event-retention-delete")) {
          return db.prepare(sql);
        }
        const statement = {
          bind: () => statement as unknown as D1PreparedStatement,
          run: async () => {
            throw new Error("event retention unavailable");
          },
        };
        return statement as unknown as D1PreparedStatement;
      },
    } as D1Database;

    const result = await pruneMintBurnRetention(failingDb, NOW_SEC);

    expect(result.eventRows.error).toBe("event retention unavailable");
    expect(result.hourlyRows.error).toBeNull();
    expect(result.error).toContain("eventRows: event retention unavailable");
  });

  it("reports aggregation repair failure without preventing bounded deletion", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const cutoff = NOW_SEC - MINT_BURN_EVENT_RETENTION_SEC;
    insertEvent(sqlite, { id: "eligible-after-repair-error", timestamp: cutoff - 1 });
    const failingDb = {
      ...db,
      prepare(sql: string) {
        if (!sql.includes("pharos:mint-burn:aggregation-evidence-repair")) {
          return db.prepare(sql);
        }
        const statement = {
          bind: () => statement as unknown as D1PreparedStatement,
          run: async () => {
            throw new Error("aggregation repair unavailable");
          },
        };
        return statement as unknown as D1PreparedStatement;
      },
    } as D1Database;

    const result = await pruneMintBurnRetention(failingDb, NOW_SEC);

    expect(result.aggregationRepair.error).toBe("aggregation repair unavailable");
    expect(result.eventRows.deletedRows).toBe(1);
    expect(result.eventRows.error).toBeNull();
    expect(result.hourlyRows.error).toBeNull();
    expect(result.error).toContain("aggregationRepair: aggregation repair unavailable");
  });

  it("throws before D1 work when already aborted", async () => {
    const { sqlite, db } = setupDb();
    openDb = sqlite;
    const controller = new AbortController();
    controller.abort(new Error("mint/burn retention aborted"));

    await expect(
      pruneMintBurnRetention(db, NOW_SEC, controller.signal),
    ).rejects.toThrow("mint/burn retention aborted");
  });
});
