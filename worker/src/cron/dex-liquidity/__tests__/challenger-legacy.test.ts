import { describe, expect, it } from "vitest";
import { loadPublishedDexPoolChallengers } from "../challenger-load";
import { mockD1 } from "@shared/test-utils/mock-d1";

describe("challenger legacy fallback", () => {
  it("surfaces a missing mandatory challenger snapshot table", async () => {
    const db = mockD1(
      [
        {
          match: "FROM dex_price_challenger_snapshots",
          rows: [{
            stablecoin_id: "coin-z",
            snapshot_at: 100,
            published_at: 100,
            has_rows: 0,
            source_coverage_complete: 0,
          }],
          throwError: new Error("no such table: dex_price_challenger_snapshots"),
        },
        {
          match: "FROM dex_price_challengers",
          rows: [],
          throwError: new Error("no such table: dex_price_challengers"),
        },
        {
          match: "FROM dex_liquidity",
          rows: [
            {
              stablecoin_id: "coin-z",
              top_pools_json: JSON.stringify([
                {
                  poolId: "coin-z:legacy-top",
                  chain: "Ethereum",
                  project: "legacy-top",
                  tvlUsd: 30_000,
                  price: 0.993,
                },
              ]),
              updated_at: 100,
            },
          ],
        },
        {
          match: "FROM dex_prices",
          rows: [
            {
              stablecoin_id: "coin-y",
              price_sources_json: JSON.stringify([
                {
                  protocol: "legacy-source",
                  chain: "Base",
                  price: 0.989,
                  tvl: 40_000,
                },
              ]),
              updated_at: 100,
            },
          ],
        },
      ],
      { requireMatch: true },
    );

    await expect(
      loadPublishedDexPoolChallengers(db, 20_000, 1_000, 120),
    ).rejects.toThrow("no such table: dex_price_challenger_snapshots");
  });

  it("skips malformed legacy challenger JSON payloads", async () => {
    const db = mockD1(
      [
        {
          match: "FROM dex_price_challenger_snapshots",
          rows: [],
        },
        {
          match: "FROM dex_price_challengers",
          rows: [],
        },
        {
          match: "FROM dex_liquidity",
          rows: [
            {
              stablecoin_id: "coin-z",
              top_pools_json: "{bad-json",
              updated_at: 100,
            },
          ],
        },
        {
          match: "FROM dex_prices",
          rows: [
            {
              stablecoin_id: "coin-y",
              price_sources_json: "{bad-json",
              updated_at: 100,
            },
          ],
        },
      ],
      { requireMatch: true },
    );

    const result = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 120);

    expect(result.diagnostics.mode).toBe("absent");
    expect(result.challengersByStablecoin.size).toBe(0);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM dex_liquidity"))).toBe(true);
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM dex_prices"))).toBe(true);
  });
});
