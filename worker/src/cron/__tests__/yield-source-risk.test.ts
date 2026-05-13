import { describe, expect, it } from "vitest";
import { derivePysSourceRiskPenalty } from "@shared/lib/yield-scoring";
import {
  buildYieldSourceRisk,
  resolveReviewedYieldRiskConfig,
  YIELD_RISK_CONFIG,
  YIELD_RISK_CONFIG_PROTOCOLS,
  YIELD_RISK_CONFIG_REVIEW_CADENCE,
} from "../yield-sync/source-risk";
import type { EvaluatedYieldSource } from "../yield-sync/evaluation-types";

function makeSource(overrides: Partial<EvaluatedYieldSource> = {}): EvaluatedYieldSource {
  return {
    sourceKey: "aave-v3-onchain:ethereum:0xasset",
    dataSource: "onchain",
    yieldType: "lending-vault",
    currentApy: 5,
    apyReward: null,
    sourceRisk: null,
    sourceRiskPenalty: 1,
    sourceDepthRatio: null,
    observationCount30d: null,
    sourceSwitchCount30d: null,
    venueProtocol: null,
    venueChain: null,
    ...overrides,
  } as EvaluatedYieldSource;
}

describe("yield source-risk registry", () => {
  it("provides reviewed candidate entries without assigning non-unknown tiers", () => {
    expect(YIELD_RISK_CONFIG_REVIEW_CADENCE).toBe("monthly-yield-coverage-audit");

    for (const protocol of YIELD_RISK_CONFIG_PROTOCOLS) {
      const config = YIELD_RISK_CONFIG[protocol];
      expect(config.venueRiskTier, protocol).toBe("unknown");
      expect(config.rationale, protocol).toContain("unknown remains neutral");
      expect(config.evidence, protocol).toEqual([]);
      expect(config.reviewCadence, protocol).toBe(YIELD_RISK_CONFIG_REVIEW_CADENCE);
    }
  });

  it("keeps reviewed unknown/default tiers neutral for PYS derivation", () => {
    const reviewedAave = resolveReviewedYieldRiskConfig("aave-v3");
    const unknownVenue = resolveReviewedYieldRiskConfig("unreviewed-protocol");

    expect(reviewedAave?.venueRiskTier).toBe("unknown");
    expect(unknownVenue).toBeNull();
    expect(derivePysSourceRiskPenalty({ venueRiskTier: reviewedAave?.venueRiskTier })).toBe(1);
    expect(derivePysSourceRiskPenalty({ venueRiskTier: unknownVenue?.venueRiskTier })).toBe(1);
  });

  it("publishes configured venue identity while preserving neutral unknown risk", () => {
    const sourceRisk = buildYieldSourceRisk({
      source: makeSource(),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });

    expect(sourceRisk).toMatchObject({
      sourceRiskPenalty: 1,
      venueProtocol: "aave-v3",
      venueChain: "ethereum",
      venueRiskTier: "unknown",
    });
    expect(derivePysSourceRiskPenalty({ venueRiskTier: sourceRisk.venueRiskTier })).toBe(1);
  });
});
