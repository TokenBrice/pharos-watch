import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { describe, expect, it } from "vitest";
import { loadStablecoinCoverageHealth } from "../stablecoin-publication-health";

describe("stablecoin publication health", () => {
  it("queries only runs that carry exact publication evidence", async () => {
    const activeIds = [...ACTIVE_IDS];
    let queriedSql = "";
    const db = {
      prepare: (sql: string) => {
        queriedSql = sql;
        return {
          first: async () => ({
            started_at: 1_700_000_000,
            metadata: JSON.stringify({
              activePublicationCoverage: {
                complete: true,
                expectedActiveCount: activeIds.length,
                presentActiveCount: activeIds.length,
                waivedActiveCount: 0,
                missingActiveIds: [],
                waivedActiveIds: [],
                expiredWaiverIds: [],
              },
              activePriceCoverage: {
                complete: true,
                expectedActiveCount: activeIds.length,
                presentActiveCount: activeIds.length,
                pricedActiveCount: activeIds.length,
                pricedActiveIds: activeIds,
                missingPriceCount: 0,
                missingActiveIds: [],
              },
            }),
          }),
        };
      },
    } as unknown as D1Database;

    const result = await loadStablecoinCoverageHealth(db);

    expect(queriedSql).toContain(`metadata LIKE '%"activePublicationCoverage"%'`);
    expect(queriedSql).toContain(`metadata LIKE '%"activePriceCoverage"%'`);
    expect(result.publication.status).toBe("complete");
    expect(result.activePriceCoverage.status).toBe("complete");
  });
});
