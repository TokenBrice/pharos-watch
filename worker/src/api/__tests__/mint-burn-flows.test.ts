import { afterEach, describe, expect, it, vi } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v8/evaluation-build-manifest-v1";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { handleMintBurnFlows } from "../mint-burn-flows";
import { MintBurnFlowsResponseSchema, MintBurnPerCoinResponseSchema } from "@shared/types/mint-burn";

// ---------------------------------------------------------------------------
// Regression tests (shape assertions on literal objects)
// ---------------------------------------------------------------------------

describe("mint-burn-flows regression: per-coin vs aggregate shape", () => {
  it("per-coin response does NOT have a coins array", async () => {
    const perCoinResponse = {
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      mintVolumeUsd: 1000,
      burnVolumeUsd: 500,
      netFlowUsd: 500,
      mintCount: 10,
      burnCount: 5,
      chains: [],
      hourly: [],
      updatedAt: 1000,
    };

    expect(perCoinResponse).not.toHaveProperty("coins");
    expect(perCoinResponse).toHaveProperty("stablecoinId");
  });

  it("aggregate response DOES have a coins array", async () => {
    const aggregateResponse = {
      gauge: {
        score: 0,
        band: "NEUTRAL",
        intensitySemantics: "signed-v2",
        flightToQuality: false,
        flightIntensity: 0,
        trackedCoins: 4,
        trackedMcapUsd: 1e11,
      },
      coins: [
        {
          stablecoinId: "usdt-tether",
          symbol: "USDT",
          flowIntensity: 0,
          pressureShiftScore: 0,
          pressureShiftState: "stable",
          netFlowDirection24h: "minting",
          has24hActivity: true,
          baselineDailyNetUsd: 0,
          baselineDailyAbsUsd: 1000000,
          baselineDataDays: 30,
          netFlow24hUsd: 100,
          mintVolume24hUsd: 200,
          burnVolume24hUsd: 100,
          mintCount24h: 5,
          burnCount24h: 3,
          netFlow7dUsd: 500,
          netFlow30dUsd: 1000,
          netFlow90dUsd: 1000,
          largestEvent24h: null,
        },
      ],
      hourly: [],
      updatedAt: 1000,
    };

    expect(aggregateResponse).toHaveProperty("coins");
    expect(Array.isArray(aggregateResponse.coins)).toBe(true);
    expect(aggregateResponse).toHaveProperty("gauge");
    expect(aggregateResponse).not.toHaveProperty("stablecoinId");
  });
});

// ---------------------------------------------------------------------------
// Contract tests (handler-level, using D1 mock)
// ---------------------------------------------------------------------------

