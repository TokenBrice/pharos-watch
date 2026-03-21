import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import { makeAsset } from "../../api/__tests__/helpers/fixtures";

const loadStablecoinsCacheMock = vi.fn();
const loadDexLiquiditySnapshotMock = vi.fn();
const resolveRedemptionBackstopEntryMock = vi.fn();
const buildRedemptionBackstopEntryMock = vi.fn();
const upsertRedemptionBackstopSnapshotsMock = vi.fn();
const loadReserveSyncStateMapMock = vi.fn();
let configuredIdsMock = ["cusd-cap", "iusd-infinifi"];

function makeResolvedSnapshot(stablecoinId: string, now: number, overrides: Record<string, unknown> = {}) {
  return {
    stablecoinId,
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
    updatedAt: now,
    capsApplied: [],
    ...overrides,
  };
}

vi.mock("../../lib/stablecoins-cache", () => ({
  loadStablecoinsCache: loadStablecoinsCacheMock,
  hasUsableStablecoinsPayload: (result: { kind: string; payload?: { peggedAssets?: unknown[] } | null }) =>
    (result.kind === "ok" || result.kind === "degraded") &&
    !!result.payload &&
    Array.isArray(result.payload.peggedAssets) &&
    result.payload.peggedAssets.length > 0,
}));

vi.mock("../../lib/dex-liquidity", () => ({
  loadDexLiquiditySnapshot: loadDexLiquiditySnapshotMock,
}));

vi.mock("../../lib/live-reserves-store", () => ({
  loadReserveSyncStateMap: loadReserveSyncStateMapMock,
}));

vi.mock("../../lib/redemption-backstop-sources", () => ({
  buildRedemptionBackstopEntry: buildRedemptionBackstopEntryMock,
  resolveRedemptionBackstopEntry: resolveRedemptionBackstopEntryMock,
}));

vi.mock("../../lib/redemption-backstops-store", () => ({
  upsertRedemptionBackstopSnapshots: upsertRedemptionBackstopSnapshotsMock,
}));

vi.mock("@shared/lib/redemption-backstops", () => ({
  getConfiguredRedemptionBackstopIds: () => configuredIdsMock,
  getRedemptionBackstopConfig: (id: string) =>
    configuredIdsMock.includes(id)
      ? {
          routeFamily: "basket-redeem",
          accessModel: "permissionless-onchain",
          settlementModel: "atomic",
          executionModel: "deterministic-basket",
          outputAssetType: "stable-basket",
          capacityModel: { kind: "supply-full" },
          costModel: { kind: "dynamic-or-unclear" },
        }
      : null,
}));

