import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { describe, it, expect, vi } from "vitest";
import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { makeDexLiquidityRow } from "../../test-helpers/__shared/fixtures";
import { handleDexLiquidity } from "../dex-liquidity";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { summarizeDexVolumeWindow, type DexPoolVolumeObservationInput } from "@shared/lib/dex-volume-availability";
import { DexLiquidityMapSchema } from "@shared/types/market";

function makeDexDeploymentOutcomeFallbackTable() {
  return { match: "FROM dex_deployment_outcomes", rows: [] };
}

function mockDexD1(tables: MockTableConfig[]) {
  return mockD1([...tables, makeDexDeploymentOutcomeFallbackTable(), { match: "cron_runs", rows: [], first: null }]);
}

describe("handleDexLiquidity", () => {
  const row = makeDexLiquidityRow();


  it.each([null, -120, -3 * 86400] as const)("never timestamps an empty DEX table with render time (producer offset %s)", async (offset) => {
    const now = 1_790_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      if (offset != null) {
        const publishedAt = now + offset;
        sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata) VALUES ('sync-dex-liquidity', ?, 1, 'ok', ?)")
          .run(publishedAt, JSON.stringify({ outputPublishedAt: publishedAt }));
      }
      // A successful no-output attempt does not replace the served generation.
      sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata) VALUES ('sync-dex-liquidity', ?, 1, 'ok', ?)")
        .run(now, JSON.stringify({ outputPublishedAt: null }));
      const res = await handleDexLiquidity(db);
      expect(await res.json()).toEqual({});
      if (offset == null) {
        expect(res.headers.get("X-Data-Updated-At")).toBe("unknown");
        expect(res.headers.get("X-Data-Age")).toBe("unavailable");
        expect(res.headers.get("X-Data-Freshness-Reason")).toBe("producer-history-missing");
        expect(res.headers.get("Cache-Control")).toBe("no-store");
      } else {
        expect(res.headers.get("X-Data-Updated-At")).toBe(String(now + offset));
        expect(res.headers.get("X-Data-Age")).toBe(String(-offset));
        expect(res.headers.get("Warning")?.includes("stale") ?? false).toBe(offset === -3 * 86400);
      }
    } finally {
      sqlite.close();
      vi.restoreAllMocks();
    }
  });
  it.each([false, true])("distinguishes an empty producer advisory read from failure=%s", async (failed) => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockDexD1([
      { match: "cron_runs", rows: [], first: null, ...(failed ? { throwError: new Error("cron-status read failed") } : {}) },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
      { match: "dex_liquidity", rows: [makeDexLiquidityRow({ updated_at: now })] },
    ]);
    const res = await handleDexLiquidity(db);
    const body = DexLiquidityMapSchema.parse(await readJsonResponse(res, 200));
    expect(body["usdt-tether"].advisoryUnavailableReason).toBe(failed ? "dex-advisory-read-failed" : null);
    if (failed) {
      expect(body["usdt-tether"].warning).toContain("dex-advisory-read-failed");
      expect(res.headers.get("Warning")).toContain("dex-advisory-read-failed");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    } else {
      expect(body["usdt-tether"].warning).toBeNull();
      expect(res.headers.get("Warning")).toBeNull();
    }
  });

  it.each([
    { coverage_class: "primary", coverage_confidence: null },
    { coverage_class: "invalid", coverage_confidence: 1 },
    { coverage_class: "primary", coverage_confidence: 2 },
  ])("quarantines invalid coverage %j without losing healthy assets", async (coverage) => {
    const db = mockDexD1([
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
      { match: "dex_liquidity", rows: [row, makeDexLiquidityRow({ stablecoin_id: "usdc-circle", ...coverage })] },
    ]);
    const body = DexLiquidityMapSchema.parse(await (await handleDexLiquidity(db)).json());
    expect(body["usdt-tether"].liquidityScore).toBe(row.liquidity_score);
    expect(body["usdt-tether"].unavailableReason).toBeNull();
    expect(body["usdc-circle"]).toMatchObject({
      unavailableReason: "invalid-coverage-evidence",
      liquidityScore: null, coverageClass: null, coverageConfidence: null,
      liquidityEvidenceClass: null, hasMeasuredLiquidityEvidence: false, trendworthy: false,
      tvlChange24h: null, tvlChange7d: null, scoreComponents: null, exitRouteObservations: null,
    });
  });

  it.each([
    ["stale", -7 * 86_400, 0, "stale-price"],
    ["other publication", -60, 0, "publication-mismatch"],
    ["future", 120, 0, "future-timestamp"],
    ["fresh", -30, -30, null],
    ["inclusive price budget", -86_400, -86_400, null],
  ] as const)("uses the price's own clock for %s evidence", async (_label, priceOffset, liquidityOffset, reason) => {
    const now = 1_790_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    try {
      const db = mockDexD1([
        { match: "dex_liquidity_history", rows: [] },
        { match: "dex_prices", rows: [{
          stablecoin_id: row.stablecoin_id, dex_price_usd: 0.81, deviation_from_primary_bps: -1900,
          source_pool_count: 2, source_total_tvl: 1_000_000,
          price_sources_json: JSON.stringify([{ protocol: "curve", chain: "Ethereum", price: 0.81, tvl: 1_000_000 }]),
          updated_at: now + priceOffset,
        }] },
        { match: "dex_liquidity", rows: [makeDexLiquidityRow({ updated_at: now + liquidityOffset })] },
      ]);
      const res = await handleDexLiquidity(db);
      const coin = DexLiquidityMapSchema.parse(await res.json())[row.stablecoin_id];
      expect(coin.dexPriceUnavailableReason).toBe(reason);
      expect(coin.dexPriceUpdatedAt).toBe(now + priceOffset);
      expect(coin.dexPriceMaxAgeSec).toBe(86_400);
      expect(coin.dexPriceAgeSeconds).toBe(reason === "future-timestamp" ? null : -priceOffset);
      if (reason == null) {
        expect(coin.dexPriceUsd).toBe(0.81);
        expect(coin.priceSourceCount).toBe(2);
        expect(coin.priceSources).toHaveLength(1);
      } else {
        expect(coin.dexPriceUsd).toBeNull();
        expect(coin.dexDeviationBps).toBeNull();
        expect(coin.priceSourceCount).toBeNull();
        expect(coin.priceSourceTvl).toBeNull();
        expect(coin.priceSources).toBeNull();
      }
      if (liquidityOffset === 0) expect(res.headers.get("X-Data-Age")).toBe("0");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("retains a quality warning across skipped runs and clears it after a successful clean run", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const insert = sqlite.prepare("INSERT INTO cron_runs (job, started_at, duration_ms, status, metadata) VALUES ('sync-dex-liquidity', ?, 1, ?, ?)");
      insert.run(100, "ok", JSON.stringify({ sourceCoverage: {
        qualityDriftSeverity: "medium", qualityDriftFlags: ["staged-merge-drop"],
      } }));
      insert.run(200, "skipped_neutral", null);
      insert.run(300, "skipped_locked", null);
      insert.run(350, "ok", JSON.stringify({ persistence: { skippedReason: "liquidity-cadence-reuse" } }));
      expect((await handleDexLiquidity(db)).headers.get("Warning")).toContain("staged-merge-drop");
      const publishedAt = Math.floor(Date.now() / 1000);
      insert.run(publishedAt, "ok", JSON.stringify({ outputPublishedAt: publishedAt }));
      expect((await handleDexLiquidity(db)).headers.get("Warning")).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it.each([
    ["ok", ["major-tvl-cliff:crvusd-curve"], [], false],
    ["ok", ["major-tvl-cliff:crvusd-curve", "price-observation-drop"], [], true],
    ["ok", ["major-tvl-cliff:crvusd-curve"], ["uniswap-v4-subgraph:arbitrum"], true],
    ["degraded", ["major-tvl-cliff:crvusd-curve"], [], true],
    ["error", ["major-tvl-cliff:crvusd-curve"], [], true],
  ])("keeps %s run findings %j (failedSources %j) off unaffected coin rows", async (
    status,
    flags,
    failedSources,
    affectsGlobalSurface,
  ) => {
    const db = mockDexD1([
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
      { match: "cron_runs", rows: [], first: { status, metadata: JSON.stringify({ failedSources, sourceCoverage: {
        qualityDriftSeverity: "high", qualityDriftFlags: flags,
      } }) } },
      { match: "dex_liquidity", rows: [row, makeDexLiquidityRow({ stablecoin_id: "crvusd-curve" })] },
    ]);
    const res = await handleDexLiquidity(db);
    const body = await res.json() as Record<string, { warning: string | null }>;
    const globalWarning = res.headers.get("Warning");
    if (affectsGlobalSurface) expect(globalWarning).toBeTruthy();
    else expect(globalWarning).toBeNull();
    // Dataset-wide provider failures, guards, drift severity and run outcomes are
    // operator findings; a coin row warns only when a flag names that coin.
    expect(body["crvusd-curve"].warning).toContain("major-tvl-cliff:crvusd-curve");
    expect(body["usdt-tether"].warning).toBeNull();
  });

  it("keeps a coin-scoped cliff flag off the global surface and on its own coin row", async () => {
    const db = mockDexD1([
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
      { match: "cron_runs", rows: [], first: { status: "ok", metadata: JSON.stringify({
        failedSources: [],
        sourceCoverage: {
          qualityDriftSeverity: "high",
          qualityDriftFlags: ["major-tvl-cliff:usdg-paxos"],
          nearCoverageGuard: false,
          nearValueGuard: false,
          nearMajorCoverageGuard: false,
        },
      }) } },
      { match: "dex_liquidity", rows: [row, makeDexLiquidityRow({ stablecoin_id: "usdg-paxos" }), makeDexLiquidityRow({ stablecoin_id: "__global__" })] },
    ]);
    const res = await handleDexLiquidity(db);
    const body = await res.json() as Record<string, { warning: string | null }>;
    expect(res.headers.get("Warning")).toBeNull();
    expect(body["usdg-paxos"].warning).toContain("major-tvl-cliff:usdg-paxos");
    expect(body["usdt-tether"].warning).toBeNull();
    expect(body["__global__"].warning).toBeNull();
  });

  it("returns 200 with liquidity map", async () => {
    const db = mockDexD1([
      { match: "dex_liquidity", rows: [row] },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const res = await handleDexLiquidity(db);
    const body = (await readJsonResponse(res, 200)) as Record<string, unknown>;
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
    const body = (await readJsonResponse(res, 200)) as Record<string, Record<string, unknown>>;
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
    const body = await readJsonResponse(res, 200);
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

    const body = (await readJsonResponse(res, 200)) as Record<string, Record<string, unknown>>;
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

    const body = (await readJsonResponse(res, 200)) as Record<string, Record<string, unknown>>;
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

    const body = (await readJsonResponse(res, 200)) as Record<string, Record<string, unknown>>;
    expect(body["usdt-tether"]?.dexPriceUsd).toBeNull();
    expect(body["usdt-tether"]?.priceSources).toBeNull();
    expect(body["usdt-tether"]?.dexPriceUnavailableReason).toBe("stale-price");
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
  it("uses the shared conservative default for null coverage", async () => {
    const db = mockDexD1([
      {
        match: "dex_liquidity",
        rows: [makeDexLiquidityRow({
          coverage_class: null,
          coverage_confidence: null,
          effective_tvl_usd: null,
          balance_measured_tvl_usd: null,
          organic_measured_tvl_usd: null,
        })],
      },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const body = await readJsonResponse<Record<string, Record<string, unknown>>>(
      await handleDexLiquidity(db),
      200,
    );
    expect(body["usdt-tether"]).toMatchObject({
      coverageClass: "legacy",
      coverageConfidence: 0.5,
      liquidityEvidenceClass: "observed_unmeasured",
      hasMeasuredLiquidityEvidence: false,
      trendworthy: false,
      effectiveTvlUsd: 0,
      balanceMeasuredTvlUsd: 0,
      organicMeasuredTvlUsd: 0,
    });
  });

  it.each([
    [0, "fallback", 0.5, "observed_unmeasured", false],
    [1_900_000, "primary", 0.9, "measured", true],
    [2_000_000, "fallback", 0.5, "observed_unmeasured", false],
    [900_000, "mixed", 0.8, "partial_measured", true],
  ] as const)("classifies %s measured TVL with %s coverage at %s confidence", async (measuredTvl, coverage, confidence, evidenceClass, measured) => {
    const db = mockDexD1([
      { match: "dex_liquidity", rows: [makeDexLiquidityRow({
        total_tvl_usd: 2_000_000,
        balance_measured_tvl_usd: measuredTvl,
        coverage_class: coverage,
        coverage_confidence: confidence,
      })] },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const body = await readJsonResponse<Record<string, Record<string, unknown>>>(await handleDexLiquidity(db), 200);
    expect(body["usdt-tether"]).toMatchObject({
      liquidityEvidenceClass: evidenceClass,
      hasMeasuredLiquidityEvidence: measured,
      trendworthy: measured,
    });
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

  it.each([-33 * 3600, 3600])("keeps generic freshness warnings on coin rows at timestamp offset %s", async (offset) => {
    const db = mockDexD1([
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
      { match: "dex_liquidity", rows: [makeDexLiquidityRow({ updated_at: Math.floor(Date.now() / 1000) + offset })] },
    ]);
    const res = await handleDexLiquidity(db);
    const body = await res.json() as Record<string, { warning: string | null }>;
    expect(res.headers.get("Warning")).toBeTruthy();
    expect(body["usdt-tether"].warning).toBe(res.headers.get("Warning"));
  });

  it("passes the stored methodology_version through unchanged", async () => {
    const db = mockDexD1([
      { match: "dex_liquidity", rows: [makeDexLiquidityRow({ methodology_version: "5.91" })] },
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
    ]);
    const res = await handleDexLiquidity(db);
    const body = (await res.json()) as Record<string, { methodologyVersion: string }>;
    expect(body["usdt-tether"]?.methodologyVersion).toBe("5.91");
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

describe("handleDexLiquidity DEC-19 volume availability (release A readers)", () => {
  const AS_OF = 1_790_000_000;
  const clock = { asOfSec: AS_OF, maxObservationAgeSec: 86_400 };
  const fresh = (volumeUsd: number | null): DexPoolVolumeObservationInput => ({ volumeUsd, observedAtSec: AS_OF - 600 });
  const aged = (volumeUsd: number): DexPoolVolumeObservationInput => ({ volumeUsd, observedAtSec: AS_OF - 180 * 3600 });
  const missing: DexPoolVolumeObservationInput = { volumeUsd: null, observedAtSec: null };
  const record = (pools: DexPoolVolumeObservationInput[]) => JSON.stringify({
    "24h": summarizeDexVolumeWindow(pools, "24h", clock).availability,
    "7d": summarizeDexVolumeWindow(pools, "7d", clock).availability,
  });

  async function publish(overrides: Parameters<typeof makeDexLiquidityRow>[0]) {
    const db = mockDexD1([
      { match: "dex_liquidity_history", rows: [] },
      { match: "dex_prices", rows: [] },
      { match: "dex_liquidity", rows: [makeDexLiquidityRow({ updated_at: AS_OF, ...overrides })] },
    ]);
    const body = (await readJsonResponse(await handleDexLiquidity(db), 200)) as Record<string, unknown>;
    // Every emitted shape must satisfy the widened public contract.
    expect(DexLiquidityMapSchema.safeParse(body).success).toBe(true);
    return body["usdt-tether"] as Record<string, unknown> & {
      volume24hAvailability?: Record<string, unknown>;
      volume7dAvailability?: Record<string, unknown>;
    };
  }

  it("keeps legacy numeric rows numeric with unrecorded completeness", async () => {
    const coin = await publish({ total_volume_24h_usd: 1_234, total_volume_7d_usd: 5_000, total_volume_7d_measured: 1 });
    expect(coin.totalVolume24hUsd).toBe(1_234);
    expect(coin.totalVolume7dUsd).toBe(5_000);
    expect(coin).not.toHaveProperty("volume24hAvailability");
    expect(coin).not.toHaveProperty("volume7dAvailability");
  });

  it("publishes a complete measured zero as 0, not unavailable", async () => {
    const coin = await publish({
      total_volume_24h_usd: 0,
      total_volume_7d_usd: 0,
      volume_availability_json: record([fresh(0), fresh(0)]),
    });
    expect(coin.totalVolume24hUsd).toBe(0);
    expect(coin.totalVolume7dUsd).toBe(0);
    expect(coin.volume24hAvailability).toMatchObject({ completeness: "complete", reason: null, measuredPoolCount: 2 });
  });

  it.each([
    ["all-missing", [missing, missing], 0, "missing", "pool-observations-missing", null],
    ["mixed", [fresh(50_000), missing], 50_000, "partial", "pool-observations-missing", 50_000],
    ["stale", [aged(50_000)], 50_000, "stale", "pool-observations-stale", null],
  ] as const)("publishes %s 24h/7d windows as null beside their availability", async (
    _name,
    pools,
    storedUsd,
    completeness,
    reason,
    partialGrossUsd,
  ) => {
    const coin = await publish({
      total_volume_24h_usd: storedUsd,
      total_volume_7d_usd: storedUsd,
      volume_availability_json: record([...pools]),
    });
    expect(coin.totalVolume24hUsd).toBeNull();
    expect(coin.totalVolume7dUsd).toBeNull();
    for (const availability of [coin.volume24hAvailability, coin.volume7dAvailability]) {
      expect(availability).toMatchObject({ completeness, reason, partialGrossUsd, asOfSec: AS_OF, maxObservationAgeSec: 86_400 });
    }
  });

  it("never publishes a stored total whose availability record is unreadable", async () => {
    const coin = await publish({ total_volume_24h_usd: 9_999, volume_availability_json: "{not json" });
    expect(coin.totalVolume24hUsd).toBeNull();
    expect(coin.volume24hAvailability).toMatchObject({ completeness: "unknown", reason: "availability-record-unreadable" });
  });

  it("accepts nullable pool volume, pool observations and an NR activity component", async () => {
    const coin = await publish({
      liquidity_score: null,
      score_components_json: JSON.stringify({
        tvlDepth: 70, volumeActivity: null, poolQuality: 60, durability: 50, pairDiversity: 40,
      }),
      top_pools_json: JSON.stringify([
        {
          project: "curve", chain: "Ethereum", tvlUsd: 100_000, symbol: "USDT/USDC", poolType: "stable",
          source: "dl", volumeUsd1d: null, volumeObservation: { status: "missing", observedAtSec: null },
        },
        {
          project: "uniswap-v3", chain: "Ethereum", tvlUsd: 50_000, symbol: "USDT/USDC", poolType: "generic",
          source: "dl", volumeUsd1d: 10_000, volumeObservation: { status: "measured-ish", observedAtSec: -1 },
        },
      ]),
    });
    expect(coin.scoreComponents).toEqual({
      tvlDepth: 70, volumeActivity: null, poolQuality: 60, durability: 50, pairDiversity: 40,
    });
    const pools = coin.topPools as Array<Record<string, unknown>>;
    expect(pools[0]).toMatchObject({ volumeUsd1d: null, volumeObservation: { status: "missing", observedAtSec: null } });
    expect(pools[1]).not.toHaveProperty("volumeObservation");
  });
});
