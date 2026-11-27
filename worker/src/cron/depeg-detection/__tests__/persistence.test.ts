import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { persistDepegCommands } from "../persistence";
import type { DepegPersistenceCommand } from "../types";
import { sealPredictionFixture, withSqliteD1 } from "../../../lib/__tests__/depeg-resolver-ddrv2-store.test-support";

function insertOpenEvent(sqlite: DatabaseSync, stablecoinId: string, startedAt: number): number {
  sqlite.prepare(`INSERT INTO depeg_events (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peak_price, peg_reference, source)
    VALUES (?, ?, 'peggedUSD', 'below', -200, ?, 0.98, 0.98, 1, 'live')`).run(stablecoinId, stablecoinId, startedAt);
  return (sqlite.prepare("SELECT id FROM depeg_events WHERE stablecoin_id = ?").get(stablecoinId) as { id: number }).id;
}

const pendingCommand = (stablecoinId: string, seenAt: number): DepegPersistenceCommand => ({
  type: "upsert-pending",
  payload: { stablecoinId, symbol: stablecoinId, pegType: "peggedUSD", direction: "below", bps: -200, seenAt, price: 0.98, pegReference: 1, reason: "large-cap" },
});

const closeCommand = (id: number, endedAt: number): DepegPersistenceCommand =>
  ({ type: "close-event", id, endedAt, recoveryPrice: 1, closeReason: "recovered-primary" });

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

  it("persists update-escalation on open rows only and clears candidate clocks on close-event", async () => withSqliteD1(async (db) => {
    const id = insertOpenEvent(db.sqlite, "test-escalation", 100);
    const read = () => db.sqlite.prepare(
      "SELECT ended_at, peak_escalated_at, peak_escalation_anchor_bps, peak_escalation_candidate_at, peak_escalation_candidate_seen_at FROM depeg_events WHERE id = ?",
    ).get(id);
    await persistDepegCommands(db, [{ type: "update-escalation", id, peakEscalatedAt: 500, peakEscalationAnchorBps: 650, peakEscalationCandidateAt: 700, peakEscalationCandidateSeenAt: 750 }]);
    expect(read()).toEqual({ ended_at: null, peak_escalated_at: 500, peak_escalation_anchor_bps: 650, peak_escalation_candidate_at: 700, peak_escalation_candidate_seen_at: 750 });
    await persistDepegCommands(db, [closeCommand(id, 900)]);
    expect(read()).toEqual({ ended_at: 900, peak_escalated_at: 500, peak_escalation_anchor_bps: 650, peak_escalation_candidate_at: null, peak_escalation_candidate_seen_at: null });
    await persistDepegCommands(db, [{ type: "update-escalation", id, peakEscalatedAt: 1000, peakEscalationAnchorBps: 900, peakEscalationCandidateAt: 1000, peakEscalationCandidateSeenAt: 1000 }]);
    expect(read()).toEqual({ ended_at: 900, peak_escalated_at: 500, peak_escalation_anchor_bps: 650, peak_escalation_candidate_at: null, peak_escalation_candidate_seen_at: null });
  }));

  it("retains sealed source events without granting deletion authority", async () => withSqliteD1(async (db) => {
    const { prediction } = await sealPredictionFixture(db);
    await persistDepegCommands(db, [{ type: "delete-event", id: prediction.eventId }]);
    expect(db.sqlite.prepare("SELECT id FROM depeg_events WHERE id = ?").get(prediction.eventId)).toEqual({ id: prediction.eventId });
    expect(() => db.sqlite.prepare("DELETE FROM depeg_events WHERE id = ?").run(prediction.eventId))
      .toThrow("sealed depeg event deletes require incident repair authorization");
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_resolver_event_repair_authorizations").get()).toEqual({ count: 0 });
  }));

  it("commits every asset transition when the total statement count crosses 100", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const commands: DepegPersistenceCommand[] = [];
    for (let i = 0; i < 51; i++) {
      const id = `atomic-coin-${i}`;
      commands.push(closeCommand(insertOpenEvent(sqlite, id, i + 1), 10_000), pendingCommand(id, 10_000));
    }
    await expect(persistDepegCommands(db, commands)).resolves.toBe(102);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_events WHERE ended_at IS NULL").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM depeg_pending").get()).toEqual({ count: 51 });
    sqlite.close();
  });

  it("does not partially apply a later failing asset group", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    sqlite.exec("CREATE TRIGGER fail_atomic_depeg_pending BEFORE INSERT ON depeg_pending WHEN NEW.stablecoin_id = 'atomic-fail' BEGIN SELECT RAISE(ABORT, 'injected pending failure'); END");
    const commands = ["atomic-ok-1", "atomic-ok-2", "atomic-fail"].flatMap((id, i) => [
      closeCommand(insertOpenEvent(sqlite, id, i + 1), 10_000), pendingCommand(id, 10_000),
    ]);
    await expect(persistDepegCommands(db, commands)).rejects.toThrow("injected pending failure");
    expect(sqlite.prepare("SELECT stablecoin_id, ended_at FROM depeg_events ORDER BY stablecoin_id").all()).toEqual([
      { stablecoin_id: "atomic-fail", ended_at: null },
      { stablecoin_id: "atomic-ok-1", ended_at: 10_000 },
      { stablecoin_id: "atomic-ok-2", ended_at: 10_000 },
    ]);
    expect(sqlite.prepare("SELECT stablecoin_id FROM depeg_pending ORDER BY stablecoin_id").all()).toEqual([
      { stablecoin_id: "atomic-ok-1" }, { stablecoin_id: "atomic-ok-2" },
    ]);
    sqlite.close();
  });
});
