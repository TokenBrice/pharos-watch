import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { FROZEN_SNAPSHOTS_BY_ID } from "@shared/lib/stablecoins/frozen-snapshots";
import { getConfiguredRedemptionBackstopIds } from "@shared/lib/redemption-backstops";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";

const DUSD_FLUID = "dusd-fluid";

function makeResolvedSnapshot(stablecoinId: string, now: number): RedemptionBackstopEntry {
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
    routeStatus: "unknown",
    routeStatusSource: "static-config",
    holderEligibility: "unknown",
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
  };
}

const loadStablecoinsCacheMock = vi.fn();
const loadDexLiquidityScoresMock = vi.fn();
const loadAcceptedReserveGenerationMock = vi.fn();
const upsertRedemptionBackstopSnapshotsMock = vi.fn();

vi.mock("../../lib/stablecoins-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/stablecoins-cache")>()),
  loadStablecoinsCache: loadStablecoinsCacheMock,
}));

vi.mock("../../lib/dex-liquidity", () => ({
  loadDexLiquidityScores: loadDexLiquidityScoresMock,
}));

vi.mock("../../lib/accepted-reserve-generation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/accepted-reserve-generation")>()),
  loadAcceptedReserveGeneration: loadAcceptedReserveGenerationMock,
}));

vi.mock("../../lib/redemption-backstops-store-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/redemption-backstops-store-write")>()),
  upsertRedemptionBackstopSnapshots: upsertRedemptionBackstopSnapshotsMock,
}));

vi.mock("../../lib/redemption-backstop/sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/redemption-backstop/sources")>();
  return {
    ...actual,
    // Keep the frozen asset's row fully real. Other configured ids only need a
    // schema-valid placeholder so the run reaches publication.
    buildRedemptionBackstopEntry: async (
      db: Parameters<typeof actual.buildRedemptionBackstopEntry>[0],
      stablecoinId: string,
      config: Parameters<typeof actual.buildRedemptionBackstopEntry>[2],
      supplyUsd: number | null,
      dexLiquidityScore: number | null,
      now: number,
      options: Parameters<typeof actual.buildRedemptionBackstopEntry>[6],
    ) => stablecoinId === DUSD_FLUID
      ? actual.buildRedemptionBackstopEntry(db, stablecoinId, config, supplyUsd, dexLiquidityScore, now, options)
      : makeResolvedSnapshot(stablecoinId, now ?? Math.floor(Date.now() / 1000)),
  };
});

describe("frozen dissolved DUSD Fluid redemption coverage", () => {
  it("does not publish an open, resolved full-supply redemption route for dusd-fluid", async () => {
    // Frozen coins are excluded from write-side crons and live aggregates, so the
    // config stays archive history and must not enter the live publication cohort.
    expect(getConfiguredRedemptionBackstopIds()).not.toContain(DUSD_FLUID);

    const now = Math.floor(Date.parse("2026-10-30T00:00:00Z") / 1000);
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    try {
      const frozen = FROZEN_SNAPSHOTS_BY_ID.get(DUSD_FLUID);
      expect(frozen).toBeDefined();
      loadStablecoinsCacheMock.mockResolvedValue({
        kind: "ok",
        updatedAt: now,
        // The published stablecoins cache injects the frozen snapshot row and
        // tags it `frozen`, so this is the supply a normal sync sees.
        payload: { peggedAssets: [{ ...frozen!.peggedAssetRow, frozen: true, frozenAt: "2024-04-22" }] },
      });
      loadDexLiquidityScoresMock.mockResolvedValue({ map: {}, latestUpdatedAt: now });
      loadAcceptedReserveGenerationMock.mockResolvedValue({
        schemaVersion: 2,
        generationId: "reserve:1700000000:test",
        root: { scheduleKey: "fourHourlyReserveSync", slotStartedAt: 1_700_000_000, queueHash: "test" },
        sealedBy: { attemptNo: 1, executionGeneration: 1, invocationId: "test" },
        producerCompletedAtSec: now,
        contentSha256: "a".repeat(64),
        members: [],
      });
      upsertRedemptionBackstopSnapshotsMock.mockImplementation((_db: unknown, snapshots: RedemptionBackstopEntry[]) =>
        Promise.resolve({
          runId: "redemption:test-run",
          attemptedCount: snapshots.length,
          runRowsWrittenCount: snapshots.length,
          historyWrittenCount: snapshots.length,
          warnings: [],
        }),
      );

      const { syncRedemptionBackstops } = await import("../sync-redemption-backstops");
      // Only the depeg-availability read reaches D1; the writer is captured above.
      const db = mockD1([{ match: "FROM depeg_events", rows: [] }]);
      await syncRedemptionBackstops(db, new AbortController().signal);

      expect(upsertRedemptionBackstopSnapshotsMock).toHaveBeenCalled();
      const published = upsertRedemptionBackstopSnapshotsMock.mock.calls[0][1] as RedemptionBackstopEntry[];
      const dusdRows = published.filter((row) => row.stablecoinId === DUSD_FLUID);

      // The coin obituary records Fluid Finance SA's 2024-04-22 bankruptcy and
      // the frozen notice says no current redemption route was verified. A
      // frozen asset is excluded from live publication, so either it is absent
      // or it must not claim open route status, resolved capacity or a positive
      // full-supply score.
      const liveClaims = dusdRows.filter((row) =>
        row.routeStatus === "open" ||
        row.resolutionState === "resolved" ||
        (row.capacityProfile?.eventualUsd ?? 0) > 0 ||
        (row.eventualRedeemabilityScore ?? 0) > 0,
      );
      expect(liveClaims).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  }, 30_000);
});
