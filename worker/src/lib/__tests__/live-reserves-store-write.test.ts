import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "../collections";
import { cleanupStaleLiveReserveArtifacts } from "../live-reserves-store-write";

describe("cleanupStaleLiveReserveArtifacts", () => {
  it("chunks stale artifact deletes under the D1 IN-clause bind limit", async () => {
    const staleIds = Array.from({ length: D1_SAFE_IN_CLAUSE_BIND_LIMIT + 11 }, (_, index) => `stale-${index}`);
    const staleBreakerKeys = staleIds.map((id) => `circuit:live-reserves:${id}`);
    const db = mockD1([
      {
        match: "SELECT stablecoin_id FROM reserve_sync_state",
        rows: staleIds.map((stablecoin_id) => ({ stablecoin_id })),
      },
      {
        match: "SELECT stablecoin_id FROM reserve_composition",
        rows: staleIds.map((stablecoin_id) => ({ stablecoin_id })),
      },
      {
        match: "SELECT key FROM cache WHERE key LIKE 'circuit:live-reserves:%'",
        rows: staleBreakerKeys.map((key) => ({ key })),
      },
      { match: "DELETE FROM reserve_sync_state", rows: [], runMeta: { changes: 1 } },
      { match: "DELETE FROM reserve_composition", rows: [], runMeta: { changes: 1 } },
      { match: "DELETE FROM cache WHERE key", rows: [], runMeta: { changes: 1 } },
    ]);

    const result = await cleanupStaleLiveReserveArtifacts(db, [], new Set());

    expect(result).toEqual({
      syncStateDeleted: 2,
      compositionDeleted: 2,
      breakerCacheDeleted: 2,
    });

    const deleteRows = db.getHistory().filter((entry) => entry.sql.includes("DELETE FROM"));
    expect(deleteRows).toHaveLength(6);
    expect(Math.max(...deleteRows.map((entry) => entry.binds.length))).toBeLessThanOrEqual(
      D1_SAFE_IN_CLAUSE_BIND_LIMIT,
    );
  });
});
