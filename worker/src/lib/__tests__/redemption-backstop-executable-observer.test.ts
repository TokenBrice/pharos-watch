import { describe, expect, it } from "vitest";
import { mockD1Strict } from "@shared/test-utils/mock-d1";
import { getRedemptionBackstopConfig, type RedemptionCapacityModel } from "@shared/lib/redemption-backstops";
import type { ExecutableRedemptionObservation } from "../../cron/reserve-adapters/executable-redemption-observers";
import type { CapacityResolverContext } from "../redemption-backstop-capacity/profile";
import { resolveExecutableObserverCapacity } from "../redemption-backstop-capacity/executable-observer";
import { EXECUTABLE_REDEMPTION_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/redemption-backstop-capacity";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "@shared/lib/live-reserve-freshness";
import { STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { RedemptionCapacityRejectionReasonSchema } from "@shared/types/redemption";

const now = 1_791_155_000;
const measuredModel = {
  kind: "executable-observer", observerId: "usdfr-par-controller", capacityUse: "measured",
  requiredOutputAssetKeys: ["usdc-circle"],
} satisfies Extract<RedemptionCapacityModel, { kind: "executable-observer" }>;
const observation: ExecutableRedemptionObservation = {
  capacityRaw: 500_000_000n, capacitySource: "forest-road-controller", capacityState: "measured",
  outputAssetKeys: ["usdc-circle"], underlyingDecimals: 6, capacityKind: "live-direct-bounded",
  freshnessKind: "same-run-onchain", routeStatus: "open", routeStatusSource: "onchain",
  routeStatusReason: "Pinned controller route", holderEligibility: "any-holder", feeBps: 0,
  allInFeeBps: 1, settlementDelaySec: 0, blockNumber: 26_143_056,
  sourceTimestamp: now, sourceUrls: ["https://www.usdfr.com/"], diagnostics: {},
};
function context(overrides: Partial<ExecutableRedemptionObservation> = {}): CapacityResolverContext {
  return { db: mockD1Strict([]), stablecoinId: "usdfr-forest-road", supplyUsd: 1_000, now,
    options: { executableRedemptionObservation: { ...observation, ...overrides },
      executableObserverValuation: { outputAssetKey: "usdc-circle", priceUsd: 0.98, observedAt: now } } };
}

describe("standalone executable observer capacity admission", () => {
  it("never borrows decoy reserve capacity or supply when the registered direct observer is absent", () => {
    const model = getRedemptionBackstopConfig("usdfr-forest-road")!.capacityModel;
    if (model.kind !== "executable-observer") throw new Error("Expected direct observer configuration");
    const input = context();
    input.options.executableRedemptionObservation = null;
    input.options.reserveSnapshotMetadata = {
      metadata: { redemption: { capacityUsd: 9_000_000 } },
    } as CapacityResolverContext["options"]["reserveSnapshotMetadata"];
    expect(resolveExecutableObserverCapacity(model, input)).toMatchObject({
      immediateCapacityUsd: null, scoringCapacityUsd: null, eventualCapacityUsd: null,
    });
  });
  it("keeps APY's funded receipt bound queued rather than immediate same-notional capacity", () => {
    const model = getRedemptionBackstopConfig("apyusd-apyx")!.capacityModel;
    if (model.kind !== "executable-observer") throw new Error("Expected direct observer configuration");
    const input = context({ outputAssetKeys: ["apxusd-apyx"], settlementDelaySec: 20 * 86400 });
    input.stablecoinId = "apyusd-apyx";
    input.options.executableObserverValuation = { outputAssetKey: "apxusd-apyx", priceUsd: 0.98, observedAt: now };
    expect(resolveExecutableObserverCapacity(model, input)).toMatchObject({
      immediateCapacityUsd: null, scoringCapacityUsd: null, eventualCapacityUsd: 490,
      capacityConfidence: "documented-bound", capacitySemantics: "eventual-only",
      capacityProfile: { scoringHorizon: "queued", scoringUsd: null, eventualUsd: 490 },
    });
    input.options.executableObserverValuation = null;
    expect(resolveExecutableObserverCapacity(model, input).eventualCapacityUsd).toBeNull();
    input.options.executableObserverValuation = { outputAssetKey: "apxusd-apyx", priceUsd: 0.98, observedAt: now };
    input.options.executableRedemptionObservation = { ...input.options.executableRedemptionObservation!, allInFeeBps: null };
    expect(resolveExecutableObserverCapacity(model, input).eventualCapacityUsd).toBeNull();
  });
  it("values exact native output at the admitted generation price and clamps only after admission", () => {
    const admitted = resolveExecutableObserverCapacity(measuredModel, context());
    expect(admitted).toMatchObject({ immediateCapacityUsd: 490, immediateCapacityRatio: 0.49,
      scoringCapacityUsd: 490, capacityConfidence: "live-direct", sourceMode: "dynamic", provider: "executable-observer" });
    const capped = context(); capped.supplyUsd = 100;
    expect(resolveExecutableObserverCapacity(measuredModel, capped).immediateCapacityUsd).toBe(100);
  });
  it("distinguishes a measured zero from a placeholder zero", () => {
    expect(resolveExecutableObserverCapacity(measuredModel, context({ capacityRaw: 0n })).scoringCapacityUsd).toBe(0);
    expect(resolveExecutableObserverCapacity(measuredModel, context({ capacityRaw: 0n, capacityState: "unquantified" })).scoringCapacityUsd).toBeNull();
    expect(resolveExecutableObserverCapacity(measuredModel, context({ capacityRaw: 0n, capacityState: "closed", routeStatus: "paused" })).scoringCapacityUsd).toBe(0);
  });
  it("never values diagnostic Lido liquidity even if a producer reports positive raw amounts", () => {
    const diagnostic = { ...measuredModel, observerId: "lido-earnusd-queue", capacityUse: "diagnostic-only" } as const;
    const input = context({ settlementBoundUnproven: true }); input.stablecoinId = "earnusd-lido";
    const result = resolveExecutableObserverCapacity(diagnostic, input);
    expect(result).toMatchObject({ immediateCapacityUsd: null, scoringCapacityUsd: null, eventualCapacityUsd: null,
      capacityConfidence: "heuristic", settlementBoundUnproven: true, routeStatus: "open" });
  });
  it.each([
    { outputAssetKeys: ["usdt-tether"] },
    { sourceTimestamp: now - EXECUTABLE_REDEMPTION_OBSERVATION_MAX_AGE_SEC - 1 },
    { sourceTimestamp: now + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC + 1 },
    { blockNumber: 0 }, { underlyingDecimals: 37 }, { capacityRaw: -1n },
    { feeBps: null, allInFeeBps: null }, { feeBps: 0, allInFeeBps: null },
    { settlementDelaySec: undefined }, { settlementBoundUnproven: true },
  ] satisfies Partial<ExecutableRedemptionObservation>[]) ("withholds unavailable or inadmissible evidence %#", (overrides) => {
    expect(resolveExecutableObserverCapacity(measuredModel, context(overrides)).scoringCapacityUsd).toBeNull();
  });
  it.each([
    { outputAssetKey: "usdt-tether", priceUsd: 1, observedAt: now },
    { outputAssetKey: "usdc-circle", priceUsd: 1, observedAt: now - STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC - 1 },
    { outputAssetKey: "usdc-circle", priceUsd: 1, observedAt: now + 1 },
    { outputAssetKey: "usdc-circle", priceUsd: 1, observedAt: 0 },
    { outputAssetKey: "usdc-circle", priceUsd: 1, observedAt: now - 0.5 },
    { outputAssetKey: "usdc-circle", priceUsd: 1, observedAt: Number.NaN },
    { outputAssetKey: "usdc-circle", priceUsd: 0, observedAt: now },
    { outputAssetKey: "usdc-circle", priceUsd: Number.NaN, observedAt: now },
    null,
  ])("withholds mismatched, stale or absent output valuation %#", (valuation) => {
    const input = context(); input.options.executableObserverValuation = valuation;
    expect(resolveExecutableObserverCapacity(measuredModel, input)).toMatchObject({
      scoringCapacityUsd: null, capacityRejectionReason: "output-valuation-unobserved",
      notes: ["output-valuation-unobserved"],
    });
  });
  it.each([null, undefined, Number.NaN, -1, 10_001])("names unavailable all-in execution cost independently (%s)", (allInFeeBps) => {
    expect(RedemptionCapacityRejectionReasonSchema.parse("all-in-cost-unobserved")).toBe("all-in-cost-unobserved");
    expect(resolveExecutableObserverCapacity(measuredModel, context({ allInFeeBps }))).toMatchObject({
      immediateCapacityUsd: null, eventualCapacityUsd: null, scoringCapacityUsd: null,
      capacityRejectionReason: "all-in-cost-unobserved", notes: ["all-in-cost-unobserved"],
    });
  });
  it.each([now, now - 1, now - STABLECOINS_GENERATION_CONSUMER_MAX_AGE_SEC])(
    "admits fresh positive cached-generation clocks without relabelling them as the run clock (%s)", (observedAt) => {
      const input = context();
      input.options.executableObserverValuation = { outputAssetKey: "usdc-circle", priceUsd: 0.98, observedAt };
      expect(resolveExecutableObserverCapacity(measuredModel, input).scoringCapacityUsd).toBe(490);
    },
  );
  it.each([
    now - EXECUTABLE_REDEMPTION_OBSERVATION_MAX_AGE_SEC,
    now + MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC,
  ])("uses shared source-age and source-skew boundaries (%s)", (sourceTimestamp) => {
    expect(resolveExecutableObserverCapacity(measuredModel, context({ sourceTimestamp })).scoringCapacityUsd).toBe(490);
  });
});
