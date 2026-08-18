import { describe, it, expect, vi } from "vitest";
import { mockD1, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import { makeDexLiquidityRow } from "../../test-helpers/__shared/fixtures";
import { handleDexLiquidity } from "../dex-liquidity";

function makeDexDeploymentOutcomeFallbackTable() {
  return { match: "FROM dex_deployment_outcomes", rows: [] };
}

function mockDexD1(tables: MockTableConfig[]) {
  return mockD1([...tables, makeDexDeploymentOutcomeFallbackTable()]);
}

describe("handleDexLiquidity", () => {
  const row = makeDexLiquidityRow();

  it("returns 200 with liquidity map", async () => {
    const db = mockDexD1([
      { match: "dex_liquidity", rows: [row] },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const res = await handleDexLiquidity(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("usdt-tether");
    const coin = body["usdt-tether"] as Record<string, unknown>;
    expect(coin).toHaveProperty("totalTvlUsd");
    expect(coin).toHaveProperty("liquidityScore");
    expect(coin).toHaveProperty("poolCount");
    expect(coin).toHaveProperty("chainCount");
    expect(coin).toHaveProperty("protocolTvl");
    expect(coin).toHaveProperty("topPools");
    expect(coin).toHaveProperty("updatedAt");
    expect(coin).toHaveProperty("methodologyVersion");
    expect(coin).toHaveProperty("coverageClass");
    expect(coin).toHaveProperty("coverageConfidence");
    expect(coin).toHaveProperty("liquidityEvidenceClass");
    expect(coin).toHaveProperty("hasMeasuredLiquidityEvidence");
    expect(coin).toHaveProperty("trendworthy");
    expect(coin).toHaveProperty("sourceMix");
    expect(coin).toHaveProperty("deploymentCoverage");
  });

  it("returns null 7d volume when the producer marked 7d volume as unmeasured", async () => {
    const db = mockDexD1([
      {
        match: "dex_liquidity",
        rows: [
          makeDexLiquidityRow({
            total_volume_24h_usd: 2_890_000,
            total_volume_7d_usd: 0,
            total_volume_7d_measured: 0,
            top_pools_json: JSON.stringify([
              {
                project: "gate",
                chain: "orderbook",
                tvlUsd: 517_330,
                symbol: "GUSD/USDT",
                volumeUsd1d: 2_890_000,
                poolType: "cex-orderbook",
                source: "cg_tickers",
              },
            ]),
          }),
        ],
      },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);

    const res = await handleDexLiquidity(db);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;

    expect(body["usdt-tether"]?.totalVolume24hUsd).toBe(2_890_000);
    expect(body["usdt-tether"]?.totalVolume7dUsd).toBeNull();
    expect((body["usdt-tether"]?.topPools as Array<Record<string, unknown>>)[0]?.volumeUsd7d).toBeUndefined();
  });

  it("infers null 7d volume for pre-migration fallback rows whose top pools lack 7d volume", async () => {
    const db = mockDexD1([
      {
        match: "dex_liquidity",
        rows: [
          makeDexLiquidityRow({
            total_volume_24h_usd: 100_000,
            total_volume_7d_usd: 0,
            total_volume_7d_measured: undefined,
            top_pools_json: JSON.stringify([
              {
                project: "gate",
                chain: "orderbook",
                tvlUsd: 50_000,
                symbol: "GUSD/USDT",
                volumeUsd1d: 100_000,
                poolType: "cex-orderbook",
                source: "cg_tickers",
              },
            ]),
          }),
        ],
      },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);

    const res = await handleDexLiquidity(db);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;

    expect(body["usdt-tether"]?.totalVolume7dUsd).toBeNull();
  });

  it("keeps measured pre-migration 7d volume when top pools include finite 7d volume", async () => {
    const db = mockDexD1([
      {
        match: "dex_liquidity",
        rows: [
          makeDexLiquidityRow({
            total_volume_7d_usd: 700_000,
            total_volume_7d_measured: undefined,
            top_pools_json: JSON.stringify([
              {
                project: "curve",
                chain: "Ethereum",
                tvlUsd: 500_000,
                symbol: "USDT/USDC",
                volumeUsd1d: 100_000,
                volumeUsd7d: 700_000,
                poolType: "curve-stableswap",
                source: "dl",
              },
            ]),
          }),
        ],
      },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);

    const res = await handleDexLiquidity(db);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;

    expect(body["usdt-tether"]?.totalVolume7dUsd).toBe(700_000);
    expect((body["usdt-tether"]?.topPools as Array<Record<string, unknown>>)[0]?.volumeUsd7d).toBe(700_000);
  });

  it("exposes exact deployment outcome truth", async () => {
    const db = mockDexD1([
      { match: "FROM dex_liquidity\n", rows: [row] },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
      {
        match: "dex_deployment_outcomes",
        rows: [{
          stablecoin_id: "usdt-tether",
          chain: "ethereum",
          contract_address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
          outcome: "verified_no_pools",
          provider_set_json: JSON.stringify(["coingecko", "dexscreener"]),
          reason: "verified empty",
          observed_pool_count: 0,
          observed_at: Math.floor(Date.now() / 1000),
          waiver_owner: null,
          waiver_reason: null,
          waiver_expires_at: null,
        }],
      },
    ]);

    const res = await handleDexLiquidity(db);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    expect(body["usdt-tether"]?.deploymentCoverage).toMatchObject({
      observedPools: 0,
      verifiedNoPools: 1,
      providerInaccessible: 0,
    });
  });

  it("logs malformed persisted JSON fields and falls back safely", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = mockDexD1([
      {
        match: "dex_liquidity",
        rows: [makeDexLiquidityRow({ protocol_tvl_json: "{bad-json" })],
      },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);

    const res = await handleDexLiquidity(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    expect(body["usdt-tether"]?.protocolTvl).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[cache] Failed to parse persisted JSON (dex-liquidity:usdt-tether:protocol_tvl_json); count=1:"),
    );
    warn.mockRestore();
  });

  it("returns 200 with empty map when no data", async () => {
    const db = mockDexD1([
      { match: "dex_liquidity", rows: [] },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const res = await handleDexLiquidity(db);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({});
  });

  // Fails closed: the router boundary turns this throw into the JSON 500 pinned by
  // `router-contract.test.ts` ("returns a router-level JSON 500 when an unwrapped
  // route handler throws"). Asserting the throw here keeps the cause visible.
  it("fails closed when dex_prices fails unexpectedly", async () => {
    const db = mockDexD1([
      { match: "dex_liquidity", rows: [row] },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [], throwError: new Error("database is locked") },
    ]);

    await expect(handleDexLiquidity(db)).rejects.toThrow("database is locked");
  });

  it("treats dex_prices as optional when the table is not deployed yet", async () => {
    const db = mockDexD1([
      { match: "dex_liquidity", rows: [row] },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [], throwError: new Error("no such table: dex_prices") },
    ]);

    const res = await handleDexLiquidity(db);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    expect(body["usdt-tether"]?.dexPriceUsd).toBeNull();
    expect(body["usdt-tether"]?.priceSources).toBeNull();
  });

  it("treats deployment outcomes as optional when the table is not deployed yet", async () => {
    const db = mockDexD1([
      { match: "dex_liquidity", rows: [row] },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
      {
        match: "dex_deployment_outcomes",
        rows: [],
        throwError: new Error("no such table: dex_deployment_outcomes"),
      },
    ]);

    const res = await handleDexLiquidity(db);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    expect(body["usdt-tether"]?.deploymentCoverage).toBeNull();
  });

  it("fails closed when deployment outcomes fail unexpectedly", async () => {
    const db = mockDexD1([
      { match: "dex_liquidity", rows: [row] },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
      {
        match: "dex_deployment_outcomes",
        rows: [],
        throwError: new Error("database is locked"),
      },
    ]);

    await expect(handleDexLiquidity(db)).rejects.toThrow("database is locked");
  });

  it("falls back to row timestamps when cron freshness lookups fail", async () => {
    const staleRow = makeDexLiquidityRow({ updated_at: 1_700_000_000 });
    const db = mockDexD1([
      { match: "dex_liquidity_history", rows: [] },
      {
        match: "dex_prices",
        rows: [{
          stablecoin_id: "usdt-tether",
          dex_price_usd: 0.999,
          deviation_from_primary_bps: -10,
          source_pool_count: 2,
          source_total_tvl: 1_250_000,
          price_sources_json: JSON.stringify([{ source: "curve" }]),
          updated_at: 1_700_000_010,
        }],
      },
      { match: "MAX(started_at)", rows: [], throwError: new Error("cron max unavailable") },
      { match: "ORDER BY started_at DESC", rows: [], throwError: new Error("cron latest unavailable") },
      { match: "dex_liquidity", rows: [staleRow] },
    ]);

    const before = Math.floor(Date.now() / 1000);
    const res = await handleDexLiquidity(db);
    const after = Math.floor(Date.now() / 1000);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    expect(body["usdt-tether"]?.dexPriceUsd).toBe(0.999);
    expect(body["usdt-tether"]?.priceSources).toEqual([{ source: "curve" }]);
    const age = Number(res.headers.get("X-Data-Age"));
    expect(age).toBeGreaterThanOrEqual(before - staleRow.updated_at);
    expect(age).toBeLessThanOrEqual(after - staleRow.updated_at);
  });

  it("overrides coverageClass to null for the __global__ sentinel row", async () => {
    const globalRow = makeDexLiquidityRow({
      stablecoin_id: "__global__",
      coverage_class: "unobserved",
    });
    const db = mockDexD1([
      { match: "dex_liquidity", rows: [globalRow] },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const res = await handleDexLiquidity(db);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    expect(body["__global__"]?.coverageClass).toBeNull();
  });

  it("includes v2 fields in response", async () => {
    const db = mockDexD1([
      { match: "dex_liquidity", rows: [row] },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const res = await handleDexLiquidity(db);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    const coin = body["usdt-tether"];
    expect(coin).toHaveProperty("effectiveTvlUsd");
    expect(coin).toHaveProperty("avgPoolStress");
    expect(coin).toHaveProperty("weightedBalanceRatio");
    expect(coin).toHaveProperty("organicFraction");
    expect(coin).toHaveProperty("durabilityScore");
    expect(coin).toHaveProperty("balanceMeasuredTvlUsd");
    expect(coin).toHaveProperty("organicMeasuredTvlUsd");
  });

  it("classifies observed but unmeasured liquidity explicitly", async () => {
    const db = mockDexD1([
      {
        match: "dex_liquidity",
        rows: [makeDexLiquidityRow({
          total_tvl_usd: 2_000_000,
          balance_measured_tvl_usd: 0,
          coverage_class: "fallback",
          coverage_confidence: 0.5,
        })],
      },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const res = await handleDexLiquidity(db);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    const coin = body["usdt-tether"];
    expect(coin?.liquidityEvidenceClass).toBe("observed_unmeasured");
    expect(coin?.hasMeasuredLiquidityEvidence).toBe(false);
    expect(coin?.trendworthy).toBe(false);
  });

  it("classifies strong measured liquidity and marks high-confidence snapshots trendworthy", async () => {
    const db = mockDexD1([
      {
        match: "dex_liquidity",
        rows: [makeDexLiquidityRow({
          total_tvl_usd: 2_000_000,
          balance_measured_tvl_usd: 1_900_000,
          coverage_class: "primary",
          coverage_confidence: 0.9,
        })],
      },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const res = await handleDexLiquidity(db);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    const coin = body["usdt-tether"];
    expect(coin?.liquidityEvidenceClass).toBe("measured");
    expect(coin?.hasMeasuredLiquidityEvidence).toBe(true);
    expect(coin?.trendworthy).toBe(true);
  });

  it("uses coverage confidence instead of balance ratio for liquidity evidence", async () => {
    const db = mockDexD1([
      {
        match: "dex_liquidity",
        rows: [makeDexLiquidityRow({
          total_tvl_usd: 2_000_000,
          balance_measured_tvl_usd: 2_000_000,
          coverage_class: "fallback",
          coverage_confidence: 0.5,
        })],
      },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const res = await handleDexLiquidity(db);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    const coin = body["usdt-tether"];
    expect(coin?.liquidityEvidenceClass).toBe("observed_unmeasured");
    expect(coin?.hasMeasuredLiquidityEvidence).toBe(false);
    expect(coin?.trendworthy).toBe(false);
  });

  it("classifies partial measured liquidity separately", async () => {
    const db = mockDexD1([
      {
        match: "dex_liquidity",
        rows: [makeDexLiquidityRow({
          total_tvl_usd: 2_000_000,
          balance_measured_tvl_usd: 900_000,
          coverage_class: "mixed",
          coverage_confidence: 0.8,
        })],
      },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const res = await handleDexLiquidity(db);
    const body = (await res.json()) as Record<string, Record<string, unknown>>;
    const coin = body["usdt-tether"];
    expect(coin?.liquidityEvidenceClass).toBe("partial_measured");
    expect(coin?.hasMeasuredLiquidityEvidence).toBe(true);
    expect(coin?.trendworthy).toBe(true);
  });

  it("includes X-Data-Age header", async () => {
    const db = mockDexD1([
      { match: "dex_liquidity", rows: [row] },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const res = await handleDexLiquidity(db);
    expect(res.headers.has("X-Data-Age")).toBe(true);
  });

  it("reconstructs methodologyVersion from updatedAt when DB version is null", async () => {
    const legacyRow = {
      ...makeDexLiquidityRow({
        updated_at: 1772280000, // v3.0 window
      }),
      methodology_version: null,
    };
    const db = mockDexD1([
      { match: "dex_liquidity", rows: [legacyRow] },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const res = await handleDexLiquidity(db);
    const body = (await res.json()) as Record<string, { methodologyVersion: string }>;
    expect(body["usdt-tether"]?.methodologyVersion).toBe("3.0");
  });

  it("adds a Warning header when the latest liquidity cron run was degraded", async () => {
    const db = mockDexD1([
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
      {
        match: "cron_runs",
        rows: [],
        first: {
          status: "degraded",
          metadata: JSON.stringify({
            failedSources: ["defillama-yields"],
            sourceCoverage: {
              nearCoverageGuard: true,
              nearValueGuard: false,
              nearMajorCoverageGuard: false,
            },
          }),
        },
      },
      { match: "dex_liquidity", rows: [row] },
    ]);

    const res = await handleDexLiquidity(db);
    expect(res.headers.get("Warning") ?? "").toContain("Latest sync-dex-liquidity run degraded");
    expect(res.headers.get("Warning") ?? "").toContain("failedSources=defillama-yields");
  });

  it("adds a Warning header when the latest liquidity cron run is ok but shows high quality drift", async () => {
    const db = mockDexD1([
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
      {
        match: "cron_runs",
        rows: [],
        first: {
          status: "ok",
          metadata: JSON.stringify({
            sourceCoverage: {
              qualityDriftSeverity: "high",
              qualityDriftFlags: ["price-observation-drop", "measured-balance-drop"],
            },
          }),
        },
      },
      { match: "dex_liquidity", rows: [row] },
    ]);

    const res = await handleDexLiquidity(db);
    expect(res.headers.get("Warning") ?? "").toContain("shows high quality drift");
    expect(res.headers.get("Warning") ?? "").toContain("qualityDrift=high");
  });

  it("adds a failure warning when the latest liquidity cron run errored", async () => {
    const db = mockDexD1([
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
      {
        match: "cron_runs",
        rows: [],
        first: {
          status: "error",
          metadata: JSON.stringify({
            failedSources: ["defillama-yields"],
            sourceCoverage: {
              nearValueGuard: true,
            },
          }),
        },
      },
      { match: "dex_liquidity", rows: [row] },
    ]);

    const res = await handleDexLiquidity(db);
    expect(res.headers.get("Warning") ?? "").toContain("run failed");
    expect(res.headers.get("Warning") ?? "").toContain("failedSources=defillama-yields");
    expect(res.headers.get("Warning") ?? "").toContain("nearValueGuard");
  });

  it("omits retired topPools source values and uses score-row time for freshness", async () => {
    const retiredSourceRow = {
      ...makeDexLiquidityRow({
        updated_at: 1_700_000_000,
        top_pools_json: JSON.stringify([
          {
            project: "uniswap-v4",
            chain: "Ethereum",
            tvlUsd: 100_000,
            symbol: "USDC / USDT",
            volumeUsd1d: 50_000,
            poolType: "generic",
            source: "cg",
          },
          {
            project: "camelot-v3",
            chain: "Arbitrum",
            tvlUsd: 50_000,
            symbol: "USDC / USDT",
            volumeUsd1d: 10_000,
            poolType: "generic",
            source: "gt",
          },
        ]),
      }),
    };
    const scoreUpdatedAt = retiredSourceRow.updated_at;
    const db = mockDexD1([
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
      {
        match: "cron_runs",
        rows: [],
        first: { status: "ok", metadata: null },
      },
      { match: "dex_liquidity", rows: [retiredSourceRow] },
    ]);

    const before = Math.floor(Date.now() / 1000);
    const res = await handleDexLiquidity(db);
    const after = Math.floor(Date.now() / 1000);
    const body = (await res.json()) as Record<string, { topPools: Array<{ source?: string }> }>;
    expect(body["usdt-tether"]?.topPools.map((pool) => pool.source)).toEqual([undefined, undefined]);

    const age = Number(res.headers.get("X-Data-Age"));
    expect(age).toBeGreaterThanOrEqual(before - scoreUpdatedAt);
    expect(age).toBeLessThanOrEqual(after - scoreUpdatedAt);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
