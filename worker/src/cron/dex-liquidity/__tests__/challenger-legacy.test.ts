import { describe, expect, it, vi } from "vitest";
import { loadPublishedDexPoolChallengers } from "../challenger-load";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";

describe("challenger legacy fallback", () => {
  it("falls back safely when the challenger tables are absent", async () => {
    const db = mockD1(
      [
        {
          match: "FROM dex_price_challenger_snapshots",
          rows: [],
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

    const result = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 120);

    expect(result.diagnostics.missingTables).toBe(true);
    expect(result.diagnostics.mode).toBe("legacy");
    expect(result.challengersByStablecoin.get("coin-z")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-z",
        poolId: "coin-z:legacy-top",
        sourceFamily: "legacy-top-pools",
        priceUsd: 0.993,
        tvlUsd: 30_000,
      }),
    ]);
    expect(result.challengersByStablecoin.get("coin-y")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-y",
        poolId: "coin-y:legacy-source:Base",
        sourceFamily: "legacy-price-sources",
        priceUsd: 0.989,
        tvlUsd: 40_000,
      }),
    ]);
  });

  it("logs and skips malformed legacy challenger JSON payloads", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = mockD1(
      [
        {
          match: "FROM dex_price_challenger_snapshots",
          rows: [],
          throwError: new Error("no such table: dex_price_challenger_snapshots"),
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
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes("owner=challenger-persistence")
        && String(message).includes("context=dex_liquidity.top_pools_json"),
      ),
    ).toBe(true);
    expect(
      warnSpy.mock.calls.some(([message]) =>
        String(message).includes("owner=challenger-persistence")
        && String(message).includes("context=dex_prices.price_sources_json"),
      ),
    ).toBe(true);

    warnSpy.mockRestore();
  });
});
