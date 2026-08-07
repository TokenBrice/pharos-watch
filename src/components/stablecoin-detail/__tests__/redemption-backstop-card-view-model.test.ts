import { describe, expect, it } from "vitest";
import { buildRedemptionBackstopCardViewModel } from "../redemption-backstop-card-view-model";
import type { RedemptionBackstopEntry } from "@shared/types";

const BASE_ENTRY: RedemptionBackstopEntry = {
  stablecoinId: "test-usd",
  score: 72,
  effectiveExitScore: 64,
  dexLiquidityScore: 51,
  accessScore: 70,
  settlementScore: 80,
  executionCertaintyScore: 75,
  capacityScore: 65,
  outputAssetQualityScore: 90,
  costScore: 85,
  routeFamily: "stablecoin-redeem",
  accessModel: "permissionless-onchain",
  settlementModel: "atomic",
  executionModel: "deterministic-onchain",
  outputAssetType: "stable-single",
  provider: "test-provider",
  sourceMode: "dynamic",
  resolutionState: "resolved",
  routeStatus: "open",
  routeStatusSource: "protocol-api",
  holderEligibility: "any-holder",
  capacityConfidence: "live-direct",
  capacitySemantics: "immediate-bounded",
  feeConfidence: "fixed",
  feeModelKind: "fixed-bps",
  modelConfidence: "high",
  immediateCapacityUsd: 5_000_000,
  immediateCapacityRatio: 0.1,
  feeBps: 0,
  queueEnabled: false,
  methodologyVersion: "1.4",
  updatedAt: 1_765_000_000,
  capsApplied: [],
};

function entry(overrides: Partial<RedemptionBackstopEntry> = {}): RedemptionBackstopEntry {
  return {
    ...BASE_ENTRY,
    ...overrides,
  };
}

function telemetryValue(
  viewModel: ReturnType<typeof buildRedemptionBackstopCardViewModel>,
  label: string,
): string | undefined {
  return viewModel.telemetryContext.find((item) => item.label === label)?.value;
}

