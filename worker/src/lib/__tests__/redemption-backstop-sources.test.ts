import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1Strict } from "@shared/test-utils/mock-d1";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import * as redemptionBackstops from "@shared/lib/redemption-backstops";
import * as redemptionCapacity from "../redemption-backstop/capacity";
import { STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS } from "@shared/data/coverage-dispositions/redemption-coverage-dispositions";
import type { StablecoinData } from "@shared/types/market";
import type {
  applyOutputDependencyResolution as ApplyOutputDependencyResolution,
  buildRedemptionBackstopEntry as BuildRedemptionBackstopEntry,
  buildFailedRedemptionBackstopEntry as BuildFailedRedemptionBackstopEntry,
  resolveRedemptionBackstopEntry as ResolveRedemptionBackstopEntry,
} from "../redemption-backstop/sources";
import type { ExecutableRedemptionObservation } from "../../cron/reserve-adapters/executable-redemption-observers";
import {
  buildEntryFixture,
  dusdOpenQueueMetadata,
  fpiControllerState,
  route,
  severeMarketEvidence,
  liveSnapshot,
} from "./redemption-backstop-sources.test-support";
import { readRedemptionBackstopLiveMetadata } from "../redemption-backstop/live-metadata";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { buildChainRpcs } from "../chain-registry";
import { assessReserveFetchFreshness } from "../live-reserves/store-snapshot-state";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import type * as ExecutableObservers from "../../cron/reserve-adapters/executable-redemption-observers";

const { getReserveSyncStateMock, getLatestSuccessfulReserveSnapshotMetadataMock, observeExecutableRedemptionRouteMock } = vi.hoisted(() => ({
  getReserveSyncStateMock: vi.fn(),
  getLatestSuccessfulReserveSnapshotMetadataMock: vi.fn(),
  observeExecutableRedemptionRouteMock: vi.fn(),
}));

vi.mock("../../cron/reserve-adapters/executable-redemption-observers", async (importOriginal) => ({
  ...await importOriginal<typeof ExecutableObservers>(),
  observeExecutableRedemptionRoute: observeExecutableRedemptionRouteMock,
}));
vi.mock("../live-reserves/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../live-reserves/store")>();
  return {
    ...actual,
    getReserveSyncState: getReserveSyncStateMock,
    getLatestSuccessfulReserveSnapshotMetadata: getLatestSuccessfulReserveSnapshotMetadataMock,
    LIVE_RESERVE_FRESHNESS_SEC: 3600,
  };
});

