import { describe, expect, it, vi } from "vitest";
import {
  buildDexPriceChallengerPublicationPlan,
  getDexPriceChallengerPublicationStatements,
  loadPublishedDexPoolChallengers,
  selectDexPriceChallengerRowsFromPools,
} from "../dex-liquidity/challenger-persistence";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";

describe("challenger persistence", () => {
  it("builds payload statements before snapshot metadata and suppresses incomplete coverage snapshots", () => {
    const completePlan = buildDexPriceChallengerPublicationPlan({
      stablecoinId: "USDT-TETHER",
      snapshotAt: 1_700_000_000.9,
      publishedAt: 1_700_000_111.2,
      sourceCoverageComplete: true,
      rows: [
        {
          stablecoinId: "usdt-tether",
          poolId: "pool-a",
          chain: "Ethereum",
          protocol: "curve",
          sourceFamily: "gecko-terminal",
          priceUsd: 0.999,
          tvlUsd: 10_000,
        },
        {
          stablecoinId: "USDT-TETHER",
          poolId: "pool-b",
          chain: "Base",
          protocol: "aerodrome",
          sourceFamily: "gecko-terminal",
          priceUsd: 1.001,
          tvlUsd: 15_000,
        },
      ],
    });

    expect(completePlan.skipReason).toBeNull();
    expect(completePlan.shouldPublishSnapshot).toBe(true);
    expect(completePlan.payloadStatements).toHaveLength(2);
    expect(completePlan.snapshotStatement).not.toBeNull();

    const ordered = getDexPriceChallengerPublicationStatements(completePlan);
    expect(ordered.map((stmt) => stmt.sql)).toEqual([
      completePlan.payloadStatements[0]!.sql,
      completePlan.payloadStatements[1]!.sql,
      completePlan.snapshotStatement!.sql,
    ]);

    const incompletePlan = buildDexPriceChallengerPublicationPlan({
      stablecoinId: "usdt-tether",
      snapshotAt: 1_700_000_000,
      sourceCoverageComplete: false,
      rows: [
        {
          stablecoinId: "usdt-tether",
          poolId: "pool-a",
          chain: "Ethereum",
          protocol: "curve",
          sourceFamily: "gecko-terminal",
          priceUsd: 0.999,
          tvlUsd: 10_000,
        },
      ],
    });

    expect(incompletePlan.skipReason).toBe("incomplete-coverage");
    expect(incompletePlan.shouldPublishSnapshot).toBe(false);
    expect(incompletePlan.snapshotStatement).toBeNull();
    expect(incompletePlan.payloadStatements).toHaveLength(1);
  });

  it("loads published challenger snapshots when present, falls back per coin, and keeps empty snapshots authoritative", async () => {
    const db = mockD1(
      [
        {
          match: "FROM sqlite_master",
          rows: [
            { name: "dex_price_challengers" },
            { name: "dex_price_challenger_snapshots" },
          ],
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

  it("falls back safely when the challenger tables are absent", async () => {
    const db = mockD1(
      [
        {
          match: "FROM sqlite_master",
          rows: [],
        },
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
          match: "FROM sqlite_master",
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

  it("excludes blocked dead DEX pools from challenger selection", () => {
    const rows = selectDexPriceChallengerRowsFromPools(
      "usr-resolv",
      [
        {
          poolId: "ethereum:bunni-1",
          project: "bunni-ethereum",
          chain: "Ethereum",
          tvlUsd: 1_451_774,
          symbol: "USR-USDC",
          volumeUsd1d: 12_000,
          volumeUsd7d: 84_000,
          poolType: "generic",
          source: "gecko_terminal",
          price: 0.9993,
        },
        {
          poolId: "ethereum:curve-1",
          project: "curve",
          chain: "Ethereum",
          tvlUsd: 64_711,
          symbol: "USR-USDC",
          volumeUsd1d: 8_000,
          volumeUsd7d: 56_000,
          poolType: "curve-stableswap",
          source: "dl",
          price: 0.1152,
        },
      ],
      20_000,
    );

    expect(rows).toEqual([
      expect.objectContaining({
        poolId: "ethereum:curve-1",
        protocol: "curve",
        priceUsd: 0.1152,
        tvlUsd: 64_711,
      }),
    ]);
  });
});