describe("handleMintBurnFlows contract tests", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const nowSec = Math.floor(Date.now() / 1000);

  const hourlyRow = {
    stablecoin_id: "usdt-tether",
    chain_id: "ethereum",
    hour_ts: nowSec - 3600,
    mint_count: 5,
    burn_count: 3,
    mint_volume_usd: 10000,
    burn_volume_usd: 5000,
    net_flow_usd: 5000,
  };

  const stablecoinsCache = JSON.stringify({
    peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100000000000 } }],
  });

  const db = mockD1([
    { match: "mint_burn_hourly", rows: [hourlyRow] },
    { match: "mint_burn_events", rows: [] },
    {
      match: "cache",
      rows: [{ key: "stablecoins", value: stablecoinsCache, updated_at: nowSec }],
      first: { key: "stablecoins", value: stablecoinsCache, updated_at: nowSec },
    },
  ]);

  it("aggregate mode returns shape matching MintBurnFlowsResponseSchema", async () => {
    const url = new URL("https://x/api/mint-burn-flows");
    const res = await handleMintBurnFlows(db, url);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // Cross-validate against the same Zod schema the frontend uses
    const parsed = MintBurnFlowsResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);

    // Structural assertions
    expect(body).toHaveProperty("gauge");
    expect(body).toHaveProperty("coins");
    expect(body).toHaveProperty("hourly");
    expect(Array.isArray(body.coins)).toBe(true);
    expect(body).not.toHaveProperty("stablecoinId");
  });

  it("per-coin mode returns shape matching MintBurnPerCoinResponseSchema", async () => {
    const url = new URL("https://x/api/mint-burn-flows?stablecoin=usdt-tether");
    const res = await handleMintBurnFlows(db, url);

    expect(res.status).toBe(200);
    const body = await res.json();

    // Cross-validate against per-coin schema
    const parsed = MintBurnPerCoinResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);

    // Structural assertions — NOT aggregate shape
    expect(body).toHaveProperty("stablecoinId");
    expect(body).toHaveProperty("chains");
    expect(body).not.toHaveProperty("coins");
    expect(body).not.toHaveProperty("gauge");
  });

  it("unknown stablecoin returns 404", async () => {
    const url = new URL("https://x/api/mint-burn-flows?stablecoin=99999");
    const res = await handleMintBurnFlows(db, url);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("returns 404 for a valid stablecoin that is not tracked for mint/burn flows", async () => {
    const url = new URL("https://x/api/mint-burn-flows?stablecoin=susdai-usd-ai");
    const res = await handleMintBurnFlows(db, url);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: 'Stablecoin "susdai-usd-ai" is not tracked for mint/burn flows',
    });
  });

  it("filters aggregate flow metrics to configured stablecoin-chain pairs", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdai-usd-ai", symbol: "USDai", circulating: { peggedUSD: 250_000_000 } }],
    });

    const scopedDb = mockD1([
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        rows: [
          {
            stablecoin_id: "usdai-usd-ai",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 5_000_000,
            burn_volume_usd: 0,
            net_flow_usd: 5_000_000,
          },
          {
            stablecoin_id: "usdai-usd-ai",
            chain_id: "arbitrum",
            hour_ts: now - 1800,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 7_000_000,
            burn_volume_usd: 0,
            net_flow_usd: 7_000_000,
          },
        ],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [
          { stablecoin_id: "usdai-usd-ai", chain_id: "ethereum", net_flow_usd: 5_000_000 },
          { stablecoin_id: "usdai-usd-ai", chain_id: "arbitrum", net_flow_usd: 7_000_000 },
        ],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [
          {
            stablecoin_id: "usdai-usd-ai",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 100_000_000,
            daily_abs: 100_000_000,
          },
          {
            stablecoin_id: "usdai-usd-ai",
            chain_id: "arbitrum",
            day_ts: tenDaysAgoDay,
            daily_net: 2_000_000,
            daily_abs: 8_000_000,
          },
        ],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [
          { stablecoin_id: "usdai-usd-ai", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour - 30 * 86400 },
          { stablecoin_id: "usdai-usd-ai", chain_id: "arbitrum", first_hour_ts: tenDaysAgoHour },
        ],
      },
      { match: "mint_burn_events", rows: [] },
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: cache, updated_at: now }],
        first: { key: "stablecoins", value: cache, updated_at: now },
      },
    ]);

    const res = await handleMintBurnFlows(scopedDb, new URL("https://x/api/mint-burn-flows"));
    expect(res.status).toBe(200);

    const body = MintBurnFlowsResponseSchema.parse(await res.json());
    const usdai = body.coins.find((coin) => coin.stablecoinId === "usdai-usd-ai");

    expect(body.scope).toEqual({
      chainIds: ["ethereum", "arbitrum"],
      label: "Configured issuance chains",
    });
    expect(usdai?.netFlow24hUsd).toBe(7_000_000);
    expect(usdai?.mintVolume24hUsd).toBe(7_000_000);
    expect(usdai?.baselineDailyNetUsd).toBe(200_000);
    const firstHourQuery = scopedDb
      .getHistory()
      .find((entry) => entry.sql.includes("pharos:mint-burn-flows:first-hour-seek"));
    expect(firstHourQuery?.sql).toContain("INDEXED BY idx_mbh_chain_coin_hour");
    expect(firstHourQuery?.sql).toContain("ORDER BY h.hour_ts ASC");
    expect(firstHourQuery?.sql).not.toContain("GROUP BY");
    const recentAggregateQueries = scopedDb
      .getHistory()
      .filter((entry) => entry.sql.includes("FROM mint_burn_hourly INDEXED BY idx_mbh_ts"));
    expect(recentAggregateQueries.length).toBeGreaterThanOrEqual(5);
  });

  it("excludes historical rows for quarantined mint/burn configs from the public aggregate", async () => {
    const now = Math.floor(Date.now() / 1000);
    const inactiveDb = mockD1([
      {
        match: "mint_burn_hourly",
        rows: [{
          stablecoin_id: "busd0-usual",
          chain_id: "ethereum",
          hour_ts: now - 3600,
          mint_count: 1,
          burn_count: 0,
          mint_volume_usd: 5_000_000,
          burn_volume_usd: 0,
          net_flow_usd: 5_000_000,
        }],
      },
      { match: "mint_burn_events", rows: [] },
      {
        match: "cache",
        rows: [{
          key: "stablecoins",
          value: JSON.stringify({
            peggedAssets: [{
              id: "busd0-usual",
              symbol: "bUSD0",
              circulating: { peggedUSD: 100_000_000 },
            }],
          }),
          updated_at: now,
        }],
        first: {
          key: "stablecoins",
          value: JSON.stringify({
            peggedAssets: [{
              id: "busd0-usual",
              symbol: "bUSD0",
              circulating: { peggedUSD: 100_000_000 },
            }],
          }),
          updated_at: now,
        },
      },
    ]);

    const res = await handleMintBurnFlows(inactiveDb, new URL("https://x/api/mint-burn-flows"));
    expect(res.status).toBe(200);
    const body = MintBurnFlowsResponseSchema.parse(await res.json());
    expect(body.coins.some((coin) => coin.stablecoinId === "busd0-usual")).toBe(false);
    expect(body.hourly.some((row) => row.netFlowUsd === 5_000_000)).toBe(false);
    expect(body.gauge.trackedMcapUsd).toBe(0);
  });

  it("rejects out-of-range hours instead of clamping them", async () => {
    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows?hours=9999"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid hours: must be between 1 and 720" });
  });

  it("returns NR flow intensity for sparse coins with no 24h activity after 7+ tracked days", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const sparseCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100000000000 } }],
    });

    const sparseDb = mockD1([
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 1_000_000,
            daily_abs: 1_000_000,
          },
        ],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour }],
      },
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        rows: [],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 1_000_000 }],
      },
      { match: "mint_burn_events", rows: [] },
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: sparseCache, updated_at: now }],
        first: { key: "stablecoins", value: sparseCache, updated_at: now },
      },
    ]);

    const res = await handleMintBurnFlows(sparseDb, new URL("https://x/api/mint-burn-flows"));
    expect(res.status).toBe(200);

    const body = MintBurnFlowsResponseSchema.parse(await res.json());
    const usdt = body.coins.find((coin) => coin.stablecoinId === "usdt-tether");

    expect(usdt).toBeDefined();
    expect(usdt?.flowIntensity).toBeNull();
    expect(usdt?.pressureShiftScore).toBeNull();
    expect(usdt?.pressureShiftState).toBe("nr");
    expect(usdt?.netFlowDirection24h).toBe("inactive");
    expect(usdt?.has24hActivity).toBe(false);
    expect(body.gauge.score).toBeNull();
  });

  it("returns 503 when stablecoins cache is unavailable and no flow fallback cache exists", async () => {
    const res = await handleMintBurnFlows(mockD1(), new URL("https://x/api/mint-burn-flows"));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Stablecoins data not yet available",
    });
  });

  it("classifies safe inflows and risky outflows for flight-to-quality detection", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [
        { id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 60_000_000_000 } },
        { id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 120_000_000_000 } },
      ],
    });
    const publicationGenerationId = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${now}`;
    const scores = Object.fromEntries([...ACTIVE_IDS].map((id) => [id, { score: 60, grade: "B-" }]));
    scores["usdc-circle"] = { score: 80, grade: "A" };
    scores["usdt-tether"] = { score: 40, grade: "D" };
    const reportCardCache = JSON.stringify({
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      scores,
      safetyScoreIdentity: {
        model: "v8",
        schemaVersion: 1,
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
        evaluationBuildDigest: SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST,
        baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
        publicationGenerationId,
      },
      publicationGenerationId,
      completeness: {
        generationId: publicationGenerationId,
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
        expectedCount: ACTIVE_IDS.size,
        scoredCount: ACTIVE_IDS.size,
        notRatedCount: 0,
        notRatedIds: [],
      },
      updatedAt: now,
    });

    const db = mockD1([
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 4,
            burn_count: 1,
            mint_volume_usd: 170_000_000,
            burn_volume_usd: 20_000_000,
            net_flow_usd: 150_000_000,
          },
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 1,
            burn_count: 5,
            mint_volume_usd: 20_000_000,
            burn_volume_usd: 220_000_000,
            net_flow_usd: -200_000_000,
          },
        ],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [
          { stablecoin_id: "usdc-circle", chain_id: "ethereum", net_flow_usd: 150_000_000 },
          { stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: -200_000_000 },
        ],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 10_000_000,
            daily_abs: 190_000_000,
          },
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: -10_000_000,
            daily_abs: 240_000_000,
          },
        ],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [
          { stablecoin_id: "usdc-circle", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour },
          { stablecoin_id: "usdt-tether", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour },
        ],
      },
      { match: "FROM mint_burn_events", rows: [] },
      {
        match: "cache",
        matchBinds: ["report_card_cache"],
        rows: [{ key: "report_card_cache", value: reportCardCache, updated_at: now }],
        first: { key: "report_card_cache", value: reportCardCache, updated_at: now },
      },
      {
        match: "cache",
        matchBinds: ["stablecoins"],
        rows: [{ key: "stablecoins", value: stablecoinsCache, updated_at: now }],
        first: { key: "stablecoins", value: stablecoinsCache, updated_at: now },
      },
    ]);

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
    expect(res.status).toBe(200);

    const body = MintBurnFlowsResponseSchema.parse(await res.json());
    expect(body.gauge.classificationSource).toBe("report-card-cache");
    expect(body.gauge.flightToQuality).toBe(true);
    expect(body.gauge.flightIntensity).toBe(20);
    expect(body.gauge.safetyScoreIdentity).toMatchObject({
      model: "v8",
      evaluationBuildDigest: SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST,
    });
    expect(body.sync?.classificationWarning).toBeNull();
  });

  it("excludes NR no-activity coins from gauge weighting", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const mixedCache = JSON.stringify({
      peggedAssets: [
        { id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } },
        { id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 50_000_000_000 } },
      ],
    });

    const mixedDb = mockD1([
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 7,
            burn_count: 2,
            mint_volume_usd: 70_000_000,
            burn_volume_usd: 10_000_000,
            net_flow_usd: 60_000_000,
          },
        ],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [
          { stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 0 },
          { stablecoin_id: "usdc-circle", chain_id: "ethereum", net_flow_usd: 60_000_000 },
        ],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 1_000_000,
            daily_abs: 1_000_000,
          },
          {
            stablecoin_id: "usdc-circle",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 0,
            daily_abs: 200_000_000,
          },
        ],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [
          { stablecoin_id: "usdt-tether", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour },
          { stablecoin_id: "usdc-circle", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour },
        ],
      },
      { match: "mint_burn_events", rows: [] },
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: mixedCache, updated_at: now }],
        first: { key: "stablecoins", value: mixedCache, updated_at: now },
      },
    ]);

    const res = await handleMintBurnFlows(mixedDb, new URL("https://x/api/mint-burn-flows"));
    expect(res.status).toBe(200);

    const body = MintBurnFlowsResponseSchema.parse(await res.json());
    const noActivityCoin = body.coins.find((coin) => coin.stablecoinId === "usdt-tether");
    const activeCoin = body.coins.find((coin) => coin.stablecoinId === "usdc-circle");

    expect(noActivityCoin?.flowIntensity).toBeNull();
    expect(noActivityCoin?.pressureShiftScore).toBeNull();
    expect(noActivityCoin?.pressureShiftState).toBe("nr");
    expect(noActivityCoin?.netFlowDirection24h).toBe("inactive");
    expect(noActivityCoin?.has24hActivity).toBe(false);
    expect(activeCoin?.flowIntensity).toBe(100);
    expect(activeCoin?.pressureShiftScore).toBe(100);
    expect(activeCoin?.pressureShiftState).toBe("improving");
    expect(activeCoin?.netFlowDirection24h).toBe("minting");
    expect(activeCoin?.has24hActivity).toBe(true);
    expect(body.gauge.score).toBe(100);
  });

  it("weights gauge mcap by canonical-chain circulating, not global supply", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    // USDC with multi-chain chainCirculating: only ethereum (30B) should weight
    // the gauge; solana (4B) must be excluded because it is untracked by mint-burn.
    const multiChainCache = JSON.stringify({
      peggedAssets: [
        {
          id: "usdc-circle",
          symbol: "USDC",
          circulating: { peggedUSD: 34_000_000_000 },
          chainCirculating: {
            ethereum: {
              current: 30_000_000_000,
              circulatingPrevDay: 30_000_000_000,
              circulatingPrevWeek: 30_000_000_000,
              circulatingPrevMonth: 30_000_000_000,
            },
            solana: {
              current: 4_000_000_000,
              circulatingPrevDay: 4_000_000_000,
              circulatingPrevWeek: 4_000_000_000,
              circulatingPrevMonth: 4_000_000_000,
            },
          },
        },
      ],
    });

    const multiChainDb = mockD1([
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 4,
            burn_count: 1,
            mint_volume_usd: 80_000_000,
            burn_volume_usd: 20_000_000,
            net_flow_usd: 60_000_000,
          },
        ],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [{ stablecoin_id: "usdc-circle", chain_id: "ethereum", net_flow_usd: 60_000_000 }],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [
          {
            stablecoin_id: "usdc-circle",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 0,
            daily_abs: 100_000_000,
          },
        ],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdc-circle", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour }],
      },
      { match: "mint_burn_events", rows: [] },
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: multiChainCache, updated_at: now }],
        first: { key: "stablecoins", value: multiChainCache, updated_at: now },
      },
    ]);

    const res = await handleMintBurnFlows(multiChainDb, new URL("https://x/api/mint-burn-flows"));
    expect(res.status).toBe(200);

    const body = MintBurnFlowsResponseSchema.parse(await res.json());
    // Gauge mcap must sum only tracked-chain supply (ethereum = 30B), NOT the
    // peg-bucket total (34B). This guards the Bank Run Gauge from over-weighting
    // coins whose intensity is measured on one chain but whose supply lives on many.
    expect(body.gauge.trackedMcapUsd).toBe(30_000_000_000);
    expect(body.gauge.trackedMcapUsd).not.toBe(34_000_000_000);
  });

  it("keeps negative net flow separate from positive pressure shift semantics", async () => {
    const now = Math.floor(Date.now() / 1000);
    const nowDay = Math.floor(now / 86400) * 86400;
    const firstHourTs = nowDay - 9 * 86400;
    const baselineRows = Array.from({ length: 10 }, (_, index) => ({
      stablecoin_id: "usdf-falcon",
      chain_id: "ethereum",
      day_ts: nowDay - index * 86400,
      daily_net: -7_500_000,
      daily_abs: 40_000_000,
    }));
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdf-falcon", symbol: "USDF", circulating: { peggedUSD: 600_000_000 } }],
    });

    const regressionDb = mockD1([
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        rows: [
          {
            stablecoin_id: "usdf-falcon",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 1,
            burn_count: 2,
            mint_volume_usd: 300_000,
            burn_volume_usd: 500_000,
            net_flow_usd: -200_000,
          },
        ],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [{ stablecoin_id: "usdf-falcon", chain_id: "ethereum", net_flow_usd: -200_000 }],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: baselineRows,
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdf-falcon", chain_id: "ethereum", first_hour_ts: firstHourTs }],
      },
      { match: "mint_burn_events", rows: [] },
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: cache, updated_at: now }],
        first: { key: "stablecoins", value: cache, updated_at: now },
      },
    ]);

    const res = await handleMintBurnFlows(regressionDb, new URL("https://x/api/mint-burn-flows"));
    expect(res.status).toBe(200);

    const body = MintBurnFlowsResponseSchema.parse(await res.json());
    const usdf = body.coins.find((coin) => coin.stablecoinId === "usdf-falcon");

    expect(usdf).toBeDefined();
    expect(usdf?.netFlow24hUsd).toBeLessThan(0);
    expect(usdf?.pressureShiftScore).toBeGreaterThan(0);
    expect(usdf?.flowIntensity).toBe(usdf?.pressureShiftScore);
    expect(usdf?.netFlowDirection24h).toBe("burning");
    expect(usdf?.pressureShiftState).toBe("improving");
    expect(usdf?.has24hActivity).toBe(true);
    expect(usdf?.baselineDailyNetUsd).toBe(-7_500_000);
    expect(usdf?.baselineDailyAbsUsd).toBe(40_000_000);
    expect(usdf?.baselineDataDays).toBe(9);
  });

  it("excludes the current UTC day from the trailing baseline window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const nowDay = Math.floor(now / 86400) * 86400;
    const firstHourTs = nowDay - 10 * 86400;
    const baselineRows = [
      ...Array.from({ length: 10 }, (_, index) => ({
        stablecoin_id: "usdt-tether",
        chain_id: "ethereum",
        day_ts: nowDay - (index + 1) * 86400,
        daily_net: 1_000_000,
        daily_abs: 10_000_000,
      })),
      {
        stablecoin_id: "usdt-tether",
        chain_id: "ethereum",
        day_ts: nowDay,
        daily_net: 999_000_000,
        daily_abs: 999_000_000,
      },
    ];
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });

    const db = mockD1([
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 1_500_000,
            burn_volume_usd: 500_000,
            net_flow_usd: 1_000_000,
          },
        ],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 1_000_000 }],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: baselineRows,
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", first_hour_ts: firstHourTs }],
      },
      { match: "FROM mint_burn_events", rows: [] },
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: cache, updated_at: now }],
        first: { key: "stablecoins", value: cache, updated_at: now },
      },
    ]);

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
    expect(res.status).toBe(200);

    const body = MintBurnFlowsResponseSchema.parse(await res.json());
    const usdt = body.coins.find((coin) => coin.stablecoinId === "usdt-tether");

    expect(usdt?.baselineDailyNetUsd).toBe(1_000_000);
    expect(usdt?.baselineDailyAbsUsd).toBe(10_000_000);
    expect(usdt?.pressureShiftScore).toBe(0);
  });

  it("selects the latest event when largest-event amounts tie", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });

    const db = mockD1([
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 2,
            burn_count: 0,
            mint_volume_usd: 2_000_000,
            burn_volume_usd: 0,
            net_flow_usd: 2_000_000,
          },
        ],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 2_000_000 }],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 0,
            daily_abs: 2_000_000,
          },
        ],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour }],
      },
      {
        match: "FROM mint_burn_events",
        rows: [
          {
            id: "evt-older",
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            chain_id: "ethereum",
            direction: "mint",
            amount: 1_000_000,
            amount_usd: 5_000_000,
            counterparty: null,
            tx_hash: "0xolder",
            block_number: 10,
            timestamp: now - 3600,
            explorer_tx_url: "https://etherscan.io/tx/0xolder",
          },
          {
            id: "evt-unpriced",
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            chain_id: "ethereum",
            direction: "mint",
            amount: 100_000_000,
            amount_usd: null,
            counterparty: null,
            tx_hash: "0xunpriced",
            block_number: 12,
            timestamp: now - 900,
            explorer_tx_url: "https://etherscan.io/tx/0xunpriced",
          },
          {
            id: "evt-newer",
            stablecoin_id: "usdt-tether",
            symbol: "USDT",
            chain_id: "ethereum",
            direction: "mint",
            amount: 1_000_000,
            amount_usd: 5_000_000,
            counterparty: null,
            tx_hash: "0xnewer",
            block_number: 11,
            timestamp: now - 1800,
            explorer_tx_url: "https://etherscan.io/tx/0xnewer",
          },
        ],
      },
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: cache, updated_at: now }],
        first: { key: "stablecoins", value: cache, updated_at: now },
      },
    ]);

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
    expect(res.status).toBe(200);

    const body = MintBurnFlowsResponseSchema.parse(await res.json());
    const usdt = body.coins.find((coin) => coin.stablecoinId === "usdt-tether");

    expect(usdt?.largestEvent24h?.txHash).toBe("0xnewer");
    expect(usdt?.largestEvent24h?.timestamp).toBe(now - 1800);
    const largestEventQuery = db.getHistory().find((entry) => entry.sql.includes("FROM mint_burn_events"));
    expect(largestEventQuery?.sql).toContain("amount_usd IS NOT NULL");
  });

  it("keeps aggregate coin fields on a fixed 24h window even when hours changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));

    const now = Math.floor(Date.now() / 1000);
    const sevenDayStart = now - 168 * 3600;
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });

    const db = mockD1([
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        matchBinds: ["ethereum", "arbitrum", sevenDayStart],
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 15_000_000,
            burn_volume_usd: 5_000_000,
            net_flow_usd: 10_000_000,
          },
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 48 * 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 45_000_000,
            burn_volume_usd: 15_000_000,
            net_flow_usd: 30_000_000,
          },
        ],
      },
      {
        match: "pharos:mint-burn-flows:net-7d",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 40_000_000 }],
      },
      {
        match: "pharos:mint-burn-flows:net-30d",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 40_000_000 }],
      },
      {
        match: "pharos:mint-burn-flows:net-90d",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 40_000_000 }],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 0,
            daily_abs: 20_000_000,
          },
        ],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour }],
      },
      { match: "FROM mint_burn_events", rows: [] },
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: cache, updated_at: now }],
        first: { key: "stablecoins", value: cache, updated_at: now },
      },
    ]);

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows?hours=168"));
    expect(res.status).toBe(200);

    const body = MintBurnFlowsResponseSchema.parse(await res.json());
    const usdt = body.coins.find((coin) => coin.stablecoinId === "usdt-tether");

    expect(body.windowHours).toBe(168);
    expect(body.hourly).toHaveLength(2);
    expect(usdt?.netFlow24hUsd).toBe(10_000_000);
    expect(usdt?.mintVolume24hUsd).toBe(15_000_000);
    expect(usdt?.burnVolume24hUsd).toBe(5_000_000);

    const history = db.getHistory();
    const windowScans = history.filter((entry) => entry.sql.includes("pharos:mint-burn-flows:window-rows"));
    expect(windowScans).toHaveLength(1);
    expect(windowScans[0]?.binds).toEqual(["ethereum", "arbitrum", sevenDayStart]);
    expect(history.some((entry) => entry.sql.includes("pharos:mint-burn-flows:window-24h-rows"))).toBe(false);
  });

  it("keeps fixed 24h coin fields when the requested hourly window is shorter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));

    const now = Math.floor(Date.now() / 1000);
    const oneHourStart = now - 3600;
    const twentyFourHourStart = now - 24 * 3600;
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });

    const db = mockD1([
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        matchBinds: ["ethereum", "arbitrum", twentyFourHourStart],
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: oneHourStart,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 15_000_000,
            burn_volume_usd: 5_000_000,
            net_flow_usd: 10_000_000,
          },
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 3 * 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 45_000_000,
            burn_volume_usd: 15_000_000,
            net_flow_usd: 30_000_000,
          },
        ],
      },
      {
        match: "pharos:mint-burn-flows:net-7d",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 40_000_000 }],
      },
      {
        match: "pharos:mint-burn-flows:net-30d",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 40_000_000 }],
      },
      {
        match: "pharos:mint-burn-flows:net-90d",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 40_000_000 }],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 0,
            daily_abs: 20_000_000,
          },
        ],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour }],
      },
      { match: "FROM mint_burn_events", rows: [] },
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: cache, updated_at: now }],
        first: { key: "stablecoins", value: cache, updated_at: now },
      },
    ]);

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows?hours=1"));
    expect(res.status).toBe(200);

    const body = MintBurnFlowsResponseSchema.parse(await res.json());
    const usdt = body.coins.find((coin) => coin.stablecoinId === "usdt-tether");

    expect(body.windowHours).toBe(1);
    expect(body.hourly).toEqual([
      {
        hourTs: oneHourStart,
        netFlowUsd: 10_000_000,
        mintVolumeUsd: 15_000_000,
        burnVolumeUsd: 5_000_000,
      },
    ]);
    expect(usdt?.netFlow24hUsd).toBe(40_000_000);
    expect(usdt?.mintVolume24hUsd).toBe(60_000_000);
    expect(usdt?.burnVolume24hUsd).toBe(20_000_000);

    const history = db.getHistory();
    const windowScans = history.filter((entry) => entry.sql.includes("pharos:mint-burn-flows:window-rows"));
    expect(windowScans).toHaveLength(1);
    expect(windowScans[0]?.binds).toEqual(["ethereum", "arbitrum", twentyFourHourStart]);
    expect(history.some((entry) => entry.sql.includes("pharos:mint-burn-flows:window-24h-rows"))).toBe(false);
  });

  it("disables FTQ in a legacy cached aggregate before running live aggregate queries", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cachedBody = {
      gauge: {
        score: 0,
        band: "NEUTRAL",
        intensitySemantics: "signed-v2",
        flightToQuality: false,
        flightIntensity: 0,
        trackedCoins: 1,
        trackedMcapUsd: 0,
      },
      coins: [],
      hourly: [],
      updatedAt: now - 60,
      sync: { lastSuccessfulSyncAt: now - 120 },
    };
    const cachedDb = mockD1([
      {
        match: "cache",
        rows: [
          {
            key: "mint-burn-flows:v3:aggregate:24",
            value: JSON.stringify(cachedBody),
            updated_at: now,
          },
        ],
      },
      {
        match: "FROM mint_burn_hourly",
        rows: [],
        throwError: new Error("live aggregate query should not run"),
      },
    ]);

    const res = await handleMintBurnFlows(cachedDb, new URL("https://x/api/mint-burn-flows"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      gauge: {
        flightToQuality: false,
        flightIntensity: 0,
        classificationSource: "unavailable",
        safetyScoreIdentity: null,
      },
      sync: {
        lastSuccessfulSyncAt: now - 120,
        classificationWarning: expect.stringContaining("identity-missing"),
      },
    });
    expect(res.headers.get("Warning")).toContain("identity-missing");

    const history = cachedDb.getHistory();
    expect(history.some((entry) => entry.sql.includes("FROM mint_burn_hourly"))).toBe(false);
  });

  it("serves a fresh aggregate with FTQ unavailable when the report-card cache read fails", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "mint_burn_hourly", rows: [hourlyRow] },
      { match: "mint_burn_events", rows: [] },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["report_card_cache"],
        rows: [],
        throwError: new Error("report-card cache read failed"),
      },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["stablecoins"],
        rows: [{ key: "stablecoins", value: stablecoinsCache, updated_at: now }],
        first: { key: "stablecoins", value: stablecoinsCache, updated_at: now },
      },
    ]);

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
    const body = MintBurnFlowsResponseSchema.parse(await res.json());

    expect(res.status).toBe(200);
    expect(body.gauge).toMatchObject({
      flightToQuality: false,
      flightIntensity: 0,
      classificationSource: "unavailable",
      safetyScoreIdentity: null,
    });
    expect(body.sync?.classificationWarning).toContain("cache-read-failed");
  });

  it("preserves an explicitly unavailable cached FTQ state without revalidation", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cachedBody = {
      gauge: {
        score: 0,
        band: "NEUTRAL",
        intensitySemantics: "signed-v2",
        flightToQuality: false,
        flightIntensity: 0,
        classificationSource: "unavailable",
        safetyScoreIdentity: null,
        trackedCoins: 1,
        trackedMcapUsd: 0,
      },
      coins: [],
      hourly: [],
      updatedAt: now - 60,
      sync: {
        lastSuccessfulSyncAt: now - 120,
        freshnessStatus: "fresh",
        warning: null,
        classificationWarning: "Report-card FTQ classification unavailable (identity-missing)",
        criticalLaneHealthy: true,
      },
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["mint-burn-flows:v3:aggregate:24"],
        rows: [
          {
            key: "mint-burn-flows:v3:aggregate:24",
            value: JSON.stringify(cachedBody),
            updated_at: now,
          },
        ],
      },
    ]);

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(cachedBody);
    expect(db.getHistory().some((entry) => entry.binds.includes("report_card_cache"))).toBe(false);
  });

  it("removes cached FTQ output when its report-card identity is no longer active", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cachedGenerationId = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${now - 900}`;
    const activeGenerationId = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${now}`;
    const cachedIdentity = {
      model: "v8" as const,
      schemaVersion: 1 as const,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      evaluationBuildDigest: SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST,
      baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
      publicationGenerationId: cachedGenerationId,
    };
    const activeIdentity = {
      ...cachedIdentity,
      baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
      publicationGenerationId: activeGenerationId,
    };
    const cachedBody = {
      gauge: {
        score: 10,
        band: "BUYING",
        intensitySemantics: "signed-v2" as const,
        flightToQuality: true,
        flightIntensity: 20,
        classificationSource: "report-card-cache" as const,
        safetyScoreIdentity: cachedIdentity,
        trackedCoins: 1,
        trackedMcapUsd: 1,
      },
      coins: [],
      hourly: [],
      updatedAt: now - 60,
      sync: {
        lastSuccessfulSyncAt: now - 120,
        freshnessStatus: "fresh" as const,
        warning: null,
        classificationWarning: null,
        criticalLaneHealthy: true,
      },
    };
    const activeScores = Object.fromEntries([...ACTIVE_IDS].map((id) => [id, { score: 80, grade: "A" }]));
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["mint-burn-flows:v3:aggregate:24"],
        rows: [
          {
            key: "mint-burn-flows:v3:aggregate:24",
            value: JSON.stringify(cachedBody),
            updated_at: now,
          },
        ],
      },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["report_card_cache"],
        rows: [
          {
            key: "report_card_cache",
            value: JSON.stringify({
              scores: activeScores,
              safetyScoreIdentity: activeIdentity,
              publicationGenerationId: activeGenerationId,
              completeness: {
                generationId: activeGenerationId,
                methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
                expectedCount: ACTIVE_IDS.size,
                scoredCount: ACTIVE_IDS.size,
                notRatedCount: 0,
                notRatedIds: [],
              },
              updatedAt: now,
              methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
            }),
            updated_at: now,
          },
        ],
      },
      {
        match: "FROM mint_burn_hourly",
        rows: [],
        throwError: new Error("live aggregate query should not run"),
      },
    ]);

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
    const body = MintBurnFlowsResponseSchema.parse(await res.json());

    expect(body.gauge).toMatchObject({
      flightToQuality: false,
      flightIntensity: 0,
      classificationSource: "unavailable",
      safetyScoreIdentity: null,
    });
    expect(body.sync?.classificationWarning).toContain("identity-mismatch");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM mint_burn_hourly"))).toBe(false);
  });

  it("keeps cached aggregate flow data while disabling FTQ when report-card validation throws", async () => {
    const now = Math.floor(Date.now() / 1000);
    const identity = {
      model: "v8" as const,
      schemaVersion: 1 as const,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      evaluationBuildDigest: SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST,
      baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
      publicationGenerationId: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${now}`,
    };
    const cachedBody = {
      gauge: {
        score: 10,
        band: "BUYING",
        intensitySemantics: "signed-v2" as const,
        flightToQuality: true,
        flightIntensity: 20,
        classificationSource: "report-card-cache" as const,
        safetyScoreIdentity: identity,
        trackedCoins: 1,
        trackedMcapUsd: 1,
      },
      coins: [],
      hourly: [],
      updatedAt: now - 60,
      sync: {
        lastSuccessfulSyncAt: now - 120,
        freshnessStatus: "fresh" as const,
        warning: null,
        classificationWarning: null,
        criticalLaneHealthy: true,
      },
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["mint-burn-flows:v3:aggregate:24"],
        rows: [
          {
            key: "mint-burn-flows:v3:aggregate:24",
            value: JSON.stringify(cachedBody),
            updated_at: now,
          },
        ],
      },
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: ["report_card_cache"],
        rows: [],
        throwError: new Error("report-card cache read failed"),
      },
    ]);

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
    const body = MintBurnFlowsResponseSchema.parse(await res.json());

    expect(res.status).toBe(200);
    expect(body.gauge).toMatchObject({
      flightToQuality: false,
      flightIntensity: 0,
      classificationSource: "unavailable",
      safetyScoreIdentity: null,
    });
    expect(body.sync?.classificationWarning).toContain("cache-read-failed");
  });

  it("serves cached aggregate fallback when live query fails after a cache miss", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cachedBody = {
      gauge: {
        score: 0,
        band: "NEUTRAL",
        intensitySemantics: "signed-v2",
        flightToQuality: false,
        flightIntensity: 0,
        trackedCoins: 1,
        trackedMcapUsd: 0,
      },
      coins: [],
      hourly: [],
      updatedAt: now - 60,
    };
    let aggregateCacheLookups = 0;

    const failingDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async <T>() => {
            if (sql.includes("FROM mint_burn_hourly")) {
              throw new Error("simulated d1 failure");
            }
            return { results: [] as T[], success: true, meta: {} };
          },
          first: async <T>() => {
            if (sql.includes("SELECT value, updated_at FROM cache WHERE key = ?")) {
              const key = String(args[0] ?? "");
              if (key.startsWith("mint-burn-flows:v3:aggregate:")) {
                aggregateCacheLookups += 1;
                if (aggregateCacheLookups === 1) return null;
                return {
                  value: JSON.stringify(cachedBody),
                  updated_at: now,
                } as T;
              }
            }
            return null;
          },
          run: async () => ({ success: true, meta: {} }),
        }),
        all: async <T>() => {
          if (sql.includes("FROM mint_burn_hourly")) {
            throw new Error("simulated d1 failure");
          }
          return { results: [] as T[], success: true, meta: {} };
        },
        first: async () => null,
        run: async () => ({ success: true, meta: {} }),
      }),
    } as unknown as D1Database;

    const res = await handleMintBurnFlows(failingDb, new URL("https://x/api/mint-burn-flows?hours=720"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      gauge: {
        flightToQuality: false,
        flightIntensity: 0,
        classificationSource: "unavailable",
        safetyScoreIdentity: null,
      },
    });
    expect(res.headers.get("Warning")).toContain("identity-missing");
  });

  it("returns 503 when the aggregate fallback cache is malformed", async () => {
    const now = Math.floor(Date.now() / 1000);
    const failingDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async <T>() => {
            if (sql.includes("FROM mint_burn_hourly")) {
              throw new Error("simulated d1 failure");
            }
            return { results: [] as T[], success: true, meta: {} };
          },
          first: async <T>() => {
            if (sql.includes("SELECT value, updated_at FROM cache WHERE key = ?")) {
              const key = String(args[0] ?? "");
              if (key.startsWith("mint-burn-flows:v3:aggregate:")) {
                return {
                  value: "{bad json",
                  updated_at: now,
                } as T;
              }
            }
            return null;
          },
          run: async () => ({ success: true, meta: {} }),
        }),
        all: async <T>() => {
          if (sql.includes("FROM mint_burn_hourly")) {
            throw new Error("simulated d1 failure");
          }
          return { results: [] as T[], success: true, meta: {} };
        },
        first: async () => null,
        run: async () => ({ success: true, meta: {} }),
      }),
    } as unknown as D1Database;

    const res = await handleMintBurnFlows(failingDb, new URL("https://x/api/mint-burn-flows?hours=720"));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Cached mint-burn-flows payload is malformed",
    });
  });

  it("disables FTQ when the report-card cache lacks an identity-complete publication", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });
    const identitylessReportCardCache = JSON.stringify({
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      scores: { "usdt-tether": { score: 80, grade: "A" } },
      updatedAt: now,
    });

    const db = mockD1([
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 15_000_000,
            burn_volume_usd: 5_000_000,
            net_flow_usd: 10_000_000,
          },
        ],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 10_000_000 }],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 0,
            daily_abs: 20_000_000,
          },
        ],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour }],
      },
      { match: "FROM mint_burn_events", rows: [] },
      {
        match: "cache",
        matchBinds: ["report_card_cache"],
        rows: [{ key: "report_card_cache", value: identitylessReportCardCache, updated_at: now }],
        first: { key: "report_card_cache", value: identitylessReportCardCache, updated_at: now },
      },
      {
        match: "cache",
        matchBinds: ["stablecoins"],
        rows: [{ key: "stablecoins", value: stablecoinsCache, updated_at: now }],
        first: { key: "stablecoins", value: stablecoinsCache, updated_at: now },
      },
    ]);

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
    expect(res.status).toBe(200);

    const body = MintBurnFlowsResponseSchema.parse(await res.json());
    expect(body.gauge.classificationSource).toBe("unavailable");
    expect(body.gauge.safetyScoreIdentity).toBeNull();
    expect(body.sync?.classificationWarning).toContain("identity-missing");
    expect(body.gauge.flightToQuality).toBe(false);
    expect(body.gauge.flightIntensity).toBe(0);
  });

  it("keeps freshness healthy through one missed critical-lane slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00Z"));

    const now = Math.floor(Date.now() / 1000);
    const thirtyMinutesAgo = now - 30 * 60;
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });

    const db = mockD1([
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 15_000_000,
            burn_volume_usd: 5_000_000,
            net_flow_usd: 10_000_000,
          },
        ],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 10_000_000 }],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 0,
            daily_abs: 20_000_000,
          },
        ],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour }],
      },
      { match: "FROM mint_burn_events", rows: [] },
      {
        match: "FROM mint_burn_sync_state",
        rows: [{ config_key: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7", last_block: 22_345_678 }],
      },
      {
        match: "SELECT started_at, status, metadata",
        rows: [{ started_at: thirtyMinutesAgo, status: "ok", metadata: JSON.stringify({ chainHead: 22_345_999 }) }],
        first: { started_at: thirtyMinutesAgo, status: "ok", metadata: JSON.stringify({ chainHead: 22_345_999 }) },
      },
      {
        match: "MAX(started_at) as started_at FROM cron_runs WHERE job = ? AND status = 'ok'",
        rows: [{ started_at: thirtyMinutesAgo }],
        first: { started_at: thirtyMinutesAgo },
      },
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: cache, updated_at: now }],
        first: { key: "stablecoins", value: cache, updated_at: now },
      },
    ]);

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
    expect(res.status).toBe(200);

    const body = MintBurnFlowsResponseSchema.parse(await res.json());
    const sync = body.sync!;
    const usdt = body.coins.find((coin) => coin.stablecoinId === "usdt-tether");
    expect(sync.freshnessStatus).toBe("fresh");
    expect(sync.warning).toBeNull();
    expect(usdt?.coverage?.adapterKinds).toEqual(["custom-events"]);
    expect(usdt?.coverage?.startBlockSource).toBe("reviewed-contract-specific");
    expect(usdt?.coverage?.startBlockConfidence).toBe("high");
    expect(res.headers.get("Warning")).toBeNull();
    expect(res.headers.get("X-Data-Age")).toBe(String(30 * 60));
  });

  it("warns once mint/burn freshness exceeds the shared status grace window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00Z"));

    const now = Math.floor(Date.now() / 1000);
    // 75 min old → ratio 1.25 vs the 60-min SLA (MAX_AGE = 2× 30-min lane),
    // firmly inside the "degraded" band (1.0 < ratio ≤ 1.5) and outside "fresh".
    const seventyFiveMinutesAgo = now - 75 * 60;
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });

    const db = mockD1([
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 15_000_000,
            burn_volume_usd: 5_000_000,
            net_flow_usd: 10_000_000,
          },
        ],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 10_000_000 }],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 0,
            daily_abs: 20_000_000,
          },
        ],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour }],
      },
      { match: "FROM mint_burn_events", rows: [] },
      {
        match: "FROM mint_burn_sync_state",
        rows: [{ config_key: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7", last_block: 22_345_678 }],
      },
      {
        match: "SELECT started_at, status, metadata",
        rows: [
          { started_at: seventyFiveMinutesAgo, status: "ok", metadata: JSON.stringify({ chainHead: 22_345_999 }) },
        ],
        first: { started_at: seventyFiveMinutesAgo, status: "ok", metadata: JSON.stringify({ chainHead: 22_345_999 }) },
      },
      {
        match: "MAX(started_at) as started_at FROM cron_runs WHERE job = ? AND status = 'ok'",
        rows: [{ started_at: seventyFiveMinutesAgo }],
        first: { started_at: seventyFiveMinutesAgo },
      },
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: cache, updated_at: now }],
        first: { key: "stablecoins", value: cache, updated_at: now },
      },
    ]);

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
    expect(res.status).toBe(200);

    const body = MintBurnFlowsResponseSchema.parse(await res.json());
    const sync = body.sync!;
    expect(sync.freshnessStatus).toBe("degraded");
    expect(sync.warning).toBe("Mint/burn sync freshness is degraded versus the 30-minute cron cadence.");
    expect(res.headers.get("Warning")).toBeNull();
    expect(res.headers.get("X-Data-Age")).toBe(String(75 * 60));
  });

  it("combines degraded freshness with the lookup fallback warning when cron freshness lookup fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00Z"));

    const now = Math.floor(Date.now() / 1000);
    // 75 min old → ratio 1.25 vs the 60-min SLA; see the previous test for the
    // rationale behind the band math.
    const seventyFiveMinutesAgo = now - 75 * 60;
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });

    const db = mockD1([
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            hour_ts: now - 3600,
            mint_count: 1,
            burn_count: 0,
            mint_volume_usd: 15_000_000,
            burn_volume_usd: 5_000_000,
            net_flow_usd: 10_000_000,
          },
        ],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", net_flow_usd: 10_000_000 }],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            chain_id: "ethereum",
            day_ts: tenDaysAgoDay,
            daily_net: 0,
            daily_abs: 20_000_000,
          },
        ],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdt-tether", chain_id: "ethereum", first_hour_ts: tenDaysAgoHour }],
      },
      { match: "FROM mint_burn_events", rows: [] },
      {
        match: "FROM mint_burn_sync_state",
        rows: [{ config_key: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7", last_block: 22_345_678 }],
      },
      {
        match: "SELECT started_at, status, metadata",
        rows: [
          { started_at: seventyFiveMinutesAgo, status: "ok", metadata: JSON.stringify({ chainHead: 22_345_999 }) },
        ],
        first: { started_at: seventyFiveMinutesAgo, status: "ok", metadata: JSON.stringify({ chainHead: 22_345_999 }) },
      },
      {
        match: "MAX(started_at) as started_at FROM cron_runs WHERE job = ? AND status = 'ok'",
        rows: [],
        throwError: new Error("cron lookup failed"),
      },
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: cache, updated_at: now }],
        first: { key: "stablecoins", value: cache, updated_at: now },
      },
    ]);

    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows"));
    expect(res.status).toBe(200);

    const body = MintBurnFlowsResponseSchema.parse(await res.json());
    expect(body.sync?.freshnessStatus).toBe("degraded");
    expect(body.sync?.warning).toContain("Mint/burn sync freshness is degraded");
    expect(body.sync?.warning).toContain("freshness lookup failed");
    expect(res.headers.get("X-Data-Age")).toBe(String(75 * 60));
  });
});
