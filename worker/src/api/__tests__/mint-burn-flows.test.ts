import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleMintBurnFlows } from "../mint-burn-flows";
import {
  MintBurnFlowsResponseSchema,
  MintBurnPerCoinResponseSchema,
} from "../../../../src/lib/types";

// ---------------------------------------------------------------------------
// Regression tests (shape assertions on literal objects)
// ---------------------------------------------------------------------------

describe("mint-burn-flows regression: per-coin vs aggregate shape", () => {
  it("per-coin response does NOT have a coins array", async () => {
    const perCoinResponse = {
      stablecoinId: "1",
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
      gauge: { score: 50, band: "NEUTRAL", flightToQuality: false, flightIntensity: 0, trackedCoins: 4, trackedMcapUsd: 1e11 },
      coins: [{ stablecoinId: "1", symbol: "USDT", flowIntensity: 50, netFlow24hUsd: 100, mintVolume24hUsd: 200, burnVolume24hUsd: 100, mintCount24h: 5, burnCount24h: 3, netFlow7dUsd: 500, largestEvent24h: null }],
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
  const nowSec = Math.floor(Date.now() / 1000);

  const hourlyRow = {
    stablecoin_id: "1",
    chain_id: "ethereum",
    hour_ts: nowSec - 3600,
    mint_count: 5,
    burn_count: 3,
    mint_volume_usd: 10000,
    burn_volume_usd: 5000,
    net_flow_usd: 5000,
  };

  const stablecoinsCache = JSON.stringify({
    peggedAssets: [{ id: "1", circulating: { peggedUSD: 100000000000 } }],
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
    const url = new URL("https://x/api/mint-burn-flows?stablecoin=1");
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

  it("returns neutral flow intensity for sparse coins with no 24h activity after 7+ tracked days", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tenDaysAgoHour = Math.floor((now - 10 * 86400) / 3600) * 3600;
    const tenDaysAgoDay = Math.floor(tenDaysAgoHour / 86400) * 86400;
    const sparseCache = JSON.stringify({
      peggedAssets: [{ id: "1", circulating: { peggedUSD: 100000000000 } }],
    });

    const sparseDb = mockD1([
      {
        match: "SUM(net_flow_usd) as daily_net",
        rows: [{ stablecoin_id: "1", day_ts: tenDaysAgoDay, daily_net: 1_000_000, daily_abs: 1_000_000 }],
      },
      {
        match: "MIN(hour_ts) as first_hour_ts",
        rows: [{ stablecoin_id: "1", first_hour_ts: tenDaysAgoHour }],
      },
      {
        match: "SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count",
        rows: [],
      },
      {
        match: "SUM(net_flow_usd) as net_flow_usd",
        rows: [{ stablecoin_id: "1", net_flow_usd: 1_000_000 }],
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
    const usdt = body.coins.find((coin) => coin.stablecoinId === "1");

    expect(usdt).toBeDefined();
    expect(usdt?.flowIntensity).not.toBeNull();
    expect(usdt?.flowIntensity ?? 0).toBe(50);
  });
});
