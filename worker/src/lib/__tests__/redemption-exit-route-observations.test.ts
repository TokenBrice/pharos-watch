import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig, type RedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import type { RedemptionBackstopEntry, RedemptionCapacityProfile } from "@shared/types/redemption";
import {
  buildRedemptionExitRouteObservation,
  buildPhysicalToUsdExitObservation,
  deriveSupplyModelExitRouteObservation,
} from "../redemption-exit-route-observations";
import { makeSupplyFullRedemption } from "./redemption-backstops-store.test-support";

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

describe("physical-to-USD modelled capacity", () => {
  it("caps every grid point at the documented window throughput or one conservative minimum lot", () => {
    const clockSec = Date.UTC(2026, 9, 1, 12) / 1000;
    const physicalConfig = structuredClone(getRedemptionBackstopConfig("paxg-paxos")!);
    const terms = physicalConfig.physicalToUsd!;
    terms.fees = { issuerFeeBps: 0, issuerFixedUsd: 0, deliveryUsdPerLot: 0, insuranceBps: 0, assayUsdPerLot: 0, taxBps: 0, conversionBps: 0 };
    terms.settlementLegs = [{ leg: "issuer-release", maximumBusinessDays: 1 }];
    delete terms.throughput;
    const input = { assetId: "paxg-paxos", config: physicalConfig, supplyUsd: 500_000_000,
      reference: { usdPerTroyOunce: 1000, observedAtSec: clockSec }, clockSec, routeOpen: true };
    const undocumented = buildPhysicalToUsdExitObservation(input)!;
    expect(undocumented.capacityCurve?.map((point) => point.executableUsd)).toEqual([0, 350_000, 350_000, 350_000]);
    terms.throughput = { tokens: 700, periodSec: 15 * 86400,
      evidence: { url: "https://example.com/terms", quote: "At most 700 tokens of delivered fine metal per fifteen calendar days." } };
    const documented = buildPhysicalToUsdExitObservation(input)!;
    expect(documented.capacityCurve?.map((point) => point.executableUsd)).toEqual([0, 700_000, 700_000, 700_000]);
    expect(documented.physicalToUsd).toMatchObject({ grossUsd: 700_000, netUsd: 693_000, costBps: 100 });
    expect(buildPhysicalToUsdExitObservation({ ...input, routeOpen: false })?.capacityCurve?.map((point) => point.executableUsd)).toEqual([0, 0, 0, 0]);
  });
});

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

describe("issuer payout identity", () => {
  it("retains the fiat default for an issuer without explicit outputs", () => {
    expect(build({ config: { ...config, outputAssetType: "stable-single" } })?.output)
      .toEqual({ kind: "fiat", currency: "USD" });
  });

  it("honors HLUSD's reviewed stablecoin basket", () => {
    expect(build({
      stablecoinId: "hlusd-hela",
      config: getRedemptionBackstopConfig("hlusd-hela")!,
    })?.output).toEqual({
      kind: "tracked-stablecoin",
      trackedAssetIds: ["usdc-circle", "usdt-tether"],
    });
  });

  it("does not infer an issuer payout from its variant parent", () => {
    expect(build({
      stablecoinId: "pusd-plume",
      config: { ...config, outputAssetType: "stable-single" },
    })?.output).toEqual({ kind: "fiat", currency: "USD" });
  });

  it("honors an explicit single stablecoin payout", () => {
    expect(build({
      config: { ...config, outputAssetType: "stable-single", outputAssets: ["usdc-circle"] },
    })?.output).toEqual({ kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] });
  });

  it.each([
    ["witry-brix", ["asset:itry"]],
    ["srusde-strata", ["usde-ethena", "susde-ethena"]],
    ["dllr-sovryn", ["asset:zusd", "doc-money-on-chain"]],
    ["gldy-streamex", ["fiat:USD", "stablecoin:identity-unspecified", "physical:XAU"]],
  ] as const)("keeps %s explicit unresolved outputs instead of parent, fiat or basket inference", (id, keys) => {
    const reviewed = getRedemptionBackstopConfig(id)!;
    expect(build({ stablecoinId: id, config: reviewed })?.output).toEqual({
      kind: "unresolved-asset",
      assetKeys: [...keys],
    });
  });
});

