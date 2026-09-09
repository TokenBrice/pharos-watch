import { describe, expect, it } from "vitest";
import type { HealthResponse } from "@shared/types";
import { countPublicImpactOpenCircuits, isPublicImpactCircuitKey } from "@shared/lib/public-health";
import { makeActivePriceCoverage, makeHealthyHealthResponse, makeMissingActiveAsset } from "@/test-utils/status-fixtures";
import {
  getImpactedPublicSurfaces,
  getPublicDivergenceNotice,
  getPublicHealthWarningPresentation,
  getPublicMintBurnStatus,
  getPublicWorstCacheSummary,
} from "@/lib/status/public-status";

const BASE_HEALTH: HealthResponse = makeHealthyHealthResponse();

describe("public status helpers", () => {
  it("renders active-price warnings with impacted assets without a public surface incident", () => {
    const health: HealthResponse = {
      ...BASE_HEALTH,
      status: "healthy",
      warnings: ["active-price-coverage-incomplete:nxusd-nereus,test-dollar"],
      activePriceCoverage: makeActivePriceCoverage([
        makeMissingActiveAsset({
          stablecoinId: "nxusd-nereus",
          symbol: "NXUSD",
          marketCapUsd: 1_500_000,
          consecutiveMissingGenerations: 2,
          alertEligible: true,
        }),
        makeMissingActiveAsset(),
      ]),
    };

    expect(getPublicHealthWarningPresentation(health.warnings[0]!, health)).toEqual({
      title: "Stablecoin price coverage",
      detail:
        "Live prices are unavailable for 2 active assets: NXUSD and TUSD. Stablecoin listings and price-dependent analytics may be incomplete until coverage recovers.",
    });
    expect(getImpactedPublicSurfaces(health).some((surface) => surface.id === "active-price-coverage")).toBe(false);
  });

  it("degrades mint/burn status when the critical writer lane is unhealthy despite fresh sync age", () => {
    const sync = {
      ...BASE_HEALTH.mintBurn.sync,
      criticalLaneHealthy: false,
      warning: "Critical mint/burn lane last run errored; cached or partial data may be served.",
    };

    expect(getPublicMintBurnStatus(sync)).toBe("degraded");

    const impacted = getImpactedPublicSurfaces({
      ...BASE_HEALTH,
      mintBurn: {
        ...BASE_HEALTH.mintBurn,
        sync,
      },
    });

    expect(impacted).toContainEqual(expect.objectContaining({ id: "mint-burn", tone: "degraded" }));
  });

  it("treats missing cache rows as stale in the worst cache summary", () => {
    const summary = getPublicWorstCacheSummary({
      stablecoins: {
        ageSeconds: null,
        maxAge: 900,
        healthy: false,
      },
    });

    expect(summary).toEqual({
      ratio: null,
      status: "stale",
      impactedCount: 1,
    });
  });

  it("selects the worst severity across caches and counts every impacted cache", () => {
    const summary = getPublicWorstCacheSummary({
      stablecoins: { ageSeconds: 11_700, maxAge: 900, healthy: false }, // ratio 13 → stale
      "stablecoin-charts": { ageSeconds: 8_100, maxAge: 900, healthy: false }, // ratio 9 → degraded
      "fx-rates": { ageSeconds: 90, maxAge: 900, healthy: true }, // ratio 0.1 → healthy
    });

    expect(summary).toEqual({ ratio: 13, status: "stale", impactedCount: 2 });
  });

  it("breaks severity ties by the largest freshness ratio regardless of insertion order", () => {
    const caches = {
      "stablecoin-charts": { ageSeconds: 880, maxAge: 100, healthy: false }, // ratio 8.8 → degraded
      "fx-rates": { ageSeconds: 920, maxAge: 100, healthy: false }, // ratio 9.2 → degraded
    };

    expect(getPublicWorstCacheSummary(caches)).toEqual({ ratio: 9.2, status: "degraded", impactedCount: 2 });
    expect(
      getPublicWorstCacheSummary({ "fx-rates": caches["fx-rates"], "stablecoin-charts": caches["stablecoin-charts"] }),
    ).toEqual({ ratio: 9.2, status: "degraded", impactedCount: 2 });
  });

  it("prefers a missing freshness row over a numeric ratio within a severity tie, in any order", () => {
    const missingRow = { ageSeconds: null, maxAge: 900, healthy: false }; // stale, no freshness ratio
    const numericStale = { ageSeconds: 1_300, maxAge: 100, healthy: false }; // ratio 13 → stale

    expect(getPublicWorstCacheSummary({ stablecoins: missingRow, "stablecoin-charts": numericStale })).toEqual({
      ratio: null,
      status: "stale",
      impactedCount: 2,
    });
    expect(getPublicWorstCacheSummary({ "stablecoin-charts": numericStale, stablecoins: missingRow })).toEqual({
      ratio: null,
      status: "stale",
      impactedCount: 2,
    });
  });

  it("treats source-degraded as informational — fresh cache stays healthy impact", () => {
    const ratio = 120 / 3_600;
    const summary = getPublicWorstCacheSummary({
      "fx-rates": {
        ageSeconds: 120,
        maxAge: 3_600,
        healthy: true,
        sourceStatus: "degraded",
      },
    });

    expect(summary).toEqual({
      ratio,
      status: "healthy",
      impactedCount: 0,
    });

    const impacted = getImpactedPublicSurfaces({
      ...BASE_HEALTH,
      caches: {
        "fx-rates": {
          ageSeconds: 120,
          maxAge: 3_600,
          healthy: true,
          sourceStatus: "degraded",
        },
      },
    });

    expect(impacted).not.toContainEqual(expect.objectContaining({ id: "cache-fx-rates", tone: "degraded" }));
  });

  it("excludes optional circuit breakers from public-impact circuit counts", () => {
    expect(isPublicImpactCircuitKey("live-reserves:ousg-ondo")).toBe(false);
    expect(isPublicImpactCircuitKey("dexscreener-liquidity")).toBe(false);
    expect(isPublicImpactCircuitKey("dexscreener-search")).toBe(false);
    expect(isPublicImpactCircuitKey("usx-stable-pools")).toBe(false);
    expect(isPublicImpactCircuitKey("aznd-curve-pool")).toBe(false);
    expect(isPublicImpactCircuitKey("mento-broker")).toBe(false);
    expect(isPublicImpactCircuitKey("kava-pricefeed")).toBe(false);
    expect(isPublicImpactCircuitKey("jusd-citrea-bridge")).toBe(false);
    expect(isPublicImpactCircuitKey("defillama-stablecoins")).toBe(true);

    const circuit = {
      state: "open",
      consecutiveFailures: 3,
      lastFailureAt: 1_700_000_000,
      lastSuccessAt: null,
      openedAt: 1_700_000_000,
    } as const;

    expect(
      countPublicImpactOpenCircuits({
        "live-reserves:ousg-ondo": circuit,
        "live-reserves:mtbill-midas": circuit,
        "dexscreener-liquidity": circuit,
        "dexscreener-search": circuit,
        "usx-stable-pools": circuit,
        "aznd-curve-pool": circuit,
        "mento-broker": circuit,
        "kava-pricefeed": circuit,
        "jusd-citrea-bridge": circuit,
      }),
    ).toBe(0);
  });
});

