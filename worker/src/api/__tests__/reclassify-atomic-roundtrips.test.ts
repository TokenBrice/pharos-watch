import { describe, expect, it, vi } from "vitest";
import { handleReclassifyAtomicRoundtripsTrusted } from "../reclassify-atomic-roundtrips";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { recalcAffectedHours } from "../../lib/mint-burn-pipeline/persistence";

vi.mock("../../lib/mint-burn-pipeline/persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/mint-burn-pipeline/persistence")>();
  return {
    ...actual,
    recalcAffectedHours: vi.fn().mockResolvedValue(undefined),
  };
});

describe("reclassify-atomic-roundtrips", () => {
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
          { tx_hash: "0xaaa", stablecoin_id: "usdc-circle", chain_id: "ethereum", min_ts: 1700000000, cnt: 2 },
          { tx_hash: "0xbbb", stablecoin_id: "usdt-tether", chain_id: "ethereum", min_ts: 1700003600, cnt: 3 },
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
            min_ts: 1_700_000_000,
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
    const recalcCalls = vi.mocked(recalcAffectedHours).mock.calls;
    expect(recalcCalls.length).toBeGreaterThanOrEqual(1);
    const recalcArg = recalcCalls[recalcCalls.length - 1]?.[1];
    expect(recalcArg?.size).toBeGreaterThanOrEqual(1);
  });

  it("scopes update predicates by chain_id for same hash and stablecoin on different chains", async () => {
    const db = mockD1([
      {
        match: "WHERE flow_type = 'standard'",
        rows: [
          {
            tx_hash: "0xshared",
            stablecoin_id: "usdc-circle",
            chain_id: "ethereum",
            timestamp: 1_700_000_000,
          },
          {
            tx_hash: "0xshared",
            stablecoin_id: "usdc-circle",
            chain_id: "arbitrum",
            timestamp: 1_700_003_600,
          },
        ],
      },
      { match: "WHERE flow_type = 'atomic_roundtrip'", rows: [] },
      { match: "UPDATE mint_burn_events", rows: [], runMeta: { changes: 1 } },
    ]);

    const res = await handleReclassifyAtomicRoundtripsTrusted({ db, url: new URL("https://api.pharos.watch/api/reclassify-atomic-roundtrips") });

    expect(res.status).toBe(200);
    const updates = db.getHistory().filter((entry) =>
      entry.sql.includes("UPDATE mint_burn_events") &&
      entry.sql.includes("flow_type = 'atomic_roundtrip'") &&
      entry.sql.includes("flow_type = 'standard'"),
    );
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect(update.sql).toContain("chain_id = ?");
    }
    expect(updates.map((update) => update.binds)).toEqual([
      ["0xshared", "usdc-circle", "ethereum"],
      ["0xshared", "usdc-circle", "arbitrum"],
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
