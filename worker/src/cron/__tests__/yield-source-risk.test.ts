import { describe, expect, it } from "vitest";
import { derivePysSourceRiskPenalty } from "@shared/lib/yield-scoring";
import {
  buildYieldSourceRisk,
  resolveReviewedYieldRiskConfig,
  venueRiskTierOf,
  venueRiskWeightedOf,
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

const WAVE_2_REVIEWED_TIERS = {
  "aave-v3": "low",
  "compound-v3": "low",
  sparklend: "low",
  "spark-savings": "low",
  maple: "medium",
  yearn: "low",
  "yearn-finance": "low",
  morpho: "medium",
  "morpho-v1": "medium",
  "morpho-blue": "medium",
  pendle: "low",
  beefy: "medium",
} as const;

describe("yield source-risk registry", () => {
  it("provides reviewed candidate entries with 5-category scores and evidence for every tracked tier", () => {
    expect(YIELD_RISK_CONFIG_REVIEW_CADENCE).toBe("monthly-yield-coverage-audit");

    for (const protocol of YIELD_RISK_CONFIG_PROTOCOLS) {
      const config = YIELD_RISK_CONFIG[protocol];
      const expectedTier = WAVE_2_REVIEWED_TIERS[protocol];
      expect(config.reviewCadence, protocol).toBe(YIELD_RISK_CONFIG_REVIEW_CADENCE);
      // Tier is now DERIVED from the weighted 5-category score, not hand-set.
      expect(venueRiskTierOf(config), protocol).toBe(expectedTier);
      expect(venueRiskTierOf(config), protocol).not.toBe("unknown");
      for (const category of ["audits", "centralization", "fundsManagement", "liquidity", "operational"] as const) {
        expect(config.scores[category], `${protocol}.${category}`).toBeGreaterThanOrEqual(1);
        expect(config.scores[category], `${protocol}.${category}`).toBeLessThanOrEqual(5);
      }
      expect(config.evidence.length, protocol).toBeGreaterThan(0);
      expect(config.rationale.length, protocol).toBeGreaterThan(0);
    }
  });

  it("preserves calibration: low venues stay no-op, medium venues land in-band", () => {
    for (const protocol of YIELD_RISK_CONFIG_PROTOCOLS) {
      const config = YIELD_RISK_CONFIG[protocol];
      const tier = venueRiskTierOf(config);
      const penalty = derivePysSourceRiskPenalty({ venueRiskWeighted: venueRiskWeightedOf(config) });
      if (tier === "low") {
        // Legacy `low` was a 0 penalty; that no-op is preserved exactly.
        expect(penalty, protocol).toBe(1);
      } else {
        // Legacy `medium` was a flat +0.15; scored mediums are now differentiated near it.
        expect(penalty, protocol).toBeGreaterThan(1);
        expect(penalty, protocol).toBeLessThanOrEqual(1.25);
      }
    }
  });

  it("derives the continuous PYS penalty from reviewed weighted scores", () => {
    const reviewedAave = resolveReviewedYieldRiskConfig("aave-v3");
    const reviewedMorphoBlue = resolveReviewedYieldRiskConfig("morpho-blue");
    const reviewedPendle = resolveReviewedYieldRiskConfig("pendle");
    const reviewedMaple = resolveReviewedYieldRiskConfig("maple");
    const reviewedBeefy = resolveReviewedYieldRiskConfig("beefy");
    const unknownVenue = resolveReviewedYieldRiskConfig("unreviewed-protocol");

    expect(reviewedAave && venueRiskTierOf(reviewedAave)).toBe("low");
    expect(reviewedMorphoBlue && venueRiskTierOf(reviewedMorphoBlue)).toBe("medium");
    expect(reviewedPendle && venueRiskTierOf(reviewedPendle)).toBe("low");
    expect(reviewedMaple && venueRiskTierOf(reviewedMaple)).toBe("medium");
    expect(reviewedBeefy && venueRiskTierOf(reviewedBeefy)).toBe("medium");
    expect(unknownVenue).toBeNull();
    // Low venues: zero venue contribution (weighted <= 2.0).
    expect(derivePysSourceRiskPenalty({ venueRiskWeighted: venueRiskWeightedOf(reviewedAave!) })).toBe(1);
    expect(derivePysSourceRiskPenalty({ venueRiskWeighted: venueRiskWeightedOf(reviewedPendle!) })).toBe(1);
    // Medium venues: continuous curve (weighted-2.0)*0.15, near the legacy +0.15.
    expect(derivePysSourceRiskPenalty({ venueRiskWeighted: venueRiskWeightedOf(reviewedMorphoBlue!) })).toBeCloseTo(1.135, 5);
    expect(derivePysSourceRiskPenalty({ venueRiskWeighted: venueRiskWeightedOf(reviewedMaple!) })).toBeCloseTo(1.18, 5);
  });

  it("publishes the reviewed venue tier on built source-risk evidence", () => {
    const sourceRisk = buildYieldSourceRisk({
      source: makeSource(),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });

    expect(sourceRisk).toMatchObject({
      sourceRiskPenalty: 1,
      venueProtocol: "aave-v3",
      venueChain: "ethereum",
      venueRiskTier: "low",
      venueRiskScores: { audits: 1, centralization: 2, fundsManagement: 1, liquidity: 1, operational: 1 },
    });
    expect(sourceRisk.venueRiskWeighted).toBeCloseTo(1.3, 5);
  });

  it("treats fixed-yield Pendle rows as lending-market opportunities with reviewed venue risk", () => {
    const sourceRisk = buildYieldSourceRisk({
      source: makeSource({
        sourceKey: "protocol-api:pendle:ethereum:0xpool",
        dataSource: "protocol-api",
        yieldType: "fixed-yield",
      }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });

    expect(sourceRisk).toMatchObject({
      deploymentPlace: "lending-market",
      venueProtocol: "pendle",
      venueChain: "ethereum",
      venueRiskTier: "low",
    });
  });

  it("classifies fixed-yield Pendle PT rows as external lending-market exposure", () => {
    const sourceRisk = buildYieldSourceRisk({
      source: makeSource({
        sourceKey: "protocol-api:pendle:ethereum:0xpt",
        dataSource: "protocol-api",
        yieldType: "fixed-yield",
      }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: false,
    });

    expect(sourceRisk).toMatchObject({
      deploymentPlace: "lending-market",
      venueProtocol: "pendle",
      venueChain: "ethereum",
      venueRiskTier: "low",
    });
  });

  it("normalizes sourceRiskScore from the resolved sourceRiskPenalty", () => {
    const neutralSource = buildYieldSourceRisk({
      source: makeSource({ sourceRiskPenalty: 1 }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });
    expect(neutralSource.sourceRiskScore).toBe(0);

    const elevatedSource = buildYieldSourceRisk({
      source: makeSource({ sourceRiskPenalty: 1.75 }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });
    expect(elevatedSource.sourceRiskScore).toBe(50);

    const maxedSource = buildYieldSourceRisk({
      source: makeSource({ sourceRiskPenalty: 2.5 }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });
    expect(maxedSource.sourceRiskScore).toBe(100);
  });
});
