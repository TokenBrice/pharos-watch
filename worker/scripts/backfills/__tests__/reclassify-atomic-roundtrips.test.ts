import { afterEach, describe, expect, it, vi } from "vitest";
import { handleReclassifyAtomicRoundtripsTrusted } from "../reclassify-atomic-roundtrips";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import type { DatabaseSync } from "node:sqlite";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function seedRoundtrips(sqlite: DatabaseSync, flowType: "standard" | "atomic_roundtrip", count = 1) {
  const insert = sqlite.prepare(`INSERT INTO mint_burn_events
    (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, tx_hash, block_number, timestamp, explorer_tx_url, burn_type, flow_type)
    VALUES (?, 'usdc-circle', 'USDC', 'ethereum', ?, ?, ?, ?, 1, 1700000000, '', 'effective_burn', ?)`);
  for (let index = 0; index < count; index++) {
    const tx = `tx-${index.toString().padStart(3, "0")}`;
    for (const direction of ["mint", "burn"]) {
      const amount = direction === "burn" && flowType === "atomic_roundtrip" ? 50 : 100;
      insert.run(`${tx}-${direction}`, direction, amount, amount, tx, flowType);
    }
  }
  sqlite.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_volume_usd, burn_volume_usd)
    VALUES ('usdc-circle', 'ethereum', 1699999200, ?, ?)`)
    .run(flowType === "standard" ? count * 100 : 0, flowType === "standard" ? count * 100 : 0);
}

const run = (db: D1Database, query = "since=0") => handleReclassifyAtomicRoundtripsTrusted({
  db, url: new URL(`https://operator.invalid/jobs/reclassify-atomic-roundtrips?${query}`),
});

function totals(sqlite: DatabaseSync) {
  return sqlite.prepare("SELECT mint_volume_usd, burn_volume_usd FROM mint_burn_hourly WHERE stablecoin_id = 'usdc-circle' AND chain_id = 'ethereum' AND hour_ts = 1699999200").get();
}

