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
  it("provides reviewed candidate entries with explicit evidence for every tracked tier", () => {
    expect(YIELD_RISK_CONFIG_REVIEW_CADENCE).toBe("monthly-yield-coverage-audit");

    for (const protocol of YIELD_RISK_CONFIG_PROTOCOLS) {
      const config = YIELD_RISK_CONFIG[protocol];
      const expectedTier = WAVE_2_REVIEWED_TIERS[protocol];
      expect(config.reviewCadence, protocol).toBe(YIELD_RISK_CONFIG_REVIEW_CADENCE);
      expect(config.venueRiskTier, protocol).toBe(expectedTier);
      expect(config.venueRiskTier, protocol).not.toBe("unknown");
      expect(config.evidence.length, protocol).toBeGreaterThan(0);
      expect(config.rationale.length, protocol).toBeGreaterThan(0);
    }
  });

  it("derives matching PYS penalties for reviewed tiers", () => {
    const reviewedAave = resolveReviewedYieldRiskConfig("aave-v3");
    const reviewedMorphoBlue = resolveReviewedYieldRiskConfig("morpho-blue");
    const reviewedPendle = resolveReviewedYieldRiskConfig("pendle");
    const reviewedMaple = resolveReviewedYieldRiskConfig("maple");
    const reviewedBeefy = resolveReviewedYieldRiskConfig("beefy");
    const unknownVenue = resolveReviewedYieldRiskConfig("unreviewed-protocol");

    expect(reviewedAave?.venueRiskTier).toBe("low");
    expect(reviewedMorphoBlue?.venueRiskTier).toBe("medium");
    expect(reviewedPendle?.venueRiskTier).toBe("low");
    expect(reviewedMaple?.venueRiskTier).toBe("medium");
    expect(reviewedBeefy?.venueRiskTier).toBe("medium");
    expect(unknownVenue).toBeNull();
    expect(derivePysSourceRiskPenalty({ venueRiskTier: reviewedAave?.venueRiskTier })).toBe(1);
    expect(derivePysSourceRiskPenalty({ venueRiskTier: reviewedMorphoBlue?.venueRiskTier })).toBeCloseTo(1.15, 5);
    expect(derivePysSourceRiskPenalty({ venueRiskTier: reviewedPendle?.venueRiskTier })).toBe(1);
    expect(derivePysSourceRiskPenalty({ venueRiskTier: reviewedMaple?.venueRiskTier })).toBeCloseTo(1.15, 5);
    expect(derivePysSourceRiskPenalty({ venueRiskTier: reviewedBeefy?.venueRiskTier })).toBeCloseTo(1.15, 5);
    expect(derivePysSourceRiskPenalty({ venueRiskTier: unknownVenue?.venueRiskTier })).toBe(1);
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
    });
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
