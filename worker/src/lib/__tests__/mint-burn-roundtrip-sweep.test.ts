import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { sweepRecentRoundtrips } from "../mint-burn-pipeline/roundtrip-sweep";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { rebuildMintBurnMaterializationHours } from "../mint-burn-pipeline/materialization-debt";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function seedPair(sqlite: DatabaseSync, tx: string, burnAmount = 1000, timestamp = 1700000000, coin = "usdc-circle") {
  const insert = sqlite.prepare(`INSERT INTO mint_burn_events
    (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, burn_type, tx_hash, block_number, timestamp, explorer_tx_url, flow_type)
    VALUES (?, ?, 'USDC', 'ethereum', ?, ?, ?, ?, ?, 1, ?, '', 'standard')`);
  insert.run(`${tx}-mint`, coin, "mint", 1000, 1000, null, tx, timestamp);
  insert.run(`${tx}-burn`, coin, "burn", burnAmount, burnAmount, "effective_burn", tx, timestamp);
}

describe("sweepRecentRoundtrips", () => {
  it("returns no affected hours when no roundtrips exist", async () => {
    const { db } = fixtures.open();
    expect(await sweepRecentRoundtrips(db, 1700001000)).toEqual({ reclassified: 0, affectedHours: new Map(), saturated: false });
  });

  it("reclassifies persisted cross-run rows and recomputes the exact affected bucket", async () => {
    const { db, sqlite } = fixtures.open();
    seedPair(sqlite, "0xaaa");
    const result = await sweepRecentRoundtrips(db, 1700001000);
    expect(result.reclassified).toBe(2);
    expect([...result.affectedHours]).toEqual([["usdc-circle-ethereum-1699999200", {
      stablecoinId: "usdc-circle", chainId: "ethereum", hourTs: 1699999200,
    }]]);
    expect(sqlite.prepare("SELECT flow_type FROM mint_burn_events ORDER BY id").all()).toEqual([
      { flow_type: "atomic_roundtrip" }, { flow_type: "atomic_roundtrip" },
    ]);
    expect(sqlite.prepare("SELECT * FROM mint_burn_hourly").get()).toEqual({
      stablecoin_id: "usdc-circle", chain_id: "ethereum", hour_ts: 1699999200,
      mint_count: 0, burn_count: 0, mint_unpriced_event_count: 0, burn_unpriced_event_count: 0,
      mint_volume_usd: 0, burn_volume_usd: 0, net_flow_usd: 0,
    });
  });

  it("keeps classification and debt atomic when the source update fails", async () => {
    const { sqlite } = fixtures.open();
    seedPair(sqlite, "failed");
    const db = createSqliteD1(sqlite, { onRun(sql) {
      if (sql.includes("UPDATE mint_burn_events")) throw new Error("injected classification failure");
    } });
    await expect(sweepRecentRoundtrips(db, 1700001000)).rejects.toThrow("injected classification failure");
    expect(sqlite.prepare("SELECT flow_type FROM mint_burn_events").all())
      .toEqual([{ flow_type: "standard" }, { flow_type: "standard" }]);
    expect(sqlite.prepare("SELECT * FROM mint_burn_dirty_hours").all()).toEqual([]);
  });

  it("keeps every mutated hour dirty after rebuild failure without recovering unpriced classifications", async () => {
    const { db, sqlite } = fixtures.open();
    seedPair(sqlite, "multi-hour");
    sqlite.prepare(`UPDATE mint_burn_events SET timestamp = 1700003600, amount_usd = NULL,
      price_repair_status = 'pending_aggregate' WHERE direction = 'burn'`).run();
    const failingDb = createSqliteD1(sqlite, { onRun(sql) {
      if (sql.includes("INSERT INTO mint_burn_hourly")) throw new Error("injected rebuild failure");
    } });
    await expect(sweepRecentRoundtrips(failingDb, 1700005000)).rejects.toThrow("injected rebuild failure");
    expect(sqlite.prepare("SELECT flow_type FROM mint_burn_events").all())
      .toEqual([{ flow_type: "atomic_roundtrip" }, { flow_type: "atomic_roundtrip" }]);
    expect(sqlite.prepare("SELECT hour_ts FROM mint_burn_dirty_hours ORDER BY hour_ts").all())
      .toEqual([{ hour_ts: 1699999200 }, { hour_ts: 1700002800 }]);
    await rebuildMintBurnMaterializationHours(db, new Map([
      ["first", { stablecoinId: "usdc-circle", chainId: "ethereum", hourTs: 1699999200 }],
      ["second", { stablecoinId: "usdc-circle", chainId: "ethereum", hourTs: 1700002800 }],
    ]));
    expect(sqlite.prepare("SELECT price_repair_status, amount_usd FROM mint_burn_events WHERE direction = 'burn'").get())
      .toEqual({ price_repair_status: "pending_aggregate", amount_usd: null });
    expect(sqlite.prepare("SELECT mint_count, burn_count, net_flow_usd FROM mint_burn_hourly ORDER BY hour_ts").all())
      .toEqual([{ mint_count: 0, burn_count: 0, net_flow_usd: 0 }, { mint_count: 0, burn_count: 0, net_flow_usd: 0 }]);
    expect(sqlite.prepare("SELECT * FROM mint_burn_dirty_hours").all()).toEqual([]);
  });

  it("includes exactly 0.5% mismatch but excludes just outside tolerance", async () => {
    const { db, sqlite } = fixtures.open();
    seedPair(sqlite, "boundary", 995);
    seedPair(sqlite, "outside", 994.999);
    expect((await sweepRecentRoundtrips(db, 1700001000)).reclassified).toBe(2);
    expect(sqlite.prepare("SELECT tx_hash, flow_type FROM mint_burn_events WHERE direction = 'burn' ORDER BY tx_hash").all()).toEqual([
      { tx_hash: "boundary", flow_type: "atomic_roundtrip" }, { tx_hash: "outside", flow_type: "standard" },
    ]);
  });

  it("bounds oldest-first selection and resolves tied timestamps by coin then transaction", async () => {
    const { db, sqlite } = fixtures.open();
    seedPair(sqlite, "newest", 1000, 1700000001);
    seedPair(sqlite, "aaa", 1000, 1700000000, "usdt-tether");
    for (let index = 200; index >= 0; index--) seedPair(sqlite, `tx-${String(index).padStart(3, "0")}`);
    const result = await sweepRecentRoundtrips(db, 1700001000);
    expect(result).toMatchObject({ reclassified: 400, saturated: true });
    expect(sqlite.prepare("SELECT tx_hash FROM mint_burn_events WHERE direction = 'mint' AND flow_type = 'standard' ORDER BY tx_hash").all())
      .toEqual([{ tx_hash: "aaa" }, { tx_hash: "newest" }, { tx_hash: "tx-200" }]);
  });
});
