import { describe, expect, it } from "vitest";
import { derivePysSourceRiskPenalty } from "@shared/lib/yield-scoring";
import {
  buildYieldSourceRisk,
  findStaleVenueRiskScores,
  resolveDependencyConcentration,
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
  // Phase 2 (yield v8.3) scored long-tail venues — derived tiers.
  clearpool: "high",
  goldfinch: "high",
  "3jane-lending": "high",
  centrifuge: "medium",
  "flux-finance": "medium",
  cap: "medium",
  avantis: "high",
  "euler-v2": "low",
  gearbox: "low",
  "curve-llamalend": "low",
  "fluid-lending": "low",
  dolomite: "medium",
  exactly: "low",
  "fraxlend-v2": "medium",
  "aave-v4": "low",
  "compound-v2": "low",
  "felix-cdp": "medium",
  frankencoin: "low",
  "kamino-lend": "low",
  justlend: "low",
  "benqi-lending": "low",
  "aries-markets": "high",
  "scallop-lend": "medium",
  "echelon-market": "medium",
  "blend-pools-v2": "low",
  "jupiter-lend": "medium",
  "hyperlend-pooled": "medium",
  curvance: "high",
  "sovryn-dex": "medium",
  // FU3 Wave 2 — derived tiers.
  truefi: "high",
  "radiant-v2": "high",
  "wildcat-protocol": "high",
  "gains-network": "low",
  "venus-core-pool": "low",
  "moonwell-lending": "low",
  "silo-v2": "medium",
  "sturdy-v2": "medium",
  vesper: "medium",
  "convex-finance": "low",
  liqwid: "low",
  "lista-lending": "low",
  loopscale: "high",
  "navi-lending": "low",
  "zest-v2": "medium",
  resupply: "medium",
  termmax: "medium",
  upshift: "high",
  tectonic: "medium",
  "openeden-usdo": "medium",
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
      // Reviewer provenance lives on the entry itself; every enrolled protocol carries both.
      expect(config.evidence?.length ?? 0, protocol).toBeGreaterThan(0);
      expect(config.rationale?.length ?? 0, protocol).toBeGreaterThan(0);
    }
  });

  // The original blue-chip venues (pre-Phase-2) were `low` = 0 penalty; that exact
  // no-op must be preserved by the weighted curve.
  const ORIGINAL_BLUE_CHIP_NO_OP = [
    "aave-v3",
    "compound-v3",
    "sparklend",
    "spark-savings",
    "yearn",
    "yearn-finance",
    "pendle",
  ] as const;

  it("preserves the blue-chip no-op and keeps every venue penalty on the curve within bounds", () => {
    for (const protocol of ORIGINAL_BLUE_CHIP_NO_OP) {
      const config = YIELD_RISK_CONFIG[protocol];
      expect(venueRiskTierOf(config), protocol).toBe("low");
      expect(derivePysSourceRiskPenalty({ venueRiskWeighted: venueRiskWeightedOf(config) }), protocol).toBe(1);
    }

    for (const protocol of YIELD_RISK_CONFIG_PROTOCOLS) {
      const config = YIELD_RISK_CONFIG[protocol];
      const weighted = venueRiskWeightedOf(config);
      const penalty = derivePysSourceRiskPenalty({ venueRiskWeighted: weighted });
      // Penalty is exactly the continuous curve, and stays within sane bounds.
      expect(penalty, protocol).toBeCloseTo(1 + Math.max(0, weighted - 2.0) * 0.15, 6);
      expect(penalty, protocol).toBeGreaterThanOrEqual(1);
      expect(penalty, protocol).toBeLessThanOrEqual(1.45);
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
    expect(derivePysSourceRiskPenalty({ venueRiskWeighted: venueRiskWeightedOf(reviewedMorphoBlue!) })).toBeCloseTo(
      1.135,
      5,
    );
    expect(derivePysSourceRiskPenalty({ venueRiskWeighted: venueRiskWeightedOf(reviewedMaple!) })).toBeCloseTo(
      1.1125,
      5,
    );
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

  it("agrees with Yearn's published yvUSDC risk report (calibration anchor)", () => {
    // Yearn's own report scores yvUSDC 1.3/5 "Minimal". Its funded legs are
    // spark-savings (sUSDS) + sparklend; both must derive to `low` so our tiering
    // neither over- nor under-penalizes the vault vs Yearn's external assessment.
    // Reviewed evidence is owned by the source-risk metadata; change history is
    // recorded in the structured yield methodology changelog.
    for (const venue of ["spark-savings", "sparklend"] as const) {
      const config = resolveReviewedYieldRiskConfig(venue);
      expect(config, venue).not.toBeNull();
      expect(venueRiskTierOf(config!), venue).toBe("low");
      expect(venueRiskWeightedOf(config!), venue).toBeLessThan(2.5);
    }
    // The single-ecosystem (Sky) concentration Yearn flags as its dominant risk —
    // which per-venue tiering structurally misses — is captured separately.
    expect(resolveDependencyConcentration("yvusdc-yearn")?.ecosystem).toBe("Sky");
    expect(resolveDependencyConcentration("yvusdc-yearn")?.severity).toBe("medium");
  });

  it("flags venue-risk scores older than the max age for re-review", () => {
    // Every entry was reviewed 2026-05-15..2026-07-01, so nothing is stale soon after.
    expect(findStaleVenueRiskScores(Date.parse("2026-06-16T00:00:00Z"))).toEqual([]);

    // ~109 days after the oldest cohort (2026-05-15), those entries cross 90d.
    const stale = findStaleVenueRiskScores(Date.parse("2026-09-01T00:00:00Z"));
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.every((s) => s.ageDays > 90)).toBe(true);
    expect(stale.map((s) => s.protocol)).toContain("aave-v3"); // reviewed 2026-05-15
    expect(stale.map((s) => s.protocol)).not.toContain("clearpool"); // reviewed 2026-06-15 (~78d)
    expect(stale[0]!.ageDays).toBeGreaterThanOrEqual(stale[stale.length - 1]!.ageDays); // oldest first
  });

  it("resolves reviewer-set dependency concentration by stablecoin id", () => {
    const yvusdc = resolveDependencyConcentration("yvusdc-yearn");
    expect(yvusdc?.ecosystem).toBe("Sky");
    expect(yvusdc?.severity).toBe("medium");
    expect(yvusdc?.note.length ?? 0).toBeGreaterThan(0);
    expect(resolveDependencyConcentration("usdc-circle")).toBeNull();
    expect(resolveDependencyConcentration(null)).toBeNull();

    // Single-curator MetaMorpho vaults: surfaced at low severity (chip, no penalty)
    // because the medium morpho-blue venue tier already prices Morpho protocol risk.
    const gt = resolveDependencyConcentration("gtusdc-gauntlet");
    expect(gt?.ecosystem).toBe("Morpho (Gauntlet)");
    expect(gt?.severity).toBe("low");
    expect(resolveDependencyConcentration("steakusdc-steakhouse")?.ecosystem).toBe("Morpho (Steakhouse)");
    // low severity adds no penalty (avoids double-counting the venue tier)
    expect(derivePysSourceRiskPenalty({ dependencyConcentrationSeverity: "low" })).toBe(1);
  });

  it("preserves opportunity-level risk evidence for published source-risk payloads", () => {
    const opportunityRisk = {
      opportunityClass: "lending" as const,
      underlyingSafetyScore: 82,
      opportunitySafetyScore: 77,
      opportunitySafetyPenalty: 5,
      venueReviewed: true,
      missingCriticalEvidence: [],
    };

    const sourceRisk = buildYieldSourceRisk({
      source: makeSource({
        yieldType: "lending-opportunity",
        sourceRisk: { opportunityRisk },
      }),
      provenance: { sourceAgeSeconds: 300 },
      isBest: true,
    });

    expect(sourceRisk.opportunityRisk).toEqual(opportunityRisk);
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