describe("redemption same-notional route observations", () => {
  it("withholds live-direct scoring when its producing evidence time is missing", () => {
    const observation = build({
      sourceMode: "dynamic",
      capacityConfidence: "live-direct",
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
    });
    expect(observation?.scoreEligible).toBe(false);
    expect(observation?.observedAt).toBe(0);
  });

  it("keeps physical metal non-fiat and non-score-eligible even on an atomic-shaped route", () => {
    const observation = build({
      config: {
        ...config,
        settlementModel: "atomic",
        outputAssetType: "physical-commodity-delivery",
        physicalCommodityDelivery: {
          commodity: "XAU", deliverableOuncesPerToken: 1, minimumDeliveryTokens: 1,
          deliveryTermsUnbounded: false,
          feeModel: { bps: 0, flatUsd: 0, deliveryUsd: 0 }, sameNotionalEligible: false,
        },
      },
    });
    expect(observation).toMatchObject({
      scoreEligible: false,
      output: { kind: "physical-commodity-delivery", assetKeys: ["commodity:xau"], sameNotionalEligible: false },
    });
  });

  it("publishes a reviewed immediate route at the common request", () => {
    const observation = build();
    expect(observation).toMatchObject({
      routeId: "redemption:usdc-circle:offchain-issuer",
      routeFamily: "issuer-redemption",
      requestedNotionalUsd: 5_000_000,
      settlementHorizonSec: 3_600,
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
    expect(delayed).toMatchObject({ scoreEligible: false, settlementHorizonSec: 86_400 });

    const queued = build({
      config: { ...config, settlementModel: "queued" },
      capacityProfile: { ...profile, scoringHorizon: "queued" },
      settlementDelaySec: 30 * 86_400,
    });
    expect(queued).toMatchObject({ scoreEligible: false, settlementHorizonSec: 30 * 86_400 });

    const expensive = build({
      config: { ...config, costModel: { kind: "fee-bps", feeBps: 250 } },
      resolvedFeeBps: 250,
    });
    expect(expensive).toMatchObject({ scoreEligible: false, executableUsd: 0, completionRatio: 0 });
  });

  it("emits unproven settlement-bound evidence without synthesizing a zero capacity curve", () => {
    const observation = build({
      capacityProfile: { ...profile, scoringUsd: null, scoringHorizon: "unknown" },
      scoringCapacityUsd: null,
      resolutionState: "missing-capacity",
      settlementBoundUnproven: true,
    });

    expect(observation).toMatchObject({
      settlementBoundUnproven: true,
      executableUsd: 0,
      completionRatio: 0,
      scoreEligible: false,
    });
    expect(observation).not.toHaveProperty("capacityCurve");
  });

  it("preserves reviewed capacity when only the variable fee bound is unknown", () => {
    const observation = build({
      config: {
        ...config,
        costModel: {
          kind: "dynamic-or-unclear",
          feeDescription: "The issuer documents a variable redemption fee without a numeric ceiling.",
          confidence: "undisclosed-reviewed",
          feeModelKind: "documented-variable",
        },
      },
      resolvedFeeBps: null,
    });

    expect(observation).toMatchObject({
      executableUsd: 5_000_000,
      completionRatio: 1,
      feeEvidence: "undisclosed-reviewed",
      scoreEligible: false,
    });
    expect(observation!.capacityCurve!.every((point) => point.executableUsd > 0)).toBe(true);
  });

  it("uses fresh direct telemetry as high-confidence route evidence", () => {
    const observedAt = Date.UTC(2026, 6, 13, 10) / 1_000;
    const observation = build({
      sourceMode: "dynamic",
      capacityConfidence: "live-direct",
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      evidenceObservedAt: observedAt,
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

  it("publishes a live same-run settlement delay as the horizon, keeping the model ceiling as fallback", () => {
    const daysConfig: RedemptionBackstopConfig = { ...config, settlementModel: "days" };
    const live = build({ config: daysConfig, settlementDelaySec: 604_800 });
    expect(live?.settlementHorizonSec).toBe(604_800);
    const unreported = build({ config: daysConfig });
    expect(unreported?.settlementHorizonSec).toBe(14 * 86_400);
    // A zero live delay (instant route) is not a horizon; the schema requires > 0.
    const instant = build({ config: daysConfig, settlementDelaySec: 0 });
    expect(instant?.settlementHorizonSec).toBe(14 * 86_400);
  });

  it("stamps a documented-bound observation with the chain-read time, not the review date", () => {
    const chainReadAt = Date.UTC(2026, 8, 22, 12) / 1_000;
    const observation = build({
      sourceMode: "dynamic",
      capacityConfidence: "documented-bound",
      capacityKind: "documented-bound",
      freshnessKind: "same-run-onchain",
      evidenceObservedAt: chainReadAt,
      now: chainReadAt + 60,
    });
    expect(observation).toMatchObject({
      evidenceKind: "documented-terms",
      observedAt: chainReadAt,
    });
    expect(observation?.observedAt).not.toBe(Date.parse("2026-07-01T00:00:00.000Z") / 1_000);
  });

  it("preserves a source-bound proportional CUSD basket and its all-in value", () => {
    const cusdConfig = getRedemptionBackstopConfig("cusd-cap");
    expect(cusdConfig).toBeDefined();
    const observedAt = Date.UTC(2026, 6, 13, 10) / 1_000;
    const outputObservedAt = observedAt - 120;
    const observation = build({
      stablecoinId: "cusd-cap",
      config: cusdConfig!,
      sourceMode: "dynamic",
      capacityConfidence: "live-direct",
      capacityKind: "live-direct-bounded",
      freshnessKind: "same-run-onchain",
      evidenceObservedAt: observedAt,
      resolvedFeeBps: 0,
      outputValuation: {
        sourceId: "cap-vault:chainlink-nav:0xd13cb763c43b5c058e7ec40176962c5030f4eb49",
        observedAt: outputObservedAt,
        unitValueUsd: 0.999983,
        basketWeights: [
          { assetId: "usdc-circle", weight: 0.93 },
          { assetId: "wtgxx-wisdomtree", weight: 0.07 },
        ],
      },
      now: observedAt + 60,
    });

    expect(observation).toMatchObject({
      output: {
        kind: "tracked-stablecoin",
        trackedAssetIds: ["usdc-circle", "wtgxx-wisdomtree"],
        basketWeights: [
          { assetId: "usdc-circle", weight: 0.93 },
          { assetId: "wtgxx-wisdomtree", weight: 0.07 },
        ],
      },
      executionCostBps: 0,
      outputUnitValueUsd: 0.999983,
      outputUnitValueSourceId:
        "cap-vault:chainlink-nav:0xd13cb763c43b5c058e7ec40176962c5030f4eb49",
      outputUnitValueObservedAt: outputObservedAt,
      allInCostBps: expect.closeTo(0.17, 8),
      scoreEligible: true,
    });
  });

  it("does not attach a same-size basket valuation for different output members", () => {
    const observation = build({
      config: { ...config, routeFamily: "psm-swap", outputAssetType: "stable-basket", outputAssets: ["usdc-circle", "usdt-tether"] },
      outputValuation: {
        sourceId: "fixture-nav", observedAt: Date.UTC(2026, 6, 13) / 1_000, unitValueUsd: 1,
        basketWeights: [{ assetId: "usdc-circle", weight: 0.5 }, { assetId: "dai-makerdao", weight: 0.5 }],
      },
    });
    expect(observation?.output).toEqual({
      kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle", "usdt-tether"],
    });
    expect(observation).not.toHaveProperty("outputUnitValueUsd");
    expect(observation).not.toHaveProperty("allInCostBps");
  });

  it("withholds eligibility when output valuation loss breaches the all-in ceiling", () => {
    const input = {
      config: { ...config, routeFamily: "psm-swap" as const, outputAssetType: "stable-basket" as const, outputAssets: ["usdc-circle", "usdt-tether"] },
      outputValuation: {
        sourceId: "fixture-nav", observedAt: Date.UTC(2026, 6, 13) / 1_000, unitValueUsd: 1,
        basketWeights: [{ assetId: "usdc-circle", weight: 0.5 }, { assetId: "usdt-tether", weight: 0.5 }],
      },
    };
    expect(build(input)).toMatchObject({ executionCostBps: 25, allInCostBps: 25, scoreEligible: true });
    expect(build({ ...input, outputValuation: { ...input.outputValuation, unitValueUsd: 0.98 } })).toMatchObject({
      executionCostBps: 25, allInCostBps: expect.closeTo(225, 8), scoreEligible: false,
    });
  });

  it("uses canonical live-fee precedence and prices minimum plus fixed network costs at each request", () => {
    const costModel = {
      kind: "fee-bps" as const,
      feeBps: 1,
      feeBpsMax: 20,
      minFeeUsd: 1_500,
      gasOrBridgeCostUsd: 600,
    };
    const bounded = build({ config: { ...config, costModel }, resolvedFeeBps: 10 });
    expect(bounded).toMatchObject({ executableUsd: 5_000_000, scoreEligible: true });
    expect(bounded?.capacityCurve?.filter((point) => [100_000, 1_000_000].includes(point.requestedNotionalUsd))).toEqual([
      { requestedNotionalUsd: 100_000, maxCostBps: 200, executableUsd: 0, completionRatio: 0 },
      { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 1_000_000, completionRatio: 1 },
    ]);
    expect(build({
      config: { ...config, costModel: { ...costModel, feeBpsMax: 250 } },
      resolvedFeeBps: 10,
    })).toMatchObject({ executableUsd: 5_000_000, scoreEligible: true });
  });

  it("normalizes fractional live telemetry timestamps before publishing integer observations", () => {
    const observedAt = Date.UTC(2026, 6, 13, 10) / 1_000;
    const observation = build({
      sourceMode: "dynamic",
      capacityConfidence: "live-direct",
      capacityKind: "live-direct-bounded",
      freshnessKind: "verified-source-timestamp",
      evidenceObservedAt: observedAt + 0.75,
      now: observedAt + 61.25,
    });
    expect(observation).toMatchObject({
      evidenceKind: "live-reserve-state",
      confidence: "high",
      observedAt,
      freshnessSeconds: 61,
      scoreEligible: true,
    });
  });

  it("returns no observation when the immediate capacity request is undefined", () => {
    expect(build({ capacityProfile: undefined })).toBeNull();
    expect(build({ scoringCapacityUsd: null })).toBeNull();
  });

  it("does not label a published formula as opaque or admit its unquantified execution cost", () => {
    const observation = build({
      config: {
        ...config,
        costModel: {
          kind: "dynamic-or-unclear", confidence: "formula", feeModelKind: "formula",
          feeDescription: "Early redemption fee declines linearly from 3.5% to 0.1%.",
        },
      },
      resolvedFeeBps: null,
    });
    expect(observation).toMatchObject({ feeEvidence: "disclosed-unquantified", scoreEligible: false });
    expect(observation).not.toHaveProperty("executionCostBps");
  });

  it("withholds executable capacity when a formula's resolved fee provably exceeds the cost budget", () => {
    const observation = build({
      config: {
        ...config,
        costModel: {
          kind: "dynamic-or-unclear", confidence: "formula", feeModelKind: "formula",
          feeDescription: "Observed coreRate plus 75 bps.",
        },
      },
      resolvedFeeBps: 250,
    });
    expect(observation).toMatchObject({ executableUsd: 0, completionRatio: 0, scoreEligible: false });
    expect(observation).not.toHaveProperty("feeEvidence");
    expect(observation!.capacityCurve!.every((point) => point.executableUsd === 0)).toBe(true);
  });
});

const supplyFullEntry: RedemptionBackstopEntry = makeSupplyFullRedemption();

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

  it("preserves reviewed capacity while distinguishing unquantified published fees", () => {
    const variable = deriveSupplyModelExitRouteObservation(
      { ...supplyFullEntry, feeModelKind: "documented-variable", feeBps: null },
      now,
    );
    expect(variable).toMatchObject({
      scoreEligible: false,
      executableUsd: 5_000_000,
      completionRatio: 1,
      feeEvidence: "undisclosed-reviewed",
    });
    const formula = deriveSupplyModelExitRouteObservation(
      { ...supplyFullEntry, feeConfidence: "formula", feeModelKind: "formula", feeBps: null }, now,
    );
    expect(formula).toMatchObject({ feeEvidence: "disclosed-unquantified", scoreEligible: false });
    const overCost = deriveSupplyModelExitRouteObservation({ ...supplyFullEntry, feeBps: 250 }, now);
    expect(overCost).toMatchObject({ scoreEligible: false, executableUsd: 0 });
    expect(overCost).not.toHaveProperty("feeEvidence");
    // A cost-bounded fixed-bps row keeps its measured capacity and stays untagged.
    expect(deriveSupplyModelExitRouteObservation(supplyFullEntry, now)).not.toHaveProperty("feeEvidence");
  });

  it("emits modeled capacity tagged undisclosed-reviewed for a reviewed opaque fee (SIM-EXIT-L2)", () => {
    const observation = deriveSupplyModelExitRouteObservation(
      { ...supplyFullEntry, feeModelKind: "undisclosed-reviewed", feeBps: null },
      now,
    );
    // Modeled capacity is emitted (min of request and the documented full-supply
    // basis), tagged, but never fact-level score eligible: the cost is unbounded.
    expect(observation).toMatchObject({
      executableUsd: 5_000_000,
      completionRatio: 1,
      evidenceKind: "documented-terms",
      feeEvidence: "undisclosed-reviewed",
      scoreEligible: false,
    });
    expect(observation!.capacityCurve!.every((point) => point.executableUsd > 0)).toBe(true);
  });

  it("arms capacity from a reviewed documented fee ceiling on the static config (T1)", () => {
    // usdt-tether's config states the issuer redemption fee outright (0.10% ->
    // feeBpsMax 10), so a documented-variable published row derives a real
    // executable bound instead of the zero-capacity curve.
    const armed = deriveSupplyModelExitRouteObservation(
      { ...supplyFullEntry, stablecoinId: "usdt-tether", feeModelKind: "documented-variable", feeBps: null },
      now,
    );
    expect(armed).toMatchObject({
      routeId: "redemption:usdt-tether:offchain-issuer",
      executableUsd: 5_000_000,
      completionRatio: 1,
      scoreEligible: true,
    });
    // usdc-circle's config has no feeBpsMax: documented-variable keeps its
    // reviewed capacity under the bounded-unknown marker, while only a primary
    // source numeric ceiling can make the route producer-level score eligible.
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
  it("keeps offchain commodity delivery unresolved instead of assigning fiat par", () => {
    const observation = deriveSupplyModelExitRouteObservation(
      {
        ...supplyFullEntry,
        stablecoinId: "paxg-paxos",
        settlementModel: "days",
        outputAssetType: "bluechip-collateral",
      },
      now,
    );

    expect(observation).toMatchObject({
      output: { kind: "unresolved-asset" },
      scoreEligible: false,
    });
    expect(observation?.output).not.toMatchObject({ kind: "fiat" });
    expect(observation?.output).not.toHaveProperty("currency");
  });

  it.each(["srusd-reservoir", "wsrusd-reservoir"] as const)(
    "resolves the composed %s redemption route to its final USDC output",
    (stablecoinId) => {
      const configured = getRedemptionBackstopConfig(stablecoinId);
      expect(configured).toBeDefined();

      expect(
        build({
          stablecoinId,
          config: configured!,
          resolvedFeeBps: null,
        })?.output,
      ).toEqual({
        kind: "tracked-stablecoin",
        trackedAssetIds: ["usdc-circle"],
      });
    },
  );

  it("shapes the sourced redemption-tail outputs and keeps incomplete claims fail-closed", () => {
    const buildConfigured = (
      stablecoinId: string,
      overrides: Partial<Parameters<typeof buildRedemptionExitRouteObservation>[0]> = {},
    ) => {
      const configured = getRedemptionBackstopConfig(stablecoinId);
      expect(configured).toBeDefined();
      return build({
        stablecoinId,
        config: configured!,
        routeStatus: configured!.routeStatus ?? "open",
        now: Date.UTC(2026, 6, 15, 12) / 1_000,
        ...overrides,
      });
    };

    for (const [stablecoinId, trackedAssetIds] of [
      ["ntbill-nest", ["usdc-circle", "pusd-plume"]],
      ["nbasis-nest", ["usdc-circle", "pusd-plume"]],
      ["nopal-nest", ["usdc-circle", "pusd-plume", "usdt-tether"]],
      ["nwisdom-nest", ["usdc-circle", "pusd-plume"]],
    ] as const) {
      expect(buildConfigured(stablecoinId)?.output).toEqual({ kind: "tracked-stablecoin", trackedAssetIds });
    }
    expect(buildConfigured("ussd-sonic-labs")?.output).toEqual({
      kind: "tracked-stablecoin",
      trackedAssetIds: ["frxusd-frax"],
    });
    expect(buildConfigured("cusd-celo")?.output).toEqual({
      kind: "tracked-stablecoin",
      trackedAssetIds: ["usdc-circle", "usdt-tether"],
    });
    expect(buildConfigured("ceur-celo")?.output).toEqual({
      kind: "tracked-stablecoin",
      trackedAssetIds: ["cusd-celo"],
    });
    expect(buildConfigured("ftusd-flying-tulip")?.output).toEqual({
      kind: "tracked-stablecoin",
      trackedAssetIds: ["usdc-circle", "usdt-tether"],
    });
    expect(buildConfigured("usd0-usual")?.output).toEqual({
      kind: "collateral",
      assetKeys: ["asset:usyc", "asset:m", "asset:ustbl"],
    });

    const dusd = buildConfigured("dusd-dtrinity", { capacityConfidence: "heuristic" });
    expect(dusd).toMatchObject({
      output: {
        kind: "unresolved-basket",
        assetKeys: [
          "usdc-circle",
          "usdt-tether",
          "usds-sky",
          "susds-sky",
          "frxusd-frax",
          "sfrxusd-frax",
          "dai-makerdao",
          "sdai-sky",
          "asset:vbusdc",
          "asset:vbusdt",
          "ausd-agora",
        ],
      },
      scoreEligible: false,
    });

    expect(buildConfigured("dllr-sovryn")?.output).toEqual({
      kind: "unresolved-asset",
      assetKeys: ["asset:zusd", "doc-money-on-chain"],
    });
    const deuroBasket = [
      "asset:eura",
      "asset:eure-legacy-ethereum",
      "asset:eurt",
      "asset:veur",
      "eurc-circle",
      "euri-banking-circle",
      "europ-schuman",
      "eurr-stablr",
      "eurs-stasis",
    ].map((assetId, index) => ({ assetId, weight: index === 4 ? 1 : 0 }));
    expect(buildConfigured("deuro-deuro", {
      outputValuation: {
        sourceId: "collateral-positions-api:deuro-bridge-basket:test",
        observedAt: Date.UTC(2026, 6, 15, 12) / 1_000,
        unitValueUsd: 1.15,
        expectedUnitValueUsd: 1.15,
        basketWeights: deuroBasket,
      },
    })).toMatchObject({
      output: {
        kind: "unresolved-basket",
        basketWeights: deuroBasket,
      },
      outputUnitValueUsd: 1.15,
      outputExpectedUnitValueUsd: 1.15,
      allInCostBps: 25,
      scoreEligible: true,
    });
    expect(buildConfigured("witry-brix")?.output).toEqual({
      kind: "unresolved-asset",
      assetKeys: ["asset:itry"],
    });
    expect(buildConfigured("aznd-mu-digital")?.output).toEqual({
      kind: "tracked-stablecoin",
      trackedAssetIds: ["usdc-circle"],
    });
    expect(buildConfigured("zys-zephyr-protocol")?.output).toEqual({
      kind: "tracked-stablecoin",
      trackedAssetIds: ["zsd-zephyr-protocol"],
    });

    const hyusd = buildConfigured("hyusd-hylo");
    expect(hyusd).toMatchObject({ output: { kind: "collateral" }, scoreEligible: false });
    expect(hyusd?.output.assetKeys).toBeUndefined();
    expect(hyusd?.output.trackedAssetIds).toBeUndefined();
  });

  it("derives nothing outside the documented full-supply basis", () => {
    expect(
      deriveSupplyModelExitRouteObservation({ ...supplyFullEntry, provider: "reserve-sync-metadata" }, now),
    ).toBeNull();
    expect(
      deriveSupplyModelExitRouteObservation({ ...supplyFullEntry, capacityProfile: undefined }, now),
    ).toBeNull();
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
            exitRouteObservations: [deriveSupplyModelExitRouteObservation(supplyFullEntry, now)!],
          },
        },
        now,
      ),
    ).toBeNull();
  });

  it("still derives when the published row scored immediate capacity as zero", () => {
    const observation = deriveSupplyModelExitRouteObservation(
      {
        ...supplyFullEntry,
        capacityProfile: { ...supplyFullEntry.capacityProfile!, scoringUsd: 0 },
      },
      now,
    );
    expect(observation).toMatchObject({
      routeFamily: "issuer-redemption",
      executableUsd: 5_000_000,
      scoreEligible: true,
    });
  });

  it("derives diagnostic eventual-redemption from the live Avalon USDa config", () => {
    const avalonConfig = getRedemptionBackstopConfig("usda-avalon");
    expect(avalonConfig).toBeDefined();
    expect(avalonConfig?.outputAssets).toEqual(["usdt-tether"]);
    expect(avalonConfig?.settlementModel).toBe("days");
    expect(avalonConfig?.capacityModel.kind).toBe("supply-full");

    const observation = deriveSupplyModelExitRouteObservation(
      {
        ...supplyFullEntry,
        stablecoinId: "usda-avalon",
        routeFamily: avalonConfig!.routeFamily,
        accessModel: avalonConfig!.accessModel,
        settlementModel: avalonConfig!.settlementModel,
        executionModel: avalonConfig!.executionModel,
        outputAssetType: avalonConfig!.outputAssetType,
        feeModelKind: "documented-variable",
        feeBps: null,
        docs: {
          label: avalonConfig!.docs![0]!.label,
          url: avalonConfig!.docs![0]!.url,
          reviewedAt: avalonConfig!.reviewedAt,
        },
      },
      now,
    );

    expect(observation).toMatchObject({
      routeId: "redemption:usda-avalon:stablecoin-redeem",
      routeFamily: "eventual-redemption",
      settlementHorizonSec: 14 * 86_400,
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdt-tether"] },
      evidenceKind: "documented-terms",
      feeEvidence: "undisclosed-reviewed",
      scoreEligible: false,
      executableUsd: 5_000_000,
      completionRatio: 1,
    });
  });
});

describe("reserve-sync observations with tiny live capacity", () => {
  it("publishes a fail-closed observation when scoring capacity is a near-zero USDC payout", () => {
    const anzenConfig = getRedemptionBackstopConfig("usdz-anzen");
    expect(anzenConfig).toBeDefined();
    expect(anzenConfig?.outputAssets).toEqual(["usdc-circle"]);

    const observation = build({
      stablecoinId: "usdz-anzen",
      config: anzenConfig!,
      capacityProfile: {
        scoringUsd: 0.006695,
        scoringHorizon: "immediate",
        capacityProfileConfidence: "live-direct",
        modeledExitSizeUsd: 5_000_000,
      },
      scoringCapacityUsd: 0.006695,
      supplyUsd: 806_422.8,
      sourceMode: "dynamic",
      capacityConfidence: "live-direct",
      capacityKind: "live-direct",
      freshnessKind: "same-run-onchain",
      evidenceObservedAt: Date.UTC(2026, 6, 13, 10) / 1_000,
      now: Date.UTC(2026, 6, 13, 10, 1) / 1_000,
      resolvedFeeBps: 0,
    });

    expect(observation).toMatchObject({
      routeId: "redemption:usdz-anzen:stablecoin-redeem",
      routeFamily: "protocol-redemption",
      output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] },
      evidenceKind: "onchain-contract-state",
      executableUsd: 0.006695,
      completionRatio: 0.006695 / 5_000_000,
      scoreEligible: true,
    });
  });
});

