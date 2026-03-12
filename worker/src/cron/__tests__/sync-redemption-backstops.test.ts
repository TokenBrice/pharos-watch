import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { makeAsset } from "../../api/__tests__/helpers/fixtures";

const loadStablecoinsCacheMock = vi.fn();
const loadDexLiquidityMapMock = vi.fn();
const resolveRedemptionBackstopEntryMock = vi.fn();
const upsertRedemptionBackstopSnapshotsMock = vi.fn();

vi.mock("../../lib/stablecoins-cache", () => ({
  loadStablecoinsCache: loadStablecoinsCacheMock,
  hasUsableStablecoinsPayload: (result: { kind: string; payload?: { peggedAssets?: unknown[] } | null }) =>
    (result.kind === "ok" || result.kind === "degraded")
      && !!result.payload
      && Array.isArray(result.payload.peggedAssets)
      && result.payload.peggedAssets.length > 0,
}));

vi.mock("../../lib/dex-liquidity", () => ({
  loadDexLiquidityMap: loadDexLiquidityMapMock,
}));

vi.mock("../../lib/redemption-backstop-sources", () => ({
  resolveRedemptionBackstopEntry: resolveRedemptionBackstopEntryMock,
}));

vi.mock("../../lib/redemption-backstops-store", () => ({
  upsertRedemptionBackstopSnapshots: upsertRedemptionBackstopSnapshotsMock,
}));

vi.mock("@shared/lib/redemption-backstops", () => ({
  getConfiguredRedemptionBackstopIds: () => ["cusd-cap", "iusd-infinifi"],
}));

describe("syncRedemptionBackstops", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadStablecoinsCacheMock.mockResolvedValue({
      kind: "ok",
      updatedAt: 1_700_000_000,
      payload: {
        peggedAssets: [
          makeAsset({ id: "cusd-cap", symbol: "CUSD", circulating: { peggedUSD: 10_000_000 } }),
          makeAsset({ id: "iusd-infinifi", symbol: "IUSD", circulating: { peggedUSD: 20_000_000 } }),
        ],
      },
    });
    loadDexLiquidityMapMock.mockResolvedValue({
      "cusd-cap": { liquidityScore: 29 },
      "iusd-infinifi": { liquidityScore: 47 },
    });
    upsertRedemptionBackstopSnapshotsMock.mockResolvedValue(undefined);
  });

  it("returns an error when the stablecoins cache is unavailable", async () => {
    loadStablecoinsCacheMock.mockResolvedValue({
      kind: "error",
      reason: "missing-cache",
      updatedAt: null,
    });

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    expect(result.status).toBe("error");
    expect(result.metadata).toContain("stablecoins-cache:missing-cache");
    expect(upsertRedemptionBackstopSnapshotsMock).not.toHaveBeenCalled();
  });

  it("writes snapshots and summarizes source-mode coverage", async () => {
    resolveRedemptionBackstopEntryMock
      .mockResolvedValueOnce({
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
        immediateCapacityUsd: 10_000_000,
        immediateCapacityRatio: 1,
        feeBps: null,
        queueEnabled: false,
        methodologyVersion: "1.0",
        updatedAt: 1_700_000_000,
        capsApplied: [],
      })
      .mockResolvedValueOnce({
        stablecoinId: "iusd-infinifi",
        score: 70,
        effectiveExitScore: 57,
        dexLiquidityScore: 47,
        accessScore: 100,
        settlementScore: 20,
        executionCertaintyScore: 60,
        capacityScore: 70,
        outputAssetQualityScore: 100,
        costScore: 100,
        routeFamily: "queue-redeem",
        accessModel: "permissionless-onchain",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        outputAssetType: "stable-single",
        provider: "reserve-sync-metadata",
        sourceMode: "dynamic",
        immediateCapacityUsd: 32_000_000,
        immediateCapacityRatio: 0.19,
        feeBps: 0,
        queueEnabled: true,
        methodologyVersion: "1.0",
        updatedAt: 1_700_000_000,
        capsApplied: ["queue-route-cap"],
      });

    const db = mockD1();
    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(db, new AbortController().signal);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(2);
    expect(upsertRedemptionBackstopSnapshotsMock).toHaveBeenCalledTimes(1);
    expect(db.getHistory().some((entry) => entry.sql.includes("DELETE FROM redemption_backstop"))).toBe(true);

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, number>;
    expect(metadata.dynamic).toBe(1);
    expect(metadata.estimated).toBe(1);
  });
});