describe("getImpactedPublicSurfaces", () => {
  it("returns an empty list when everything is healthy", () => {
    const surfaces = getImpactedPublicSurfaces(BASE_HEALTH);
    expect(surfaces).toEqual([]);
  });

  it("does not surface a degraded price-coverage callout for a transient (non-alert-eligible) miss", () => {
    // status stays "incomplete" for observability, but a merely un-repriced miss
    // is not alert-eligible — the hero is healthy, so the surface must be too.
    const transient: HealthResponse = {
      ...BASE_HEALTH,
      status: "healthy",
      warnings: [],
      activePriceCoverage: makeActivePriceCoverage([makeMissingActiveAsset()]),
    };
    expect(getImpactedPublicSurfaces(transient).some((s) => s.id === "active-price-coverage")).toBe(false);
  });

  it("keeps alert-eligible incomplete price coverage warning-only", () => {
    const alertEligible: HealthResponse = {
      ...BASE_HEALTH,
      status: "healthy",
      warnings: ["active-price-coverage-incomplete:test-dollar"],
      activePriceCoverage: makeActivePriceCoverage([makeMissingActiveAsset({ alertEligible: true })]),
    };
    expect(getImpactedPublicSurfaces(alertEligible).some((surface) => surface.id === "active-price-coverage")).toBe(false);
  });

  it("fails closed with a degraded surface when exact price coverage is unknown", () => {
    const health: HealthResponse = {
      ...BASE_HEALTH,
      activePriceCoverage: makeActivePriceCoverage([], {
        status: "unknown",
        expectedActiveCount: 0,
        presentActiveCount: 0,
        pricedActiveCount: 0,
        observedAt: null,
      }),
    };

    expect(getImpactedPublicSurfaces(health)).toContainEqual(
      expect.objectContaining({ id: "active-price-coverage", tone: "degraded" }),
    );
  });

  it("surfaces both mint-burn and blacklist when both are degraded", () => {
    const health: HealthResponse = {
      ...BASE_HEALTH,
      mintBurn: {
        ...BASE_HEALTH.mintBurn,
        majorStaleCount: 2,
        staleMajorSymbols: ["USDT", "USDC"],
      },
      blacklist: {
        ...BASE_HEALTH.blacklist,
        totalEvents: 1000,
        missingAmounts: 200,
        recentMissingAmounts: 25,
        missingRatio: 0.2,
      },
    };
    const surfaces = getImpactedPublicSurfaces(health);
    const ids = surfaces.map((s) => s.id);
    expect(ids).toContain("mint-burn");
    expect(ids).toContain("blacklist");
  });

  it("maps a stale mint/burn lane to the stale public surface tone", () => {
    const staleHealth: HealthResponse = {
      ...BASE_HEALTH,
      mintBurn: {
        ...BASE_HEALTH.mintBurn,
        sync: {
          ...BASE_HEALTH.mintBurn.sync,
          freshnessStatus: "stale",
        },
      },
    };

    expect(getImpactedPublicSurfaces(staleHealth)).toContainEqual(
      expect.objectContaining({ id: "mint-burn", tone: "stale" }),
    );
  });
});

