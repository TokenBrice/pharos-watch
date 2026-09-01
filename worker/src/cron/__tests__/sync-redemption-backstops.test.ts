import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 as createMockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { makeAsset } from "../../test-helpers/__shared/fixtures";

const DEFAULT_REDEMPTION_BACKSTOP_D1_TABLES: MockTableConfig[] = [
  { match: "FROM depeg_events", rows: [] },
];

function mockD1(tables: MockTableConfig[] = []) {
  return createMockD1([...tables, ...DEFAULT_REDEMPTION_BACKSTOP_D1_TABLES]);
}

const loadStablecoinsCacheMock = vi.fn();
const loadDexLiquiditySnapshotMock = vi.fn();
const resolveRedemptionBackstopEntryMock = vi.fn();
const buildRedemptionBackstopEntryMock = vi.fn();
const buildFailedRedemptionBackstopEntryMock = vi.fn();
const upsertRedemptionBackstopSnapshotsMock = vi.fn();
const loadReserveSnapshotMetadataMapMock = vi.fn();
let configuredIdsMock = ["cusd-cap", "iusd-infinifi"];
const GATE_LOAD_TIMEOUT_MS = 15_000;

function makeResolvedSnapshot(stablecoinId: string, now: number, overrides: Record<string, unknown> = {}) {
  return {
    stablecoinId,
    score: 88,
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

vi.mock("../../lib/redemption-backstop-sources", () => ({
  buildFailedRedemptionBackstopEntry: buildFailedRedemptionBackstopEntryMock,
  buildRedemptionBackstopEntry: buildRedemptionBackstopEntryMock,
  resolveRedemptionBackstopEntry: resolveRedemptionBackstopEntryMock,
}));

vi.mock("../../lib/redemption-backstops-store", () => ({
  upsertRedemptionBackstopSnapshots: upsertRedemptionBackstopSnapshotsMock,
}));

vi.mock("../../lib/live-reserves-store", () => ({
  loadReserveSnapshotMetadataMap: loadReserveSnapshotMetadataMapMock,
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
    buildRedemptionBackstopEntryMock.mockResolvedValue({
      stablecoinId: "iusd-infinifi",
      score: null,
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
      capacitySemantics: "eventual-only",
      feeConfidence: "undisclosed-reviewed",
      feeModelKind: "undisclosed-reviewed",
      modelConfidence: "low",
      immediateCapacityUsd: null,
      immediateCapacityRatio: null,
      feeBps: null,
      queueEnabled: false,
      methodologyVersion: "1.0",
      updatedAt: now,
      capsApplied: [],
    });
    buildFailedRedemptionBackstopEntryMock.mockImplementation(
      (stablecoinId: string, _config: unknown, failedAt: number) => ({
        stablecoinId,
        score: null,
        dexLiquidityScore: null,
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
        provider: "sync-error",
        sourceMode: "static",
        resolutionState: "failed",
        capacityConfidence: "heuristic",
        capacitySemantics: "eventual-only",
        feeConfidence: "undisclosed-reviewed",
        feeModelKind: "undisclosed-reviewed",
        modelConfidence: "low",
        immediateCapacityUsd: null,
        immediateCapacityRatio: null,
        feeBps: null,
        queueEnabled: false,
        methodologyVersion: "1.0",
        updatedAt: failedAt,
        capsApplied: [],
        notes: ["Latest redemption-backstop sync failed"],
      }),
    );
    loadReserveSnapshotMetadataMapMock.mockResolvedValue(new Map());
    upsertRedemptionBackstopSnapshotsMock.mockImplementation((_db: unknown, snapshots: unknown[]) =>
      Promise.resolve({
        runId: "redemption:test-run",
        attemptedCount: snapshots.length,
        runRowsWrittenCount: snapshots.length,
        historyWrittenCount: snapshots.length,
        warnings: [],
      }),
    );
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
  }, GATE_LOAD_TIMEOUT_MS);

  it("aborts before loading inputs when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("manual abort"));

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");

    await expect(syncRedemptionBackstops(mockD1(), controller.signal)).rejects.toThrow("manual abort");
    expect(loadStablecoinsCacheMock).not.toHaveBeenCalled();
    expect(resolveRedemptionBackstopEntryMock).not.toHaveBeenCalled();
    expect(upsertRedemptionBackstopSnapshotsMock).not.toHaveBeenCalled();
  }, GATE_LOAD_TIMEOUT_MS);

  it("aborts between configured IDs without writing a partial snapshot", async () => {
    const now = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    resolveRedemptionBackstopEntryMock.mockImplementationOnce((_db: unknown, asset: { id: string }) => {
      controller.abort(new Error("abort after first row"));
      return Promise.resolve(makeResolvedSnapshot(asset.id, now));
    });

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");

    await expect(syncRedemptionBackstops(mockD1(), controller.signal)).rejects.toThrow("abort after first row");
    expect(resolveRedemptionBackstopEntryMock).toHaveBeenCalledTimes(1);
    expect(upsertRedemptionBackstopSnapshotsMock).not.toHaveBeenCalled();
  });

  it("aborts after the final row resolves before writing snapshots", async () => {
    const now = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    resolveRedemptionBackstopEntryMock.mockImplementation((_db: unknown, asset: { id: string }) => {
      if (asset.id === "iusd-infinifi") {
        controller.abort(new Error("abort before write"));
      }
      return Promise.resolve(makeResolvedSnapshot(asset.id, now));
    });

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");

    await expect(syncRedemptionBackstops(mockD1(), controller.signal)).rejects.toThrow("abort before write");
    expect(resolveRedemptionBackstopEntryMock).toHaveBeenCalledTimes(2);
    expect(upsertRedemptionBackstopSnapshotsMock).not.toHaveBeenCalled();
  });

  it("writes snapshots and summarizes source-mode coverage", async () => {
    resolveRedemptionBackstopEntryMock
      .mockResolvedValueOnce(makeResolvedSnapshot("cusd-cap", 1_700_000_000))
      .mockResolvedValueOnce(
        makeResolvedSnapshot("iusd-infinifi", 1_700_000_000, {
          score: 70,
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
          capacitySemantics: "immediate-bounded",
          feeConfidence: "fixed",
          feeModelKind: "fixed-bps",
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
    // The legacy current-table mirror is retired: the cron no longer reads or
    // prunes the redemption_backstop table directly.
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM redemption_backstop"))).toBe(false);

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.resolved).toBe(2);
    expect(metadata.unresolved).toBe(0);
    expect(metadata.familyMissingCapacityBy).toBeUndefined();
    expect(metadata.providerMissingCapacityBy).toBeUndefined();
    expect(metadata.dynamic).toBe(1);
    expect(metadata.estimated).toBe(1);
    expect(metadata.routeStatusProducer).toBe("live-reserve-adapters-plus-static-policy");
    expect(metadata.routeStatusProducerFetches).toBe(false);
    expect(metadata.snapshotRunId).toBe("redemption:test-run");
    expect(metadata.runRowsWrittenCount).toBe(2);
    expect(metadata.currentMirroredCount).toBeUndefined();
    expect(typeof metadata.registryHash).toBe("string");
    expect(typeof metadata.v4ScoringParametersHash).toBe("string");
  });

  it("propagates snapshot write failures without reporting successful metadata", async () => {
    upsertRedemptionBackstopSnapshotsMock.mockRejectedValueOnce(new Error("snapshot write failed"));

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");

    await expect(syncRedemptionBackstops(mockD1(), new AbortController().signal)).rejects.toThrow(
      "snapshot write failed",
    );
    expect(resolveRedemptionBackstopEntryMock).toHaveBeenCalledTimes(2);
  });

  it("aborts after the snapshot write resolves before reporting run metadata", async () => {
    const controller = new AbortController();
    upsertRedemptionBackstopSnapshotsMock.mockImplementationOnce((_db: unknown, snapshots: unknown[]) => {
      controller.abort(new Error("abort during write"));
      return Promise.resolve({
        runId: "redemption:test-run",
        attemptedCount: snapshots.length,
        runRowsWrittenCount: snapshots.length,
        historyWrittenCount: snapshots.length,
        warnings: [],
      });
    });

    const db = mockD1();
    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");

    await expect(syncRedemptionBackstops(db, controller.signal)).rejects.toThrow("abort during write");
  });

  it("continues with degraded static rows when optional DEX preload fails", async () => {
    loadDexLiquiditySnapshotMock.mockRejectedValueOnce(new Error("dex unavailable"));

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    expect(result.status).toBe("degraded");
    expect(resolveRedemptionBackstopEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "cusd-cap" }),
      null,
      expect.any(Number),
      expect.anything(),
    );
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.preloadDegraded).toBe(true);
    expect(metadata.preloadWarnings).toEqual([expect.stringContaining("dex-liquidity:dex unavailable")]);
    expect(metadata.liquidityStale).toBe(true);
  });

  it("continues with fail-closed live metadata when optional reserve preload fails", async () => {
    loadReserveSnapshotMetadataMapMock.mockRejectedValueOnce(new Error("reserve preload unavailable"));

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    expect(result.status).toBe("degraded");
    expect(resolveRedemptionBackstopEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "cusd-cap" }),
      29,
      expect.any(Number),
      expect.objectContaining({ reserveSnapshotMetadata: null }),
    );
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.preloadDegraded).toBe(true);
    expect(metadata.preloadWarnings).toEqual([expect.stringContaining("reserve-metadata:reserve preload unavailable")]);
  });

  it("passes severe active depeg availability into builders without degrading the cron", async () => {
    const now = Math.floor(Date.now() / 1000);
    loadStablecoinsCacheMock.mockResolvedValue({
      kind: "ok",
      updatedAt: now - 60,
      payload: {
        peggedAssets: [
          makeAsset({
            id: "cusd-cap",
            symbol: "CUSD",
            circulating: { peggedUSD: 10_000_000 },
            price: 0.1668,
            priceSource: "pyth",
            priceConfidence: "single-source",
            priceObservedAt: now - 60,
            priceUpdatedAt: now - 60,
            priceObservedAtMode: "upstream",
            agreeSources: ["pyth"],
          }),
          makeAsset({ id: "iusd-infinifi", symbol: "IUSD", circulating: { peggedUSD: 20_000_000 } }),
        ],
      },
    });
    resolveRedemptionBackstopEntryMock
      .mockResolvedValueOnce(
        makeResolvedSnapshot("cusd-cap", now, {
          score: null,
          resolutionState: "impaired",
          routeStatus: "degraded",
          routeStatusSource: "market-implied",
          routeStatusReason:
            "Active severe depeg of 8332 bps started 2026-03-22; static redemption route requires current live-open evidence before it can score.",
          routeStatusReviewedAt: "2026-04-14",
          modelConfidence: "low",
        }),
      )
      .mockResolvedValueOnce(makeResolvedSnapshot("iusd-infinifi", now));

    const db = mockD1([
      {
        match: "FROM depeg_events",
        rows: [
          {
            stablecoin_id: "cusd-cap",
            direction: "below",
            started_at: 1_774_145_097,
          },
        ],
      },
    ]);
    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(db, new AbortController().signal);

    expect(result.status).toBe("ok");
    expect(resolveRedemptionBackstopEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "cusd-cap" }),
      29,
      expect.any(Number),
      expect.objectContaining({
        routeAvailability: expect.objectContaining({
          routeStatus: "degraded",
          routeStatusSource: "market-implied",
          activeDepegBps: 8332,
        }),
      }),
    );

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.availabilityDegraded).toBe(1);
    expect(metadata.availabilityDegradedIds).toEqual(["cusd-cap"]);
    expect(metadata.marketImpliedDegraded).toBe(1);
    expect(metadata.marketEvidenceUncertain).toBe(0);
    expect(metadata.unresolvedCritical).toBe(0);
    expect(metadata.severeActiveDepegThresholdBps).toBe(2500);
  });

  it("does not convert impairment-only runs into zero-resolved errors", async () => {
    const now = Math.floor(Date.now() / 1000);
    configuredIdsMock = ["cusd-cap"];
    loadStablecoinsCacheMock.mockResolvedValue({
      kind: "ok",
      updatedAt: now,
      payload: {
        peggedAssets: [makeAsset({ id: "cusd-cap", symbol: "CUSD", circulating: { peggedUSD: 10_000_000 } })],
      },
    });
    resolveRedemptionBackstopEntryMock.mockResolvedValueOnce(
      makeResolvedSnapshot("cusd-cap", now, {
        score: null,
        resolutionState: "impaired",
        routeStatus: "degraded",
        routeStatusSource: "market-implied",
        modelConfidence: "low",
      }),
    );

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    expect(result.status).toBe("ok");

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.resolved).toBe(0);
    expect(metadata.unresolved).toBe(1);
    expect(metadata.unresolvedCritical).toBe(0);
    expect(metadata.availabilityDegraded).toBe(1);
  });

  it("caps availability-degraded metadata ids at 25 and marks truncation", async () => {
    const now = Math.floor(Date.now() / 1000);
    configuredIdsMock = Array.from({ length: 26 }, (_value, index) => `coin-${index + 1}`);

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
      Promise.resolve(
        makeResolvedSnapshot(asset.id, now, {
          score: null,
          resolutionState: "impaired",
          routeStatus: "degraded",
          routeStatusSource: "market-implied",
          modelConfidence: "low",
        }),
      ),
    );

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.availabilityDegraded).toBe(26);
    expect(metadata.availabilityDegradedIds).toEqual(configuredIdsMock.slice(0, 25));
    expect(metadata.availabilityDegradedIdsTruncated).toBe(true);
  });

  it("snapshots configured ids that are absent from the active stablecoins cache without degrading", async () => {
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
      updatedAt: Math.floor(Date.now() / 1000),
      capsApplied: [],
    });

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(2);
    expect(resolveRedemptionBackstopEntryMock).toHaveBeenCalledTimes(1);
    expect(buildRedemptionBackstopEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      "iusd-infinifi",
      expect.objectContaining({ routeFamily: "basket-redeem" }),
      null,
      47,
      expect.any(Number),
      expect.objectContaining({ reserveSnapshotMetadata: null, routeAvailability: null }),
    );
    expect(upsertRedemptionBackstopSnapshotsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ stablecoinId: "cusd-cap" }),
        expect.objectContaining({ stablecoinId: "iusd-infinifi" }),
      ]),
      expect.objectContaining({
        expectedCount: 2,
        metadata: expect.objectContaining({ configured: 2 }),
      }),
    );

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.synced).toBe(2);
    expect(metadata.resolved).toBe(1);
    expect(metadata.unresolved).toBe(1);
    expect(metadata.unresolvedCritical).toBe(0);
    expect(metadata.activeConfigured).toBe(1);
    expect(metadata.cacheAbsentConfigured).toBe(1);
    expect(metadata.coverageRatio).toBe(1);
    expect(metadata.missingFromCache).toEqual(["iusd-infinifi"]);
  });

  it("errors when every configured route is absent from the active stablecoins cache", async () => {
    configuredIdsMock = ["iusd-infinifi"];
    loadStablecoinsCacheMock.mockResolvedValue({
      kind: "ok",
      updatedAt: Math.floor(Date.now() / 1000),
      payload: {
        peggedAssets: [makeAsset({ id: "cusd-cap", symbol: "CUSD", circulating: { peggedUSD: 10_000_000 } })],
      },
    });

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    expect(result.status).toBe("error");
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.activeConfigured).toBe(0);
    expect(metadata.cacheAbsentConfigured).toBe(1);
    expect(metadata.missingFromCache).toEqual(["iusd-infinifi"]);
  });

  it("caps missing-from-cache metadata ids at 25 and marks truncation", async () => {
    const now = Math.floor(Date.now() / 1000);
    configuredIdsMock = Array.from({ length: 27 }, (_value, index) => `coin-${index + 1}`);
    const cachedId = configuredIdsMock[0];
    const missingIds = configuredIdsMock.slice(1);

    loadStablecoinsCacheMock.mockResolvedValue({
      kind: "ok",
      updatedAt: now,
      payload: {
        peggedAssets: [makeAsset({ id: cachedId, symbol: "COIN1", circulating: { peggedUSD: 1_000_000 } })],
      },
    });
    loadDexLiquiditySnapshotMock.mockResolvedValue({
      map: {},
      latestUpdatedAt: now,
    });
    resolveRedemptionBackstopEntryMock.mockResolvedValueOnce(makeResolvedSnapshot(cachedId, now));
    buildRedemptionBackstopEntryMock.mockImplementation(
      (_db: unknown, stablecoinId: string, _config: unknown, _asset: null, dexLiquidityScore: number | null) =>
        Promise.resolve({
          ...makeResolvedSnapshot(stablecoinId, now, {
            score: null,
            dexLiquidityScore,
            sourceMode: "static",
            resolutionState: "missing-cache",
            capacityConfidence: "heuristic",
            capacitySemantics: "eventual-only",
            modelConfidence: "low",
            immediateCapacityUsd: null,
            immediateCapacityRatio: null,
          }),
        }),
    );

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.missingFromCache).toEqual(missingIds.slice(0, 25));
    expect(metadata.missingFromCacheTruncated).toBe(true);
  });

  it("keeps a tiny missing-capacity tail as ok when no failures or cache misses remain", async () => {
    const now = Math.floor(Date.now() / 1000);
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
    resolveRedemptionBackstopEntryMock
      .mockResolvedValueOnce(makeResolvedSnapshot("cusd-cap", now))
      .mockResolvedValueOnce({
        stablecoinId: "iusd-infinifi",
        score: null,
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
        provider: "reserve-sync-metadata",
        sourceMode: "static",
        resolutionState: "missing-capacity",
        capacityConfidence: "dynamic",
        capacitySemantics: "immediate-bounded",
        feeConfidence: "undisclosed-reviewed",
        feeModelKind: "undisclosed-reviewed",
        modelConfidence: "low",
        immediateCapacityUsd: null,
        immediateCapacityRatio: null,
        feeBps: null,
        queueEnabled: false,
        methodologyVersion: "1.0",
        updatedAt: now,
        capsApplied: [],
        notes: ["Live reserve metadata lacks scoring-grade freshness evidence"],
      });

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    expect(result.status).toBe("ok");

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.resolved).toBe(1);
    expect(metadata.unresolved).toBe(1);
    expect(metadata.unresolvedMissingCapacity).toBe(1);
    expect(metadata.familyMissingCapacityBy).toEqual({ "basket-redeem": 1 });
    expect(metadata.providerMissingCapacityBy).toEqual({ "reserve-sync-metadata": 1 });
    expect(metadata.unresolvedCritical).toBe(0);
    expect(metadata.missingCapacityOkThreshold).toBe(1);
  });

  it("reports error when every configured route is missing capacity", async () => {
    const now = Math.floor(Date.now() / 1000);
    configuredIdsMock = ["cusd-cap"];
    loadStablecoinsCacheMock.mockResolvedValue({
      kind: "ok",
      updatedAt: now,
      payload: {
        peggedAssets: [makeAsset({ id: "cusd-cap", symbol: "CUSD", circulating: { peggedUSD: 10_000_000 } })],
      },
    });
    resolveRedemptionBackstopEntryMock.mockResolvedValueOnce(
      makeResolvedSnapshot("cusd-cap", now, {
        score: null,
        capacityScore: null,
        provider: "reserve-sync-metadata",
        sourceMode: "static",
        resolutionState: "missing-capacity",
        capacityConfidence: "dynamic",
        capacitySemantics: "immediate-bounded",
        modelConfidence: "low",
        immediateCapacityUsd: null,
        immediateCapacityRatio: null,
        notes: ["Live reserve metadata lacks scoring-grade freshness evidence"],
      }),
    );

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    expect(result.status).toBe("error");

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.resolved).toBe(0);
    expect(metadata.unresolvedMissingCapacity).toBe(1);
    expect(metadata.unresolvedCritical).toBe(0);
  });

  it("still degrades when missing-capacity drift exceeds the tolerance budget", async () => {
    const now = Math.floor(Date.now() / 1000);
    configuredIdsMock = Array.from({ length: 101 }, (_value, index) => `coin-${index + 1}`);
    const unresolvedIds = new Set(["coin-1", "coin-2", "coin-3"]);

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
      Promise.resolve(
        unresolvedIds.has(asset.id)
          ? makeResolvedSnapshot(asset.id, now, {
              score: null,
              capacityScore: null,
              provider: "reserve-sync-metadata",
              sourceMode: "static",
              resolutionState: "missing-capacity",
              capacityConfidence: "dynamic",
              capacitySemantics: "immediate-bounded",
              modelConfidence: "low",
              immediateCapacityUsd: null,
              immediateCapacityRatio: null,
              notes: ["Live reserve metadata lacks scoring-grade freshness evidence"],
            })
          : makeResolvedSnapshot(asset.id, now),
      ),
    );

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    expect(result.status).toBe("degraded");

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.resolved).toBe(98);
    expect(metadata.unresolved).toBe(3);
    expect(metadata.unresolvedMissingCapacity).toBe(3);
    expect(metadata.familyMissingCapacityBy).toEqual({ "basket-redeem": 3 });
    expect(metadata.providerMissingCapacityBy).toEqual({ "reserve-sync-metadata": 3 });
    expect(metadata.unresolvedCritical).toBe(0);
    expect(metadata.missingCapacityOkThreshold).toBe(2);
  });

  it("forwards run retention telemetry from the snapshot write into cron metadata", async () => {
    upsertRedemptionBackstopSnapshotsMock.mockImplementationOnce((_db: unknown, snapshots: unknown[]) =>
      Promise.resolve({
        runId: "redemption:test-run",
        attemptedCount: snapshots.length,
        runRowsWrittenCount: snapshots.length,
        historyWrittenCount: snapshots.length,
        retentionCutoff: 1_700_000_000,
        retentionRunRowsDeletedCount: 4,
        retentionRunsDeletedCount: 2,
        warnings: [],
      }),
    );

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    expect(result.status).toBe("ok");
    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.retentionCutoff).toBe(1_700_000_000);
    expect(metadata.retentionRunRowsDeletedCount).toBe(4);
    expect(metadata.retentionRunsDeletedCount).toBe(2);
    expect(metadata.writeStatus).toBe("completed");
  });

  it("materializes failed rows instead of leaving the coin absent from the new snapshot", async () => {
    resolveRedemptionBackstopEntryMock
      .mockResolvedValueOnce(makeResolvedSnapshot("cusd-cap", 1_700_000_000))
      .mockRejectedValueOnce(new Error("resolver blew up"));

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    expect(result.status).toBe("degraded");
    expect(buildFailedRedemptionBackstopEntryMock).toHaveBeenCalledWith(
      "iusd-infinifi",
      expect.objectContaining({ routeFamily: "basket-redeem" }),
      expect.any(Number),
    );
    expect(upsertRedemptionBackstopSnapshotsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({ stablecoinId: "cusd-cap", resolutionState: "resolved" }),
        expect.objectContaining({ stablecoinId: "iusd-infinifi", resolutionState: "failed" }),
      ]),
      expect.objectContaining({
        expectedCount: 2,
        metadata: expect.objectContaining({ configured: 2 }),
      }),
    );

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.failed).toBe(1);
    expect(metadata.failedIds).toEqual(["iusd-infinifi"]);
  });

  it("caps failed metadata ids at 25 and marks truncation", async () => {
    const now = Math.floor(Date.now() / 1000);
    configuredIdsMock = Array.from({ length: 26 }, (_value, index) => `coin-${index + 1}`);

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
    resolveRedemptionBackstopEntryMock.mockRejectedValue(new Error("resolver blew up"));

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.failed).toBe(26);
    expect(metadata.failedIds).toEqual(configuredIdsMock.slice(0, 25));
    expect(metadata.failedIdsTruncated).toBe(true);
  });

  it("marks the run degraded but keeps computing effective-exit scores from stale-but-present DEX data", async () => {
    // Staleness is now an operational signal (degraded-run + metadata) but no
    // longer suppresses effectiveExitScore. Matches the report-cards path,
    // which also uses the last-known DEX score when stale.
    const staleNow = Math.floor(Date.now() / 1000);
    loadDexLiquiditySnapshotMock.mockResolvedValue({
      map: {
        "cusd-cap": { liquidityScore: 29 },
        "iusd-infinifi": { liquidityScore: 47 },
      },
      latestUpdatedAt: staleNow - 14_401,
    });

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    expect(result.status).toBe("degraded");
    expect(resolveRedemptionBackstopEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "cusd-cap" }),
      29,
      expect.any(Number),
      expect.not.objectContaining({ suppressEffectiveExitScore: expect.anything() }),
    );

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.liquidityStale).toBe(true);
  });

  it("marks missing DEX liquidity snapshots as stale", async () => {
    loadDexLiquiditySnapshotMock.mockResolvedValue({
      map: {},
      latestUpdatedAt: null,
    });

    const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
    const result = await syncRedemptionBackstops(mockD1(), new AbortController().signal);

    expect(result.status).toBe("degraded");
    expect(resolveRedemptionBackstopEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "cusd-cap" }),
      null,
      expect.any(Number),
      expect.anything(),
    );

    const metadata = JSON.parse(result.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata.liquidityStale).toBe(true);
  });
});
