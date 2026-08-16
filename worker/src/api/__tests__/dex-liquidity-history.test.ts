import { describe, it, expect } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { makeDexLiquidityHistoryRow } from "../../test-helpers/__shared/fixtures";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleDexLiquidityHistory } from "../dex-liquidity-history";

describe("handleDexLiquidityHistory", () => {
  const row = makeDexLiquidityHistoryRow();

  it("returns 200 with history array", async () => {
    const db = mockD1([{ match: "dex_liquidity_history", rows: [row] }]);
    const res = await handleDexLiquidityHistory(
      db,
      new URL("https://x/api/dex-liquidity-history?stablecoin=usdt-tether"),
    );
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

  it("returns validated prospective route summaries and ignores legacy absence", async () => {
    const withSummary = makeDexLiquidityHistoryRow({
      exit_route_summary_json: JSON.stringify({
        observations: [
          {
            routeId: "dex:test",
            routeFamily: "dex-orderbook",
            scope: { kind: "venue", venue: "test", protocol: "test" },
            requestedNotionalUsd: 1_000_000,
            settlementHorizonSec: 300,
            maxCostBps: 200,
            executableUsd: 100_000,
            completionRatio: 0.1,
            output: { kind: "fiat", currency: "USD" },
            evidenceKind: "direct-orderbook-depth",
            confidence: "medium",
            scoreEligible: false,
            observedAt: 1_700_000_000,
            freshnessSeconds: 0,
            commonModeKeys: ["venue:test"],
          },
        ],
        coverage: {
          status: "populated",
          capabilityMatrixVersion: "test",
          retainedPoolCount: 1,
          observationCount: 1,
          scoreEligibleObservationCount: 0,
          unsupportedPoolCount: 0,
          evidenceCounts: { "direct-orderbook-depth": 1 },
          unsupportedReasons: {},
        },
      }),
    });
    const db = mockD1([{ match: "dex_liquidity_history", rows: [withSummary] }]);
    const res = await handleDexLiquidityHistory(
      db,
      new URL("https://x/api/dex-liquidity-history?stablecoin=usdt-tether"),
    );
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body[0]).toMatchObject({
      exitRouteObservations: [{ routeId: "dex:test", scoreEligible: false }],
      exitRouteObservationCoverage: { capabilityMatrixVersion: "test" },
    });
  });

  it("returns 200 with empty array when no data", async () => {
    const db = mockD1([{ match: "dex_liquidity_history", rows: [] }]);
    const res = await handleDexLiquidityHistory(
      db,
      new URL("https://x/api/dex-liquidity-history?stablecoin=usdt-tether"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("maps snake_case columns to camelCase", async () => {
    const db = mockD1([{ match: "dex_liquidity_history", rows: [row] }]);
    const res = await handleDexLiquidityHistory(
      db,
      new URL("https://x/api/dex-liquidity-history?stablecoin=usdt-tether"),
    );
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
    const res = await handleDexLiquidityHistory(
      db,
      new URL("https://x/api/dex-liquidity-history?stablecoin=usdt-tether"),
    );
    const body = (await res.json()) as Array<{ methodologyVersion: string }>;
    expect(body[0]?.methodologyVersion).toBe("2.2");
  });

  it("marks low-confidence snapshots as informational rather than trendworthy", async () => {
    const db = mockD1([
      {
        match: "dex_liquidity_history",
        rows: [
          makeDexLiquidityHistoryRow({
            coverage_class: "fallback",
            coverage_confidence: 0.5,
          }),
        ],
      },
    ]);
    const res = await handleDexLiquidityHistory(
      db,
      new URL("https://x/api/dex-liquidity-history?stablecoin=usdt-tether"),
    );
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

registerStablecoinParameterContract({
  name: "DEX liquidity history",
  path: "/api/dex-liquidity-history",
  invoke: handleDexLiquidityHistory,
});