describe("buildRedemptionBackstopCardViewModel", () => {
  it("formats immediate capacity, scoring horizon, and telemetry context", () => {
    const viewModel = buildRedemptionBackstopCardViewModel(
      entry({
        immediateCapacityUsd: 4_250_000,
        immediateCapacityRatio: 0.085,
        routeExitCorrelation: "independent-issuer-rail",
        capacityProfile: {
          immediateUsd: 4_250_000,
          dailyLimitUsd: 1_500_000,
          queuedUsd: 12_000_000,
          eventualUsd: 30_000_000,
          scoringUsd: 1_500_000,
          scoringHorizon: "daily",
          capacityProfileConfidence: "live-direct",
          modeledExitSizeUsd: 2_000_000,
        },
        eventualRedeemabilityScore: 88,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-api",
        settlementDelaySec: 90 * 60,
        queueDepthUsd: 9_500_000,
        dailyLimitUsd: 1_500_000,
        minRedeemUsd: 100_000,
      }),
    );

    expect(viewModel.capacitySummary).toMatchObject({
      title: "Daily Capacity",
      headline: "$1.5M",
    });
    expect(viewModel.capacitySummary.detail).toContain("Live direct redemption telemetry.");
    expect(viewModel.capacitySummary.detail).toContain("Current modeled capacity is daily-limited.");
    expect(viewModel.routeExitCorrelationLabel).toBe("independent issuer rail");
    expect(telemetryValue(viewModel, "Horizon")).toBe("daily");
    expect(telemetryValue(viewModel, "Scoring capacity")).toBe("$1.5M");
    expect(telemetryValue(viewModel, "Eventual capacity")).toBe("$30.0M");
    expect(telemetryValue(viewModel, "Queued capacity")).toBe("$12.0M");
    expect(telemetryValue(viewModel, "Modeled exit")).toBe("$2.0M");
    expect(telemetryValue(viewModel, "Eventual score")).toBe("88/100");
    expect(telemetryValue(viewModel, "Capacity evidence")).toBe("live direct bounded");
    expect(telemetryValue(viewModel, "Freshness")).toBe("same run api");
    expect(telemetryValue(viewModel, "Live delay")).toBe("2h");
    expect(telemetryValue(viewModel, "Queue depth")).toBe("$9.5M");
    expect(telemetryValue(viewModel, "Daily limit")).toBe("$1.5M");
    expect(telemetryValue(viewModel, "Minimum redeem")).toBe("$100.0K");
  });

  it("uses capacity profile scoring amount as the fallback headline capacity", () => {
    const viewModel = buildRedemptionBackstopCardViewModel(
      entry({
        immediateCapacityUsd: null,
        immediateCapacityRatio: null,
        capacityConfidence: "documented-bound",
        capacityProfile: {
          scoringUsd: 750_000,
          scoringHorizon: "queued",
          capacityProfileConfidence: "documented-bound",
          modeledExitSizeUsd: 2_500_000,
        },
      }),
    );

    expect(viewModel.capacitySummary).toMatchObject({
      title: "Queued Capacity",
      headline: "$750.0K",
    });
    expect(viewModel.capacitySummary.detail).toContain("Reviewed documented redemption bound.");
    expect(viewModel.capacitySummary.detail).toContain("Current modeled capacity is queue-limited.");
    expect(telemetryValue(viewModel, "Modeled exit")).toBe("$2.5M");
  });

  it("formats fixed, zero, formula, documented-variable, and undisclosed fee summaries", () => {
    expect(buildRedemptionBackstopCardViewModel(entry({ feeBps: 0 })).feeSummary).toMatchObject({
      headline: "0 bps (0.00%)",
      detail: "No fixed redemption fee is modeled for this route.",
    });

    expect(buildRedemptionBackstopCardViewModel(entry({ feeBps: 12.5 })).feeSummary).toMatchObject({
      headline: "12.5 bps (0.13%)",
      detail: "Pharos models this route with a fixed bounded redemption fee.",
    });

    expect(
      buildRedemptionBackstopCardViewModel(
        entry({
          feeBps: null,
          feeModelKind: "formula",
          feeConfidence: "formula",
          feeDescription: "baseRate + 50 bps minimum",
        }),
      ).feeSummary,
    ).toMatchObject({
      headline: "baseRate + 50 bps minimum",
      detail: "Protocol or issuer docs publish a fee formula rather than a single fixed bps rate.",
    });

    const liveFormula = buildRedemptionBackstopCardViewModel(
      entry({
        feeBps: 52,
        feeModelKind: "formula",
        feeConfidence: "formula",
        feeDescription: "Minimum 50 bps plus live baseRate.",
      }),
    );
    expect(liveFormula.feeSummary).toMatchObject({
      headline: "52 bps current (0.52%)",
      detail:
        "Minimum 50 bps plus live baseRate. Current live telemetry resolved this formula to the displayed bps value.",
    });
    expect(liveFormula.scoreBreakdown.cost.suffix).toBe(" (52 bps current)");

    expect(
      buildRedemptionBackstopCardViewModel(
        entry({
          feeBps: null,
          feeModelKind: "documented-variable",
          feeConfidence: "formula",
          feeDescription: "Redemption fee depends on utilization.",
        }),
      ).feeSummary,
    ).toMatchObject({
      headline: "Redemption fee depends on utilization.",
      detail:
        "Protocol or issuer docs publish fee logic, but it is variable, conditional, or not a single fixed bps value.",
    });

    expect(
      buildRedemptionBackstopCardViewModel(
        entry({
          feeBps: null,
          feeModelKind: "undisclosed-reviewed",
          feeConfidence: "undisclosed-reviewed",
          feeDescription: undefined,
        }),
      ).feeSummary,
    ).toMatchObject({
      headline: "Reviewed, but not published",
      detail: "Public route docs were reviewed, but they do not publish a bounded numeric redemption fee.",
    });
  });

  it("preserves telemetry warning notes while removing redundant eventual-redeemability notes", () => {
    const viewModel = buildRedemptionBackstopCardViewModel(
      entry({
        capacitySemantics: "eventual-only",
        immediateCapacityUsd: null,
        immediateCapacityRatio: null,
        freshnessKind: "unverified",
        liveHolderEligibility: "pre-incident-holder",
        notes: [
          "Stale live capacity telemetry was ignored by the runtime adapter",
          "Modeled as eventual redeemability of current supply",
        ],
      }),
    );

    expect(viewModel.capacitySummary).toMatchObject({
      title: "Eventual Redeemability",
      headline: "Not separately quantified",
    });
    expect(telemetryValue(viewModel, "Freshness")).toBe("unverified");
    expect(telemetryValue(viewModel, "Live eligibility")).toBe("pre incident holder");
    expect(viewModel.filteredNotes).toEqual(["Stale live capacity telemetry was ignored by the runtime adapter"]);
  });

  it("maps every route family to the stable detail label", () => {
    expect(buildRedemptionBackstopCardViewModel(entry({ routeFamily: "stablecoin-redeem" })).routeFamilyLabel).toBe(
      "Stablecoin redeem",
    );
    expect(buildRedemptionBackstopCardViewModel(entry({ routeFamily: "basket-redeem" })).routeFamilyLabel).toBe(
      "Basket redeem",
    );
    expect(buildRedemptionBackstopCardViewModel(entry({ routeFamily: "collateral-redeem" })).routeFamilyLabel).toBe(
      "Collateral redeem",
    );
    expect(buildRedemptionBackstopCardViewModel(entry({ routeFamily: "psm-swap" })).routeFamilyLabel).toBe(
      "PSM / swap floor",
    );
    expect(buildRedemptionBackstopCardViewModel(entry({ routeFamily: "queue-redeem" })).routeFamilyLabel).toBe(
      "Queue redeem",
    );
    expect(buildRedemptionBackstopCardViewModel(entry({ routeFamily: "offchain-issuer" })).routeFamilyLabel).toBe(
      "Offchain issuer",
    );
  });

  it("maps route status and docs provenance labels", () => {
    expect(buildRedemptionBackstopCardViewModel(entry({ routeStatus: "open" }))).toMatchObject({
      showRouteStatusBadge: false,
      routeStatusLabel: "open",
    });
    expect(buildRedemptionBackstopCardViewModel(entry({ routeStatus: "degraded" }))).toMatchObject({
      showRouteStatusBadge: true,
      routeStatusLabel: "degraded",
    });
    expect(buildRedemptionBackstopCardViewModel(entry({ routeStatus: "cohort-limited" }))).toMatchObject({
      showRouteStatusBadge: true,
      routeStatusLabel: "cohort limited",
    });
    expect(buildRedemptionBackstopCardViewModel(entry({ routeStatus: "unknown" }))).toMatchObject({
      showRouteStatusBadge: true,
      routeStatusLabel: "status unknown",
    });

    const provenanceCases = [
      ["config-reviewed", "Reviewed route source"],
      ["live-reserve-display", "Fallback live reserve source"],
      ["proof-of-reserves", "Fallback proof-of-reserves source"],
      ["preferred-link", "Fallback project link"],
    ] as const;
    for (const [provenance, label] of provenanceCases) {
      expect(
        buildRedemptionBackstopCardViewModel(
          entry({
            docs: {
              reviewedAt: "2026-05-24",
              provenance,
              sources: [
                {
                  label: "Fixture source",
                  url: "https://example.com/redemption",
                  supports: ["route", "capacity"],
                },
              ],
            },
          }),
        ),
      ).toMatchObject({
        docsReviewedAt: "2026-05-24",
        docsProvenanceLabel: label,
        docSources: [
          {
            label: "Fixture source",
            url: "https://example.com/redemption",
            supports: "route, capacity",
          },
        ],
      });
    }

    expect(
      buildRedemptionBackstopCardViewModel(
        entry({
          docs: {
            label: "Legacy source",
            url: "https://example.com/legacy",
          },
        }),
      ).docSources,
    ).toEqual([
      {
        label: "Legacy source",
        url: "https://example.com/legacy",
        supports: null,
      },
    ]);
  });

  it("explains non-rated score states and exposes score breakdown labels", () => {
    const missingCache = buildRedemptionBackstopCardViewModel(
      entry({
        score: null,
        effectiveExitScore: null,
        resolutionState: "missing-cache",
        sourceMode: "static",
        modelConfidence: "low",
        feeBps: 5,
      }),
    );

    expect(missingCache.heroScoreLabel).toBe("NR");
    expect(missingCache.title).toBe("Redemption route");
    expect("showExitScore" in missingCache).toBe(false);
    expect(missingCache.showResolutionStateBadge).toBe(true);
    expect(missingCache.resolutionStateLabel).toBe("missing cache");
    expect(missingCache.modelConfidenceLabel).toBe("confidence: low");
    expect(missingCache.resolutionSummary).toContain("current stablecoins snapshot did not contain the asset");
    expect(missingCache.scoreBreakdown.access.label).toBe("Access score");
    expect(missingCache.scoreBreakdown.settlement.label).toBe("Settlement");
    expect(missingCache.scoreBreakdown.execution.label).toBe("Execution");
    expect(missingCache.scoreBreakdown.capacity.label).toBe("Capacity");
    expect(missingCache.scoreBreakdown.outputQuality.label).toBe("Output quality");
    expect(missingCache.scoreBreakdown.cost.label).toBe("Cost");
    expect(missingCache.scoreBreakdown.cost.suffix).toBe(" (5 bps)");

    expect(
      buildRedemptionBackstopCardViewModel(entry({ resolutionState: "missing-capacity" })).resolutionSummary,
    ).toContain("could not resolve enough capacity data");
    expect(buildRedemptionBackstopCardViewModel(entry({ resolutionState: "failed" })).resolutionSummary).toContain(
      "failed to resolve a usable redemption score",
    );
    expect(
      buildRedemptionBackstopCardViewModel(
        entry({
          resolutionState: "impaired",
          routeStatus: "paused",
          routeStatusReason: "Issuer paused primary redemption while reserves are reconciled.",
        }),
      ),
    ).toMatchObject({
      showRouteStatusBadge: true,
      routeStatusLabel: "paused",
      resolutionSummary: "Issuer paused primary redemption while reserves are reconciled.",
    });
  });
});
