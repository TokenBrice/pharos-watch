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
});
