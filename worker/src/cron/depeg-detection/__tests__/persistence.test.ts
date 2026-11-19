import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { persistDepegCommands } from "../persistence";
import type { DepegPersistenceCommand } from "../types";
import { sealPredictionFixture, withSqliteD1 } from "../../../lib/__tests__/depeg-resolver-ddrv2-store.test-support";

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
  it("persists both USD trade clocks independently of the paired recovery clocks and clears them on exit", async () => withSqliteD1(async (db) => {
    const id = insertOpenEvent(db.sqlite, "test-recovery", 100);
    const clocks = () => db.sqlite.prepare(`SELECT recovery_usd_first_seen_at AS firstUsd, recovery_usd_observed_at AS lastUsd,
      recovery_first_seen_at AS firstPair, recovery_last_seen_at AS lastPair FROM depeg_events WHERE id = ?`).get(id);
    const begin: DepegPersistenceCommand = { type: "begin-recovery", id, source: "native", firstSeenAt: 200, lastSeenAt: 200, usdObservedAt: 250 };
    await persistDepegCommands(db, [begin, { type: "continue-recovery", id, lastSeenAt: 260, usdObservedAt: 280 }]);
    expect(clocks()).toEqual({ firstUsd: 250, lastUsd: 280, firstPair: 200, lastPair: 260 });
    await persistDepegCommands(db, [{ type: "begin-recovery", id, source: "native", firstSeenAt: 301, lastSeenAt: 301 }]);
    expect(clocks()).toEqual({ firstUsd: null, lastUsd: null, firstPair: 301, lastPair: 301 });
    for (const terminal of [{ type: "clear-recovery" as const, id }, closeCommand(id, 400)]) {
      await persistDepegCommands(db, [begin, terminal]);
      expect(clocks()).toEqual({ firstUsd: null, lastUsd: null, firstPair: null, lastPair: null });
    }
  }));

  it("retains sealed source events without granting deletion authority", async () => withSqliteD1(async (db) => {
    const { prediction } = await sealPredictionFixture(db);
    await persistDepegCommands(db, [{ type: "delete-event", id: prediction.eventId }]);
    expect(db.sqlite.prepare("SELECT id FROM depeg_events WHERE id = ?").get(prediction.eventId))
      .toEqual({ id: prediction.eventId });
    expect(() => db.sqlite.prepare("DELETE FROM depeg_events WHERE id = ?").run(prediction.eventId))
      .toThrow("sealed depeg event deletes require incident repair authorization");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_resolver_event_repair_authorizations").get())
      .toEqual({ count: 0 });
  }));

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