describe("syncRedemptionBackstops", () => {
  beforeEach(() => {
    const now = Math.floor(Date.now() / 1000);
    configuredIdsMock = ["cusd-cap", "iusd-infinifi"];
    vi.clearAllMocks();
    loadStablecoinsCacheMock.mockResolvedValue({
      kind: "ok",
      updatedAt: now,
      payload: {
        peggedAssets: [
          makeAsset({ id: "cusd-cap", symbol: "CUSD", circulating: { peggedUSD: 10_000_000 } }),
          makeAsset({ id: "iusd-infinifi", symbol: "IUSD", circulating: { peggedUSD: 20_000_000 } }),
        ],
      },
    });
    loadDexLiquiditySnapshotMock.mockResolvedValue({
      map: {
        "cusd-cap": { liquidityScore: 29 },
        "iusd-infinifi": { liquidityScore: 47 },
      },
      latestUpdatedAt: now,
    });
    loadReserveSyncStateMapMock.mockResolvedValue(new Map());
    buildRedemptionBackstopEntryMock.mockResolvedValue({
      stablecoinId: "iusd-infinifi",
      score: null,
      effectiveExitScore: 47,
      dexLiquidityScore: 47,
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 80,
      capacityScore: null,
      outputAssetQualityScore: 80,
      costScore: 40,
      routeFamily: "basket-redeem",
      accessModel: "permissionless-onchain",
      settlementModel: "atomic",
      executionModel: "deterministic-basket",
      outputAssetType: "stable-basket",
      provider: "supply-full-model",
      sourceMode: "static",
      resolutionState: "missing-cache",
      capacityConfidence: "heuristic",
      feeConfidence: "undisclosed-reviewed",
      modelConfidence: "low",
      immediateCapacityUsd: null,
      immediateCapacityRatio: null,
      feeBps: null,
      queueEnabled: false,
      methodologyVersion: "1.0",
      updatedAt: now,
      capsApplied: [],
    });
    upsertRedemptionBackstopSnapshotsMock.mockResolvedValue(undefined);
    resolveRedemptionBackstopEntryMock.mockImplementation((_db: unknown, asset: { id: string }) =>
      Promise.resolve(makeResolvedSnapshot(asset.id, now)),
    );
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
      .mockResolvedValueOnce(makeResolvedSnapshot("cusd-cap", 1_700_000_000))
      .mockResolvedValueOnce(
        makeResolvedSnapshot("iusd-infinifi", 1_700_000_000, {
          score: 70,
          effectiveExitScore: 57,
          dexLiquidityScore: 47,
          settlementScore: 20,
          executionCertaintyScore: 60,
          capacityScore: 70,
          outputAssetQualityScore: 100,
          costScore: 100,
          routeFamily: "queue-redeem",
          settlementModel: "queued",
          executionModel: "rules-based-nav",
          outputAssetType: "stable-single",
          provider: "reserve-sync-metadata",
          sourceMode: "dynamic",
          capacityConfidence: "dynamic",
          feeConfidence: "fixed",
          modelConfidence: "high",
          immediateCapacityUsd: 32_000_000,
          immediateCapacityRatio: 0.19,
          feeBps: 0,
          queueEnabled: true,
          capsApplied: ["queue-route-cap"],
        }),
      );

    const db = mockD1();
    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(db, new AbortController().signal);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(2);
    expect(upsertRedemptionBackstopSnapshotsMock).toHaveBeenCalledTimes(1);
    expect(db.getHistory().some((entry) => entry.sql.includes("SELECT stablecoin_id FROM redemption_backstop"))).toBe(true);

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, number>;
    expect(metadata.resolved).toBe(2);
    expect(metadata.unresolved).toBe(0);
    expect(metadata.dynamic).toBe(1);
    expect(metadata.estimated).toBe(1);
  });

  it("still snapshots configured ids that are missing from the stablecoins cache", async () => {
    loadStablecoinsCacheMock.mockResolvedValue({
      kind: "ok",
      updatedAt: Math.floor(Date.now() / 1000),
      payload: {
        peggedAssets: [makeAsset({ id: "cusd-cap", symbol: "CUSD", circulating: { peggedUSD: 10_000_000 } })],
      },
    });

    resolveRedemptionBackstopEntryMock.mockResolvedValueOnce({
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
      updatedAt: Math.floor(Date.now() / 1000),
      capsApplied: [],
    });

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(2);
    expect(resolveRedemptionBackstopEntryMock).toHaveBeenCalledTimes(1);
    expect(buildRedemptionBackstopEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      "iusd-infinifi",
      expect.objectContaining({ routeFamily: "basket-redeem" }),
      null,
      47,
      expect.any(Number),
      { reserveSyncState: null },
    );
    expect(upsertRedemptionBackstopSnapshotsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ stablecoinId: "cusd-cap" }),
        expect.objectContaining({ stablecoinId: "iusd-infinifi" }),
      ]),
    );

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.synced).toBe(2);
    expect(metadata.resolved).toBe(1);
    expect(metadata.unresolved).toBe(1);
    expect(metadata.missingFromCache).toEqual(["iusd-infinifi"]);
  });

  it("prunes stale rows without issuing an oversized NOT IN clause", async () => {
    const now = Math.floor(Date.now() / 1000);
    configuredIdsMock = Array.from({ length: 136 }, (_value, index) => `coin-${index + 1}`);

    loadStablecoinsCacheMock.mockResolvedValue({
      kind: "ok",
      updatedAt: now,
      payload: {
        peggedAssets: configuredIdsMock.map((id) =>
          makeAsset({ id, symbol: id.toUpperCase(), circulating: { peggedUSD: 1_000_000 } }),
        ),
      },
    });
    loadDexLiquiditySnapshotMock.mockResolvedValue({
      map: {},
      latestUpdatedAt: now,
    });
    resolveRedemptionBackstopEntryMock.mockImplementation((_db: unknown, asset: { id: string }) =>
      Promise.resolve(makeResolvedSnapshot(asset.id, now)),
    );

    const db = mockD1([{ match: "SELECT stablecoin_id FROM redemption_backstop", rows: [{ stablecoin_id: "legacy-removed" }] }]);
    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(db, new AbortController().signal);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(136);
    expect(db.getHistory().some((entry) => entry.sql.includes("NOT IN"))).toBe(false);
    expect(db.getHistory()).toContainEqual({
      sql: "DELETE FROM redemption_backstop WHERE stablecoin_id = ?",
      binds: ["legacy-removed"],
    });
  });
});
