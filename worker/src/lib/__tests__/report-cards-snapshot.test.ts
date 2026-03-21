import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { makeAsset } from "../../api/__tests__/helpers/fixtures";
import { handleReportCards } from "../../api/report-cards";
import {
  buildReportCardsSnapshot,
  ReportCardsSnapshotUnavailableError,
} from "../report-cards-snapshot";
import { RedemptionBackstopSnapshotUnavailableError } from "../redemption-backstops-store";

const loadRedemptionBackstopMapMock = vi.hoisted(() =>
  vi.fn(async () => ({})),
);

vi.mock("../redemption-backstops-store", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../redemption-backstops-store")
  >();
  return {
    ...original,
    loadRedemptionBackstopMap: loadRedemptionBackstopMapMock,
  };
});

const nowSec = Math.floor(Date.now() / 1000);

function makeReportCardsDb(assets: ReturnType<typeof makeAsset>[] = []) {
  const cacheValue = JSON.stringify({ peggedAssets: assets });
  return mockD1([
    {
      match: "cache",
      rows: [
        { key: "stablecoins", value: cacheValue, updated_at: nowSec },
        { key: "bluechip-ratings", value: "{}", updated_at: nowSec },
      ],
      first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
    },
    { match: "dex_liquidity", rows: [] },
    { match: "depeg_events", rows: [] },
    { match: "supply_history", rows: [] },
  ]);
}

describe("buildReportCardsSnapshot", () => {
  it("throws when stablecoins cache is missing", async () => {
    await expect(buildReportCardsSnapshot(mockD1())).rejects.toBeInstanceOf(
      ReportCardsSnapshotUnavailableError,
    );
  });

  it("returns cards + methodology + dependencyGraph + updatedAt", async () => {
    const db = makeReportCardsDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);
    const snapshot = await buildReportCardsSnapshot(db);

    expect(Array.isArray(snapshot.cards)).toBe(true);
    expect(snapshot.cards.length).toBeGreaterThan(0);
    expect(snapshot.methodology).toHaveProperty("version");
    expect(snapshot.methodology).toHaveProperty("weights");
    expect(snapshot.methodology).toHaveProperty("thresholds");
    expect(Array.isArray(snapshot.dependencyGraph.edges)).toBe(true);
    expect(typeof snapshot.updatedAt).toBe("number");
  });

  it("matches /api/report-cards response payload", async () => {
    const db = makeReportCardsDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);
    const snapshot = await buildReportCardsSnapshot(db);

    const response = await handleReportCards(db);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual(snapshot);
  });

  it("uses effective exit scoring when a redemption backstop row exists", async () => {
    const cacheValue = JSON.stringify({
      peggedAssets: [makeAsset({ id: "cusd-cap", symbol: "CUSD" })],
    });
    const db = mockD1([
      {
        match: "cache",
        rows: [
          { key: "stablecoins", value: cacheValue, updated_at: nowSec },
          { key: "bluechip-ratings", value: "{}", updated_at: nowSec },
        ],
        first: { key: "stablecoins", value: cacheValue, updated_at: nowSec },
      },
      {
        match: "dex_liquidity",
        rows: [
          {
            stablecoin_id: "cusd-cap",
            liquidity_score: 29,
            concentration_hhi: 1,
            pool_count: 1,
            chain_count: 1,
          },
        ],
      },
      { match: "depeg_events", rows: [] },
      { match: "supply_history", rows: [] },
    ]);
    loadRedemptionBackstopMapMock.mockResolvedValueOnce({
      "cusd-cap": {
        stablecoinId: "cusd-cap",
        score: 88,
        effectiveExitScore: 56,
        dexLiquidityScore: 29,
        accessScore: 100,
        settlementScore: 100,
        executionCertaintyScore: 80,
        capacityScore: 100,
        outputAssetQualityScore: 80,
        costScore: 40,
        routeFamily: "basket-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
        executionModel: "deterministic-basket",
        outputAssetType: "stable-basket",
        provider: "supply-full-model",
        sourceMode: "estimated",
        resolutionState: "resolved",
        capacityConfidence: "heuristic",
        feeConfidence: "undisclosed-reviewed",
        modelConfidence: "low",
        immediateCapacityUsd: 10_000_000,
        immediateCapacityRatio: 1,
        feeBps: null,
        queueEnabled: false,
        methodologyVersion: "1.0",
        updatedAt: nowSec,
        capsApplied: [],
      },
    });

    const snapshot = await buildReportCardsSnapshot(db);
    const card = snapshot.cards.find((entry) => entry.id === "cusd-cap");
    expect(card?.rawInputs.liquidityScore).toBe(29);
    expect(card?.rawInputs.redemptionBackstopScore).toBe(88);
    expect(card?.rawInputs.effectiveExitScore).toBe(56);
    expect(card?.dimensions.liquidity.score).toBe(56);
  });

  it("throws when the redemption backstop snapshot is unavailable", async () => {
    const db = makeReportCardsDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);
    loadRedemptionBackstopMapMock.mockRejectedValueOnce(
      new RedemptionBackstopSnapshotUnavailableError(
        "redemption snapshot unavailable",
      ),
    );

    await expect(buildReportCardsSnapshot(db)).rejects.toBeInstanceOf(
      ReportCardsSnapshotUnavailableError,
    );
  });
});
