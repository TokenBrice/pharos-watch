import { describe, expect, it } from "vitest";
import {
  YIELD_RISK_CONFIG,
  YIELD_RISK_CONFIG_PROTOCOLS,
  YIELD_RISK_CONFIG_REVIEW_CADENCE,
  findStaleVenueRiskScores,
  resolveDependencyConcentration,
  resolveReviewedYieldRiskConfig,
  venueRiskTierOf,
  venueRiskWeightedOf,
} from "@shared/lib/yield-source-risk-registry";

// Structural-integrity gate for the canonical shared/lib registry. The worker
// cron test (worker/src/cron/__tests__/yield-source-risk.test.ts) exercises the
// same exports through the worker re-export shim, but the registry is also read
// by the frontend (src/lib/yield-source-risk.ts) via deriveVenueRiskTier /
// dependencyConcentration; a shared/lib registry that drifts from these
// invariants should fail here, on the shared side, not only in worker. [Q-254]
describe("yield-source-risk-registry (shared/lib structural integrity)", () => {
  it("has a config entry for every enrolled protocol with 5 finite 1..5 category scores", () => {
    expect(YIELD_RISK_CONFIG_PROTOCOLS.length).toBeGreaterThan(0);
    for (const protocol of YIELD_RISK_CONFIG_PROTOCOLS) {
      const config = YIELD_RISK_CONFIG[protocol];
      expect(config, protocol).toBeDefined();
      expect(config.reviewCadence, protocol).toBe(YIELD_RISK_CONFIG_REVIEW_CADENCE);
      for (const category of ["audits", "centralization", "fundsManagement", "liquidity", "operational"] as const) {
        const score = config.scores[category];
        expect(Number.isFinite(score), `${protocol}.${category}`).toBe(true);
        expect(score, `${protocol}.${category}`).toBeGreaterThanOrEqual(1);
        expect(score, `${protocol}.${category}`).toBeLessThanOrEqual(5);
      }
      // Reviewer provenance lives on the entry itself; every enrolled protocol carries both.
      expect(config.evidence?.length ?? 0, protocol).toBeGreaterThan(0);
      expect(config.rationale?.length ?? 0, protocol).toBeGreaterThan(0);
    }
  });

  it("derives a non-unknown tier with a weighted score in [1,5] for every protocol", () => {
    for (const protocol of YIELD_RISK_CONFIG_PROTOCOLS) {
      const config = YIELD_RISK_CONFIG[protocol];
      const weighted = venueRiskWeightedOf(config);
      expect(Number.isFinite(weighted), protocol).toBe(true);
      expect(weighted, protocol).toBeGreaterThanOrEqual(1);
      expect(weighted, protocol).toBeLessThanOrEqual(5);
      expect(venueRiskTierOf(config), protocol).not.toBe("unknown");
    }
  });

  it("derives the expected tier for representative calibration anchors", () => {
    // aave-v3: blue-chip money market → low. morpho-blue: shared Morpho scores → medium.
    expect(venueRiskTierOf(YIELD_RISK_CONFIG["aave-v3"])).toBe("low");
    expect(venueRiskTierOf(YIELD_RISK_CONFIG["morpho-blue"])).toBe("medium");
    // Resolver (incl. aliases) returns the same entries; unknown venues are null.
    expect(resolveReviewedYieldRiskConfig("aave-v3")).toBe(YIELD_RISK_CONFIG["aave-v3"]);
    expect(resolveReviewedYieldRiskConfig("compound")).toBe(YIELD_RISK_CONFIG["compound-v3"]);
    expect(resolveReviewedYieldRiskConfig("unreviewed-protocol")).toBeNull();
    expect(resolveReviewedYieldRiskConfig(null)).toBeNull();
  });

  it("resolves reviewer-set dependency concentration by stablecoin id", () => {
    // yvUSDC's dominant risk (single-ecosystem Sky coupling) is captured here,
    // not via the per-venue tier — the canonical case the signal exists for.
    const yvusdc = resolveDependencyConcentration("yvusdc-yearn");
    expect(yvusdc?.ecosystem).toBe("Sky");
    expect(yvusdc?.severity).toBe("medium");
    expect(resolveDependencyConcentration("usdc-circle")).toBeNull();
    expect(resolveDependencyConcentration(null)).toBeNull();
  });

  it("applies the strict 90-day boundary independently of registry refresh dates", () => {
    const dates = YIELD_RISK_CONFIG_PROTOCOLS.map((protocol) => ({
      protocol,
      reviewedAt: YIELD_RISK_CONFIG[protocol].reviewedAt,
    }));
    for (const entry of dates) {
      expect(Number.isFinite(Date.parse(`${entry.reviewedAt}T00:00:00Z`)), entry.protocol).toBe(true);
    }
    const oldestDate = dates.map((entry) => entry.reviewedAt).sort()[0];
    const oldestMs = Date.parse(`${oldestDate}T00:00:00Z`);
    expect(findStaleVenueRiskScores(oldestMs + 90 * 86_400_000)).toEqual([]);
    expect(findStaleVenueRiskScores(oldestMs + 91 * 86_400_000).map((entry) => entry.protocol)).toEqual(
      dates.filter((entry) => entry.reviewedAt === oldestDate).map((entry) => entry.protocol),
    );
  });
});
