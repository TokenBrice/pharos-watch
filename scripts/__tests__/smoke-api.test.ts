import { describe, expect, it } from "vitest";
import { ENDPOINT_ASSERTIONS } from "../smoke-api.mjs";

function makeRedemptionBody(overrides: Record<string, unknown> = {}) {
  return {
    coins: {
      "cusd-cap": {
        stablecoinId: "cusd-cap",
        score: 88,
        effectiveExitScore: 56,
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
        provider: "supply-full-model",
        sourceMode: "estimated",
        resolutionState: "resolved",
        routeStatus: "open",
        routeStatusSource: "static-config",
        holderEligibility: "any-holder",
        capacityConfidence: "heuristic",
        capacityProfile: {
          immediateUsd: 10_000_000,
          dailyLimitUsd: 5_000_000,
          queuedUsd: 12_000_000,
          eventualUsd: null,
          scoringUsd: 5_000_000,
          scoringHorizon: "daily",
          capacityProfileConfidence: "heuristic",
          modeledExitSizeUsd: 1_000_000,
        },
        capacityKind: "live-proxy-validated",
        freshnessKind: "verified-source-timestamp",
        capacityBasis: "issuer-term-redemption",
        capacitySemantics: "eventual-only",
        confidenceDetails: {
          capacityEvidenceQuality: 40,
          feeEvidenceQuality: 50,
          routeStatusFreshness: 60,
          holderCohortBreadth: 70,
          sourceQuality: 80,
          reviewedDocAgeDays: 30,
          reasons: ["heuristic capacity"],
        },
        sourceTimestamp: 1_699_999_900,
        sourceUrls: ["https://example.com/redemption.json"],
        settlementDelaySec: 3600,
        queueDepthUsd: 12_000_000,
        dailyLimitUsd: 5_000_000,
        minRedeemUsd: 100_000,
        liveHolderEligibility: "whitelisted-primary",
        feeConfidence: "undisclosed-reviewed",
        feeModelKind: "undisclosed-reviewed",
        modelConfidence: "low",
        immediateCapacityUsd: 10_000_000,
        immediateCapacityRatio: 1,
        eventualRedeemabilityScore: 72,
        feeBps: null,
        costScenarioScores: {
          retail: 30,
          activeUser: 40,
          institutional: null,
        },
        routeExitCorrelation: "independent-issuer-rail",
        queueEnabled: false,
        methodologyVersion: "1.1",
        updatedAt: 1_700_000_000,
        docs: {
          sources: [
            {
              label: "Docs",
              url: "https://example.com/docs",
              supports: ["route", "capacity"],
            },
          ],
        },
        ...overrides,
      },
    },
    methodology: {
      version: "1.1",
      versionLabel: "v1.1",
      currentVersion: "1.1",
      currentVersionLabel: "v1.1",
      changelogPath: "/methodology/redemption-backstops",
      asOf: 1_700_000_000,
      isCurrent: true,
      componentWeights: {
        access: 0.15,
        settlement: 0.15,
        executionCertainty: 0.2,
        capacity: 0.25,
        outputAssetQuality: 0.15,
        cost: 0.1,
      },
      effectiveExitModel: {
        model: "best-path",
        diversificationFactor: 0.15,
      },
      routeFamilyCaps: {
        queueRedeem: 80,
        offchainIssuer: 65,
      },
    },
    updatedAt: 1_700_000_000,
  };
}

describe("smoke-api redemption backstop assertion", () => {
  it("accepts a valid redemption-backstops response", () => {
    expect(
      ENDPOINT_ASSERTIONS["/api/redemption-backstops"]({
        status: 200,
        body: makeRedemptionBody(),
      }),
    ).toBe("1 redemption entries");
  });

  it("rejects invalid enum values", () => {
    expect(() =>
      ENDPOINT_ASSERTIONS["/api/redemption-backstops"]({
        status: 200,
        body: makeRedemptionBody({ routeFamily: "bad-family" }),
      }),
    ).toThrow("routeFamily");
  });

  it("rejects malformed docs URLs", () => {
    expect(() =>
      ENDPOINT_ASSERTIONS["/api/redemption-backstops"]({
        status: 200,
        body: makeRedemptionBody({
          docs: {
            sources: [
              {
                label: "Docs",
                url: "not-a-url",
                supports: ["route"],
              },
            ],
          },
        }),
      }),
    ).toThrow();
  });

  it("rejects non-http source URLs", () => {
    expect(() =>
      ENDPOINT_ASSERTIONS["/api/redemption-backstops"]({
        status: 200,
        body: makeRedemptionBody({
          sourceUrls: ["ftp://example.com/redemption.json"],
        }),
      }),
    ).toThrow("http(s)");
  });
});
