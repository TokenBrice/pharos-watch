import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "../../../test-helpers/latest-schema-sqlite";
import { persistDepegCommands } from "../persistence";
import type { DepegPersistenceCommand } from "../types";

function insertOpenEvent(sqlite: DatabaseSync, stablecoinId: string, startedAt: number): number {
  sqlite.prepare(
    `INSERT INTO depeg_events (
       stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
       started_at, start_price, peak_price, peg_reference, source
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(stablecoinId, stablecoinId, "peggedUSD", "below", -200, startedAt, 0.98, 0.98, 1, "live");
  const row = sqlite.prepare("SELECT id FROM depeg_events WHERE stablecoin_id = ?").get(stablecoinId) as { id: number };
  return row.id;
}

function pendingCommand(stablecoinId: string, seenAt: number): DepegPersistenceCommand {
  return {
    type: "upsert-pending",
    payload: {
      stablecoinId,
      symbol: stablecoinId,
      pegType: "peggedUSD",
      direction: "below",
      bps: -200,
      seenAt,
      price: 0.98,
      pegReference: 1,
      reason: "large-cap",
    },
  };
}

function closeCommand(id: number, endedAt: number): DepegPersistenceCommand {
  return {
    type: "close-event",
    id,
    endedAt,
    recoveryPrice: 1,
    closeReason: "recovered-primary",
  };
}

describe("persistDepegCommands", () => {
  it("commits every asset transition when the total statement count crosses 100", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const commands: DepegPersistenceCommand[] = [];

    for (let index = 0; index < 51; index++) {
      const stablecoinId = `atomic-coin-${index}`;
      const eventId = insertOpenEvent(sqlite, stablecoinId, index + 1);
      commands.push(closeCommand(eventId, 10_000));
      commands.push(pendingCommand(stablecoinId, 10_000));
    }

    await expect(persistDepegCommands(db, commands)).resolves.toBe(102);

    const incompleteEvents = sqlite
      .prepare("SELECT COUNT(*) AS count FROM depeg_events WHERE ended_at IS NULL")
      .get() as { count: number };
    const pendingCount = sqlite
      .prepare("SELECT COUNT(*) AS count FROM depeg_pending")
      .get() as { count: number };
    expect(incompleteEvents.count).toBe(0);
    expect(pendingCount.count).toBe(51);
    sqlite.close();
  });

  it("does not partially apply a later failing asset group", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    sqlite.exec(`
      CREATE TRIGGER fail_atomic_depeg_pending
      BEFORE INSERT ON depeg_pending
      WHEN NEW.stablecoin_id = 'atomic-fail'
      BEGIN
        SELECT RAISE(ABORT, 'injected pending failure');
      END
    `);

    const commands: DepegPersistenceCommand[] = [];
    for (const [index, stablecoinId] of ["atomic-ok-1", "atomic-ok-2", "atomic-fail"].entries()) {
      const eventId = insertOpenEvent(sqlite, stablecoinId, index + 1);
      commands.push(closeCommand(eventId, 10_000));
      commands.push(pendingCommand(stablecoinId, 10_000));
    }

    await expect(persistDepegCommands(db, commands)).rejects.toThrow("injected pending failure");

    const eventRows = sqlite
      .prepare("SELECT stablecoin_id, ended_at FROM depeg_events ORDER BY stablecoin_id")
      .all() as Array<{ stablecoin_id: string; ended_at: number | null }>;
    expect(eventRows).toEqual([
      { stablecoin_id: "atomic-fail", ended_at: null },
      { stablecoin_id: "atomic-ok-1", ended_at: 10_000 },
      { stablecoin_id: "atomic-ok-2", ended_at: 10_000 },
    ]);

    const pendingRows = sqlite
      .prepare("SELECT stablecoin_id FROM depeg_pending ORDER BY stablecoin_id")
      .all() as Array<{ stablecoin_id: string }>;
    expect(pendingRows).toEqual([
      { stablecoin_id: "atomic-ok-1" },
      { stablecoin_id: "atomic-ok-2" },
    ]);
    sqlite.close();
  });
});