function debtCount(sqlite: DatabaseSync) {
  return Number(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_dirty_hours").get()!.count);
}

describe("reclassify-atomic-roundtrips", () => {
  it("returns done:true when no roundtrips found", async () => {
    const { db } = fixtures.open();
    const url = new URL("https://api.pharos.watch/api/reclassify-atomic-roundtrips");
    const res = await handleReclassifyAtomicRoundtripsTrusted({ db, url });
    const body = await res.json() as {
      done: boolean;
      updated: number;
      toRoundtrip: number;
      toStandard: number;
    };
    expect(body.done).toBe(true);
    expect(body.updated).toBe(0);
    expect(body.toRoundtrip).toBe(0);
    expect(body.toStandard).toBe(0);
  });

  it("batches updates without per-tx queries (no N+1)", async () => {
    const { sqlite } = fixtures.open();
    let reads = 0;
    const db = createSqliteD1(sqlite, { onAll: () => { reads++; } });
    seedRoundtrips(sqlite, "standard", 41);
    const batch = vi.spyOn(db, "batch");

    const url = new URL("https://api.pharos.watch/api/reclassify-atomic-roundtrips?since=0");
    const res = await handleReclassifyAtomicRoundtripsTrusted({ db, url });
    const body = await res.json() as {
      done: boolean;
      updated: number;
      toRoundtrip: number;
      toStandard: number;
    };

    expect(body.done).toBe(true);
    expect(body.updated).toBeGreaterThan(0);
    expect(body.toRoundtrip).toBeGreaterThan(0);
    expect(body.toStandard).toBe(0);
    expect(body.toRoundtrip).toBe(82);
    expect(totals(sqlite)).toEqual({ mint_volume_usd: 0, burn_volume_usd: 0 });
    expect(debtCount(sqlite)).toBe(0);
    // Source writes remain bounded even when discovery exceeds one atomic chunk.
    expect(batch.mock.calls.every(([statements]) => statements.length <= 100)).toBe(true);
    expect(reads).toBeLessThanOrEqual(4);
  });

  it("persists forward/reverse tags and hourly totals without touching neighboring identities", async () => {
    const { sqlite, db } = fixtures.open();
    const insert = sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, tx_hash, block_number, timestamp, explorer_tx_url, burn_type, flow_type)
      VALUES (?, ?, 'USDC', ?, ?, ?, ?, ?, 1, ?, '', 'effective_burn', ?)`);
    insert.run("match-mint", "usdc-circle", "ethereum", "mint", 100, 100, "shared", 1700000000, "standard");
    insert.run("match-burn", "usdc-circle", "ethereum", "burn", 100, 100, "shared", 1700000000, "standard");
    insert.run("mismatch-mint", "usdc-circle", "ethereum", "mint", 100, 100, "forward-mismatch", 1700000000, "standard");
    insert.run("mismatch-burn", "usdc-circle", "ethereum", "burn", 50, 50, "forward-mismatch", 1700000000, "standard");
    insert.run("other-chain", "usdc-circle", "arbitrum", "mint", 70, 70, "shared", 1700000000, "standard");
    insert.run("other-coin", "usdt-tether", "ethereum", "mint", 80, 80, "shared", 1700000000, "standard");
    insert.run("reverse-mint", "usdc-circle", "ethereum", "mint", 100, 100, "mismatch", 1700003600, "atomic_roundtrip");
    insert.run("reverse-burn", "usdc-circle", "ethereum", "burn", 50, 50, "mismatch", 1700003600, "atomic_roundtrip");
    sqlite.exec(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_volume_usd)
      VALUES ('usdc-circle', 'ethereum', 1699999200, 100), ('usdc-circle', 'ethereum', 1700002800, 0),
             ('usdc-circle', 'arbitrum', 1699999200, 70), ('usdt-tether', 'ethereum', 1699999200, 80)`);

    const response = await handleReclassifyAtomicRoundtripsTrusted({
      db, url: new URL("https://api.pharos.watch/api/reclassify-atomic-roundtrips?since=0"),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ toRoundtrip: 2, toStandard: 2, hoursRecalculated: 2 });
    expect(sqlite.prepare("SELECT id, flow_type FROM mint_burn_events ORDER BY id").all()).toEqual([
      { id: "match-burn", flow_type: "atomic_roundtrip" }, { id: "match-mint", flow_type: "atomic_roundtrip" },
      { id: "mismatch-burn", flow_type: "standard" }, { id: "mismatch-mint", flow_type: "standard" },
      { id: "other-chain", flow_type: "standard" }, { id: "other-coin", flow_type: "standard" },
      { id: "reverse-burn", flow_type: "standard" }, { id: "reverse-mint", flow_type: "standard" },
    ]);
    expect(sqlite.prepare("SELECT stablecoin_id, chain_id, hour_ts, mint_volume_usd, burn_volume_usd FROM mint_burn_hourly ORDER BY stablecoin_id, chain_id, hour_ts").all()).toEqual([
      { stablecoin_id: "usdc-circle", chain_id: "arbitrum", hour_ts: 1699999200, mint_volume_usd: 70, burn_volume_usd: 0 },
      { stablecoin_id: "usdc-circle", chain_id: "ethereum", hour_ts: 1699999200, mint_volume_usd: 100, burn_volume_usd: 50 },
      { stablecoin_id: "usdc-circle", chain_id: "ethereum", hour_ts: 1700002800, mint_volume_usd: 100, burn_volume_usd: 50 },
      { stablecoin_id: "usdt-tether", chain_id: "ethereum", hour_ts: 1699999200, mint_volume_usd: 80, burn_volume_usd: 0 },
    ]);
  });

  it("retains forward debt after a reverse-read failure and drains it outside the retry discovery scope", async () => {
    const { sqlite } = fixtures.open();
    seedRoundtrips(sqlite, "standard");
    let fail = true;
    const db = createSqliteD1(sqlite, {
      onAll: (sql) => {
        if (fail && sql.includes("WHERE flow_type = 'atomic_roundtrip'")) {
          fail = false;
          throw new Error("reverse discovery interrupted");
        }
      },
    });
    expect((await run(db)).status).toBe(503);
    expect(sqlite.prepare("SELECT DISTINCT flow_type FROM mint_burn_events").all()).toEqual([{ flow_type: "atomic_roundtrip" }]);
    expect(totals(sqlite)).toEqual({ mint_volume_usd: 100, burn_volume_usd: 100 });
    expect(debtCount(sqlite)).toBe(1);
    const retry = await run(db, "since=1800000000&stablecoinId=usdt-tether");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ done: true, updated: 0, hoursRecalculated: 1 });
    expect(totals(sqlite)).toEqual({ mint_volume_usd: 0, burn_volume_usd: 0 });
    expect(debtCount(sqlite)).toBe(0);
  });

  it.each(["standard", "atomic_roundtrip"] as const)("heals committed chunks after a partial %s write failure", async (flowType) => {
    const { sqlite } = fixtures.open();
    seedRoundtrips(sqlite, flowType, 41);
    sqlite.exec("UPDATE mint_burn_events SET timestamp = 1700003600 WHERE tx_hash = 'tx-040'");
    sqlite.prepare("UPDATE mint_burn_hourly SET mint_volume_usd = ?, burn_volume_usd = ?")
      .run(flowType === "standard" ? 4000 : 0, flowType === "standard" ? 4000 : 0);
    sqlite.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_volume_usd, burn_volume_usd)
      VALUES ('usdc-circle', 'ethereum', 1700002800, ?, ?)`)
      .run(flowType === "standard" ? 100 : 0, flowType === "standard" ? 100 : 0);
    let writes = 0;
    const db = createSqliteD1(sqlite, {
      onRun: (sql) => {
        if (sql.includes("SET flow_type = ?") && ++writes === 41) throw new Error("source write interrupted");
      },
    });
    expect((await run(db)).status).toBe(503);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_events WHERE flow_type = ?").get(flowType)!.count).toBe(2);
    expect(debtCount(sqlite)).toBe(1);
    expect(totals(sqlite)).toEqual({
      mint_volume_usd: flowType === "standard" ? 4000 : 0,
      burn_volume_usd: flowType === "standard" ? 4000 : 0,
    });
    const retry = await run(db);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ done: true, updated: 2 });
    expect(totals(sqlite)).toEqual({
      mint_volume_usd: flowType === "standard" ? 0 : 4000,
      burn_volume_usd: flowType === "standard" ? 0 : 2000,
    });
    expect(sqlite.prepare("SELECT mint_volume_usd, burn_volume_usd FROM mint_burn_hourly WHERE hour_ts = 1700002800").get()).toEqual({
      mint_volume_usd: flowType === "standard" ? 0 : 100,
      burn_volume_usd: flowType === "standard" ? 0 : 50,
    });
    expect(debtCount(sqlite)).toBe(0);
  });

  it("drains more than one bounded debt chunk before a no-discovery run reports done", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`WITH RECURSIVE hours(value) AS (
      VALUES (0) UNION ALL SELECT value + 1 FROM hours WHERE value < 1000)
      INSERT INTO mint_burn_dirty_hours (stablecoin_id, chain_id, hour_ts)
      SELECT 'usdc-circle', 'ethereum', 1699999200 + value * 3600 FROM hours;`);
    const response = await run(db);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ done: true, updated: 0, hoursRecalculated: 1001 });
    expect(debtCount(sqlite)).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM mint_burn_hourly").get()!.count).toBe(0);
  });

  it("rolls back an interrupted hourly replacement without losing debt and heals a no-discovery retry", async () => {
    const { sqlite } = fixtures.open();
    seedRoundtrips(sqlite, "standard");
    let fail = true;
    const db = createSqliteD1(sqlite, {
      onRun: (sql) => {
        if (fail && sql.includes("INSERT INTO mint_burn_hourly")) {
          fail = false;
          throw new Error("hourly rebuild interrupted");
        }
      },
    });
    expect((await run(db)).status).toBe(503);
    expect(totals(sqlite)).toEqual({ mint_volume_usd: 100, burn_volume_usd: 100 });
    expect(debtCount(sqlite)).toBe(1);
    const retry = await run(db);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ done: true, updated: 0, hoursRecalculated: 1 });
    expect(totals(sqlite)).toEqual({ mint_volume_usd: 0, burn_volume_usd: 0 });
    expect(debtCount(sqlite)).toBe(0);
  });

  it("enqueues all source hours when one discovered transaction spans buckets", async () => {
    const { sqlite, db } = fixtures.open();
    seedRoundtrips(sqlite, "standard");
    sqlite.exec(`UPDATE mint_burn_events SET timestamp = 1700003600 WHERE direction = 'burn';
      UPDATE mint_burn_hourly SET burn_volume_usd = 0;
      INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, burn_volume_usd)
      VALUES ('usdc-circle', 'ethereum', 1700002800, 100);`);
    const response = await run(db);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ done: true, updated: 2, hoursRecalculated: 2 });
    expect(sqlite.prepare("SELECT hour_ts, mint_volume_usd, burn_volume_usd FROM mint_burn_hourly ORDER BY hour_ts").all()).toEqual([
      { hour_ts: 1699999200, mint_volume_usd: 0, burn_volume_usd: 0 },
      { hour_ts: 1700002800, mint_volume_usd: 0, burn_volume_usd: 0 },
    ]);
    expect(debtCount(sqlite)).toBe(0);
  });

  it.each(["before", "after"] as const)("preserves a concurrent source mutation %s the drain transaction", async (timing) => {
    const { sqlite } = fixtures.open();
    seedRoundtrips(sqlite, "standard");
    sqlite.exec(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, tx_hash, block_number, timestamp, explorer_tx_url, flow_type)
      VALUES ('concurrent', 'usdc-circle', 'USDC', 'ethereum', 'mint', 7, 7, 'unpaired', 1, 1700000000, '', 'standard');
      UPDATE mint_burn_hourly SET mint_volume_usd = 107;`);
    let injected = false;
    let rebuilding = false;
    const mutate = () => {
      sqlite.exec(`BEGIN IMMEDIATE;
        UPDATE mint_burn_events SET amount = 9, amount_usd = 9 WHERE id = 'concurrent';
        INSERT OR IGNORE INTO mint_burn_dirty_hours VALUES ('usdc-circle', 'ethereum', 1699999200);
        COMMIT;`);
      injected = true;
    };
    const db = createSqliteD1(sqlite, {
      onAll: (sql) => {
        if (!injected && timing === "before" && sql.includes("FROM mint_burn_dirty_hours") && debtCount(sqlite) > 0) mutate();
      },
      onRun: (sql) => {
        if (sql.includes("DELETE FROM mint_burn_dirty_hours")) rebuilding = true;
      },
    });
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementation(async (statements) => {
      const result = await batch(statements);
      if (!injected && timing === "after" && rebuilding) mutate();
      return result;
    });
    const response = await run(db);
    expect(response.status).toBe(200);
    expect(injected).toBe(true);
    expect(await response.json()).toMatchObject({ done: timing === "before", updated: 2 });
    expect(totals(sqlite)).toEqual({ mint_volume_usd: timing === "before" ? 9 : 7, burn_volume_usd: 0 });
    expect(debtCount(sqlite)).toBe(timing === "before" ? 0 : 1);
    if (timing === "after") {
      const retry = await run(db);
      expect(await retry.json()).toMatchObject({ done: true, updated: 0 });
      expect(totals(sqlite)).toEqual({ mint_volume_usd: 9, burn_volume_usd: 0 });
      expect(debtCount(sqlite)).toBe(0);
    }
  });

  it("rejects malformed since values", async () => {
    const db = mockD1([]);
    const res = await handleReclassifyAtomicRoundtripsTrusted({ db, url: new URL("https://api.pharos.watch/api/reclassify-atomic-roundtrips?since=0foo") });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid since: must be a non-negative integer" });
    expect(db.getHistory()).toHaveLength(0);
  });
});
