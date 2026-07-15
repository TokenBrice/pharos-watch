import { describe, expect, it } from "vitest";
import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import type { RedemptionBackstopEntry, RedemptionCapacityProfile } from "@shared/types/redemption";
import {
  buildRedemptionExitRouteObservation,
  deriveSupplyModelExitRouteObservation,
} from "../redemption-exit-route-observations";

const config: RedemptionBackstopConfig = {
  routeFamily: "offchain-issuer",
  accessModel: "issuer-api",
  settlementModel: "immediate",
  executionModel: "rules-based-nav",
  outputAssetType: "nav",
  capacityModel: { kind: "fixed-usd", amountUsd: 10_000_000, confidence: "documented-bound" },
  costModel: { kind: "fee-bps", feeBps: 25 },
  docs: [{ label: "Terms", url: "https://example.com/terms", supports: ["capacity", "fees", "settlement"] }],
  reviewedAt: "2026-07-01",
};

const profile: RedemptionCapacityProfile = {
  scoringUsd: 10_000_000,
  scoringHorizon: "immediate",
  capacityProfileConfidence: "documented-bound",
  modeledExitSizeUsd: 5_000_000,
};

function build(overrides: Partial<Parameters<typeof buildRedemptionExitRouteObservation>[0]> = {}) {
  return buildRedemptionExitRouteObservation({
    stablecoinId: "usdc-circle",
    config,
    capacityProfile: profile,
    scoringCapacityUsd: 10_000_000,
    supplyUsd: 100_000_000,
    routeStatus: "open",
    resolutionState: "resolved",
    sourceMode: "static",
    capacityConfidence: "documented-bound",
    resolvedFeeBps: 25,
    now: Date.UTC(2026, 6, 13) / 1_000,
    ...overrides,
  });
}

describe("redemption same-notional route observations", () => {
  it("publishes a reviewed immediate route at the common request", () => {
    const observation = build();
    expect(observation).toMatchObject({
      routeId: "redemption:usdc-circle:offchain-issuer",
      routeFamily: "issuer-redemption",
      requestedNotionalUsd: 5_000_000,
      settlementHorizonSec: 300,
      maxCostBps: 200,
      executableUsd: 5_000_000,
      completionRatio: 1,
      output: { kind: "fiat", currency: "USD" },
      evidenceKind: "documented-terms",
      confidence: "medium",
      scoreEligible: true,
    });
    expect(observation?.capacityCurve?.map((point) => point.requestedNotionalUsd)).toEqual([
      100_000, 1_000_000, 5_000_000, 25_000_000,
    ]);
    expect(observation?.capacityCurve?.map((point) => point.executableUsd)).toEqual([
      100_000, 1_000_000, 5_000_000, 10_000_000,
    ]);
  });

  it("retains delayed and over-cost observations without making them score eligible", () => {
    const delayed = build({
      config: { ...config, settlementModel: "same-day" },
      capacityProfile: { ...profile, scoringHorizon: "daily" },
    });
    expect(delayed?.scoreEligible).toBe(false);

    const expensive = build({
      config: { ...config, costModel: { kind: "fee-bps", feeBps: 250 } },
      resolvedFeeBps: 250,
    });
    expect(expensive).toMatchObject({ scoreEligible: false, executableUsd: 0, completionRatio: 0 });
  });

  it("uses fresh direct telemetry as high-confidence route evidence", () => {
    const observedAt = Date.UTC(2026, 6, 13, 10) / 1_000;
    const observation = build({
      sourceMode: "dynamic",
      capacityConfidence: "live-direct",
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      sourceTimestamp: observedAt,
      now: observedAt + 60,
    });
    expect(observation).toMatchObject({
      evidenceKind: "onchain-contract-state",
      confidence: "high",
      observedAt,
      freshnessSeconds: 60,
      scoreEligible: true,
    });
  });

  it("returns no observation when the immediate capacity request is undefined", () => {
    expect(build({ capacityProfile: undefined })).toBeNull();
    expect(build({ scoringCapacityUsd: null })).toBeNull();
  });
});

const supplyFullEntry: RedemptionBackstopEntry = {
  stablecoinId: "usdc-circle",
  score: null,
  effectiveExitScore: null,
  dexLiquidityScore: null,
  accessScore: 40,
  settlementScore: 65,
  executionCertaintyScore: 60,
  capacityScore: null,
  outputAssetQualityScore: 100,
  costScore: 40,
  routeFamily: "offchain-issuer",
  accessModel: "issuer-api",
  settlementModel: "atomic",
  executionModel: "rules-based-nav",
  outputAssetType: "stable-single",
  provider: "supply-full-model",
  sourceMode: "estimated",
  resolutionState: "resolved",
  routeStatus: "open",
  routeStatusSource: "static-config",
  holderEligibility: "verified-customer",
  capacityConfidence: "documented-bound",
  capacitySemantics: "eventual-only",
  capacityProfile: {
    immediateUsd: null,
    eventualUsd: 100_000_000,
    scoringUsd: null,
    scoringHorizon: "eventual",
    capacityProfileConfidence: "documented-bound",
    modeledExitSizeUsd: 5_000_000,
  },
  feeConfidence: "fixed",
  feeModelKind: "fixed-bps",
  modelConfidence: "medium",
  immediateCapacityUsd: null,
  immediateCapacityRatio: null,
  feeBps: 10,
  queueEnabled: false,
  methodologyVersion: "4.18",
  updatedAt: Date.UTC(2026, 6, 13) / 1_000,
  docs: { label: "Terms", url: "https://example.com/terms", reviewedAt: "2026-07-01" },
};

