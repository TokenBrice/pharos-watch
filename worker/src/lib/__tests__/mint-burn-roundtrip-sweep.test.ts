import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { sweepRecentRoundtrips } from "../mint-burn-pipeline/roundtrip-sweep";

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
      mint_count: 0, burn_count: 0, mint_volume_usd: 0, burn_volume_usd: 0, net_flow_usd: 0,
    });
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
