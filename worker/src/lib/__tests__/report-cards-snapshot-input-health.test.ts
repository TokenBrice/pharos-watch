import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { resolveDexDeploymentCensusMaxAgeSec } from "../../cron/dex-liquidity/deployment-census-coverage";

const scrvusdMeta = ACTIVE_META_BY_ID.get("scrvusd-curve")!;
// The rotating-sweep window grows with the reviewed deployment footprint, so the
// stale case sits one second past the window the production loader derives.
const scrvusdCensusMaxAgeSec = resolveDexDeploymentCensusMaxAgeSec([
  ...(scrvusdMeta.contracts ?? []),
  ...(scrvusdMeta.tradedContracts ?? []),
]);

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
      reserveInputAssessment: { state: "fresh", quarantined: {} },
    });
    mocks.loadFreshIndependentLiveReserveMap
      .mockReset()
      .mockResolvedValue(liveReserves());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { id: "scrvusd-curve", ageSec: 20 * 60 * 60, observedSupplyRatio: 1, unknownChains: [] },
    // r2/data/results/scrvusd-curve.json adds six satellites: the rotating census sweep stays fresh past 48h.
    { id: "scrvusd-curve", ageSec: 48 * 60 * 60 + 1, observedSupplyRatio: 1, unknownChains: [] },
    { id: "scrvusd-curve", ageSec: scrvusdCensusMaxAgeSec + 1, observedSupplyRatio: 0, unknownChains: ["ethereum"] },
    { id: "usdc-circle", ageSec: 72 * 60 * 60, observedSupplyRatio: 1, unknownChains: [] },
  ])("ages deployment census independently of quotes ($id, $ageSec seconds)", async ({
    id, ageSec, observedSupplyRatio, unknownChains,
  }) => {
    const meta = ACTIVE_META_BY_ID.get(id)!;
    const deployments = [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])];
    const ethereumDeployment = deployments.find((deployment) => deployment.chain === "ethereum")!;
    const asset = makeStablecoin({
      id,
      circulating: { peggedUSD: 100 },
      contracts: deployments,
      chainCirculating: Object.fromEntries(deployments.map((deployment) => {
        // Explicit observed zero closes each satellite without inventing a
        // positive supply allocation; the Ethereum liability reconciles to 100.
        const current = deployment.chain === "ethereum" ? 100 : 0;
        return [deployment.chain, {
          current, circulatingPrevDay: current, circulatingPrevWeek: current, circulatingPrevMonth: current,
        }];
      })),
    });
    mocks.loadDexLiquiditySnapshot.mockResolvedValue({
      map: { [asset.id]: {} },
      latestUpdatedAt: NOW_SEC - 4 * 60 * 60 - 1,
    });
    const inputs = await loadReportCardsSnapshotInputs(mockD1([{
      match: "FROM dex_liquidity",
      rows: [{
        stablecoin_id: asset.id,
        chain: "ethereum",
        contract_address: ethereumDeployment.address,
        outcome: "observed_pools",
        outcome_observed_at: NOW_SEC - ageSec,
        chain_tvl_json: JSON.stringify({ ethereum: 1_000 }),
      }],
    }]), {
      preloadedStablecoinsCache: {
        ...stablecoinsCache(),
        payload: { peggedAssets: [asset] },
      },
    });

    expect(inputs.dexLiquiditySnapshot.map[asset.id]).toMatchObject({
      deploymentSupplyCoverage: { observedSupplyRatio, unknownChains },
    });
    expect(inputs.liquidityStale).toBe(true);
    expect(inputs.v9PublicationInputHealth.dex.state).toBe("stale");
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
      coverageRatio: null,
    });
  });

  it("records zero coverage for a fulfilled empty independent reserve map", async () => {
    const inputs = await loadReportCardsSnapshotInputs(db(), {
      preloadedStablecoinsCache: stablecoinsCache(),
    });

    expect(inputs.v9PublicationInputHealth.liveReserves).toEqual({
      state: "available",
      coverageRatio: 0,
    });
  });

  it("holds a run whose consumed reserve binding is incompatible without changing the run clock", async () => {
    mocks.loadRedemptionBackstopSnapshot.mockResolvedValue({
      map: { test: { stablecoinId: "test" } }, latestUpdatedAt: NOW_SEC - 60,
      runId: "redemption:actual", methodologyVersion: "redemption:test", reserveInputAssessment: { state: "unavailable", quarantined: {} },
    });
    const inputs = await loadReportCardsSnapshotInputs(db(), { preloadedStablecoinsCache: stablecoinsCache() });
    expect(inputs.redemptionBackstopMap).toEqual({});
    expect(inputs.v9PublicationInputHealth.redemption).toEqual({ state: "unavailable", generationId: "redemption:actual", updatedAtSec: NOW_SEC - 60 });
    expect(inputs.inputFreshness.redemptionBackstops.ageSeconds).toBe(60);
  });

  it("keeps a run current when only individual assets carry inadmissible reserve evidence", async () => {
    const map = { test: { stablecoinId: "test" }, other: { stablecoinId: "other" } };
    mocks.loadRedemptionBackstopSnapshot.mockResolvedValue({
      map, latestUpdatedAt: NOW_SEC - 60, runId: "redemption:actual", methodologyVersion: "redemption:test",
      reserveInputAssessment: { state: "fresh", quarantined: { test: "freshness-unverified" } },
    });
    const inputs = await loadReportCardsSnapshotInputs(db(), { preloadedStablecoinsCache: stablecoinsCache() });
    expect(inputs.redemptionBackstopMap).toEqual(map);
    expect(inputs.v9PublicationInputHealth.redemption.state).toBe("current");
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
