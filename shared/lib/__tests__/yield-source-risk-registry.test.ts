import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import YIELD_RISK_EVIDENCE from "@shared/data/yield-source-risk-evidence.json";
import {
  YIELD_RISK_CONFIG,
  YIELD_RISK_CONFIG_PROTOCOLS,
  YIELD_VARIANT_CHILD_VENUE_PROTOCOLS,
  findStaleVenueRiskScores,
  findStaleVenueRiskScoresByEntries,
  resolveDependencyConcentration,
  resolveReviewedYieldRiskConfig,
  venueRiskTierOf,
  venueRiskWeightedOf,
} from "@shared/lib/yield-source-risk-registry";

// Structural-integrity gate for the canonical shared/lib registry. Worker
// publication code and the frontend both consume these reviewed values, so
// registry shape, evidence coverage, and resolver bytes are pinned here rather
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

  it("keeps all 61 resolved runtime records byte-identical", () => {
    const bytes = JSON.stringify(
      YIELD_RISK_CONFIG_PROTOCOLS.map((protocol) => {
        const config = resolveReviewedYieldRiskConfig(protocol);
        expect(config, protocol).not.toBeNull();
        const runtimeConfig = { ...config! } as Record<string, unknown>;
        // These explicitly retired, unread fields are excluded from the
        // pre-split baseline; every remaining resolver byte is pinned.
        delete runtimeConfig.evidence;
        delete runtimeConfig.reviewCadence;
        return [protocol, runtimeConfig];
      }),
    );

    expect(YIELD_RISK_CONFIG_PROTOCOLS).toHaveLength(61);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "ff38bd2278f21af9c60ad0162b0b94b860a5f1d534eb62e311eef9d13abd4e53",
    );
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
    // yvUSDC's dominant risk (single-ecosystem Sky coupling) is captured here,
    // not via the per-venue tier — the canonical case the signal exists for.
    const yvusdc = resolveDependencyConcentration("yvusdc-yearn");
    expect(yvusdc?.ecosystem).toBe("Sky");
    expect(yvusdc?.severity).toBe("medium");
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

  it("keeps the default 90-day threshold and skips an unparseable reviewedAt", () => {
    const baseMs = Date.parse("2026-01-01T00:00:00Z");
    const stale = findStaleVenueRiskScoresByEntries(
      {
        "controlled-90d": { reviewedAt: new Date(baseMs - 90 * 86_400_000).toISOString().slice(0, 10) },
        "controlled-91d": { reviewedAt: new Date(baseMs - 91 * 86_400_000).toISOString().slice(0, 10) },
        "controlled-bad": { reviewedAt: "not-a-date" },
      },
      baseMs,
    );
    expect(stale.map((entry) => entry.protocol)).toEqual(["controlled-91d"]);
  });

  it("scans every reviewed venue and dependency-concentration entry by default", () => {
    for (const protocol of YIELD_RISK_CONFIG_PROTOCOLS) {
      expect(
        Number.isFinite(Date.parse(`${YIELD_RISK_CONFIG[protocol].reviewedAt}T00:00:00Z`)),
        protocol,
      ).toBe(true);
    }
    const stale = findStaleVenueRiskScores(Date.parse("2100-01-01T00:00:00Z"));
    expect(stale).toHaveLength(69);
    expect(stale.map((entry) => entry.protocol)).toEqual(
      expect.arrayContaining([
        ...YIELD_RISK_CONFIG_PROTOCOLS,
        "yvusdc-yearn",
        "gtusdc-gauntlet",
        "gtusdcp-gauntlet",
        "steakusdc-steakhouse",
        "bbqusdc-steakhouse",
        "steakusdt-steakhouse",
        "syrupusdc-maple",
        "syrupusdt-maple",
      ]),
    );
  });

  it("queues only the dependency-concentration reviews still past the quarterly bound", () => {
    const concentrationIds: Record<string, true> = {
      "yvusdc-yearn": true,
      "gtusdc-gauntlet": true,
      "gtusdcp-gauntlet": true,
      "steakusdc-steakhouse": true,
      "bbqusdc-steakhouse": true,
      "steakusdt-steakhouse": true,
      "syrupusdc-maple": true,
      "syrupusdt-maple": true,
    };
    // The 2026-09-23 drain re-reviewed the five Morpho curator notes against
    // live vault pages, so only the yvUSDC note is queued at the drain date.
    const staleAtDrain = findStaleVenueRiskScores(Date.parse("2026-09-23T00:00:00Z"))
      .filter((entry) => concentrationIds[entry.protocol]);
    expect(staleAtDrain.map((entry) => [entry.protocol, entry.ageDays])).toEqual([
      ["yvusdc-yearn", 100],
    ]);
    // The Maple pair crosses the 90-day bound inside the October audit window.
    const staleAtNextAudit = findStaleVenueRiskScores(Date.parse("2026-10-01T06:00:00Z"))
      .filter((entry) => concentrationIds[entry.protocol]);
    expect(staleAtNextAudit.map((entry) => [entry.protocol, entry.ageDays])).toEqual([
      ["yvusdc-yearn", 108],
      ["syrupusdc-maple", 92],
      ["syrupusdt-maple", 92],
    ]);
  });
});
