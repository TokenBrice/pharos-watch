import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { loadStatusSupplements } from "../../lib/status/supplements";

const NOW = 1_775_910_000;

function stablecoinPayload(count = 2): string {
  return JSON.stringify({
    peggedAssets: Array.from({ length: count }, (_, index) => ({
      id: `coin-${index + 1}`,
      name: `Coin ${index + 1}`,
      symbol: `C${index + 1}`,
      pegType: "peggedUSD",
      pegMechanism: "fiat-backed",
      price: 1,
      priceSource: "test",
      circulating: { peggedUSD: 1_000_000 },
      chainCirculating: {
        Ethereum: {
          current: 1_000_000,
          circulatingPrevDay: 1_000_000,
          circulatingPrevWeek: 1_000_000,
          circulatingPrevMonth: 1_000_000,
        },
      },
      chains: ["Ethereum"],
    })),
  });
}

describe("loadStatusSupplements", () => {
  it("returns partial publication health and a section error when one surface fails", async () => {
    const updatedAt = NOW - 90;
    const db = mockD1([
      {
        match: "FROM yield_publication_generations",
        rows: [],
        throwError: new Error("D1_ERROR: query failed: yield publication ledger unavailable"),
      },
      {
        match: "FROM cache WHERE key = ?",
        rows: [
          {
            key: "stablecoins",
            value: stablecoinPayload(2),
            updated_at: updatedAt,
          },
          {
            key: "stablecoins:response-ready:v2",
            value: "{}",
            updated_at: updatedAt,
          },
        ],
      },
      { match: "FROM cache\n       WHERE key IN ('yield-rankings'", rows: [] },
      { match: "SELECT key, value FROM cache WHERE key IN (", rows: [] },
      { match: "SELECT key, LENGTH(value) as bytes FROM cache", rows: [] },
      { match: "FROM mint_burn_hourly INDEXED BY idx_mbh_ts", rows: [] },
      { match: "FROM (VALUES", rows: [] },
      { match: "FROM reserve_sync_state", rows: [] },
      { match: "FROM reserve_composition", rows: [] },
      { match: "JOIN reserve_sync_state", rows: [] },
      { match: "FROM dex_liquidity_publication_generations", rows: [], first: null },
      { match: "FROM surface_publication_generations", rows: [], first: null },
      { match: "FROM stability_index_samples", rows: [], first: null },
    ]);

    const supplements = await loadStatusSupplements(db, NOW, {});

    expect(supplements.publicationHealth).not.toBeNull();
    expect(supplements.publicationHealth?.surfaces.stablecoins).toBeUndefined();
    expect(supplements.publicationHealth?.surfaces["yield-rankings"]).toBeUndefined();
    expect(supplements.publicationHealth?.failedSurfaces).toEqual([
      {
        surface: "yield-rankings",
        code: "publication_surface_query_failed",
        message: "Publication surface query failed.",
      },
    ]);
    expect(supplements.sectionErrors.publicationHealth).toEqual({
      code: "publication_health_partial_failure",
      message: "Publication health partially unavailable.",
    });
  });
});
