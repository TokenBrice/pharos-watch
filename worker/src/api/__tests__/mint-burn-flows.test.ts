import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleMintBurnFlows } from "../mint-burn-flows";
import {
  MintBurnFlowsResponseSchema,
  MintBurnPerCoinResponseSchema,
} from "@shared/types";

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
      gauge: { score: 0, band: "NEUTRAL", intensitySemantics: "signed-v2", flightToQuality: false, flightIntensity: 0, trackedCoins: 4, trackedMcapUsd: 1e11 },
      coins: [{
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
      }],
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
        rows: [{ stablecoin_id: "usdt-tether", day_ts: tenDaysAgoDay, daily_net: 1_000_000, daily_abs: 1_000_000 }],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdt-tether", first_hour_ts: tenDaysAgoHour }],
      },
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        rows: [],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [{ stablecoin_id: "usdt-tether", net_flow_usd: 1_000_000 }],
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
          { stablecoin_id: "usdt-tether", net_flow_usd: 0 },
          { stablecoin_id: "usdc-circle", net_flow_usd: 60_000_000 },
        ],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [
          { stablecoin_id: "usdt-tether", day_ts: tenDaysAgoDay, daily_net: 1_000_000, daily_abs: 1_000_000 },
          { stablecoin_id: "usdc-circle", day_ts: tenDaysAgoDay, daily_net: 0, daily_abs: 200_000_000 },
        ],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [
          { stablecoin_id: "usdt-tether", first_hour_ts: tenDaysAgoHour },
          { stablecoin_id: "usdc-circle", first_hour_ts: tenDaysAgoHour },
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

  it("keeps negative net flow separate from positive pressure shift semantics", async () => {
    const now = Math.floor(Date.now() / 1000);
    const nowDay = Math.floor(now / 86400) * 86400;
    const firstHourTs = nowDay - 9 * 86400;
    const baselineRows = Array.from({ length: 10 }, (_, index) => ({
      stablecoin_id: "usdf-falcon",
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
        rows: [{ stablecoin_id: "usdf-falcon", net_flow_usd: -200_000 }],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: baselineRows,
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdf-falcon", first_hour_ts: firstHourTs }],
      },
      { match: "mint_burn_events", rows: [] },
      {
        match: "cache",
        rows: [{ key: "stablecoins", value: cache, updated_at: now }],
        first: { key: "stablecoins", value: cache, updated_at: now },
      },
    ]);

    const res = await handleMintBurnFlows(
      regressionDb,
      new URL("https://x/api/mint-burn-flows"),
    );
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
        day_ts: nowDay - ((index + 1) * 86400),
        daily_net: 1_000_000,
        daily_abs: 10_000_000,
      })),
      {
        stablecoin_id: "usdt-tether",
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
        rows: [{ stablecoin_id: "usdt-tether", net_flow_usd: 1_000_000 }],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: baselineRows,
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdt-tether", first_hour_ts: firstHourTs }],
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
        rows: [{ stablecoin_id: "usdt-tether", net_flow_usd: 2_000_000 }],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [{ stablecoin_id: "usdt-tether", day_ts: tenDaysAgoDay, daily_net: 0, daily_abs: 2_000_000 }],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdt-tether", first_hour_ts: tenDaysAgoHour }],
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
  });

  it("keeps aggregate coin fields on a fixed 24h window even when hours changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));

    const now = Math.floor(Date.now() / 1000);
    const twentyFourHourStart = now - 24 * 3600;
    const sevenDayStart = now - 168 * 3600;
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });

    const db = mockD1([
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        matchBinds: ["ethereum", sevenDayStart],
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
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        matchBinds: ["ethereum", twentyFourHourStart],
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
        rows: [
          { stablecoin_id: "usdt-tether", net_flow_usd: 40_000_000 },
        ],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [{ stablecoin_id: "usdt-tether", day_ts: tenDaysAgoDay, daily_net: 0, daily_abs: 20_000_000 }],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdt-tether", first_hour_ts: tenDaysAgoHour }],
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
  });

  it("serves cached aggregate fallback when live query fails", async () => {
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
              if (key.startsWith("mint-burn-flows:v2:aggregate:")) {
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
    expect(body).toEqual(cachedBody);
    expect(res.headers.get("Warning")).toBeNull();
  });

  it("marks FTQ classification unavailable when report-card cache is missing", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const stablecoinsCache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });

    const db = mockD1([
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        rows: [{
          stablecoin_id: "usdt-tether",
          chain_id: "ethereum",
          hour_ts: now - 3600,
          mint_count: 1,
          burn_count: 0,
          mint_volume_usd: 15_000_000,
          burn_volume_usd: 5_000_000,
          net_flow_usd: 10_000_000,
        }],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [{ stablecoin_id: "usdt-tether", net_flow_usd: 10_000_000 }],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [{ stablecoin_id: "usdt-tether", day_ts: tenDaysAgoDay, daily_net: 0, daily_abs: 20_000_000 }],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdt-tether", first_hour_ts: tenDaysAgoHour }],
      },
      { match: "FROM mint_burn_events", rows: [] },
      {
        match: "cache",
        matchBinds: ["report_card_cache"],
        rows: [],
        first: null,
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
    expect(body.sync?.classificationWarning).toContain("missing-cache");
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
        rows: [{
          stablecoin_id: "usdt-tether",
          chain_id: "ethereum",
          hour_ts: now - 3600,
          mint_count: 1,
          burn_count: 0,
          mint_volume_usd: 15_000_000,
          burn_volume_usd: 5_000_000,
          net_flow_usd: 10_000_000,
        }],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [{ stablecoin_id: "usdt-tether", net_flow_usd: 10_000_000 }],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [{ stablecoin_id: "usdt-tether", day_ts: tenDaysAgoDay, daily_net: 0, daily_abs: 20_000_000 }],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdt-tether", first_hour_ts: tenDaysAgoHour }],
      },
      { match: "FROM mint_burn_events", rows: [] },
      {
        match: "SELECT last_block FROM mint_burn_sync_state",
        rows: [{ key: "ethereum:usdt-tether", last_block: 22_345_678 }],
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
    expect(sync.freshnessStatus).toBe("fresh");
    expect(sync.warning).toBeNull();
    expect(res.headers.get("Warning")).toBeNull();
    expect(res.headers.get("X-Data-Age")).toBe(String(30 * 60));
  });

  it("warns once mint/burn freshness exceeds the shared status grace window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00Z"));

    const now = Math.floor(Date.now() / 1000);
    const fiftyMinutesAgo = now - 50 * 60;
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const cache = JSON.stringify({
      peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100_000_000_000 } }],
    });

    const db = mockD1([
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        rows: [{
          stablecoin_id: "usdt-tether",
          chain_id: "ethereum",
          hour_ts: now - 3600,
          mint_count: 1,
          burn_count: 0,
          mint_volume_usd: 15_000_000,
          burn_volume_usd: 5_000_000,
          net_flow_usd: 10_000_000,
        }],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [{ stablecoin_id: "usdt-tether", net_flow_usd: 10_000_000 }],
      },
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [{ stablecoin_id: "usdt-tether", day_ts: tenDaysAgoDay, daily_net: 0, daily_abs: 20_000_000 }],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "usdt-tether", first_hour_ts: tenDaysAgoHour }],
      },
      { match: "FROM mint_burn_events", rows: [] },
      {
        match: "SELECT last_block FROM mint_burn_sync_state",
        rows: [{ key: "ethereum:usdt-tether", last_block: 22_345_678 }],
      },
      {
        match: "SELECT started_at, status, metadata",
        rows: [{ started_at: fiftyMinutesAgo, status: "ok", metadata: JSON.stringify({ chainHead: 22_345_999 }) }],
        first: { started_at: fiftyMinutesAgo, status: "ok", metadata: JSON.stringify({ chainHead: 22_345_999 }) },
      },
      {
        match: "MAX(started_at) as started_at FROM cron_runs WHERE job = ? AND status = 'ok'",
        rows: [{ started_at: fiftyMinutesAgo }],
        first: { started_at: fiftyMinutesAgo },
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
    expect(sync.warning).toBe("Mint/burn sync freshness is degraded versus the 20-minute cron cadence.");
    expect(res.headers.get("Warning") ?? "").toContain("Response is stale");
    expect(res.headers.get("X-Data-Age")).toBe(String(50 * 60));
  });
});
