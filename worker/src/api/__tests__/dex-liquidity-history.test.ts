import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { makeDexLiquidityHistoryRow } from "./helpers/fixtures";
import { handleDexLiquidityHistory } from "../dex-liquidity-history";

describe("handleDexLiquidityHistory", () => {
  const row = makeDexLiquidityHistoryRow();

  it("returns 200 with history array", async () => {
    const db = mockD1([{ match: "dex_liquidity_history", rows: [row] }]);
    const res = await handleDexLiquidityHistory(db, new URL("https://x/api/dex-liquidity-history?stablecoin=usdt-tether"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      tvl: number;
      volume24h: number;
      score: number | null;
      date: number;
      coverageClass: string;
      coverageConfidence: number;
      methodologyVersion: string;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]).toHaveProperty("tvl");
    expect(body[0]).toHaveProperty("volume24h");
    expect(body[0]).toHaveProperty("score");
    expect(body[0]).toHaveProperty("date");
    expect(body[0]).toHaveProperty("coverageClass");
    expect(body[0]).toHaveProperty("coverageConfidence");
    expect(body[0]).toHaveProperty("liquidityEvidenceClass");
    expect(body[0]).toHaveProperty("hasMeasuredLiquidityEvidence");
    expect(body[0]).toHaveProperty("trendworthy");
    expect(body[0]).toHaveProperty("methodologyVersion");
  });

  it("returns 200 with empty array when no data", async () => {
    const db = mockD1([{ match: "dex_liquidity_history", rows: [] }]);
    const res = await handleDexLiquidityHistory(db, new URL("https://x/api/dex-liquidity-history?stablecoin=usdt-tether"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns 400 when stablecoin param is missing", async () => {
    const db = mockD1([]);
    const res = await handleDexLiquidityHistory(db, new URL("https://x/api/dex-liquidity-history"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing ?stablecoin= parameter" });
  });

  it("returns 404 for unknown stablecoin ID", async () => {
    const db = mockD1([]);
    const res = await handleDexLiquidityHistory(db, new URL("https://x/api/dex-liquidity-history?stablecoin=../etc"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unknown stablecoin" });
  });

  it("maps snake_case columns to camelCase", async () => {
    const db = mockD1([{ match: "dex_liquidity_history", rows: [row] }]);
    const res = await handleDexLiquidityHistory(db, new URL("https://x/api/dex-liquidity-history?stablecoin=usdt-tether"));
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body[0]).not.toHaveProperty("total_tvl_usd");
    expect(body[0]).not.toHaveProperty("total_volume_24h_usd");
    expect(body[0]).not.toHaveProperty("liquidity_score");
    expect(body[0]).not.toHaveProperty("snapshot_date");
  });

  it("reconstructs methodologyVersion from snapshot date when DB version is null", async () => {
    const legacyRow = {
      ...makeDexLiquidityHistoryRow({
        snapshot_date: 1772250000, // v2.2 window
      }),
      methodology_version: null,
    };
    const db = mockD1([{ match: "dex_liquidity_history", rows: [legacyRow] }]);
    const res = await handleDexLiquidityHistory(db, new URL("https://x/api/dex-liquidity-history?stablecoin=usdt-tether"));
    const body = (await res.json()) as Array<{ methodologyVersion: string }>;
    expect(body[0]?.methodologyVersion).toBe("2.2");
  });

  it("marks low-confidence snapshots as informational rather than trendworthy", async () => {
    const db = mockD1([{
      match: "dex_liquidity_history",
      rows: [makeDexLiquidityHistoryRow({
        coverage_class: "fallback",
        coverage_confidence: 0.5,
      })],
    }]);
    const res = await handleDexLiquidityHistory(db, new URL("https://x/api/dex-liquidity-history?stablecoin=usdt-tether"));
    const body = (await res.json()) as Array<{
      liquidityEvidenceClass: string;
      hasMeasuredLiquidityEvidence: boolean;
      trendworthy: boolean;
    }>;
    expect(body[0]?.liquidityEvidenceClass).toBe("observed_unmeasured");
    expect(body[0]?.hasMeasuredLiquidityEvidence).toBe(false);
    expect(body[0]?.trendworthy).toBe(false);
  });
});
