import { describe, expect, it } from "vitest";
import {
  defineBackstopRegistry,
  defineBatch,
  defineOverride,
  getBackstopRegistryOverrideReasons,
  getBackstopRegistrySourceFilePaths,
} from "@shared/lib/redemption-backstop-configs/factory";
import {
  applyTrackedReviewedDocs,
  documentedBoundSupplyFull,
  documentedVariableFee,
  expandIds,
  fixedFee,
  NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
  resolveRedemptionCostBpsAtNotional,
  resolveDefaultHolderEligibility,
  resolveV9RedemptionRouteCostBpsAtNotional,
  sourceRef,
  undisclosedReviewedFee,
  type RedemptionBackstopConfig,
} from "@shared/lib/redemption-backstop-configs/shared";
import { resolveFeeConfidence, resolveFeeModelKind } from "@shared/lib/redemption-backstop-confidence";

function createBaseConfig(): RedemptionBackstopConfig {
  return {
    routeFamily: "offchain-issuer",
    accessModel: "issuer-api",
    settlementModel: "same-day",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-single",
    capacityModel: { kind: "supply-full", basis: "issuer-term-redemption" },
    costModel: undisclosedReviewedFee(),
    docs: [sourceRef("Fixture docs", "https://example.com/redemption", ["route", "fees"])],
    notes: ["fixture note"],
  };
}

