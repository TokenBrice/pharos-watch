import { readJsonResponse } from "./api-request-response.test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleMintBurnFlows } from "../mint-burn-flows";
import { MintBurnFlowsResponseSchema, MintBurnPerCoinResponseSchema } from "@shared/types/mint-burn";

function mintBurnD1(tables: MockTableConfig[] = []) {
  return mockD1([
    ...tables,
    { match: "FROM mint_burn_sync_state", rows: [] },
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "SELECT MAX(started_at) as started_at FROM cron_runs", rows: [], first: { started_at: null } },
    { match: "INSERT INTO cache (key, value, updated_at)", rows: [] },
  ]);
}

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
    vi.restoreAllMocks();
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

  const db = mintBurnD1([
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

    const body = (await readJsonResponse(res, 200)) as Record<string, unknown>;

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

    const body = await readJsonResponse(res, 200);

    // Cross-validate against per-coin schema
    const parsed = MintBurnPerCoinResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);

    // Structural assertions — NOT aggregate shape
    expect(body).toHaveProperty("stablecoinId");
    expect(body).toHaveProperty("chains");
    expect(body).not.toHaveProperty("coins");
    expect(body).not.toHaveProperty("gauge");
  });

  registerStablecoinParameterContract({
    name: "mint/burn flows",
    path: "/api/mint-burn-flows",
    invoke: handleMintBurnFlows,
    cases: [{ kind: "unknown", stablecoin: "99999" }],
  });

  it("returns 404 for a valid stablecoin that is not tracked for mint/burn flows", async () => {
    const url = new URL("https://x/api/mint-burn-flows?stablecoin=susdai-usd-ai");
    const res = await handleMintBurnFlows(db, url);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: 'Stablecoin "susdai-usd-ai" is not tracked for mint/burn flows',
    });
  });

  it("rejects out-of-range hours instead of clamping them", async () => {
    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows?hours=9999"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid hours: must be between 1 and 720" });
  });

  it("returns 503 when stablecoins cache is unavailable and no flow fallback cache exists", async () => {
    const res = await handleMintBurnFlows(mintBurnD1(), new URL("https://x/api/mint-burn-flows"));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Stablecoins data not yet available",
    });
  });
});
