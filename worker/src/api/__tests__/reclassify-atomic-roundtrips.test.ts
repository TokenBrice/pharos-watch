import { describe, expect, it, vi } from "vitest";
import { handleReclassifyAtomicRoundtrips } from "../reclassify-atomic-roundtrips";
import { mockD1 } from "./helpers/mock-d1";

vi.mock("../../lib/mint-burn-pipeline/persistence", () => ({
  recalcAffectedHours: vi.fn().mockResolvedValue(undefined),
}));

describe("reclassify-atomic-roundtrips", () => {
  it("returns done:true when no roundtrips found", async () => {
    const db = mockD1([
      { match: "GROUP BY tx_hash", rows: [] },
    ]);
    const url = new URL("https://api.pharos.watch/api/reclassify-atomic-roundtrips");
    const res = await handleReclassifyAtomicRoundtrips(db, url, true);
    const body = await res.json() as { done: boolean; updated: number };
    expect(body.done).toBe(true);
    expect(body.updated).toBe(0);
  });

  it("batches updates without per-tx queries (no N+1)", async () => {
    const db = mockD1([
      // Discovery query returns rows with chain_id and timestamp
      {
        match: "GROUP BY tx_hash",
        rows: [
          { tx_hash: "0xaaa", stablecoin_id: "usdc-circle", chain_id: "ethereum", min_ts: 1700000000, cnt: 2 },
          { tx_hash: "0xbbb", stablecoin_id: "usdt-tether", chain_id: "ethereum", min_ts: 1700003600, cnt: 3 },
        ],
      },
      // Batch UPDATE — batched via db.batch()
      {
        match: "UPDATE mint_burn_events",
        rows: [],
        runMeta: { changes: 3 },
      },
    ]);

    const url = new URL("https://api.pharos.watch/api/reclassify-atomic-roundtrips");
    const res = await handleReclassifyAtomicRoundtrips(db, url, true);
    const body = await res.json() as { done: boolean; updated: number };

    expect(body.done).toBe(true);
    expect(body.updated).toBeGreaterThan(0);

    // Verify no per-tx SELECT queries happened (the old N+1 pattern)
    const history = db.getHistory();
    const selectQueries = history.filter(
      (q: { sql: string }) => q.sql.includes("SELECT") && q.sql.includes("WHERE tx_hash = ?"),
    );
    expect(selectQueries).toHaveLength(0);
  });

  it("orders candidate discovery deterministically oldest-first", async () => {
    const db = mockD1([
      { match: "GROUP BY tx_hash", rows: [] },
    ]);

    await handleReclassifyAtomicRoundtrips(
      db,
      new URL("https://api.pharos.watch/api/reclassify-atomic-roundtrips"),
      true,
    );

    const discoverySql = db.getHistory().find((entry) =>
      entry.sql.includes("GROUP BY tx_hash, stablecoin_id, chain_id"),
    )?.sql;
    expect(discoverySql).toContain("ORDER BY MIN(timestamp) ASC, stablecoin_id ASC, tx_hash ASC");
  });
});