describe("live queue/proxy capacity-method tier", () => {
  it("keeps an InfiniFi-shaped same-run queue at its measured bound, not atomic completion", () => {
    const now = Date.UTC(2026, 9, 2, 12) / 1000;
    const observation = build({
      stablecoinId: "iusd-infinifi", config: getRedemptionBackstopConfig("iusd-infinifi")!,
      capacityProfile: { ...profile, scoringHorizon: "queued", scoringUsd: 1_250_000 },
      scoringCapacityUsd: 1_250_000, sourceMode: "dynamic", capacityConfidence: "live-proxy",
      capacityKind: "live-queue", freshnessKind: "same-run-onchain",
      evidenceObservedAt: now, now, settlementDelaySec: 7 * 86_400, resolvedFeeBps: 0,
    })!;
    expect(observation.capacityEvidenceTier).toBe("live-queue-proxy");
    expect(observation.confidence).toBe("high");
    expect(observation.evidenceKind).toBe("onchain-contract-state");
    expect(observation.scoreEligible).toBe(false);
    expect(observation.settlementHorizonSec).toBe(7 * 86_400);
    expect(observation.executableUsd).toBe(1_250_000);
    expect(observation.capacityCurve!.find((point) => point.requestedNotionalUsd === 25_000_000)!.executableUsd).toBe(1_250_000);
  });

  it.each(["live-queue", "live-proxy-validated"] as const)(
    "never assigns the live %s tier to absent/future/stale clocks", (capacityKind) => {
      const now = Date.UTC(2026, 9, 2, 12) / 1000;
      for (const evidenceObservedAt of [undefined, Number.NaN, now + 1, now - 7 * 86_400]) {
        const observation = build({ sourceMode: "dynamic", capacityConfidence: "live-proxy",
          capacityKind, freshnessKind: "same-run-onchain", evidenceObservedAt, now })!;
        expect(observation.capacityEvidenceTier).not.toBe("live-queue-proxy");
        expect(observation.scoreEligible).toBe(false);
      }
    },
  );
});
