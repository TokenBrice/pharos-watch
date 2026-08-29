import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig, type RedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import type { RedemptionBackstopEntry, RedemptionCapacityProfile } from "@shared/types/redemption";
import {
  buildRedemptionExitRouteObservation,
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
      sourceTimestamp: observedAt,
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

  it("normalizes fractional live telemetry timestamps before publishing integer observations", () => {
    const observedAt = Date.UTC(2026, 6, 13, 10) / 1_000;
    const observation = build({
      sourceMode: "dynamic",
      capacityConfidence: "live-direct",
      capacityKind: "live-direct-bounded",
      freshnessKind: "verified-source-timestamp",
      sourceTimestamp: observedAt + 0.75,
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

  it("preserves reviewed capacity under the bounded-unknown fee ceiling", () => {
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
      kind: "unresolved-basket",
      assetKeys: ["asset:zusd", "doc-money-on-chain"],
    });
    expect(buildConfigured("witry-brix")?.output).toEqual({
      kind: "unresolved-asset",
      assetKeys: ["asset:itry"],
    });
    expect(buildConfigured("aznd-mu-digital")?.output).toEqual({
      kind: "unresolved-asset",
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
      sourceTimestamp: Date.UTC(2026, 6, 13, 10) / 1_000,
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