describe("derived supply-model route observations", () => {
  const now = Date.UTC(2026, 6, 13) / 1_000;

  it("projects an atomic full-supply row onto the same-notional request", () => {
    const observation = deriveSupplyModelExitRouteObservation(supplyFullEntry, now);
    expect(observation).toMatchObject({
      routeId: "redemption:usdc-circle:offchain-issuer",
      routeFamily: "issuer-redemption",
      requestedNotionalUsd: 5_000_000,
      settlementHorizonSec: 300,
      maxCostBps: 200,
      executableUsd: 5_000_000,
      completionRatio: 1,
      evidenceKind: "documented-terms",
      confidence: "medium",
      scoreEligible: true,
      observedAt: Date.parse("2026-07-01T00:00:00.000Z") / 1_000,
    });
  });

  it("publishes slower settlement models as diagnostic eventual redemption evidence", () => {
    for (const settlementModel of ["immediate", "same-day", "days", "queued"] as const) {
      const observation = deriveSupplyModelExitRouteObservation({ ...supplyFullEntry, settlementModel }, now);
      expect(observation).toMatchObject({ routeFamily: "eventual-redemption", scoreEligible: false });
      expect(observation!.settlementHorizonSec).toBeGreaterThan(300);
    }
  });

  it("carries a zero executable bound when the published fee model states no fixed bound", () => {
    const undisclosed = deriveSupplyModelExitRouteObservation(
      { ...supplyFullEntry, feeModelKind: "documented-variable", feeBps: null },
      now,
    );
    expect(undisclosed).toMatchObject({ scoreEligible: false, executableUsd: 0, completionRatio: 0 });
    const overCost = deriveSupplyModelExitRouteObservation({ ...supplyFullEntry, feeBps: 250 }, now);
    expect(overCost).toMatchObject({ scoreEligible: false, executableUsd: 0 });
  });

  it("resolves derived outputs from the reviewed static config's outputAssets", () => {
    // dai-makerdao's psm-swap config documents the LitePSM DAI <-> USDC leg.
    const daiEntry: RedemptionBackstopEntry = {
      ...supplyFullEntry,
      stablecoinId: "dai-makerdao",
      routeFamily: "psm-swap",
      accessModel: "permissionless-onchain",
      executionModel: "deterministic-onchain",
      outputAssetType: "stable-single",
    };
    const observation = deriveSupplyModelExitRouteObservation(daiEntry, now);
    expect(observation?.output).toEqual({ kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] });

    // bold-liquity's collateral-redeem config names the Liquity V2 branches.
    const boldEntry: RedemptionBackstopEntry = {
      ...daiEntry,
      stablecoinId: "bold-liquity",
      routeFamily: "collateral-redeem",
      outputAssetType: "bluechip-collateral",
    };
    const boldObservation = deriveSupplyModelExitRouteObservation(boldEntry, now);
    expect(boldObservation?.output).toEqual({
      kind: "collateral",
      assetKeys: ["asset:weth", "asset:wsteth", "asset:reth"],
    });

    const buckEntry: RedemptionBackstopEntry = {
      ...daiEntry,
      stablecoinId: "buck-bucket-protocol",
      outputAssetType: "stable-basket",
    };
    expect(deriveSupplyModelExitRouteObservation(buckEntry, now)?.output).toEqual({
      kind: "tracked-stablecoin",
      trackedAssetIds: ["usdc-circle", "usdt-tether"],
    });

    const aidEntry: RedemptionBackstopEntry = {
      ...daiEntry,
      stablecoinId: "aid-gaib",
    };
    expect(deriveSupplyModelExitRouteObservation(aidEntry, now)?.output).toEqual({
      kind: "tracked-stablecoin",
      trackedAssetIds: ["usdc-circle"],
    });

    // An asset without configured outputAssets keeps the honest unresolved kind.
    // (usn-noon gained outputAssets in the 2026-07-15 redemption curation batch;
    // usr-resolv has neither outputAssets nor a variantOf fallback.)
    const unresolvedEntry: RedemptionBackstopEntry = {
      ...daiEntry,
      stablecoinId: "usr-resolv",
    };
    expect(deriveSupplyModelExitRouteObservation(unresolvedEntry, now)?.output).toEqual({
      kind: "unresolved-asset",
    });
  });

  it("derives nothing outside the documented full-supply basis", () => {
    expect(deriveSupplyModelExitRouteObservation({ ...supplyFullEntry, provider: "reserve-sync-metadata" }, now)).toBeNull();
    expect(deriveSupplyModelExitRouteObservation({ ...supplyFullEntry, resolutionState: "impaired" }, now)).toBeNull();
    expect(deriveSupplyModelExitRouteObservation({ ...supplyFullEntry, routeStatus: "degraded" }, now)).toBeNull();
    expect(deriveSupplyModelExitRouteObservation({ ...supplyFullEntry, docs: null }, now)).toBeNull();
    expect(
      deriveSupplyModelExitRouteObservation(
        {
          ...supplyFullEntry,
          capacityProfile: { ...supplyFullEntry.capacityProfile!, scoringUsd: 1_000_000 },
        },
        now,
      ),
    ).toBeNull();
    expect(
      deriveSupplyModelExitRouteObservation(
        {
          ...supplyFullEntry,
          capacityProfile: {
            ...supplyFullEntry.capacityProfile!,
            exitRouteObservations: [
              deriveSupplyModelExitRouteObservation(supplyFullEntry, now)!,
            ],
          },
        },
        now,
      ),
    ).toBeNull();
  });
});
