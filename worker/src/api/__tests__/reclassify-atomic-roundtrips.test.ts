import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleReclassifyAtomicRoundtripsTrusted } from "../reclassify-atomic-roundtrips";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { recalcAffectedHours } from "../../lib/mint-burn-pipeline/persistence";
import type * as Persistence from "../../lib/mint-burn-pipeline/persistence";
import { createLatestSchemaFixtureTracker } from "../../test-helpers/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

vi.mock("../../lib/mint-burn-pipeline/persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof Persistence>();
  return {
    ...actual,
    recalcAffectedHours: vi.fn().mockResolvedValue(undefined),
  };
});

describe("reclassify-atomic-roundtrips", () => {
  beforeEach(() => vi.mocked(recalcAffectedHours).mockClear());
  it("returns done:true when no roundtrips found", async () => {
    const db = mockD1([
      { match: "WHERE flow_type = 'standard'", rows: [] },
      { match: "WHERE flow_type = 'atomic_roundtrip'", rows: [] },
    ]);
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
    const db = mockD1([
      // Forward discovery query returns rows with chain_id and timestamp
      {
        match: "WHERE flow_type = 'standard'",
        rows: [
          { tx_hash: "0xaaa", stablecoin_id: "usdc-circle", chain_id: "ethereum", timestamp: 1700000000, cnt: 2 },
          { tx_hash: "0xbbb", stablecoin_id: "usdt-tether", chain_id: "ethereum", timestamp: 1700003600, cnt: 3 },
        ],
      },
      // Reverse discovery query — empty (no legacy tolerance-violating groups)
      { match: "WHERE flow_type = 'atomic_roundtrip'", rows: [] },
      // Batch UPDATE — batched via db.batch()
      {
        match: "UPDATE mint_burn_events",
        rows: [],
        runMeta: { changes: 3 },
      },
    ]);

    const url = new URL("https://api.pharos.watch/api/reclassify-atomic-roundtrips");
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
    expect([...vi.mocked(recalcAffectedHours).mock.calls[0][1].values()]).toEqual([
      { stablecoinId: "usdc-circle", chainId: "ethereum", hourTs: 1699999200 },
      { stablecoinId: "usdt-tether", chainId: "ethereum", hourTs: 1700002800 },
    ]);

    // Verify no per-tx SELECT queries happened (the old N+1 pattern)
    const history = db.getHistory();
    const selectQueries = history.filter(
      (q: { sql: string }) => q.sql.includes("SELECT") && q.sql.includes("WHERE tx_hash = ?"),
    );
    expect(selectQueries).toHaveLength(0);
  });

  it("orders candidate discovery deterministically oldest-first", async () => {
    const db = mockD1([
      { match: "WHERE flow_type = 'standard'", rows: [] },
      { match: "WHERE flow_type = 'atomic_roundtrip'", rows: [] },
    ]);

    await handleReclassifyAtomicRoundtripsTrusted({ db, url: new URL("https://api.pharos.watch/api/reclassify-atomic-roundtrips") });

    const discoveryQueries = db.getHistory().filter((entry) =>
      entry.sql.includes("GROUP BY tx_hash, stablecoin_id, chain_id"),
    );
    // Both forward and reverse discovery queries must order by oldest-first.
    expect(discoveryQueries.length).toBeGreaterThanOrEqual(2);
    for (const entry of discoveryQueries) {
      expect(entry.sql).toContain("ORDER BY MIN(timestamp) ASC, stablecoin_id ASC, tx_hash ASC");
    }
  });

  it("flips atomic_roundtrip back to standard when amounts fail new tolerance", async () => {
    // Legacy group: mint=100, burn=50 (50% divergence, far exceeds 0.5%
    // tolerance). The reverse SQL pass should surface and re-tag the rows.
    const db = mockD1([
      // Forward pass finds nothing.
      { match: "WHERE flow_type = 'standard'", rows: [] },
      // Reverse pass surfaces the tolerance-violating group.
      {
        match: "WHERE flow_type = 'atomic_roundtrip'",
        rows: [
          {
            tx_hash: "0xmismatch",
            stablecoin_id: "usdc-circle",
            chain_id: "ethereum",
            timestamp: 1_700_000_000,
            mint_amt: 100,
            burn_amt: 50,
          },
        ],
      },
      // The reverse UPDATE targets a single group; simulate 2 underlying rows
      // (one mint, one burn) being flipped back to standard.
      {
        match: "UPDATE mint_burn_events",
        rows: [],
        runMeta: { changes: 2 },
      },
    ]);

    const res = await handleReclassifyAtomicRoundtripsTrusted({ db, url: new URL("https://api.pharos.watch/api/reclassify-atomic-roundtrips") });

    const body = await res.json() as {
      done: boolean;
      updated: number;
      toRoundtrip: number;
      toStandard: number;
      hoursRecalculated: number;
    };

    expect(body.done).toBe(true);
    expect(body.toStandard).toBe(2);
    expect(body.toRoundtrip).toBe(0);
    expect(body.updated).toBe(2);
    // Hour bucket for the legacy group should be scheduled for recalc.
    expect(body.hoursRecalculated).toBeGreaterThanOrEqual(1);

    // Reverse UPDATE should bind the tolerance-violating tx_hash + stablecoin_id + chain_id.
    const history = db.getHistory();
    const reverseUpdate = history.find(
      (entry) =>
        entry.sql.includes("UPDATE mint_burn_events") &&
        entry.sql.includes("flow_type = 'standard'") &&
        entry.sql.includes("flow_type = 'atomic_roundtrip'"),
    );
    expect(reverseUpdate).toBeDefined();
    expect(reverseUpdate?.binds).toEqual(["0xmismatch", "usdc-circle", "ethereum"]);

    // recalcAffectedHours should be called with the affected hour bucket.
    expect(vi.mocked(recalcAffectedHours).mock.calls).toHaveLength(1);
    expect([...vi.mocked(recalcAffectedHours).mock.calls[0][1].values()]).toEqual([
      { stablecoinId: "usdc-circle", chainId: "ethereum", hourTs: 1699999200 },
    ]);
  });

  it("persists forward/reverse tags and hourly totals without touching neighboring identities", async () => {
    const { sqlite, db } = fixtures.open();
    const actual = await vi.importActual<typeof Persistence>("../../lib/mint-burn-pipeline/persistence");
    vi.mocked(recalcAffectedHours).mockImplementationOnce(actual.recalcAffectedHours);
    const insert = sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, tx_hash, block_number, timestamp, explorer_tx_url, burn_type, flow_type)
      VALUES (?, ?, 'USDC', ?, ?, ?, ?, ?, 1, ?, '', 'effective_burn', ?)`);
    insert.run("match-mint", "usdc-circle", "ethereum", "mint", 100, 100, "shared", 1700000000, "standard");
    insert.run("match-burn", "usdc-circle", "ethereum", "burn", 100, 100, "shared", 1700000000, "standard");
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
      { id: "other-chain", flow_type: "standard" }, { id: "other-coin", flow_type: "standard" },
      { id: "reverse-burn", flow_type: "standard" }, { id: "reverse-mint", flow_type: "standard" },
    ]);
    expect(sqlite.prepare("SELECT stablecoin_id, chain_id, hour_ts, mint_volume_usd, burn_volume_usd FROM mint_burn_hourly ORDER BY stablecoin_id, chain_id, hour_ts").all()).toEqual([
      { stablecoin_id: "usdc-circle", chain_id: "arbitrum", hour_ts: 1699999200, mint_volume_usd: 70, burn_volume_usd: 0 },
      { stablecoin_id: "usdc-circle", chain_id: "ethereum", hour_ts: 1699999200, mint_volume_usd: 0, burn_volume_usd: 0 },
      { stablecoin_id: "usdc-circle", chain_id: "ethereum", hour_ts: 1700002800, mint_volume_usd: 100, burn_volume_usd: 50 },
      { stablecoin_id: "usdt-tether", chain_id: "ethereum", hour_ts: 1699999200, mint_volume_usd: 80, burn_volume_usd: 0 },
    ]);
  });

  it("rejects malformed since values", async () => {
    const db = mockD1([]);
    const res = await handleReclassifyAtomicRoundtripsTrusted({ db, url: new URL("https://api.pharos.watch/api/reclassify-atomic-roundtrips?since=0foo") });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid since: must be a non-negative integer" });
    expect(db.getHistory()).toHaveLength(0);
  });
});
