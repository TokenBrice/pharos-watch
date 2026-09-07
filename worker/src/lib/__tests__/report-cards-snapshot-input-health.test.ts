import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";

const mocks = vi.hoisted(() => ({
  getCache: vi.fn(),
  loadDexLiquiditySnapshot: vi.fn(),
  loadRedemptionBackstopSnapshot: vi.fn(),
  loadFreshIndependentLiveReserveMap: vi.fn(),
}));

vi.mock("../db-cache", () => ({
  getCache: mocks.getCache,
}));

vi.mock("../dex-liquidity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../dex-liquidity")>()),
  loadDexLiquiditySnapshot: mocks.loadDexLiquiditySnapshot,
}));

vi.mock("../redemption-backstops-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../redemption-backstops-store")>()),
  loadRedemptionBackstopSnapshot:
    mocks.loadRedemptionBackstopSnapshot,
}));

vi.mock("../live-reserves/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../live-reserves/store")>()),
  loadFreshIndependentLiveReserveMap:
    mocks.loadFreshIndependentLiveReserveMap,
}));

const {
  loadReportCardsSnapshotInputs,
} = await import("../report-cards-snapshot-inputs");
const {
  RedemptionBackstopSnapshotUnavailableError,
} = await import("../redemption-backstops-store");

const NOW_SEC = 1_700_000_000;

function db() {
  return mockD1([
    {
      match: "FROM dex_liquidity",
      rows: [],
    },
  ]);
}

function stablecoinsCache() {
  return {
    kind: "ok" as const,
    payload: { peggedAssets: [] },
    updatedAt: NOW_SEC,
  };
}

function liveReserves() {
  return Object.assign(new Map(), {
    provenanceById: new Map(),
  });
}

describe("report-card V9 publication input health", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1_000);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getCache.mockReset().mockResolvedValue(null);
    mocks.loadDexLiquiditySnapshot.mockReset().mockResolvedValue({
      map: {},
      latestUpdatedAt: NOW_SEC - 60,
    });
    mocks.loadRedemptionBackstopSnapshot.mockReset().mockResolvedValue({
      map: {},
      latestUpdatedAt: NOW_SEC - 60,
      runId: "redemption:current",
      methodologyVersion: "redemption:test",
    });
    mocks.loadFreshIndependentLiveReserveMap
      .mockReset()
      .mockResolvedValue(liveReserves());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("records a fulfilled but stale DEX scoring snapshot as stale", async () => {
    mocks.loadDexLiquiditySnapshot.mockResolvedValue({
      map: {},
      latestUpdatedAt: 1,
    });

    const inputs = await loadReportCardsSnapshotInputs(db(), {
      preloadedStablecoinsCache: stablecoinsCache(),
    });

    expect(inputs.v9PublicationInputHealth.dex).toEqual({
      state: "stale",
      generationId: "dex-liquidity-1",
      updatedAtSec: 1,
    });
  });

  it("records a rejected DEX scoring load as unavailable", async () => {
    mocks.loadDexLiquiditySnapshot.mockRejectedValue(
      new Error("DEX worker unavailable"),
    );

    const inputs = await loadReportCardsSnapshotInputs(db(), {
      preloadedStablecoinsCache: stablecoinsCache(),
    });

    expect(inputs.v9PublicationInputHealth.dex).toEqual({
      state: "unavailable",
      generationId: null,
      updatedAtSec: null,
    });
  });

  it("preserves applicable redemption and live-reserve loader failures", async () => {
    mocks.loadRedemptionBackstopSnapshot.mockRejectedValue(
      new RedemptionBackstopSnapshotUnavailableError(
        "redemption snapshot unavailable",
      ),
    );
    mocks.loadFreshIndependentLiveReserveMap.mockRejectedValue(
      new Error("live reserves unavailable"),
    );

    const inputs = await loadReportCardsSnapshotInputs(db(), {
      preloadedStablecoinsCache: stablecoinsCache(),
    });

    expect(inputs.v9PublicationInputHealth.redemption).toEqual({
      state: "unavailable",
      generationId: null,
      updatedAtSec: null,
    });
    expect(inputs.v9PublicationInputHealth.liveReserves).toEqual({
      state: "unavailable",
    });
  });

  it("marks a completed empty redemption snapshot as not applicable", async () => {
    const inputs = await loadReportCardsSnapshotInputs(db(), {
      preloadedStablecoinsCache: stablecoinsCache(),
    });

    expect(inputs.v9PublicationInputHealth.redemption).toEqual({
      state: "not-applicable",
      generationId: "redemption:current",
      updatedAtSec: NOW_SEC - 60,
    });
  });
});
