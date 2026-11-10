import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { handleReclassifyAtomicRoundtripsTrusted } from "../reclassify-atomic-roundtrips";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());
const run = (db: D1Database, query = "since=0") => handleReclassifyAtomicRoundtripsTrusted({
  db, url: new URL(`https://operator.invalid/jobs/reclassify-atomic-roundtrips?${query}`),
});
const debt = (sql: DatabaseSync) => sql.prepare("SELECT COUNT(*) AS n FROM mint_burn_dirty_hours").get()!.n;
const totals = (sql: DatabaseSync) => sql.prepare("SELECT mint_volume_usd, burn_volume_usd FROM mint_burn_hourly ORDER BY hour_ts").all()
  .map((r) => [r.mint_volume_usd, r.burn_volume_usd]);
const flows = (sql: DatabaseSync) => sql.prepare("SELECT DISTINCT flow_type FROM mint_burn_events").all().map((r) => r.flow_type);

function seed(sql: DatabaseSync, flow = "standard", count = 1) {
  const insert = sql.prepare(`INSERT INTO mint_burn_events
    (id, stablecoin_id, symbol, chain_id, direction, amount, amount_raw, amount_usd, tx_hash, block_number, timestamp, explorer_tx_url, burn_type, flow_type)
    VALUES (?, 'usdc-circle', 'USDC', 'ethereum', ?, ?, ?, ?, ?, 1, 1700000000, '', 'effective_burn', ?)`);
  for (let i = 0; i < count; i++) {
    const tx = `tx-${String(i).padStart(4, "0")}`;
    for (const direction of ["mint", "burn"]) {
      const amount = direction === "burn" && flow === "atomic_roundtrip" ? 50 : 100;
      insert.run(`${tx}-${direction}`, direction, amount, String(amount), amount, tx, flow);
    }
  }
  sql.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_volume_usd, burn_volume_usd)
    VALUES ('usdc-circle', 'ethereum', 1699999200, ?, ?)`).run(flow === "standard" ? count * 100 : 0, flow === "standard" ? count * 100 : 0);
}

describe("reclassify-atomic-roundtrips", () => {
  it("handles empty scans and rejects malformed inputs before touching storage", async () => {
    const { db } = fixtures.open();
    expect(await (await run(db, "")).json()).toMatchObject({ done: true, updated: 0, toRoundtrip: 0, toStandard: 0 });
    const prepare = vi.spyOn(db, "prepare");
    for (const query of ["since=0foo", "since=0&cursor=broken"]) {
      prepare.mockClear();
      expect((await run(db, query)).status).toBe(400);
      expect(prepare).not.toHaveBeenCalled();
    }
  });

  it("batches source writes with bounded reads and conserves the old tolerance residual", async () => {
    const { sqlite } = fixtures.open();
    seed(sqlite, "standard", 41);
    let reads = 0;
    const db = createSqliteD1(sqlite, { onAll: () => { reads++; } });
    const batch = vi.spyOn(db, "batch");
    expect(await (await run(db)).json()).toMatchObject({ done: true, toRoundtrip: 82, toStandard: 0 });
    expect(totals(sqlite)).toEqual([[0, 0]]);
    expect(debt(sqlite)).toBe(0);
    expect(reads).toBeLessThanOrEqual(4);
    expect(batch.mock.calls.every(([statements]) => statements.length <= 100)).toBe(true);
    sqlite.exec(`UPDATE mint_burn_events SET amount = 100.4, amount_usd = 100.4, amount_raw = '100400' WHERE id = 'tx-0000-burn';
      UPDATE mint_burn_events SET amount_raw = '100000' WHERE id = 'tx-0000-mint';
      UPDATE mint_burn_events SET amount_raw = NULL WHERE tx_hash = 'tx-0001';`);
    expect(await (await run(db)).json()).toMatchObject({ done: true, toStandard: 2, toRoundtrip: 0 });
    expect(sqlite.prepare("SELECT net_flow_usd FROM mint_burn_hourly").get()!.net_flow_usd).toBeCloseTo(-0.4);
    expect(sqlite.prepare("SELECT DISTINCT flow_type FROM mint_burn_events WHERE tx_hash = 'tx-0001'").get())
      .toEqual({ flow_type: "atomic_roundtrip" });
  });

  it("isolates transaction groups by coin and chain", async () => {
    const { sqlite, db } = fixtures.open();
    seed(sqlite);
    const insert = sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_raw, amount_usd, tx_hash, block_number, timestamp, explorer_tx_url, flow_type)
      VALUES (?, ?, 'USDC', ?, 'mint', 7, '7', 7, 'tx-0000', 1, 1700000000, '', 'standard')`);
    insert.run("other-coin", "usdt-tether", "ethereum");
    insert.run("other-chain", "usdc-circle", "arbitrum");
    expect(await (await run(db)).json()).toMatchObject({ toRoundtrip: 2 });
    expect(sqlite.prepare("SELECT id, flow_type FROM mint_burn_events WHERE id LIKE 'other-%' ORDER BY id").all()).toEqual([
      { id: "other-chain", flow_type: "standard" }, { id: "other-coin", flow_type: "standard" },
    ]);
  });

  it.each(["read", "rebuild"])("repairs %s interruption debt outside the retry discovery scope", async (failure) => {
    const { sqlite } = fixtures.open();
    seed(sqlite);
    const db = createSqliteD1(sqlite, {
      onAll(sql) { if (failure === "read" && sql.includes("FROM mint_burn_dirty_hours") && debt(sqlite)) throw Error("interrupted"); },
      onRun(sql) { if (failure === "rebuild" && sql.includes("INSERT INTO mint_burn_hourly")) throw Error("interrupted"); },
    });
    expect((await run(db)).status).toBe(503);
    expect(flows(sqlite)).toEqual(["atomic_roundtrip"]);
    expect(totals(sqlite)).toEqual([[100, 100]]);
    expect(debt(sqlite)).toBe(1);
    const retry = createSqliteD1(sqlite);
    expect(await (await run(retry, "since=1800000000&stablecoinId=usdt-tether")).json())
      .toMatchObject({ done: true, updated: 0, hoursRecalculated: 1 });
    expect(totals(sqlite)).toEqual([[0, 0]]);
    expect(debt(sqlite)).toBe(0);
  });

  it.each(["standard", "atomic_roundtrip"])("repairs partial %s source chunks", async (flow) => {
    const { sqlite } = fixtures.open();
    seed(sqlite, flow, 41);
    let writes = 0;
    const db = createSqliteD1(sqlite, { onRun(sql) {
      if (sql.includes("SET flow_type = CASE") && ++writes === 41) throw Error("interrupted");
    } });
    expect((await run(db)).status).toBe(503);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mint_burn_events WHERE flow_type = ?").get(flow)!.n).toBe(2);
    expect(debt(sqlite)).toBe(1);
    expect(totals(sqlite)).toEqual([flow === "standard" ? [4100, 4100] : [0, 0]]);
    expect(await (await run(createSqliteD1(sqlite))).json()).toMatchObject({ done: true, updated: 2 });
    expect(totals(sqlite)).toEqual([flow === "standard" ? [0, 0] : [4100, 2050]]);
    expect(debt(sqlite)).toBe(0);
  });

  it("drains multiple debt pages and every hour of a cross-hour transaction", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`WITH RECURSIVE hours(n) AS (VALUES (0) UNION ALL SELECT n + 1 FROM hours WHERE n < 1000)
      INSERT INTO mint_burn_dirty_hours SELECT 'usdc-circle', 'ethereum', 1699999200 + n * 3600 FROM hours;`);
    expect(await (await run(db)).json()).toMatchObject({ done: true, hoursRecalculated: 1001 });
    expect(totals(sqlite)).toEqual([]);
    seed(sqlite);
    sqlite.exec("UPDATE mint_burn_events SET timestamp = 1700003600 WHERE direction = 'burn'");
    expect(await (await run(db)).json()).toMatchObject({ updated: 2, hoursRecalculated: 2 });
    expect(totals(sqlite)).toEqual([[0, 0], [0, 0]]);
    expect(debt(sqlite)).toBe(0);
  });

  it.each(["before", "after"])("keeps a concurrent source mutation %s the drain", async (timing) => {
    const { sqlite } = fixtures.open();
    seed(sqlite);
    sqlite.exec(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, tx_hash, block_number, timestamp, explorer_tx_url, flow_type)
      VALUES ('concurrent', 'usdc-circle', 'USDC', 'ethereum', 'mint', 7, 7, 'unpaired', 1, 1700000000, '', 'standard');
      UPDATE mint_burn_hourly SET mint_volume_usd = 107;`);
    let injected = false;
    let rebuilding = false;
    const mutate = () => {
      sqlite.exec(`UPDATE mint_burn_events SET amount = 9, amount_usd = 9 WHERE id = 'concurrent';
        INSERT OR IGNORE INTO mint_burn_dirty_hours VALUES ('usdc-circle', 'ethereum', 1699999200);`);
      injected = true;
    };
    const db = createSqliteD1(sqlite, {
      onAll(sql) { if (!injected && timing === "before" && sql.includes("FROM mint_burn_dirty_hours") && debt(sqlite)) mutate(); },
      onRun(sql) { if (sql.includes("DELETE FROM mint_burn_dirty_hours")) rebuilding = true; },
    });
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementation(async (statements) => {
      const result = await batch(statements);
      if (!injected && timing === "after" && rebuilding) mutate();
      return result;
    });
    expect(await (await run(db)).json()).toMatchObject({ done: timing === "before", updated: 2 });
    expect(injected).toBe(true);
    expect(totals(sqlite)).toEqual([[timing === "before" ? 9 : 7, 0]]);
    expect(debt(sqlite)).toBe(timing === "before" ? 0 : 1);
    expect(await (await run(db)).json()).toMatchObject({ done: true, updated: 0 });
    expect(totals(sqlite)).toEqual([[9, 0]]);
  });

  it("continues past unequal groups using the explicit cursor", async () => {
    const { sqlite, db } = fixtures.open();
    seed(sqlite, "standard", 1001);
    sqlite.exec("UPDATE mint_burn_events SET amount_raw = '99' WHERE direction = 'burn' AND tx_hash != 'tx-1000'");
    const first = await (await run(db)).json() as { nextCursor: string };
    expect(first).toMatchObject({ done: false, updated: 0 });
    expect(await (await run(db, `since=0&cursor=${encodeURIComponent(first.nextCursor)}`)).json())
      .toMatchObject({ done: true, updated: 2, nextCursor: null });
  });
});
