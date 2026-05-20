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

const V8_13_REVIEWED_TIERS = {
  "aave-v3": "low",
  "compound-v3": "low",
  sparklend: "low",
  "morpho-blue": "medium",
} as const;

describe("yield source-risk registry", () => {
  it("provides reviewed candidate entries with explicit evidence for non-unknown tiers", () => {
    expect(YIELD_RISK_CONFIG_REVIEW_CADENCE).toBe("monthly-yield-coverage-audit");

    for (const protocol of YIELD_RISK_CONFIG_PROTOCOLS) {
      const config = YIELD_RISK_CONFIG[protocol];
      expect(config.reviewCadence, protocol).toBe(YIELD_RISK_CONFIG_REVIEW_CADENCE);
      if (Object.prototype.hasOwnProperty.call(V8_13_REVIEWED_TIERS, protocol)) {
        const expectedTier = V8_13_REVIEWED_TIERS[protocol as keyof typeof V8_13_REVIEWED_TIERS];
        expect(config.venueRiskTier, protocol).toBe(expectedTier);
        expect(config.evidence.length, protocol).toBeGreaterThan(0);
        expect(config.rationale.length, protocol).toBeGreaterThan(0);
      } else {
        expect(config.venueRiskTier, protocol).toBe("unknown");
        expect(config.rationale, protocol).toContain("unknown remains neutral");
        expect(config.evidence, protocol).toEqual([]);
      }
    }
  });

  it("derives matching PYS penalties for reviewed and pending tiers", () => {
    const reviewedAave = resolveReviewedYieldRiskConfig("aave-v3");
    const reviewedMorphoBlue = resolveReviewedYieldRiskConfig("morpho-blue");
    const pendingPendle = resolveReviewedYieldRiskConfig("pendle");
    const unknownVenue = resolveReviewedYieldRiskConfig("unreviewed-protocol");

    expect(reviewedAave?.venueRiskTier).toBe("low");
    expect(reviewedMorphoBlue?.venueRiskTier).toBe("medium");
    expect(pendingPendle?.venueRiskTier).toBe("unknown");
    expect(unknownVenue).toBeNull();
    expect(derivePysSourceRiskPenalty({ venueRiskTier: reviewedAave?.venueRiskTier })).toBe(1);
    expect(derivePysSourceRiskPenalty({ venueRiskTier: reviewedMorphoBlue?.venueRiskTier })).toBeCloseTo(1.15, 5);
    expect(derivePysSourceRiskPenalty({ venueRiskTier: pendingPendle?.venueRiskTier })).toBe(1);
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
