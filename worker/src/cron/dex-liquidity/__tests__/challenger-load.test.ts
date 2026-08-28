import { describe, expect, it } from "vitest";
import { loadPublishedDexPoolChallengers } from "../challenger-load";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";

describe("challenger load", () => {
  it("does not run the full legacy JSON load when published snapshots cover", async () => {
    const db = mockD1(
      [
        {
          match: "SELECT stablecoin_id\n     FROM dex_liquidity",
          rows: [],
        },
        {
          match: "SELECT stablecoin_id\n     FROM dex_prices",
          rows: [],
        },
        {
          match: "FROM dex_price_challenger_snapshots",
          rows: [
            {
              stablecoin_id: "coin-a",
              snapshot_at: 100,
              published_at: 110,
              has_rows: 1,
              source_coverage_complete: 1,
            },
          ],
        },
        {
          match: "FROM dex_price_challengers",
          rows: [
            {
              stablecoin_id: "coin-a",
              snapshot_at: 100,
              pool_id: "coin-a:published",
              chain: "Ethereum",
              protocol: "published-protocol",
              source_family: "published",
              price_usd: 0.998,
              tvl_usd: 50_000,
            },
          ],
        },
      ],
      { requireMatch: true },
    ) as MockD1Database;

    const result = await loadPublishedDexPoolChallengers(db, 20_000, 1_000, 120);

    expect(result.diagnostics.mode).toBe("published");
    expect(result.diagnostics.legacyFallbackCoins).toEqual([]);
    expect(result.challengersByStablecoin.get("coin-a")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-a",
        poolId: "coin-a:published",
        sourceFamily: "published",
        priceUsd: 0.998,
        tvlUsd: 50_000,
      }),
    ]);
    expect(
      db.getHistory().some((entry) =>
        entry.sql.includes("SELECT stablecoin_id, top_pools_json")
        || entry.sql.includes("SELECT stablecoin_id, price_sources_json"),
      ),
    ).toBe(false);
  });

  it("loads published challenger snapshots when present, falls back per coin, and keeps empty snapshots authoritative", async () => {
    const db = mockD1(
      [
        {
          match: "FROM dex_price_challenger_snapshots",
          rows: [
            {
              stablecoin_id: "coin-a",
              snapshot_at: 100,
              published_at: 110,
              has_rows: 1,
              source_coverage_complete: 1,
            },
            {
              stablecoin_id: "coin-b",
              snapshot_at: 100,
              published_at: 110,
              has_rows: 0,
              source_coverage_complete: 1,
            },
            {
              stablecoin_id: "coin-c",
              snapshot_at: 100,
              published_at: 110,
              has_rows: 1,
              source_coverage_complete: 0,
            },
          ],
        },
        {
          match: "FROM dex_price_challengers",
          rows: [
            {
              stablecoin_id: "coin-a",
              snapshot_at: 100,
              pool_id: "coin-a:published",
              chain: "Ethereum",
              protocol: "published-protocol",
              source_family: "published",
              price_usd: 0.998,
              tvl_usd: 50_000,
            },
            {
              stablecoin_id: "coin-b",
              snapshot_at: 100,
              pool_id: "coin-b:published",
              chain: "Base",
              protocol: "published-protocol",
              source_family: "published",
              price_usd: 0.997,
              tvl_usd: 40_000,
            },
            {
              stablecoin_id: "coin-c",
              snapshot_at: 100,
              pool_id: "coin-c:published",
              chain: "Solana",
              protocol: "published-protocol",
              source_family: "published",
              price_usd: 0.996,
              tvl_usd: 30_000,
            },
          ],
        },
        {
          match: "FROM dex_liquidity",
          rows: [
            {
              stablecoin_id: "coin-b",
              top_pools_json: JSON.stringify([
                {
                  poolId: "coin-b:legacy-top",
                  chain: "Base",
                  project: "legacy-top",
                  tvlUsd: 45_000,
                  price: 0.991,
                },
              ]),
              updated_at: 100,
            },
            {
              stablecoin_id: "coin-c",
              top_pools_json: JSON.stringify([
                {
                  poolId: "coin-c:legacy-top",
                  chain: "Solana",
                  project: "legacy-top",
                  tvlUsd: 35_000,
                  price: 0.988,
                },
              ]),
              updated_at: 100,
            },
            {
              stablecoin_id: "coin-d",
              top_pools_json: JSON.stringify([
                {
                  poolId: "coin-d:legacy-top",
                  chain: "Ethereum",
                  project: "legacy-top",
                  tvlUsd: 25_000,
                  price: 0.985,
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
              stablecoin_id: "coin-e",
              price_sources_json: JSON.stringify([
                {
                  protocol: "legacy-source",
                  chain: "Arbitrum",
                  price: 0.982,
                  tvl: 60_000,
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

    expect(result.diagnostics.mode).toBe("mixed");
    expect(result.diagnostics.missingTables).toBe(false);
    expect(result.diagnostics.emptyPublishedCoins).toEqual(["coin-b"]);
    expect(result.diagnostics.incompletePublishedCoins).toEqual(["coin-c"]);
    expect(new Set(result.diagnostics.legacyFallbackCoins)).toEqual(new Set(["coin-c", "coin-d", "coin-e"]));

    expect(result.challengersByStablecoin.get("coin-a")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-a",
        poolId: "coin-a:published",
        sourceFamily: "published",
        priceUsd: 0.998,
        tvlUsd: 50_000,
        snapshotAt: 100,
        publishedAt: 110,
      }),
    ]);
    expect(result.challengersByStablecoin.get("coin-b")).toEqual([]);
    expect(result.challengersByStablecoin.get("coin-c")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-c",
        poolId: "coin-c:legacy-top",
        sourceFamily: "legacy-top-pools",
        priceUsd: 0.988,
        tvlUsd: 35_000,
        snapshotAt: 100,
        publishedAt: 100,
      }),
    ]);
    expect(result.challengersByStablecoin.get("coin-d")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-d",
        poolId: "coin-d:legacy-top",
        sourceFamily: "legacy-top-pools",
        priceUsd: 0.985,
        tvlUsd: 25_000,
        snapshotAt: 100,
        publishedAt: 100,
      }),
    ]);
    expect(result.challengersByStablecoin.get("coin-e")).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-e",
        poolId: "coin-e:legacy-source:Arbitrum",
        sourceFamily: "legacy-price-sources",
        priceUsd: 0.982,
        tvlUsd: 60_000,
        snapshotAt: 100,
        publishedAt: 100,
      }),
    ]);
  });
});