describe("redemption backstop config helpers", () => {
  it("expands shared configs as independent clones", () => {
    const baseConfig = createBaseConfig();
    const expanded = expandIds(["alpha", "beta"], {
      ...baseConfig,
      capacityModel: { kind: "supply-ratio", ratio: 0.1 },
      costModel: documentedVariableFee("Variable fee schedule"),
      v9RouteCostTerms: { minFeeUsd: 1_000 },
      v9RouteReviewTerms: { minRedeemUsd: 100_000, settlementModel: "days" },
      unresolvedOutputAssetKeys: ["asset:untracked"],
    });

    const alpha = expanded["alpha"]!;
    const beta = expanded["beta"]!;
    alpha.docs![0]!.supports!.push("capacity");
    alpha.notes!.push("mutated note");
    alpha.costModel.feeDescription = "mutated fee";
    alpha.v9RouteCostTerms!.minFeeUsd = 2_000;
    alpha.v9RouteReviewTerms!.minRedeemUsd = 200_000;
    alpha.unresolvedOutputAssetKeys!.push("asset:mutated");
    if (alpha.capacityModel.kind === "supply-ratio") {
      alpha.capacityModel.ratio = 0.2;
    }

    expect(beta.docs![0]!.supports).toEqual(["route", "fees"]);
    expect(beta.notes).toEqual(["fixture note"]);
    expect(beta.costModel.feeDescription).toBe("Variable fee schedule");
    expect(beta.v9RouteCostTerms).toEqual({ minFeeUsd: 1_000 });
    expect(beta.v9RouteReviewTerms).toEqual({ minRedeemUsd: 100_000, settlementModel: "days" });
    expect(beta.unresolvedOutputAssetKeys).toEqual(["asset:untracked"]);
    expect(beta.capacityModel).toMatchObject({ kind: "supply-ratio", ratio: 0.1 });
    expect(baseConfig.docs![0]!.supports).toEqual(["route", "fees"]);
  });

  it("clones registry entries and records source file paths", () => {
    const baseConfig = createBaseConfig();
    const registry = defineBackstopRegistry([
      ...defineBatch(["alpha", "beta"], baseConfig, { sourceFilePath: "shared/base.ts" }),
      defineOverride(
        "alpha",
        baseConfig,
        {
          settlementModel: "days",
          docs: [sourceRef("Override docs", "https://example.com/override", ["route"])],
        },
        "Reviewed override for alpha.",
        { sourceFilePath: "shared/override.ts" },
      ),
    ]);

    baseConfig.docs![0]!.supports!.push("capacity");
    registry["alpha"]!.docs![0]!.supports!.push("fees");

    expect(registry["alpha"]!.settlementModel).toBe("days");
    expect(registry["alpha"]!.docs![0]!.supports).toEqual(["route", "fees"]);
    expect(registry["beta"]!.docs![0]!.supports).toEqual(["route", "fees"]);
    expect(getBackstopRegistryOverrideReasons(registry).get("alpha")).toBe("Reviewed override for alpha.");
    expect(getBackstopRegistrySourceFilePaths(registry).get("alpha")).toBe("shared/override.ts");
    expect(getBackstopRegistrySourceFilePaths(registry).get("beta")).toBe("shared/base.ts");
  });

  it("rejects blank override reasons", () => {
    expect(() => defineOverride("alpha", createBaseConfig(), {}, "   ")).toThrow(
      'Redemption backstop config override for "alpha" requires a reason.',
    );
  });

  it("builds compact source references", () => {
    const supports = ["route", "capacity"] as const;
    expect(sourceRef("Docs", "https://example.com/docs")).toEqual({
      label: "Docs",
      url: "https://example.com/docs",
    });
    expect(sourceRef("Docs", "https://example.com/docs", [])).toEqual({
      label: "Docs",
      url: "https://example.com/docs",
    });
    expect(sourceRef("Docs", "https://example.com/docs", [...supports])).toEqual({
      label: "Docs",
      url: "https://example.com/docs",
      supports: ["route", "capacity"],
    });
  });

  it("separates fixed, documented variable, formula, and undisclosed reviewed fee helpers", () => {
    expect(fixedFee(25, "25 bps")).toEqual({
      kind: "fee-bps",
      feeBps: 25,
      feeDescription: "25 bps",
      confidence: "fixed",
    });

    const documented = documentedVariableFee("Variable redemption fee schedule");
    expect(documented).toMatchObject({
      kind: "dynamic-or-unclear",
      feeDescription: "Variable redemption fee schedule",
      confidence: "undisclosed-reviewed",
      feeModelKind: "documented-variable",
    });
    expect(resolveFeeConfidence(documented)).toBe("undisclosed-reviewed");
    expect(resolveFeeModelKind(documented)).toBe("documented-variable");

    const formula = documentedVariableFee("Minimum 50 bps plus base rate", "formula");
    expect(formula).toMatchObject({
      confidence: "formula",
      feeModelKind: "formula",
    });
    expect(resolveFeeModelKind(formula)).toBe("formula");

    const legacyUndisclosed = documentedVariableFee("Redeemable 1:1; public fee schedule not disclosed");
    expect(legacyUndisclosed).toMatchObject({
      confidence: "undisclosed-reviewed",
      feeModelKind: "undisclosed-reviewed",
    });
    expect(resolveFeeModelKind(legacyUndisclosed)).toBe("undisclosed-reviewed");

    const undisclosed = undisclosedReviewedFee();
    expect(undisclosed).toMatchObject({
      kind: "dynamic-or-unclear",
      feeDescription: NO_PUBLIC_NUMERIC_REDEMPTION_FEE,
      confidence: "undisclosed-reviewed",
      feeModelKind: "undisclosed-reviewed",
    });
    expect(resolveFeeModelKind(undisclosed)).toBe("undisclosed-reviewed");
  });

  it("projects percentage, minimum, and fixed redemption terms at each notional", () => {
    const reviewedSchedule = {
      ...documentedVariableFee("10 bps with a $1,000 minimum"),
      feeBpsMax: 10,
      minFeeUsd: 1_000,
    };
    expect(resolveRedemptionCostBpsAtNotional(reviewedSchedule, 100_000)).toBe(100);
    expect(resolveRedemptionCostBpsAtNotional(reviewedSchedule, 1_000_000)).toBe(10);
    expect(resolveRedemptionCostBpsAtNotional(reviewedSchedule, 25_000_000)).toBe(10);
    expect(resolveRedemptionCostBpsAtNotional(fixedFee(35), 3_793_482.4984454736)).toBe(35);

    const fixedCosts = {
      kind: "fee-bps" as const,
      feeBps: 0,
      flatFeeUsd: 25,
      gasOrBridgeCostUsd: 25,
    };
    expect(resolveRedemptionCostBpsAtNotional(fixedCosts, 100_000)).toBe(5);
  });

  it("prefers current numeric telemetry while preserving separate reviewed minimum charges", () => {
    const reviewedSchedule = {
      ...documentedVariableFee("5-75 bps with a $1,000 minimum", "formula"),
      feeBpsMin: 5,
      feeBpsMax: 75,
      minFeeUsd: 1_000,
    };
    expect(resolveRedemptionCostBpsAtNotional(reviewedSchedule, 100_000, 5)).toBe(100);
    expect(resolveRedemptionCostBpsAtNotional(reviewedSchedule, 1_000_000, 5)).toBe(10);
    expect(resolveRedemptionCostBpsAtNotional(undisclosedReviewedFee(), 1_000_000)).toBeNull();
  });

  it("keeps post-freeze route terms isolated to the V9 projector", () => {
    const config: RedemptionBackstopConfig = {
      ...createBaseConfig(),
      costModel: {
        ...documentedVariableFee("10 bps with a $1,000 minimum"),
        feeBpsMax: 10,
      },
      v9RouteCostTerms: { minFeeUsd: 1_000 },
      v9RouteReviewTerms: { minRedeemUsd: 100_000, settlementModel: "days" },
    };

    expect(resolveRedemptionCostBpsAtNotional(config.costModel, 100_000)).toBe(10);
    expect(resolveV9RedemptionRouteCostBpsAtNotional(config, 100_000)).toBe(100);
    expect(config.settlementModel).toBe("same-day");
  });

  it("builds documented-bound supply-full fragments with reviewedAt provenance", () => {
    expect(documentedBoundSupplyFull("2026-05-12")).toEqual({
      capacityModel: {
        kind: "supply-full",
        confidence: "documented-bound",
      },
      reviewedAt: "2026-05-12",
    });
  });

  it("applies tracked reviewed docs without overwriting existing docs or reviewedAt", () => {
    const withMissingDocs = createBaseConfig();
    delete withMissingDocs.docs;
    const withExistingDocs = {
      ...createBaseConfig(),
      reviewedAt: "2026-01-01",
      docs: [sourceRef("Existing docs", "https://example.com/existing", ["route"])],
    };
    const configs = {
      "usdc-circle": withMissingDocs,
      "usdt-tether": withExistingDocs,
    };

    applyTrackedReviewedDocs(configs, ["usdc-circle", "usdt-tether"], "2026-05-12");

    expect(configs["usdc-circle"].reviewedAt).toBe("2026-05-12");
    expect(configs["usdc-circle"].docs?.length).toBeGreaterThan(0);
    expect(configs["usdc-circle"].docs?.[0]?.url).toMatch(/^https?:\/\//);
    expect(configs["usdt-tether"].reviewedAt).toBe("2026-01-01");
    expect(configs["usdt-tether"].docs).toEqual([
      sourceRef("Existing docs", "https://example.com/existing", ["route"]),
    ]);
  });

  it("throws when a tracked reviewed docs id is absent from the config map", () => {
    expect(() => applyTrackedReviewedDocs({}, ["usdc-circle"], "2026-05-12")).toThrow(
      'Missing redemption backstop config for stablecoin id "usdc-circle" while applying tracked reviewed docs',
    );
  });

  it("maps access models to default holder eligibility", () => {
    expect(resolveDefaultHolderEligibility({ accessModel: "permissionless-onchain" })).toBe("any-holder");
    expect(resolveDefaultHolderEligibility({ accessModel: "whitelisted-onchain" })).toBe("whitelisted-primary");
    expect(resolveDefaultHolderEligibility({ accessModel: "issuer-api" })).toBe("verified-customer");
    expect(resolveDefaultHolderEligibility({ accessModel: "manual" })).toBe("issuer-discretionary");
  });
});
