import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { makeAsset } from "../../api/__tests__/helpers/fixtures";
import { handleReportCards } from "../../api/report-cards";
import {
  buildReportCardsSnapshot,
  ReportCardsSnapshotUnavailableError,
} from "../report-cards-snapshot";
import { RedemptionBackstopSnapshotUnavailableError } from "../redemption-backstops-store";

const loadRedemptionBackstopMapMock = vi.hoisted(() =>
  vi.fn(),
);

const loadDexLiquiditySnapshotMock = vi.hoisted(() =>
  vi.fn(),
);

const loadFreshIndependentLiveReserveMapMock = vi.hoisted(() =>
  vi.fn(),
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

vi.mock("../dex-liquidity", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../dex-liquidity")
  >();
  return {
    ...original,
    loadDexLiquiditySnapshot: loadDexLiquiditySnapshotMock,
  };
});

vi.mock("../live-reserves-store", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../live-reserves-store")
  >();
  return {
    ...original,
    loadFreshIndependentLiveReserveMap: loadFreshIndependentLiveReserveMapMock,
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

function makeReportCardsDbWithBluechipValue(
  assets: ReturnType<typeof makeAsset>[],
  bluechipValue: string,
) {
  const stablecoinsValue = JSON.stringify({ peggedAssets: assets });
  return mockD1([
    {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: ["stablecoins"],
      rows: [],
      first: { value: stablecoinsValue, updated_at: nowSec },
    },
    {
      match: "SELECT value, updated_at FROM cache WHERE key = ?",
      matchBinds: ["bluechip-ratings"],
      rows: [],
      first: { value: bluechipValue, updated_at: nowSec },
    },
    { match: "dex_liquidity", rows: [] },
    { match: "depeg_events", rows: [] },
    { match: "supply_history", rows: [] },
  ]);
}

describe("buildReportCardsSnapshot", () => {
  beforeEach(() => {
    loadRedemptionBackstopMapMock.mockReset();
    loadRedemptionBackstopMapMock.mockResolvedValue({});
    loadDexLiquiditySnapshotMock.mockReset();
    loadDexLiquiditySnapshotMock.mockImplementation(async (db: D1Database) => {
      const rows = await db
        .prepare(
          "SELECT stablecoin_id, liquidity_score, concentration_hhi, pool_count, chain_count, updated_at FROM dex_liquidity",
        )
        .all<{
          stablecoin_id: string;
          liquidity_score: number | null;
          concentration_hhi: number | null;
          pool_count: number;
          chain_count: number;
          updated_at: number | null;
        }>();

      const map: Record<string, {
        liquidityScore: number | null;
        concentrationHhi: number | null;
        poolCount: number;
        chainCount: number;
      }> = {};
      let latestUpdatedAt: number | null = null;

      for (const row of rows.results ?? []) {
        map[row.stablecoin_id] = {
          liquidityScore: row.liquidity_score,
          concentrationHhi: row.concentration_hhi,
          poolCount: row.pool_count,
          chainCount: row.chain_count,
        };
        if (row.updated_at != null && (latestUpdatedAt == null || row.updated_at > latestUpdatedAt)) {
          latestUpdatedAt = row.updated_at;
        }
      }

      return { map, latestUpdatedAt };
    });
    loadFreshIndependentLiveReserveMapMock.mockReset();
    loadFreshIndependentLiveReserveMapMock.mockResolvedValue(new Map());
  });

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
        provider: "supply-ratio-model",
        sourceMode: "estimated",
        resolutionState: "resolved",
        capacityConfidence: "documented-bound",
        capacitySemantics: "immediate-bounded",
        feeConfidence: "undisclosed-reviewed",
        feeModelKind: "documented-variable",
        modelConfidence: "medium",
        immediateCapacityUsd: 10_000_000,
        immediateCapacityRatio: 0.5,
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
    expect(card?.rawInputs.redemptionUsedForLiquidity).toBe(true);
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

  it("degrades gracefully when dex liquidity is unavailable", async () => {
    const db = makeReportCardsDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);
    loadDexLiquiditySnapshotMock
      .mockRejectedValueOnce(new Error("dex liquidity unavailable"))
      .mockRejectedValueOnce(new Error("dex liquidity unavailable"));

    const snapshot = await buildReportCardsSnapshot(db);
    expect(snapshot.liquidityStale).toBe(true);

    const response = await handleReportCards(db);
    expect(response.status).toBe(200);
  });

  it("degrades gracefully when live reserves are unavailable", async () => {
    const db = makeReportCardsDb([makeAsset({ id: "usdt-tether", symbol: "USDT" })]);
    loadFreshIndependentLiveReserveMapMock
      .mockRejectedValueOnce(new Error("live reserves unavailable"))
      .mockRejectedValueOnce(new Error("live reserves unavailable"));

    const snapshot = await buildReportCardsSnapshot(db);
    expect(Array.isArray(snapshot.cards)).toBe(true);

    const response = await handleReportCards(db);
    expect(response.status).toBe(200);
  });

  it("ignores malformed bluechip cache payloads instead of failing the snapshot", async () => {
    const db = makeReportCardsDbWithBluechipValue(
      [makeAsset({ id: "usdt-tether", symbol: "USDT" })],
      JSON.stringify({ "usdt-tether": { grade: "A" } }),
    );

    const snapshot = await buildReportCardsSnapshot(db);
    const card = snapshot.cards.find((entry) => entry.id === "usdt-tether");

    expect(card).toBeDefined();
    expect(card?.rawInputs.bluechipGrade ?? null).toBeNull();
  });
});
