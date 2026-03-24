import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeDexLiquidityRow } from "./helpers/fixtures";
import { handleDexLiquidity } from "../dex-liquidity";

describe("handleDexLiquidity", () => {
  const row = makeDexLiquidityRow();

  it("returns 200 with liquidity map", async () => {
    const db = mockD1([
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
  });

  it("returns 200 with empty map when no data", async () => {
    const db = mockD1([
      { match: "dex_liquidity", rows: [] },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const res = await handleDexLiquidity(db);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({});
  });

  it("includes v2 fields in response", async () => {
    const db = mockD1([
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
    const db = mockD1([
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
    const db = mockD1([
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

  it("classifies partial measured liquidity separately", async () => {
    const db = mockD1([
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
    const db = mockD1([
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
    const db = mockD1([
      { match: "dex_liquidity", rows: [legacyRow] },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const res = await handleDexLiquidity(db);
    const body = (await res.json()) as Record<string, { methodologyVersion: string }>;
    expect(body["usdt-tether"]?.methodologyVersion).toBe("3.0");
  });

  it("adds a Warning header when the latest liquidity cron run was degraded", async () => {
    const db = mockD1([
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
    const db = mockD1([
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
    const db = mockD1([
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

  it("normalizes legacy topPools source values and uses latest successful cron timestamp for freshness", async () => {
    const legacySourceRow = {
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
    const latestCronStartedAt = 1_700_000_600;
    const db = mockD1([
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
      {
        match: "MAX(started_at)",
        rows: [],
        first: { started_at: latestCronStartedAt },
      },
      {
        match: "cron_runs",
        rows: [],
        first: { status: "ok", metadata: null },
      },
      { match: "dex_liquidity", rows: [legacySourceRow] },
    ]);

    const before = Math.floor(Date.now() / 1000);
    const res = await handleDexLiquidity(db);
    const after = Math.floor(Date.now() / 1000);
    const body = (await res.json()) as Record<string, { topPools: Array<{ source?: string }> }>;
    expect(body["usdt-tether"]?.topPools.map((pool) => pool.source)).toEqual(["cg_onchain", "gecko_terminal"]);

    const age = Number(res.headers.get("X-Data-Age"));
    expect(age).toBeGreaterThanOrEqual(before - latestCronStartedAt);
    expect(age).toBeLessThanOrEqual(after - latestCronStartedAt);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
