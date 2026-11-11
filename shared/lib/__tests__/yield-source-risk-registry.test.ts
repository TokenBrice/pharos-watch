import { describe, expect, it } from "vitest";
import YIELD_RISK_EVIDENCE from "@shared/data/yield-source-risk-evidence.json";
import {
  YIELD_RISK_CONFIG,
  YIELD_RISK_CONFIG_PROTOCOLS,
  YIELD_VARIANT_CHILD_VENUE_PROTOCOLS,
  findStaleVenueRiskScoresByEntries,
  resolveDependencyConcentration,
  resolveReviewedYieldRiskConfig,
  venueRiskTierOf,
} from "@shared/lib/yield-source-risk-registry";

// Structural-integrity gate for the canonical shared/lib registry. Worker
// publication code and the frontend both consume these reviewed values, so
// registry shape, evidence coverage, and resolver behavior are checked here rather
// than through a worker re-export shim. [Q-254]
describe("yield-source-risk-registry (shared/lib structural integrity)", () => {
  it("has a config entry for every enrolled protocol with 5 finite 1..5 category scores", () => {
    expect(YIELD_RISK_CONFIG_PROTOCOLS.length).toBeGreaterThan(0);
    for (const protocol of YIELD_RISK_CONFIG_PROTOCOLS) {
      const config = YIELD_RISK_CONFIG[protocol];
      expect(config, protocol).toBeDefined();
      for (const category of ["audits", "centralization", "fundsManagement", "liquidity", "operational"] as const) {
        const score = config.scores[category];
        expect(Number.isFinite(score), `${protocol}.${category}`).toBe(true);
        expect(score, `${protocol}.${category}`).toBeGreaterThanOrEqual(1);
        expect(score, `${protocol}.${category}`).toBeLessThanOrEqual(5);
      }
      expect(config.rationale?.length ?? 0, protocol).toBeGreaterThan(0);
      expect("evidence" in config, protocol).toBe(false);
      expect("reviewCadence" in config, protocol).toBe(false);
    }
  });

  it("keeps review evidence in 1:1 key lockstep with the runtime registry", () => {
    expect(Object.keys(YIELD_RISK_EVIDENCE)).toEqual([...YIELD_RISK_CONFIG_PROTOCOLS]);
    for (const protocol of YIELD_RISK_CONFIG_PROTOCOLS) {
      expect(YIELD_RISK_EVIDENCE[protocol].length, protocol).toBeGreaterThan(0);
    }
  });


  it("derives the expected tier for representative calibration anchors", () => {
    // aave-v3: blue-chip money market → low. morpho-blue: shared Morpho scores → medium.
    expect(venueRiskTierOf(YIELD_RISK_CONFIG["aave-v3"])).toBe("low");
    expect(venueRiskTierOf(YIELD_RISK_CONFIG["morpho-blue"])).toBe("medium");
    expect(resolveReviewedYieldRiskConfig("aave-v3")).toBe(YIELD_RISK_CONFIG["aave-v3"]);
    expect(resolveReviewedYieldRiskConfig("compound")).toBe(YIELD_RISK_CONFIG["compound-v3"]);
    expect(resolveReviewedYieldRiskConfig("unreviewed-protocol")).toBeNull();
    expect(resolveReviewedYieldRiskConfig(null)).toBeNull();
  });

  it("resolves every variant child identity to a reviewed lending venue", () => {
    // Venues whose review has not landed yet publish their issuing protocol and
    // stay `unknown` (PYS-neutral) until the coverage queue clears them.
    const UNREVIEWED_VENUES = new Set(["frax"]);
    const children = Object.entries(YIELD_VARIANT_CHILD_VENUE_PROTOCOLS);
    expect(children.length).toBeGreaterThan(0);
    for (const [childId, venue] of children) {
      expect(venue, childId).not.toBe("");
      const config = resolveReviewedYieldRiskConfig(venue);
      if (UNREVIEWED_VENUES.has(venue)) {
        // No reviewed config yet: the row publishes its issuing protocol, and the
        // venue tier stays PYS-neutral instead of borrowing a curated score.
        expect(config, childId).toBeNull();
      } else {
        expect(config, `${childId} -> ${venue}`).not.toBeNull();
        expect(venueRiskTierOf(config!), childId).not.toBe("unknown");
      }
    }
    // October wave anchors: the curator/brand is not the lending venue.
    expect(YIELD_VARIANT_CHILD_VENUE_PROTOCOLS["senpyusdmain-sentora"]).toBe("morpho-blue");
    expect(YIELD_VARIANT_CHILD_VENUE_PROTOCOLS["syrupusdg-maple"]).toBe("maple");
    expect(YIELD_VARIANT_CHILD_VENUE_PROTOCOLS["susdat-saturn"]).toBeUndefined();
  });

  it("resolves the A8 venue slugs and every variant child id", () => {
    // DeFiLlama project slugs that name an already-reviewed venue: the 11
    // `pendle-v2` rows and the legacy sDAI pool otherwise publish unknown tiers.
    expect(resolveReviewedYieldRiskConfig("pendle-v2")).toBe(YIELD_RISK_CONFIG.pendle);
    expect(resolveReviewedYieldRiskConfig("sdai")).toBe(YIELD_RISK_CONFIG["spark-savings"]);

    // Child wrappers whose `onchain:<childId>` / `linked-variant:<childId>` rows
    // carry no venue in the key: the child-id map is their only venue source.
    for (const childId of [
      "stusds-sky",
      "susds-sky",
      "stcusd-cap",
      "scrvusd-curve",
      "savusd-avant",
      "sfrxusd-frax",
      "susn-noon",
      "susde-ethena",
      "wsrusd-reservoir",
    ]) {
      const venue = YIELD_VARIANT_CHILD_VENUE_PROTOCOLS[childId];
      expect(venue, childId).toBeTruthy();
      const reviewed = resolveReviewedYieldRiskConfig(venue);
      // A reviewed venue must derive a real tier; an unreviewed one stays unknown
      // (never backfilled) but still publishes a venue instead of null.
      if (reviewed) expect(venueRiskTierOf(reviewed), childId).not.toBe("unknown");
    }
    expect(resolveReviewedYieldRiskConfig(YIELD_VARIANT_CHILD_VENUE_PROTOCOLS["susds-sky"]))
      .toBe(YIELD_RISK_CONFIG["spark-savings"]);
    expect(resolveReviewedYieldRiskConfig(YIELD_VARIANT_CHILD_VENUE_PROTOCOLS["stcusd-cap"]))
      .toBe(YIELD_RISK_CONFIG.cap);
  });

  it("resolves reviewer-set dependency concentration by stablecoin id", () => {
    // Sky remains yvUSDC's largest ecosystem after allocation diversification.
    const yvusdc = resolveDependencyConcentration("yvusdc-yearn");
    expect(yvusdc?.ecosystem).toBe("Sky");
    expect(yvusdc?.severity).toBe("low");
    expect(resolveDependencyConcentration("usdc-circle")).toBeNull();
    expect(resolveDependencyConcentration(null)).toBeNull();
  });

  it("flags entries strictly older than the quarterly 90-day bound, most-stale first", () => {
    const baseMs = Date.parse("2026-01-01T00:00:00Z");
    const reviewedAt = (daysOld: number) =>
      new Date(baseMs - daysOld * 86_400_000).toISOString().slice(0, 10);
    const stale = findStaleVenueRiskScoresByEntries(
      // Deliberately unsorted to require the sort, not the input order.
      {
        "controlled-90d": { reviewedAt: reviewedAt(90) },
        "controlled-120d": { reviewedAt: reviewedAt(120) },
        "controlled-91d": { reviewedAt: reviewedAt(91) },
        "controlled-100d": { reviewedAt: reviewedAt(100) },
      },
      baseMs,
    );
    expect(stale.map((entry) => [entry.protocol, entry.ageDays])).toEqual([
      ["controlled-120d", 120],
      ["controlled-100d", 100],
      ["controlled-91d", 91],
    ]);
  });

});