describe("buildRedemptionBackstopEntry", () => {
  let buildRedemptionBackstopEntry: typeof BuildRedemptionBackstopEntry;
  let buildFailedRedemptionBackstopEntry: typeof BuildFailedRedemptionBackstopEntry;
  let resolveRedemptionBackstopEntry: typeof ResolveRedemptionBackstopEntry;
  let applyOutputDependencyResolution: typeof ApplyOutputDependencyResolution;
  const now = 1_700_000_000;
  const fixedFeeCases = [
    { feeBps: 0, expectedScore: 100 }, { feeBps: 25, expectedScore: 80 },
    { feeBps: 75, expectedScore: 60 }, { feeBps: 200, expectedScore: 40 },
  ] as const;

  type RedemptionConfig = Parameters<typeof buildRedemptionBackstopEntry>[2];
  type BuildOptions = Parameters<typeof buildRedemptionBackstopEntry>[6];
  const liveDirectCoinCases = [
    { description: "LUSD Liquity v1 system debt", stablecoinId: "lusd-liquity",
      supplyUsd: 100_000_000, dexScore: null,
      metadata: { freshnessMode: "not-applicable", redemption: {
        capacityUsd: 84_000_000, capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain", feeBps: 50,
      } },
      overrides: { fetchedAt: now - 120, source: "liquity-v1", sourceModel: "single-bucket" },
      expected: { sourceMode: "dynamic", capacitySemantics: "immediate-bounded",
        immediateCapacityUsd: 84_000_000, immediateCapacityRatio: 0.84,
        capacityBasis: "live-direct-telemetry", feeBps: 50 } },
    { description: "fxSAVE ERC-4626 idle fxSP", stablecoinId: "fxsave-f-x-protocol",
      supplyUsd: 10_000_000, dexScore: 20,
      metadata: { freshnessMode: "not-applicable",
        assetAddress: "0x65c9a641afceb9c0e6034e558a319488fa0fa3be", redemption: {
          capacityUsd: 2_000_000, capacityRatioOfSupply: 0.2, capacityKind: "live-direct",
          freshnessKind: "same-run-onchain", routeStatus: "unknown", routeStatusSource: "onchain",
        } },
      overrides: { fetchedAt: now - 120, source: "erc4626-single-asset", sourceModel: "single-bucket" },
      expected: { sourceMode: "dynamic", capacityBasis: "live-direct-telemetry",
        capacitySemantics: "immediate-bounded", immediateCapacityUsd: 2_000_000,
        immediateCapacityRatio: 0.2 } },
    { description: "BOLD Liquity v2 branch debt", stablecoinId: "bold-liquity",
      supplyUsd: 40_000_000, dexScore: null,
      metadata: { freshnessMode: "not-applicable", redemption: {
        capacityUsd: 32_000_000, capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain", routeStatus: "open",
        routeStatusSource: "onchain", feeBps: 52,
      } },
      overrides: { fetchedAt: now - 120, source: "liquity-v2-branches" },
      expected: { sourceMode: "dynamic", capacitySemantics: "immediate-bounded",
        immediateCapacityUsd: 32_000_000, immediateCapacityRatio: 0.8,
        capacityBasis: "live-direct-telemetry", feeBps: 52 } },
    { description: "ZCHF CHFAU StablecoinBridge route", stablecoinId: "zchf-frankencoin",
      supplyUsd: 27_682_881.200551473, dexScore: 35,
      metadata: { redemption: { capacityUsd: 362_655.25 }, freshnessMode: "unverified" },
      overrides: { fetchedAt: now - 300, source: "collateral-positions-api" },
      expected: { routeFamily: "stablecoin-redeem", immediateCapacityUsd: 235_304.49020468752,
        feeBps: 0, feeConfidence: "fixed", provider: "reserve-sync-fallback", capacityConfidence: "heuristic", modelConfidence: "low" } },
  ] as const;

  // These fixtures cover terms/reserve telemetry; exact-execution reviews are explicit opt-ins.
  const buildEntry = (
    stablecoinId: string,
    config: RedemptionConfig,
    supplyUsd: number | null,
    dexScore: number | null,
    options?: BuildOptions,
  ) => buildEntryFixture(buildRedemptionBackstopEntry, {
    db: mockD1Strict([]),
    stablecoinId,
    route: config,
    supplyUsd,
    dexScore,
    nowSec: now,
    options: { exitExecutionReviews: [], ...options },
  });
  it("shares captured FX between local-fee scenarios and issuer output admission", async () => {
    const config = route({ routeFamily: "offchain-issuer", reviewedAt: "2023-11-01",
      capacityModel: { kind: "supply-full", confidence: "documented-bound", basis: "issuer-term-redemption" },
      costModel: { kind: "fee-bps", feeBps: 0, feeComponents: [{ currency: "CHF", terms: { flatAmount: 30 } }] } });
    const stablecoinsCache = { kind: "ok" as const, updatedAt: now - 60, payload: {
      peggedAssets: [makeAsset({ id: "vchf-vnx", symbol: "VCHF", pegType: "peggedCHF",
        price: 1.25, priceSource: "coingecko", priceObservedAt: now - 60 })],
      fxFallbackRates: { peggedCHF: 1.25 },
    } };
    const admitted = await buildEntry("vchf-vnx", config, 1_000_000, null, { stablecoinsCache });
    expect(admitted.feeBps).toBeNull();
    expect(admitted.costScenarioScores).toEqual({ retail: 40, activeUser: 80, institutional: 100 });
    expect(admitted.capacityProfile?.exitRouteObservations?.[0]).toMatchObject({
      output: { kind: "fiat", currency: "CHF" }, scoreEligible: true,
    });
    const observation = admitted.capacityProfile!.exitRouteObservations![0]!;
    expect(observation.feeEvidence).toBeUndefined();
    expect(observation.capacityCurve?.some((point) => point.executionCostBps !== undefined)).toBe(true);
    const missing = await buildEntry("vchf-vnx", config, 1_000_000, null);
    expect(missing.costScenarioScores).toBeUndefined();
    expect(missing.capacityProfile?.exitRouteObservations?.[0]).toMatchObject({
      feeEvidence: "disclosed-unquantified", scoreEligible: false,
    });
    const stale = await buildEntry("vchf-vnx", config, 1_000_000, null, {
      stablecoinsCache: { ...stablecoinsCache, updatedAt: now - STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC - 1 },
    });
    expect(stale.costScenarioScores).toBeUndefined();
  });

  it("binds only selected live capacity or fee evidence, not unused static telemetry", async () => {
    const stablecoinId = "lusd-liquity";
    const reserveInput = { generationId: "reserve:1700000000:test", contentSha256: "a".repeat(64), stablecoinId, attemptId: "success",
      configFingerprint: computeLiveReserveConfigFingerprint(TRACKED_META_BY_ID.get(stablecoinId)!.liveReservesConfig!),
      freshness: assessReserveFetchFreshness({ fetchedAt: now - 120, attemptId: "success", metadata: { freshnessMode: "not-applicable" } }, now, 172800) };
    const snapshot = liveSnapshot(stablecoinId, { freshnessMode: "not-applicable", redemption: {
      capacityUsd: 100_000, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain", feeBps: 50,
    } }, { source: "liquity-v1", sourceModel: "single-bucket" });
    const selected = await buildEntry(stablecoinId, route({ capacityModel: { kind: "reserve-sync-metadata" } }), 1_000_000, null,
      { reserveSnapshotMetadata: snapshot, reserveInput });
    expect(selected.reserveInput).toEqual(reserveInput);
    const unused = await buildEntry(stablecoinId, route({ costModel: { kind: "dynamic-or-unclear", confidence: "undisclosed-reviewed" } }), 1_000_000, null,
      { reserveSnapshotMetadata: snapshot, reserveInput });
    expect(unused.reserveInput).toBeUndefined();
    const feeOnly = await buildEntry(stablecoinId, route(), 1_000_000, null, { reserveSnapshotMetadata: snapshot, reserveInput });
    expect(feeOnly.reserveInput).toEqual(reserveInput);
    const unknownStatus = await buildEntry(stablecoinId, route({ capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 1 },
      costModel: { kind: "dynamic-or-unclear", confidence: "undisclosed-reviewed" } }), 1_000_000, null, {
      reserveInput, reserveSnapshotMetadata: liveSnapshot(stablecoinId, { freshnessMode: "not-applicable", redemption: { routeStatus: "unknown" } }),
    });
    expect(unknownStatus.reserveInput).toEqual(reserveInput);
  });


  beforeAll(async () => {
    const mod = await import("../redemption-backstop/sources");
    buildRedemptionBackstopEntry = mod.buildRedemptionBackstopEntry;
    buildFailedRedemptionBackstopEntry = mod.buildFailedRedemptionBackstopEntry;
    resolveRedemptionBackstopEntry = mod.resolveRedemptionBackstopEntry;
    applyOutputDependencyResolution = mod.applyOutputDependencyResolution;
  });

  beforeEach(() => {
    getReserveSyncStateMock.mockReset();
    getLatestSuccessfulReserveSnapshotMetadataMock.mockReset();
    getReserveSyncStateMock.mockResolvedValue(null);
    getLatestSuccessfulReserveSnapshotMetadataMock.mockResolvedValue(null);
    observeExecutableRedemptionRouteMock.mockReset();
  });

  it("publishes unrestricted-holder access for native sUSDf unwrap without inheriting parent issuer KYC", async () => {
    const config = getRedemptionBackstopConfig("susdf-falcon")!;
    const entry = await buildEntry("susdf-falcon", config, 10_000_000, null, {
      reserveSnapshotMetadata: liveSnapshot("susdf-falcon", {
        freshnessMode: "not-applicable",
        redemption: {
          capacityUsd: 5_000_000,
          capacityKind: "live-direct",
          freshnessKind: "same-run-onchain",
        },
      }, { source: "erc4626-single-asset" }),
    });

    expect(entry.accessModel).toBe("permissionless-onchain");
    expect(entry.holderEligibility).toBe("any-holder");
    expect(entry.outputAssetType).toBe("stable-single");
  });

  it.each([
    "usdso-somnia",
    "usdfc-secured-finance",
    "sparkusdtbc-spark",
    "sparkusdc-spark",
    "usdr-rise",
    "susdx-axis",
    "xgld-unitas",
  ])("publishes missing capacity rather than a measured zero for unmeasured %s liquidity", async (id) => {
    const config = getRedemptionBackstopConfig(id);
    expect(config).not.toBeNull();

    const entry = await buildEntry(id, config!, 100_000_000, null);

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.immediateCapacityUsd).toBeNull();
    expect(entry.immediateCapacityRatio).toBeNull();
    expect(entry.capacityProfile?.scoringUsd ?? null).toBeNull();
    expect(entry.capacityScore).toBeNull();
    expect(entry.score).toBeNull();
    expect(entry.eventualRedeemabilityScore).toBeNull();
  });

  it.each([null, 0, 100_000_000])(
    "publishes earnUSD fee/status diagnostics without inventing capacity from supply %s", async (supplyUsd) => {
      observeExecutableRedemptionRouteMock.mockResolvedValue({
        capacityRaw: 129641670774n,
        capacitySource: "lido-earnusd-unquantified-queue",
        capacityState: "unquantified",
        outputAssetKeys: ["usdc-circle"],
        settlementBoundUnproven: true,
        underlyingDecimals: 6,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatusSource: "onchain",
        routeStatus: "open",
        routeStatusReason: "Exact async requests open, no guaranteed completion maximum",
        feeBps: 27,
        holderEligibility: "any-holder",
        blockNumber: 26122344,
        sourceTimestamp: now,
        sourceUrls: ["https://docs.lido.fi/earn/deployment-contracts"],
        diagnostics: { syncLiquidAssetsRaw: "129641670774", capacityQuantified: false },
      } satisfies ExecutableRedemptionObservation);
      const config = getRedemptionBackstopConfig("earnusd-lido")!;
      const rpcOptions = { chainRpcs: buildChainRpcs(), beforeRequest: vi.fn(() => true) };
      const signal = new AbortController().signal;
      const reserveInput = { generationId: "reserve:1700000000:test", contentSha256: "a".repeat(64), stablecoinId: "earnusd-lido", attemptId: null, configFingerprint: "b".repeat(64),
        freshness: assessReserveFetchFreshness({ fetchedAt: now - 120, attemptId: null, metadata: { freshnessMode: "not-applicable" } }, now, 172800) };
      const entry = await buildEntry("earnusd-lido", config, supplyUsd, null, { rpcOptions, signal, reserveInput });
      expect(entry.reserveInput).toBeUndefined();
      expect(entry).toMatchObject({
        feeBps: 27, feeConfidence: "formula", routeStatus: "open", routeStatusSource: "onchain",
        provider: "executable-observer", sourceMode: "dynamic", capacityConfidence: "heuristic",
        capacitySemantics: "eventual-only", resolutionState: "missing-capacity",
        immediateCapacityUsd: null, immediateCapacityRatio: null,
        capacityScore: null, score: null, eventualRedeemabilityScore: null,
        sourceTimestamp: now,
      });
      expect(entry.capacityProfile).toMatchObject({
        immediateUsd: null, scoringUsd: null, eventualUsd: null, scoringHorizon: "unknown",
      });
      expect(entry.capacityProfile?.settlementBoundUnproven).toBe(true);
      if (supplyUsd != null && supplyUsd > 0) {
        expect(entry.capacityProfile?.exitRouteObservations).toHaveLength(1);
        expect(entry.capacityProfile?.exitRouteObservations?.[0]).toMatchObject({
          routeId: "redemption:earnusd-lido:queue-redeem",
          scoreEligible: false,
          settlementBoundUnproven: true,
          output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] },
        });
      }
      expect(entry.settlementDelaySec).toBeUndefined();
      expect(entry.notes).toContain("redemption-capacity-unquantified");
      expect(getLatestSuccessfulReserveSnapshotMetadataMock).not.toHaveBeenCalled();
    },
  );

  it("fails earnUSD closed when its exact queue observation is unavailable", async () => {
    observeExecutableRedemptionRouteMock.mockResolvedValue(null);
    await expect(buildEntry(
      "earnusd-lido", getRedemptionBackstopConfig("earnusd-lido")!, 100_000_000, null,
    )).rejects.toThrow("earnusd-lido executable observer unavailable");
  });

  it("does not retain the historical open/zero-fee snapshot after a read rejection", async () => {
    observeExecutableRedemptionRouteMock.mockRejectedValue(new Error("queue identity drift"));
    await expect(buildEntry(
      "earnusd-lido", getRedemptionBackstopConfig("earnusd-lido")!, 100_000_000, null,
    )).rejects.toThrow("queue identity drift");
  });

  it.each([
    { keys: undefined, accepted: false },
    { keys: null, accepted: false },
    { keys: "wm-m0", accepted: false },
    { keys: [], accepted: false },
    { keys: ["m-m0"], accepted: false },
    { keys: ["wm-m0", "m-m0"], accepted: false },
    { keys: ["wm-m0", "wm-m0"], accepted: false },
    { keys: ["wm-m0"], accepted: true },
  ])("admits only exact USDR holder-output capacity, fee and favorable terms ($keys)", async ({ keys, accepted }) => {
    const snapshot = liveSnapshot("usdr-rise", { freshnessMode: "not-applicable", redemption: {
      capacityUsd: 2_000_000, capacityRatioOfSupply: 0.2, capacityKind: "live-direct",
      freshnessKind: "same-run-onchain", blockNumber: 26_143_056, sourceTimestamp: now,
      feeBps: 0, outputAssetKeys: keys, routeStatus: "open", routeStatusSource: "onchain",
      holderEligibility: "any-holder", settlementDelaySec: 60,
    } });
    const metadata = readRedemptionBackstopLiveMetadata("usdr-rise", snapshot, now);
    const entry = await buildEntry("usdr-rise", getRedemptionBackstopConfig("usdr-rise")!, 10_000_000, null, {
      reserveSnapshotMetadata: snapshot, redemptionLiveMetadata: metadata,
    });
    expect(entry.immediateCapacityUsd).toBe(accepted ? 2_000_000 : null);
    expect(entry.feeBps).toBe(accepted ? 0 : null);
    expect(entry.costScore).toBe(accepted ? 100 : 60);
    expect(entry.resolutionState).toBe(accepted ? "resolved" : "missing-capacity");
    if (accepted) {
      expect(entry.routeStatus).toBe("open");
      expect(entry.routeStatusSource).toBe("onchain");
      expect(entry.liveHolderEligibility).toBe("any-holder");
      expect(entry.settlementDelaySec).toBe(60);
    } else {
      expect(entry.routeStatus).toBe("unknown");
      expect(entry.routeStatusSource).toBe("static-config");
      expect(entry.liveHolderEligibility).toBeUndefined();
      expect(entry.settlementDelaySec).toBeUndefined();
      expect(entry.capacityProfile?.exitRouteObservations ?? []).toEqual([]);
    }
  });

  it("withholds USDR favorable status-only telemetry without the configured wM payout", async () => {
    const entry = await buildEntry("usdr-rise", getRedemptionBackstopConfig("usdr-rise")!, 1_000_000, null, {
      reserveSnapshotMetadata: liveSnapshot("usdr-rise", { freshnessMode: "not-applicable", redemption: {
        routeStatus: "open", routeStatusSource: "onchain", holderEligibility: "whitelisted-primary",
      } }),
    });
    expect(entry).toMatchObject({
      routeStatus: "unknown", routeStatusSource: "static-config", feeBps: null,
      immediateCapacityUsd: null, capacityRejectionReason: "route-output-identity-unobserved",
    });
    expect(entry.liveHolderEligibility).toBeUndefined();
  });

  it.each([
    { keys: undefined, accepted: false },
    { keys: null, accepted: false },
    { keys: "usdc-circle", accepted: false },
    { keys: [], accepted: false },
    { keys: ["usdt-tether"], accepted: false },
    { keys: ["usdc-circle", "usdt-tether"], accepted: false },
    { keys: ["usdc-circle", "usdc-circle"], accepted: false },
    { keys: ["usdc-circle"], accepted: true },
  ])("applies exact-output admission to observer favorable terms ($keys)", async ({ keys, accepted }) => {
    const direct: ExecutableRedemptionObservation = {
      capacityRaw: 500_000_000n, capacitySource: "forest-road-controller", capacityState: "measured",
      outputAssetKeys: ["usdc-circle"], underlyingDecimals: 6, capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain", routeStatus: "open", routeStatusSource: "onchain",
      routeStatusReason: "Pinned controller", holderEligibility: "any-holder", feeBps: 10,
      allInFeeBps: 10, settlementDelaySec: 0, blockNumber: 26_143_056, sourceTimestamp: now,
      sourceUrls: ["https://www.usdfr.com/"], diagnostics: {},
    };
    Object.assign(direct, { outputAssetKeys: keys });
    const entry = await buildEntry("usdfr-forest-road", getRedemptionBackstopConfig("usdfr-forest-road")!, 1_000_000, null, {
      executableRedemptionObservation: direct,
      executableObserverValuation: { outputAssetKey: "usdc-circle", priceUsd: 1, observedAt: now },
    });
    // A rejected live fee cannot replace the independently reviewed fixed fee.
    expect(entry.feeBps).toBe(accepted ? 10 : 0);
    if (accepted) {
      expect(entry).toMatchObject({ immediateCapacityUsd: 500, routeStatus: "open", routeStatusSource: "onchain",
        liveHolderEligibility: "any-holder", settlementDelaySec: 0 });
    } else {
      expect(entry).toMatchObject({ immediateCapacityUsd: null, routeStatus: "unknown", routeStatusSource: "static-config",
        capacityRejectionReason: "route-output-identity-unobserved" });
      expect(entry.liveHolderEligibility).toBeUndefined();
      expect(entry.settlementDelaySec).toBeUndefined();
      expect(entry.capacityProfile?.exitRouteObservations ?? []).toEqual([]);
    }
  });

  it("retains independently source-owned adverse USDR status while rejecting payout terms", async () => {
    const entry = await buildEntry("usdr-rise", getRedemptionBackstopConfig("usdr-rise")!, 1_000_000, null, {
      reserveSnapshotMetadata: liveSnapshot("usdr-rise", { freshnessMode: "not-applicable", redemption: {
        outputAssetKeys: ["m-m0"], feeBps: 0, routeStatus: "paused", routeStatusSource: "onchain",
        routeStatusReason: "Same wrapper's redemption pause observed onchain",
      } }),
    });
    expect(entry).toMatchObject({ routeStatus: "paused", routeStatusSource: "onchain", feeBps: null, immediateCapacityUsd: null });
    expect(entry.routeStatusReason).toBe("Same wrapper's redemption pause observed onchain");
  });

  it("retains the exact observer's independently observed pause when payout terms are rejected", async () => {
    const direct: ExecutableRedemptionObservation = {
      capacityRaw: 0n, capacitySource: "forest-road-controller", capacityState: "closed",
      outputAssetKeys: ["usdt-tether"], underlyingDecimals: 6, capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain", routeStatus: "paused", routeStatusSource: "onchain",
      routeStatusReason: "Pinned controller pause", holderEligibility: "any-holder", feeBps: 10,
      allInFeeBps: 10, settlementDelaySec: 0, blockNumber: 26_143_056, sourceTimestamp: now,
      sourceUrls: ["https://www.usdfr.com/"], diagnostics: {},
    };
    const entry = await buildEntry("usdfr-forest-road", getRedemptionBackstopConfig("usdfr-forest-road")!, 1_000_000, null, {
      executableRedemptionObservation: direct,
    });
    expect(entry).toMatchObject({
      routeStatus: "paused", routeStatusSource: "onchain", routeStatusReason: "Pinned controller pause",
      immediateCapacityUsd: null, capacityRejectionReason: "route-output-identity-unobserved",
      feeBps: 0,
    });
    expect(entry.liveHolderEligibility).toBeUndefined();
    expect(entry.settlementDelaySec).toBeUndefined();
  });

  it.each(["stale", "wrong-output", "unvalued", "unknown-all-in"] as const)(
    "keeps registered USDfr %s observation unavailable without borrowing reserve or supply capacity", async (reason) => {
      const direct: ExecutableRedemptionObservation = {
        capacityRaw: 500_000_000n, capacitySource: "forest-road-controller", capacityState: "measured",
        outputAssetKeys: reason === "wrong-output" ? ["usdt-tether"] : ["usdc-circle"],
        underlyingDecimals: 6, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain",
        routeStatus: "open", routeStatusSource: "onchain", routeStatusReason: "Pinned controller",
        holderEligibility: "any-holder", feeBps: 0, allInFeeBps: reason === "unknown-all-in" ? null : 1,
        settlementDelaySec: 0, blockNumber: 26_143_056, sourceTimestamp: reason === "stale" ? now - 601 : now,
        sourceUrls: ["https://www.usdfr.com/"], diagnostics: {},
      };
      const entry = await buildEntry("usdfr-forest-road", getRedemptionBackstopConfig("usdfr-forest-road")!, 1_000_000, null, {
        executableRedemptionObservation: direct,
        executableObserverValuation: reason === "unvalued" ? null : {
          outputAssetKey: "usdc-circle", priceUsd: 1, observedAt: now,
        },
        reserveSnapshotMetadata: liveSnapshot("usdfr-forest-road", {
          redemption: { capacityUsd: 9_000_000, feeBps: 0 }, freshnessMode: "not-applicable",
        }),
      });
      expect(entry.immediateCapacityUsd).toBeNull();
      expect(entry.capacityProfile?.scoringUsd).toBeNull();
      expect(entry.capacityProfile?.eventualUsd).toBeNull();
      expect(entry.reserveInput).toBeUndefined();
      expect(entry.capacityRejectionReason).toBe({
        stale: "stale-source-timestamp", "wrong-output": "route-output-identity-unobserved",
        unvalued: "output-valuation-unobserved", "unknown-all-in": "all-in-cost-unobserved",
      }[reason]);
    },
  );
  it.each([
    { updatedAt: now - 1, admitted: true },
    { updatedAt: now - STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC, admitted: true },
    { updatedAt: now - STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC - 1, admitted: false },
    { updatedAt: now + 1, admitted: false },
    { updatedAt: 0, admitted: false },
    { updatedAt: now - 0.5, admitted: false },
  ])("preserves cached output generation time and admits only fresh generations ($updatedAt)", async ({ updatedAt, admitted }) => {
    const direct: ExecutableRedemptionObservation = {
      capacityRaw: 500_000_000n, capacitySource: "forest-road-controller", capacityState: "measured",
      outputAssetKeys: ["usdc-circle"], underlyingDecimals: 6, capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain", routeStatus: "open", routeStatusSource: "onchain",
      routeStatusReason: "Pinned controller", holderEligibility: "any-holder", feeBps: 0,
      allInFeeBps: 1, settlementDelaySec: 0, blockNumber: 26_143_056, sourceTimestamp: now,
      sourceUrls: ["https://www.usdfr.com/"], diagnostics: {},
    };
    const resolver = vi.spyOn(redemptionCapacity, "resolveRedemptionCapacity");
    try {
      const entry = await buildEntry("usdfr-forest-road", getRedemptionBackstopConfig("usdfr-forest-road")!, 1_000_000, null, {
        executableRedemptionObservation: direct,
        stablecoinsCache: { kind: "ok", updatedAt,
          payload: { peggedAssets: [makeAsset({ id: "usdc-circle", price: 0.98 })] } },
      });
      expect(resolver.mock.calls[resolver.mock.calls.length - 1]?.[5]?.executableObserverValuation).toEqual(admitted
        ? { outputAssetKey: "usdc-circle", priceUsd: 0.98, observedAt: updatedAt } : null);
      expect(entry.immediateCapacityUsd).toBe(admitted ? 490 : null);
      expect(entry.capacityRejectionReason).toBe(admitted ? undefined : "output-valuation-unobserved");
      expect(entry.reserveInput).toBeUndefined();
    } finally {
      resolver.mockRestore();
    }
  });
  it("fails closed when the registered USDfr direct observation is unavailable", async () => {
    observeExecutableRedemptionRouteMock.mockResolvedValue(null);
    await expect(buildEntry("usdfr-forest-road", getRedemptionBackstopConfig("usdfr-forest-road")!, 1_000_000, null, {
      reserveSnapshotMetadata: liveSnapshot("usdfr-forest-road", { redemption: { capacityUsd: 9_000_000 } }),
    })).rejects.toThrow("usdfr-forest-road executable observer unavailable");
  });
  it.each([
    "usdx-axis",
    "mantrausd-mantra",
  ])("withholds the %s entry when no honest exact-route capacity model exists", async (id) => {
    const entry = await resolveRedemptionBackstopEntry(mockD1Strict([]), { id } as StablecoinData, null, now);

    expect(entry).toBeNull();
    expect(REVIEWED_REDEMPTION_COVERAGE_DISPOSITIONS.find((row) => row.id === id)).toMatchObject({
      disposition: "defer",
      reasonCode: "capacity-unpublished",
    });
  });

  it("publishes the reviewed legacy Spark USDC route with unquantified capacity when no execution receipt exists", async () => {
    const asset = makeAsset({ id: "susdc-spark-v1", circulating: { peggedUSD: 100_000_000 } });
    const entry = await resolveRedemptionBackstopEntry(mockD1Strict([]), asset, null, now, {
      exitExecutionReviews: [],
    });

    expect(entry).toMatchObject({
      routeFamily: "stablecoin-redeem",
      outputAssetType: "stable-single",
      resolutionState: "missing-capacity",
      immediateCapacityUsd: null,
      immediateCapacityRatio: null,
      capacityScore: null,
      score: null,
      eventualRedeemabilityScore: null,
    });
    expect(entry?.capacityProfile).toMatchObject({
      immediateUsd: null, scoringUsd: null, eventualUsd: null, scoringHorizon: "unknown",
    });
    expect(entry?.capacityProfile?.exitRouteObservations ?? []).toEqual([]);
  });

  it("resolves supply-full capacity with valid supply", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        routeFamily: "offchain-issuer",
        accessModel: "issuer-api",
        settlementModel: "same-day",
        executionModel: "rules-based-nav",
      }),
      100_000_000, // $100M supply
      50, // dex liquidity score
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.sourceMode).toBe("estimated");
    expect(entry.capacitySemantics).toBe("eventual-only");
    expect(entry.immediateCapacityUsd).toBeNull();
    expect(entry.immediateCapacityRatio).toBeNull();
    expect(entry.score).toBeNull();
    expect(entry.capacityScore).toBeNull();
    expect(entry.eventualRedeemabilityScore).toBeLessThanOrEqual(65); // offchain-issuer cap
    expect(entry.capacityProfile).toMatchObject({
      eventualUsd: 100_000_000,
      scoringUsd: null,
      scoringHorizon: "eventual",
    });
  });

  it("floors zero eventual supply at a zero eventual redemption score", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        routeFamily: "offchain-issuer",
        accessModel: "issuer-api",
        settlementModel: "same-day",
        executionModel: "rules-based-nav",
      }),
      0,
      null,
    );

    expect(entry.eventualRedeemabilityScore).toBe(0);
    expect(entry.capacityProfile?.eventualUsd).toBe(0);
  });

  it("returns missing-cache when supply is null for supply-full model", async () => {
    const entry = await buildEntry("test-coin", route(), null, 50);

    expect(entry.resolutionState).toBe("missing-cache");
    expect(entry.score).toBeNull();
    expect(entry.immediateCapacityUsd).toBeNull();
  });

  describe("absence-preserving asset wrapper", () => {
    const models = [
      { kind: "fixed-usd", amountUsd: 1_000_000 },
      { kind: "supply-ratio", ratio: 0.5 },
      { kind: "supply-full" },
      { kind: "reserve-sync-metadata" },
    ] as const;
    const supplyCases: { label: string; circulating: StablecoinData["circulating"] | undefined }[] = [
      { label: "missing", circulating: undefined },
      { label: "empty", circulating: {} },
      { label: "NaN", circulating: { peggedUSD: NaN } },
      { label: "infinite", circulating: { peggedUSD: Infinity } },
      { label: "observed zero", circulating: { peggedUSD: 0 } },
    ];
    for (const capacityModel of models) {
      it.each(supplyCases)(`preserves $label supply through ${capacityModel.kind}`, async ({ circulating }) => {
        const configLookup = vi.spyOn(redemptionBackstops, "getRedemptionBackstopConfig")
          .mockReturnValue(route({ capacityModel }));
        try {
          const entry = await resolveRedemptionBackstopEntry(
            mockD1Strict([]),
            makeAsset({ id: "lusd-liquity", circulating }),
            null,
            now,
            {
              exitExecutionReviews: [],
              reserveSnapshotMetadata: liveSnapshot("lusd-liquity", {
                freshnessMode: "not-applicable",
                redemption: { capacityUsd: 1_000_000, capacityKind: "live-direct-bounded", freshnessKind: "same-run-onchain" },
              }, { source: "liquity-v1", sourceModel: "single-bucket" }),
            },
          );
          expect(entry).not.toBeNull();
          expect(entry!.immediateCapacityRatio).toBeNull();
          if (capacityModel.kind === "supply-full") {
            if (circulating?.peggedUSD === 0) {
              expect(entry!.capacityProfile?.eventualUsd).toBe(0);
              expect(entry!.eventualRedeemabilityScore).toBe(0);
            } else {
              expect(entry!.resolutionState).toBe("missing-cache");
              expect(entry!.capacityProfile?.eventualUsd ?? null).toBeNull();
              expect(entry!.eventualRedeemabilityScore).toBeNull();
            }
          } else if (capacityModel.kind === "supply-ratio") {
            expect(entry!.resolutionState).toBe(circulating?.peggedUSD === 0 ? "missing-capacity" : "missing-cache");
            expect(entry!.immediateCapacityUsd).toBeNull();
          } else {
            expect(entry!.immediateCapacityUsd).toBe(circulating?.peggedUSD === 0 ? 0 : 1_000_000);
          }
        } finally {
          configLookup.mockRestore();
        }
      });
    }
  });

  it("resolves supply-ratio capacity correctly", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({ routeFamily: "psm-swap", capacityModel: { kind: "supply-ratio", ratio: 0.33 } }),
      1_000_000_000,
      80,
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.immediateCapacityUsd).toBe(330_000_000);
    expect(entry.immediateCapacityRatio).toBe(0.33);
    expect(entry.score).not.toBeNull();
  });

  it.each([false, true])("joins unresolved outputs without build-order dependence (%s)", async (reverse) => {
    const config = route({
      routeFamily: "psm-swap",
      capacityModel: { kind: "supply-ratio", ratio: 0.5 },
      outputAssets: ["asset:usd", "missing-output", "test-unresolved-output"],
    });
    const buildUpstream = () => buildEntry("test-upstream", config, 100_000_000, null);
    const buildDownstream = () => buildEntry("test-unresolved-output", route(), null, null);
    const entries = reverse
      ? [await buildDownstream(), await buildUpstream()]
      : [await buildUpstream(), await buildDownstream()];
    const upstream = entries.find((entry) => entry.stablecoinId === "test-upstream")!;
    Object.freeze(upstream);
    expect(upstream).not.toHaveProperty("outputDependencyResolution");
    const completed = applyOutputDependencyResolution(entries, new Map([["test-upstream", config]]));
    const disclosed = completed.find((entry) => entry.stablecoinId === "test-upstream")!;
    expect(disclosed).toEqual({
      ...upstream,
      outputDependencyResolution: { stablecoinId: "test-unresolved-output", resolutionState: "missing-cache" },
    });
    expect(upstream).not.toHaveProperty("outputDependencyResolution");
    expect(applyOutputDependencyResolution(completed, new Map([["test-upstream", config]]))).toEqual(completed);
  });

  it("keeps concurrent same-clock snapshots isolated and returned builders unmutated", async () => {
    const config = route({ capacityModel: { kind: "supply-ratio", ratio: 0.5 }, outputAssets: ["test-output"] });
    const configs = new Map([["test-upstream", config]]);
    const [[upstreamA, failedOutput], [upstreamB, resolvedOutput]] = await Promise.all([
      Promise.all([
        buildEntry("test-upstream", config, 100_000_000, null),
        Promise.resolve(buildFailedRedemptionBackstopEntry("test-output", route(), now)),
      ]),
      Promise.all([
        buildEntry("test-upstream", config, 100_000_000, null),
        buildEntry("test-output", route(), 100_000_000, null),
      ]),
    ]);
    const first = applyOutputDependencyResolution([upstreamA, failedOutput], configs);
    const second = applyOutputDependencyResolution([upstreamB, resolvedOutput], configs);
    expect(first[0].outputDependencyResolution).toEqual({ stablecoinId: "test-output", resolutionState: "failed" });
    expect(second[0]).not.toHaveProperty("outputDependencyResolution");
    await buildEntry("test-output", route(), null, null);
    expect(first[0].outputDependencyResolution).toEqual({ stablecoinId: "test-output", resolutionState: "failed" });
    expect(upstreamA).not.toHaveProperty("outputDependencyResolution");
    expect(upstreamB).not.toHaveProperty("outputDependencyResolution");
    expect(applyOutputDependencyResolution([first[0]], configs)[0]).not.toHaveProperty("outputDependencyResolution");
    expect(applyOutputDependencyResolution([first[0], resolvedOutput], configs)[0]).not.toHaveProperty("outputDependencyResolution");
  });

  it("discloses only the first observed unresolved output across self and cyclic edges", async () => {
    const configA = route({ outputAssets: ["asset:usd", "missing", "test-b", "test-a"] });
    const configB = route({ outputAssets: ["test-a"] });
    const a = buildFailedRedemptionBackstopEntry("test-a", configA, now);
    const b = buildFailedRedemptionBackstopEntry("test-b", configB, now);
    const configs = new Map([["test-a", configA], ["test-b", configB]]);
    const completed = applyOutputDependencyResolution([a, b], configs);
    expect(completed[0].outputDependencyResolution).toEqual({ stablecoinId: "test-b", resolutionState: "failed" });
    expect(completed[1].outputDependencyResolution).toEqual({ stablecoinId: "test-a", resolutionState: "failed" });
    const self = applyOutputDependencyResolution([a], new Map([["test-a", route({ outputAssets: ["test-a"] })]]));
    expect(self[0].outputDependencyResolution).toEqual({ stablecoinId: "test-a", resolutionState: "failed" });
  });

  it("uses capacity profile scoring capacity to reduce effective exit score", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({ capacityModel: { kind: "supply-ratio", ratio: 1, dailyLimitUsd: 100_000, confidence: "documented-bound" } }),
      100_000_000,
      null,
    );
    const unconstrained = await buildEntry(
      "test-coin",
      route({ capacityModel: { kind: "supply-ratio", ratio: 1, confidence: "documented-bound" } }),
      100_000_000,
      null,
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.capacityProfile).toMatchObject({
      immediateUsd: 100_000_000,
      dailyLimitUsd: 100_000,
      scoringUsd: 100_000,
      modeledExitSizeUsd: 5_000_000,
      scoringHorizon: "daily",
    });
    expect(unconstrained.score).toBeTypeOf("number");
    expect(entry.score).toBeLessThan(unconstrained.score!);
  });

  it("applies explicit total score caps after component scoring", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        capacityModel: { kind: "supply-ratio", ratio: 1, confidence: "documented-bound" },
        totalScoreCap: 42,
      }),
      100_000_000,
      null,
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.score).toBe(42);
    expect(entry.capsApplied).toContain("config-cap");
  });

  it("keeps eventual-only queue routes out of current-exit scoring", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({ routeFamily: "queue-redeem", settlementModel: "queued", executionModel: "rules-based-nav" }),
      500_000_000,
      null,
    );

    expect(entry.score).toBeNull();
    expect(entry.capacityScore).toBeNull();
    expect(entry.eventualRedeemabilityScore).toBeLessThanOrEqual(70);
    expect(entry.capacityProfile?.scoringHorizon).toBe("eventual");
  });

  it.each(fixedFeeCases)("scores fixed $feeBps bps fee as $expectedScore", async ({ feeBps, expectedScore }) => {
    const entry = await buildEntry("test-coin", route({
      costModel: { kind: "fee-bps", feeBps },
    }), 100_000_000, null);

    expect(entry.costScore).toBe(expectedScore);
    expect(entry.feeBps).toBe(feeBps);
    expect(entry.feeConfidence).toBe("fixed");
  });

  it("scores formula-confidence dynamic fees as 60", async () => {
    const entry = await buildEntry(
      "bold-liquity",
      route({
        routeFamily: "collateral-redeem",
        outputAssetType: "bluechip-collateral",
        costModel: {
          kind: "dynamic-or-unclear",
          feeDescription: "Minimum 50 bps + baseRate",
          confidence: "formula",
        },
      }),
      100_000_000,
      null,
    );

    expect(entry.costScore).toBe(60);
    expect(entry.feeConfidence).toBe("formula");
  });

  it("uses live fee metadata for formula routes when reserve sync exposes a current fee", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        routeFamily: "collateral-redeem",
        outputAssetType: "bluechip-collateral",
        capacityModel: { kind: "supply-full", confidence: "documented-bound" },
        costModel: {
          kind: "dynamic-or-unclear",
          feeDescription: "Minimum 50 bps + baseRate",
          confidence: "formula",
        },
      }),
      100_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("bold-liquity", {
          redemption: { feeBps: 50 },
          freshnessMode: "not-applicable",
        }, {
          fetchedAt: now - 300,
          source: "single-asset",
          sourceModel: "single-bucket",
        }),
      },
    );

    expect(entry.costScore).toBe(80);
    expect(entry.feeBps).toBe(50);
    expect(entry.feeConfidence).toBe("formula");
    expect(entry.feeModelKind).toBe("formula");
  });

  it("scores undisclosed-reviewed dynamic fees as 40", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        routeFamily: "offchain-issuer",
        accessModel: "issuer-api",
        settlementModel: "same-day",
        executionModel: "rules-based-nav",
        costModel: {
          kind: "dynamic-or-unclear",
          feeDescription: "Public docs reviewed do not publish a numeric redemption fee.",
          confidence: "undisclosed-reviewed",
        },
      }),
      100_000_000,
      null,
    );

    expect(entry.costScore).toBe(40);
    expect(entry.feeConfidence).toBe("undisclosed-reviewed");
  });

  it("resolves reserve-sync-metadata capacity with fresh data", async () => {
    const entry = await buildEntry(
      "lusd-liquity",
      route({
        routeFamily: "queue-redeem",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.15 },
        costModel: { kind: "dynamic-or-unclear" },
      }),
      50_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("lusd-liquity", {
          redemption: {
            capacityUsd: 7_500_000,
            capacityRatioOfSupply: 0.15,
          },
          sourceTimestamp: now - 1800,
          freshnessMode: "verified",
        }, { fetchedAt: now - 1800 }),
      },
    );

    expect(entry.sourceMode).toBe("dynamic");
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.immediateCapacityUsd).toBe(7_500_000);
    expect(entry.immediateCapacityRatio).toBe(0.15);
    expect(entry.capacityConfidence).toBe("live-direct");
    expect(entry.capacitySemantics).toBe("immediate-bounded");
    expect(entry.eventualRedeemabilityScore).toBeNull();
    expect(entry.capacityProfile?.eventualUsd).toBeUndefined();
  });

  it("publishes reviewed queued settlement and a zero headline for eEARN-style measured incapacity", async () => {
    const entry = await buildEntry(
      "lusd-liquity",
      route({
        settlementModel: "atomic",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata" },
        v9RouteReviewTerms: { settlementModel: "queued" },
      }),
      20_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("lusd-liquity", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 0,
            capacityKind: "live-queue",
            freshnessKind: "same-run-onchain",
            settlementDelaySec: 2_592_000,
          },
        }, { fetchedAt: now - 120 }),
      },
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.score).toBe(0);
    expect(entry.capacityScore).toBe(0);
    expect(entry.capsApplied).toContain("zero-executable-capacity");
    expect(entry.settlementModel).toBe("queued");
    expect(entry.settlementScore).toBe(20);
    expect(entry.queueEnabled).toBe(true);
    expect(entry.eventualRedeemabilityScore).toBeNull();
    expect(entry.capacityProfile?.exitRouteObservations?.[0]?.settlementHorizonSec).toBe(2_592_000);
  });

  it("leaves eEARN-style unproven settlement capacity unrated while retaining the queued trace", async () => {
    const entry = await buildEntry(
      "lusd-liquity",
      route({
        settlementModel: "atomic",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata" },
        v9RouteReviewTerms: { settlementModel: "queued" },
      }),
      20_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("lusd-liquity", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 0,
            capacityKind: "live-queue",
            freshnessKind: "same-run-onchain",
            settlementBoundUnproven: true,
            settlementDelaySec: 2_592_000,
            routeStatus: "open",
            routeStatusSource: "onchain",
          },
        }, { fetchedAt: now - 120 }),
      },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.score).toBeNull();
    expect(entry.capacityScore).toBeNull();
    expect(entry.capsApplied).not.toContain("zero-executable-capacity");
    expect(entry.eventualRedeemabilityScore).toBeNull();
    expect(entry.capacityProfile).toMatchObject({
      scoringUsd: null,
      settlementBoundUnproven: true,
      exitRouteObservations: [
        {
          settlementBoundUnproven: true,
          scoreEligible: false,
          settlementHorizonSec: 2_592_000,
        },
      ],
    });
    expect(entry.capacityProfile?.exitRouteObservations?.[0]).not.toHaveProperty("capacityCurve");
  });

  it("keeps a paused flagged queue on the measured-zero path instead of the bounded gap", async () => {
    const entry = await buildEntry(
      "lusd-liquity",
      route({
        settlementModel: "atomic",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata" },
        v9RouteReviewTerms: { settlementModel: "queued" },
      }),
      20_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("lusd-liquity", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 0,
            capacityKind: "live-queue",
            freshnessKind: "same-run-onchain",
            settlementBoundUnproven: true,
            settlementDelaySec: 2_592_000,
            routeStatus: "paused",
            routeStatusSource: "onchain",
            routeStatusReason: "Withdrawals are paused onchain",
          },
        }, { fetchedAt: now - 120 }),
      },
    );

    // A paused route's zero is the measured pause, not an evidence gap: the
    // bounded-gap lane must not swallow a live impairment.
    expect(entry.routeStatus).toBe("paused");
    expect(entry.capacityProfile?.settlementBoundUnproven).toBe(true);
    expect(entry.score).toBeNull();
    expect(entry.capsApplied).toContain("live-route-status-impairment");
  });

  it("reuses pre-parsed live redemption metadata for capacity and fees", async () => {
    const entry = await buildEntry(
      "usdo-openeden",
      route({
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: {
          kind: "dynamic-or-unclear",
          confidence: "formula",
          feeDescription: "Live fee formula",
        },
      }),
      50_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("usdo-openeden", {
          redemption: {
            capacityUsd: 1,
            feeBps: 99,
          },
        }, { fetchedAt: now - 120 }),
        redemptionLiveMetadata: {
          updatedAt: now - 120,
          isFresh: true,
          hasScoringEligibleFreshness: true,
          hasBlockingWarnings: false,
          capacityNotes: [],
          capacityConfidence: "live-direct",
          settlementBoundUnproven: false,
          canUseCapacity: true,
          canUseFee: true,
          capacityReason: null,
          feeReason: null,
          immediateRedeemableUsd: 12_500_000,
          immediateRedeemableRatio: null,
          capacityKind: "live-direct",
          freshnessKind: "verified-source-timestamp",
          sourceTimestamp: now - 120,
          evidenceObservedAt: now - 120,
          sourceUrls: ["https://example.com/redemption.json"],
          settlementDelaySec: null,
          queueDepthUsd: null,
          dailyLimitUsd: null,
          minRedeemUsd: null,
          liveHolderEligibility: null,
          redemptionFeeBps: 4,
          buyFeeBpsMin: null,
          buyFeeBpsMax: null,
          routeStatus: "open",
          routeStatusSource: "protocol-api",
          routeStatusReason: null,
          routeStatusReviewedAt: null,
          v9FpiControllerRouteState: null,
          v9SfrxusdCrosschainRouteState: null,
        },
      },
    );

    expect(entry.provider).toBe("reserve-sync-metadata");
    expect(entry.immediateCapacityUsd).toBe(12_500_000);
    expect(entry.feeBps).toBe(4);
    expect(entry.sourceTimestamp).toBe(now - 120);
    expect(entry.sourceUrls).toEqual(["https://example.com/redemption.json"]);
  });

  it("derives reserve-sync ratio from supply when nested capacity omits ratio", async () => {
    const sourceUrls = ["https://example.com/redemption.json", "https://example.com/redemption.json"];
    const retainedSourceUrls = [...sourceUrls];
    const entry = await buildEntry(
      "usde-ethena",
      route({
        accessModel: "whitelisted-onchain",
        settlementModel: "immediate",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed variable fee" },
        reviewedAt: "2026-04-15",
        docs: [{ label: "Ethena collateral API", url: "https://app.ethena.fi/api/positions/current/collateral" }],
      }),
      100_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("usde-ethena", {
          freshnessMode: "verified",
          sourceTimestamp: now - 120,
          redemption: {
            capacityUsd: 50_000_000,
            capacityKind: "live-proxy-validated",
            freshnessKind: "verified-source-timestamp",
            sourceTimestamp: now - 120,
            sourceUrls,
            settlementDelaySec: 3600,
            queueDepthUsd: 12_000_000,
            dailyLimitUsd: 5_000_000,
            minRedeemUsd: 100_000,
            holderEligibility: "whitelisted-primary",
            routeStatus: "open",
            routeStatusSource: "protocol-api",
          },
        }, { fetchedAt: now - 120, source: "ethena" }),
      },
    );

    expect(entry.immediateCapacityUsd).toBe(50_000_000);
    expect(entry.immediateCapacityRatio).toBe(0.5);
    expect(entry.capacityKind).toBe("live-proxy-validated");
    expect(entry.freshnessKind).toBe("verified-source-timestamp");
    expect(entry.sourceTimestamp).toBe(now - 120);
    expect(entry.sourceUrls).toEqual(["https://example.com/redemption.json"]);
    expect(sourceUrls).toEqual(retainedSourceUrls);
    expect(entry.settlementDelaySec).toBe(3600);
    expect(entry.queueDepthUsd).toBe(12_000_000);
    expect(entry.dailyLimitUsd).toBe(5_000_000);
    expect(entry.minRedeemUsd).toBe(100_000);
    expect(entry.liveHolderEligibility).toBe("whitelisted-primary");
  });

  it("treats DUSD's open operator-batched queue as an unproven settlement bound", async () => {
    const config = getRedemptionBackstopConfig("dusd-dialectic");
    expect(config).not.toBeNull();

    const entry = await buildEntry(
      "dusd-dialectic",
      config!,
      5_800_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot(
          "dusd-dialectic",
          dusdOpenQueueMetadata(now),
          { fetchedAt: now - 120, source: "makina-strategy" },
        ),
      },
    );

    expect(entry.provider).toBe("reserve-sync-metadata");
    expect(entry.sourceMode).toBe("dynamic");
    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.routeStatus).toBe("open");
    expect(entry.routeStatusSource).toBe("onchain");
    expect(entry.liveHolderEligibility).toBe("any-holder");
    expect(entry.capacityConfidence).toBe("heuristic");
    expect(entry.capacityBasis).toBe("live-proxy-buffer");
    expect(entry.capacityKind).toBe("live-queue");
    expect(entry.immediateCapacityUsd).toBeNull();
    expect(entry.capacityProfile).toMatchObject({
      immediateUsd: null,
      scoringUsd: null,
      scoringHorizon: "unknown",
      settlementBoundUnproven: true,
    });
    expect(entry.score).toBeNull();
    expect(entry.queueDepthUsd).toBe(3_104.889979);
    expect(entry.settlementDelaySec).toBeUndefined();
    expect(entry.notes).toContain("Live redemption settlement completion bound is unproven; capacity is not established");
  });

  it("fails DUSD closed when the live queue proof omits usable capacity", async () => {
    const config = getRedemptionBackstopConfig("dusd-dialectic");
    expect(config).not.toBeNull();

    const entry = await buildEntry(
      "dusd-dialectic",
      config!,
      5_800_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("dusd-dialectic", {
          freshnessMode: "verified",
          sourceTimestamp: now - 120,
          redemption: {
            capacityKind: "live-queue",
            freshnessKind: "same-run-onchain",
            routeStatus: "open",
            routeStatusSource: "onchain",
          },
        }, { fetchedAt: now - 120, source: "makina-strategy" }),
      },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.provider).toBe("reserve-sync-metadata");
    expect(entry.immediateCapacityUsd).toBeNull();
    expect(entry.score).toBeNull();
    expect(entry.notes).toContain("Live reserve metadata lacks redeemable-capacity amount");
  });

  it("propagates live route status from reserve metadata", async () => {
    const entry = await buildEntry(
      "cusd-cap",
      route({
        routeFamily: "basket-redeem",
        executionModel: "deterministic-basket",
        outputAssetType: "stable-basket",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed variable fee" },
        reviewedAt: "2026-04-15",
        docs: [{ label: "Cap vault", url: "https://docs.cap.app/concepts/vault" }],
      }),
      100_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("cusd-cap", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 10_000_000,
            capacityKind: "live-direct-bounded",
            freshnessKind: "same-run-onchain",
            routeStatus: "paused",
            routeStatusSource: "onchain",
            routeStatusReason: "All vault assets are paused",
            routeStatusReviewedAt: "2026-04-15",
          },
        }, { fetchedAt: now - 120, source: "cap-vault" }),
      },
    );

    expect(entry.routeStatus).toBe("paused");
    expect(entry.routeStatusSource).toBe("onchain");
    expect(entry.routeStatusReason).toBe("All vault assets are paused");
    expect(entry.routeStatusReviewedAt).toBe("2026-04-15");
    expect(entry.resolutionState).toBe("impaired");
    expect(entry.score).toBeNull();
    expect(entry.modelConfidence).toBe("low");
    expect(entry.capsApplied).toContain("live-route-status-impairment");
  });

  it("treats cohort-limited live route status as an impaired route", async () => {
    const entry = await buildEntry(
      "cusd-cap",
      route({
        routeFamily: "basket-redeem",
        executionModel: "deterministic-basket",
        outputAssetType: "stable-basket",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 0 },
      }),
      100_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("cusd-cap", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 10_000_000,
            capacityKind: "live-direct-bounded",
            freshnessKind: "same-run-onchain",
            routeStatus: "cohort-limited",
            routeStatusSource: "protocol-api",
            routeStatusReason: "Redemptions are limited to a reviewed cohort",
          },
        }, { fetchedAt: now - 120, source: "cap-vault" }),
      },
    );

    expect(entry.routeStatus).toBe("cohort-limited");
    expect(entry.routeStatusSource).toBe("protocol-api");
    expect(entry.resolutionState).toBe("impaired");
    expect(entry.score).toBeNull();
    expect(entry.capsApplied).toContain("live-route-status-impairment");
  });

  it("ignores live route status without source attribution", async () => {
    const entry = await buildEntry(
      "cusd-cap",
      route({
        routeFamily: "basket-redeem",
        executionModel: "deterministic-basket",
        outputAssetType: "stable-basket",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed variable fee" },
        reviewedAt: "2026-04-15",
        docs: [{ label: "Cap vault", url: "https://docs.cap.app/concepts/vault" }],
      }),
      100_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("cusd-cap", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 10_000_000,
            capacityKind: "live-direct-bounded",
            freshnessKind: "same-run-onchain",
            routeStatus: "paused",
            routeStatusReason: "All vault assets are paused",
          },
        }, { fetchedAt: now - 120, source: "cap-vault" }),
      },
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.routeStatus).toBe("open");
    expect(entry.routeStatusSource).toBe("static-config");
    expect(entry.notes).toContain("Live redemption route status omitted source attribution and was ignored");
    expect(entry.capsApplied).not.toContain("live-route-status-impairment");
  });

  it("uses unsourced unknown live route status to suppress optimistic static open status", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed variable fee" },
        reviewedAt: "2026-04-15",
        docs: [{ label: "Fixture route", url: "https://example.com/redemption" }],
      }),
      100_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("test-coin", {
          freshnessMode: "not-applicable",
          redemption: {
            capacityUsd: 10_000_000,
            capacityKind: "live-proxy-validated",
            freshnessKind: "same-run-api",
            routeStatus: "unknown",
          },
        }, { fetchedAt: now - 120, source: "fixture" }),
      },
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.routeStatus).toBe("unknown");
    expect(entry.routeStatusSource).toBe("static-config");
    expect(entry.modelConfidence).toBe("low");
    expect(entry.confidenceDetails?.reasons).toContain(
      "Route status is unknown without direct live telemetry or a documented capacity bound",
    );
    expect(entry.notes).toContain("Live redemption route status is unknown without source attribution");
  });

  it.each(liveDirectCoinCases)(
    "uses $description as live direct redemption capacity",
    async ({ stablecoinId, supplyUsd, dexScore, metadata, overrides, expected }) => {
      const config = getRedemptionBackstopConfig(stablecoinId);
      expect(config).not.toBeNull();
      const entry = await buildEntry(stablecoinId, config!, supplyUsd, dexScore, {
        reserveSnapshotMetadata: liveSnapshot(stablecoinId, metadata, overrides),
      });
      expect(entry).toMatchObject({
        provider: "reserve-sync-metadata", resolutionState: "resolved",
        capacityConfidence: "live-direct", modelConfidence: "high", ...expected,
      });
    },
  );

  it("falls back to ratio when reserve-sync has no immediate capacity data", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        routeFamily: "queue-redeem",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.15 },
        costModel: { kind: "dynamic-or-unclear" },
      }),
      50_000_000,
      null,
      { reserveSnapshotMetadata: null },
    );

    expect(entry.sourceMode).toBe("estimated");
    expect(entry.resolutionState).toBe("resolved");
    expect(entry.immediateCapacityUsd).toBe(7_500_000); // 50M * 0.15
    expect(entry.provider).toBe("reserve-sync-fallback");
    expect(entry.capacityConfidence).toBe("heuristic");
    expect(entry.capacityBasis).toBe("strategy-buffer");
  });

  it("uses reviewed fallback confidence and basis for reserve-sync fallback ratios", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        capacityModel: {
          kind: "reserve-sync-metadata",
          fallbackRatio: 0.0025,
          confidence: "documented-bound",
          basis: "hot-buffer",
        },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed route" },
        reviewedAt: "2026-04-04",
        docs: [{ label: "Reviewed source", url: "https://example.com" }],
      }),
      100_000_000,
      null,
      { reserveSnapshotMetadata: null },
    );

    expect(entry.provider).toBe("reserve-sync-fallback");
    expect(entry.sourceMode).toBe("estimated");
    expect(entry.capacityConfidence).toBe("documented-bound");
    expect(entry.capacityBasis).toBe("hot-buffer");
    expect(entry.immediateCapacityUsd).toBe(250_000);
  });

  it("returns missing-capacity when reserve-sync has no data and no fallback", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        routeFamily: "queue-redeem",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "dynamic-or-unclear" },
      }),
      50_000_000,
      null,
      { reserveSnapshotMetadata: null },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.score).toBeNull();
  });

  it("explains missing capacity when a capable live adapter omits capacity amounts", async () => {
    const entry = await buildEntry(
      "zchf-frankencoin",
      route({
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 0 },
      }),
      50_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("zchf-frankencoin", {
          freshnessMode: "unverified",
          details: {
            freshnessSource: "position-and-price-apis",
            freshnessReason: "Collateral positions and price payloads do not expose a trustworthy source timestamp",
          },
        }, {
          fetchedAt: now - 120,
          source: "collateral-positions-api",
        }),
      },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.capacityRejectionReason).toBe("invalid-freshness");
  });

  it("does not emit an effective-exit score when the redemption route is unresolved", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        routeFamily: "queue-redeem",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "dynamic-or-unclear" },
      }),
      50_000_000,
      55,
      { reserveSnapshotMetadata: null },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.score).toBeNull();
  });

  it("preserves reviewed fee and docs metadata on failed reserve-sync routes", () => {
    const entry = buildFailedRedemptionBackstopEntry(
      "test-coin",
      route({
        routeFamily: "queue-redeem",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata", confidence: "documented-bound" },
        costModel: {
          kind: "fee-bps",
          feeBps: 25,
          feeDescription: "Reviewed fallback fee is 25 bps",
        },
        docs: [{ label: "Reviewed route docs", url: "https://example.com/route", supports: ["route", "fees"] }],
      }),
      now,
    );

    expect(entry.resolutionState).toBe("failed");
    expect(entry.score).toBeNull();
    expect(entry.capacityConfidence).toBe("heuristic");
    expect(entry.feeConfidence).toBe("fixed");
    expect(entry.feeBps).toBe(25);
    expect(entry.feeDescription).toBe("Reviewed fallback fee is 25 bps");
    expect(entry.docs).toMatchObject({
      label: "Reviewed route docs",
      url: "https://example.com/route",
      provenance: "config-reviewed",
    });
    expect(entry.docs?.sources?.[0]?.supports).toEqual(["route", "fees"]);
  });

  it("does not add current-exit uplift for eventual-only redemption", async () => {
    const entry = await buildEntry("test-coin", route({
      capacityModel: { kind: "supply-full" },
      costModel: { kind: "fee-bps", feeBps: 0 },
    }), 500_000_000, 40);
    expect(entry.score).toBeNull();
    expect(entry.eventualRedeemabilityScore).not.toBeNull();
  });

  it("marks static redemption routes impaired during severe active depegs", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound" },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed route" },
      }),
      100_000_000,
      33,
      {
        routeAvailability: severeMarketEvidence({
          routeStatusReason:
            "Active severe depeg of 8332 bps started 2026-03-22; static redemption route requires current live-open evidence before it can score.",
          routeStatusReviewedAt: "2026-04-14",
          activeDepegBps: 8332,
          activeDepegStartedAt: 1_774_145_097,
        }),
      },
    );

    expect(entry.resolutionState).toBe("impaired");
    expect(entry.score).toBeNull();
    expect(entry.routeStatus).toBe("degraded");
    expect(entry.routeStatusSource).toBe("market-implied");
    expect(entry.routeStatusReviewedAt).toBe("2026-04-14");
    expect(entry.modelConfidence).toBe("low");
    expect(entry.capsApplied).toContain("market-implied-depeg-impairment");
    expect(entry.notes).toContain(
      "Active severe depeg of 8332 bps started 2026-03-22; static redemption route requires current live-open evidence before it can score.",
    );
  });

  it("withholds the score when an open incident lacks current authoritative evidence", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound" },
        costModel: { kind: "dynamic-or-unclear", feeDescription: "Reviewed route" },
      }),
      100_000_000,
      33,
      {
        routeAvailability: severeMarketEvidence({
          routeStatus: "unknown",
          routeStatusReason:
            "Open downside incident, but no authoritative current deviation within 1800 seconds establishes present route availability; redemption score withheld.",
          activeDepegBps: undefined,
        }),
      },
    );

    expect(entry.resolutionState).toBe("impaired");
    expect(entry.score).toBeNull();
    expect(entry.routeStatus).toBe("unknown");
    expect(entry.routeStatusSource).toBe("market-implied");
    expect(entry.modelConfidence).toBe("low");
    expect(entry.capsApplied).toContain("market-implied-depeg-evidence-uncertain");
  });

  it("does not let live-direct capacity bypass uncertainty without explicit live-open status", async () => {
    const entry = await buildEntry(
      "zchf-frankencoin",
      route({
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 0 },
      }),
      50_000_000,
      33,
      {
        reserveSnapshotMetadata: liveSnapshot("zchf-frankencoin", {
          sourceTimestamp: now - 120,
          redemption: {
            capacityUsd: 5_000_000,
            capacityRatioOfSupply: 0.1,
            capacityKind: "live-direct",
            freshnessKind: "same-run-onchain",
            sourceTimestamp: now - 120,
          },
        }, { fetchedAt: now - 120 }),
        routeAvailability: severeMarketEvidence({
          routeStatus: "unknown",
          activeDepegBps: undefined,
        }),
      },
    );

    expect(entry.resolutionState).toBe("impaired");
    expect(entry.routeStatus).toBe("unknown");
    expect(entry.score).toBeNull();
  });

  it("keeps strong live-direct routes scoreable during severe active depegs", async () => {
    const entry = await buildEntry(
      "zchf-frankencoin",
      route({
        capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.1 },
        costModel: { kind: "fee-bps", feeBps: 0 },
      }),
      50_000_000,
      33,
      {
        reserveSnapshotMetadata: liveSnapshot("zchf-frankencoin", {
          sourceTimestamp: now - 120,
          redemption: {
            capacityUsd: 5_000_000,
            capacityRatioOfSupply: 0.1,
            capacityKind: "live-direct",
            freshnessKind: "same-run-onchain",
            sourceTimestamp: now - 120,
            routeStatus: "open",
            routeStatusSource: "onchain",
          },
        }, { fetchedAt: now - 120 }),
        routeAvailability: severeMarketEvidence({
          routeStatusReason:
            "Active severe depeg of 3000 bps started 2026-04-14; static redemption route requires current live-open evidence before it can score.",
          routeStatusReviewedAt: "2026-04-14",
          activeDepegStartedAt: now,
        }),
      },
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.score).not.toBeNull();
    expect(entry.routeStatus).toBe("open");
    expect(entry.routeStatusSource).toBe("onchain");
    expect(entry.modelConfidence).toBe("high");
    expect(entry.capsApplied).not.toContain("market-implied-depeg-impairment");
  });

  it("evaluates the severe-depeg exemption against the final downgraded capacity state", async () => {
    // Same direct-telemetry adapter and severe depeg as the strong live-direct
    // exemption test above, but the live snapshot is stale, so capacity
    // resolution downgrades the route to the configured heuristic fallback.
    // The exemption must be asserted against that FINAL state and not the
    // optimistic live-direct configuration, so the route is impaired.
    const entry = await buildEntry(
      "zchf-frankencoin",
      route({
        capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.1 },
        costModel: { kind: "fee-bps", feeBps: 0 },
      }),
      50_000_000,
      33,
      {
        reserveSnapshotMetadata: liveSnapshot("zchf-frankencoin", {
          sourceTimestamp: now - 7_200,
          redemption: {
            capacityUsd: 5_000_000,
            capacityRatioOfSupply: 0.1,
            capacityKind: "live-direct",
            freshnessKind: "same-run-onchain",
            sourceTimestamp: now - 7_200,
            routeStatus: "open",
            routeStatusSource: "onchain",
          },
        }, { fetchedAt: now - 7_200 }),
        routeAvailability: severeMarketEvidence({
          routeStatusReason:
            "Active severe depeg of 3000 bps started 2026-04-14; static redemption route requires current live-open evidence before it can score.",
          routeStatusReviewedAt: "2026-04-14",
          activeDepegStartedAt: now,
        }),
      },
    );

    // Capacity resolution downgraded the live-direct route to the fallback
    expect(entry.provider).toBe("reserve-sync-fallback");
    expect(entry.sourceMode).toBe("estimated");
    expect(entry.capacityConfidence).toBe("heuristic");
    // ...so the strong live-direct severe-depeg exemption does not apply
    expect(entry.resolutionState).toBe("impaired");
    expect(entry.score).toBeNull();
    expect(entry.routeStatus).toBe("degraded");
    expect(entry.routeStatusSource).toBe("market-implied");
    expect(entry.modelConfidence).toBe("low");
    expect(entry.capsApplied).toContain("market-implied-depeg-impairment");
  });

  it("derives modelConfidence correctly for resolved entries", async () => {
    // Dynamic capacity + fixed fee → high
    const highEntry = await buildEntry(
      "lusd-liquity",
      route({
        routeFamily: "queue-redeem",
        settlementModel: "queued",
        executionModel: "rules-based-nav",
        capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.15 },
        costModel: { kind: "fee-bps", feeBps: 0 },
      }),
      50_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("lusd-liquity", {
          redemption: {
            capacityUsd: 5_000_000,
            capacityRatioOfSupply: 0.1,
          },
          sourceTimestamp: now - 100,
          freshnessMode: "verified",
        }, { fetchedAt: now - 100 }),
      },
    );
    expect(highEntry.modelConfidence).toBe("high");

    // Documented eventual redeemability + reviewed formula fee -> medium
    const mediumEntry = await buildEntry("test-coin", route({
      routeFamily: "collateral-redeem",
      outputAssetType: "bluechip-collateral",
      capacityModel: { kind: "supply-full", confidence: "documented-bound" },
      costModel: {
        kind: "dynamic-or-unclear",
        feeDescription: "Minimum 50 bps + baseRate",
        confidence: "formula",
      },
    }), 100_000_000, null);
    expect(mediumEntry.modelConfidence).toBe("medium");
    expect(mediumEntry.capacitySemantics).toBe("eventual-only");

    // Supply-full (heuristic capacity) → low
    const lowEntry = await buildEntry("test-coin", route({
      routeFamily: "offchain-issuer",
      accessModel: "issuer-api",
      settlementModel: "same-day",
      executionModel: "rules-based-nav",
      capacityModel: { kind: "supply-full" },
      costModel: { kind: "dynamic-or-unclear" },
    }), 100_000_000, null);
    expect(lowEntry.modelConfidence).toBe("low");
  });

  it("stops using stale reserve capacity metadata when no safe fallback exists", async () => {
    const entry = await buildEntry(
      "gho-aave",
      route({
        routeFamily: "psm-swap",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 10 },
      }),
      50_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("test-coin", {
          redemption: {
            capacityUsd: 10_000_000,
            capacityRatioOfSupply: 0.2,
          },
        }, { fetchedAt: now - 7_200 }),
      },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.score).toBeNull();
    expect(entry.capacityRejectionReason).toBe("stale");
  });

  it("keeps GHO resolved when the only live warning is aggregated residual issuance", async () => {
    const entry = await buildEntry(
      "gho-aave",
      route({
        routeFamily: "psm-swap",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 10 },
      }),
      584_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("gho-aave", {
          redemption: {
            capacityUsd: 212_370_000,
            capacityRatioOfSupply: 212_370_000 / 584_000_000,
            feeBps: 10,
          },
          freshnessMode: "not-applicable",
        }, {
          fetchedAt: now - 120,
          source: "gho",
          warningCount: 1,
          warnings: [
            {
              code: "aggregated-residual-issuance",
              message: "Residual GHO issuance outside tracked GSM backing remains aggregated (63.63%)",
              severity: "warning",
              effect: "degraded",
            },
          ],
          syncStatus: "degraded",
        }),
      },
    );

    expect(entry.resolutionState).toBe("resolved");
    expect(entry.provider).toBe("reserve-sync-metadata");
    expect(entry.capacityConfidence).toBe("live-direct");
    expect(entry.immediateCapacityUsd).toBe(212_370_000);
    expect(entry.notes).toContain(
      "Using tracked live GSM backing as a lower-bound redemption capacity despite aggregated residual issuance outside configured GSM modules",
    );
  });

  it("still blocks GHO when degraded live metadata includes non-allowlisted warnings", async () => {
    const entry = await buildEntry(
      "gho-aave",
      route({
        routeFamily: "psm-swap",
        capacityModel: { kind: "reserve-sync-metadata" },
        costModel: { kind: "fee-bps", feeBps: 10 },
      }),
      584_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("gho-aave", {
          redemption: {
            capacityUsd: 212_370_000,
            capacityRatioOfSupply: 212_370_000 / 584_000_000,
          },
          freshnessMode: "not-applicable",
        }, {
          fetchedAt: now - 120,
          source: "gho",
          warningCount: 2,
          warnings: [
            {
              code: "aggregated-residual-issuance",
              message: "Residual GHO issuance outside tracked GSM backing remains aggregated (63.63%)",
              severity: "warning",
              effect: "degraded",
            },
            {
              code: "tracked-gsm-read-failed",
              message: "Tracked GSM module could not be read",
              severity: "warning",
              effect: "degraded",
            },
          ],
          syncStatus: "degraded",
        }),
      },
    );

    expect(entry.resolutionState).toBe("missing-capacity");
    expect(entry.notes).toContain("Live reserve metadata degraded; latest snapshot not in ok state");
  });

  it("uses fresh live redemption fee telemetry for fixed-fee routes", async () => {
    const entry = await buildEntry(
      "test-coin",
      route({
        routeFamily: "psm-swap",
        capacityModel: { kind: "supply-full", confidence: "documented-bound" },
        costModel: {
          kind: "fee-bps",
          feeBps: 10,
          feeDescription: "Reviewed fallback bound is 10 bps",
        },
      }),
      50_000_000,
      null,
      {
        reserveSnapshotMetadata: liveSnapshot("gho-aave", {
          redemption: { feeBps: 7 },
          sourceTimestamp: now - 120,
        }, { fetchedAt: now - 120 }),
      },
    );

    expect(entry.feeBps).toBe(7);
    expect(entry.costScore).toBe(100);
    expect(entry.feeDescription).toBe("Fresh live redemption fee telemetry: 7 bps.");
    expect(entry.notes).toContain("Using fresh live redemption fee telemetry in place of the reviewed fallback bound");
  });

  it("populates docs from proofOfReserves when available", async () => {
    const meta = TRACKED_META_BY_ID.get("usdt-tether");
    expect(meta?.proofOfReserves?.url).toBeTruthy();

    const entry = await buildEntry("usdt-tether", route({
      accessModel: "issuer-api",
      settlementModel: "same-day",
      executionModel: "rules-based-nav",
      capacityModel: { kind: "supply-full" },
      costModel: { kind: "fee-bps", feeBps: 0 },
      docs: [],
    }), 100_000_000, null);

    expect(entry.docs).toBeDefined();
    expect(entry.docs!.url).toBe(meta!.proofOfReserves!.url);
    expect(entry.docs!.label).toContain("feed");
    expect(entry.docs!.provenance).toBe("proof-of-reserves");
  });

  it("falls back to preferred link labels when no proofOfReserves", async () => {
    const meta = TRACKED_META_BY_ID.get("usds-sky");
    expect(meta?.proofOfReserves?.url).toBeFalsy();
    const preferredLabels = ["Docs", "Proof of Reserve", "Transparency", "Website"];
    const hasPreferred = meta?.links?.some((l) => preferredLabels.includes(l.label));
    expect(hasPreferred).toBe(true);

    const entry = await buildEntry("usds-sky", route({
      routeFamily: "psm-swap",
      capacityModel: { kind: "supply-full" },
      costModel: { kind: "fee-bps", feeBps: 0 },
      docs: [],
    }), 1_000_000_000, null);

    expect(entry.docs).toBeDefined();
    expect(preferredLabels).toContain(entry.docs!.label);
    expect(entry.docs!.provenance).toBe("preferred-link");
  });

  it("rejects docs resolution for unknown coins", async () => {
    await expect(buildEntry("test-coin", route({
      capacityModel: { kind: "supply-full" },
      costModel: { kind: "fee-bps", feeBps: 0 },
      docs: [],
    }), 100_000_000, null)).rejects.toThrow(/Unknown tracked stablecoin id "test-coin"/);
  });

  it("deduplicates notes both within config and across config + runtime sources", async () => {
    const runtimeNote = "Live reserve metadata unavailable; using configured fallback ratio";
    const entry = await buildEntry(
      "usds-sky",
      route({
        capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.1 },
        costModel: { kind: "fee-bps", feeBps: 0 },
        notes: ["Shared note", "Shared note", runtimeNote],
      }),
      1_000_000,
      50,
      { reserveSnapshotMetadata: null },
    );
    const notes = entry.notes ?? [];
    expect(notes.filter((n) => n === "Shared note").length).toBe(1);
    expect(notes.filter((n) => n === runtimeNote).length).toBe(1);
  });

  it("adds the accepted FPI controller route without changing legacy entry fields", async () => {
    const config = getRedemptionBackstopConfig("fpi-frax");
    expect(config).toBeDefined();
    const state = fpiControllerState(now, 20);
    const reserveSnapshot = (v9RouteAttempt?: Record<string, unknown>) => ({
      stablecoinId: "fpi-frax",
      fetchedAt: now - 30,
      source: "frax-fpi-collateral",
      metadata: {
        freshnessMode: "verified" as const,
        sourceTimestamp: now - 30,
        redemption: {
          capacityUsd: 2_000_000,
          capacityKind: "live-proxy-validated" as const,
          freshnessKind: "verified-source-timestamp" as const,
          sourceTimestamp: now - 30,
          routeStatus: "open" as const,
          routeStatusSource: "protocol-api" as const,
          sourceUrls: ["https://frax.com/transparency"],
          ...(v9RouteAttempt ? { v9RouteAttempt } : {}),
        },
      },
      warningCount: 0,
      warnings: [],
      sourceModel: "dynamic-mix" as const,
      evidenceClass: "independent" as const,
      syncStatus: "ok" as const,
    });
    const baseline = await buildEntry(
      "fpi-frax",
      config!,
      10_000_000,
      null,
      { reserveSnapshotMetadata: reserveSnapshot() },
    );
    const accepted = await buildEntry(
      "fpi-frax",
      config!,
      10_000_000,
      null,
      {
        reserveSnapshotMetadata: reserveSnapshot({
          status: "accepted",
          attemptedAtSec: now,
          state,
        }),
      },
    );
    const rejected = await buildEntry(
      "fpi-frax",
      config!,
      10_000_000,
      null,
      {
        reserveSnapshotMetadata: reserveSnapshot({
          status: "rejected",
          attemptedAtSec: now,
          rejectionCode: "calculation-mismatch",
          blockNumber: 25_600_682,
        }),
      },
    );

    const acceptedRoute = accepted.capacityProfile?.exitRouteObservations?.[0];
    expect(acceptedRoute).toMatchObject({
      routeId: "redemption:fpi-frax:fpi-controller:ethereum",
      scope: { kind: "chain-contract", contractOrPoolId: state.controllerAddress },
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["frax-frax"] },
      evidenceKind: "onchain-contract-state",
      scoreEligible: true,
      executableUsd: 500_000,
      completionRatio: 1,
    });
    expect(rejected.capacityProfile?.exitRouteObservations?.[0]).toMatchObject({
      routeId: "redemption:fpi-frax:collateral-redeem",
      scoreEligible: false,
    });

    const acceptedLegacy = structuredClone(accepted);
    const baselineLegacy = structuredClone(baseline);
    delete acceptedLegacy.capacityProfile?.exitRouteObservations;
    delete baselineLegacy.capacityProfile?.exitRouteObservations;
    expect(acceptedLegacy).toEqual(baselineLegacy);
  });
});