describe("getPublicMintBurnStatus — additional fixtures", () => {
  it("healthy when sync is fresh and critical lane is healthy", () => {
    expect(getPublicMintBurnStatus(BASE_HEALTH.mintBurn.sync)).toBe("healthy");
  });

  it("stale when freshnessStatus is stale regardless of critical lane", () => {
    const sync = {
      ...BASE_HEALTH.mintBurn.sync,
      freshnessStatus: "stale" as const,
      criticalLaneHealthy: false,
    };
    expect(getPublicMintBurnStatus(sync)).toBe("stale");
  });
});

describe("getPublicDivergenceNotice", () => {
  it("in-sync when equal", () => {
    expect(getPublicDivergenceNotice("healthy", "healthy").kind).toBe("in-sync");
    expect(getPublicDivergenceNotice("degraded", "degraded").kind).toBe("in-sync");
  });
  it("health-degraded-probes-ok when health > probes and probes healthy", () => {
    expect(getPublicDivergenceNotice("degraded", "healthy").kind).toBe("health-degraded-probes-ok");
  });
  it("probes-degraded-health-ok in the inverse", () => {
    expect(getPublicDivergenceNotice("healthy", "degraded").kind).toBe("probes-degraded-health-ok");
  });
  it("both-degraded-different-severity when both degraded but different", () => {
    expect(getPublicDivergenceNotice("degraded", "stale").kind).toBe("both-degraded-different-severity");
  });
});
