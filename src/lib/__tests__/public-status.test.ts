import { describe, expect, it } from "vitest";
import type { HealthResponse } from "@shared/types";
import { buildPublicHealthStatusCauses, normalizeStatusIssues } from "@/lib/status/issue-evidence-model";
import { countPublicImpactOpenCircuits, getCircuitImpactStatus, isPublicImpactCircuitKey } from "@shared/lib/public-health";
import { CIRCUIT_SOURCE_REGISTRY } from "@shared/lib/circuit-sources";
import { makeActivePriceCoverage, makeHealthyHealthResponse, makeMissingActiveAsset } from "@/test-utils/status-fixtures";
import {
  getAcknowledgedPriceGapNotice,
  describePublicHeadline,
  getAgeBandState,
  getPublicDivergenceNotice,
  getPublicHealthWarningPresentation,
  getPublicMintBurnStatus,
} from "@/lib/status/public-status";

const BASE_HEALTH: HealthResponse = makeHealthyHealthResponse();

describe("public status helpers", () => {
  it.each([
    ["info", "watch", false],
    ["warning", "impacting", true],
  ] as const)("classifies publication causes by %s severity, not their code alone", (severity, kind, publicImpacting) => {
    const issues = normalizeStatusIssues({
      overall: [], availability: [], dataQuality: [{
        code: "stablecoin_publication_incomplete", severity, layer: "data-quality", message: "Missing listing",
      }],
    });
    expect(issues[0]).toMatchObject({ kind, publicImpacting });
  });

  it.each([96_534_823.01, 500_000_000])("keeps publication UI impact aligned for a last-known cap of %s", (cap) => {
    const health: HealthResponse = {
      ...BASE_HEALTH,
      warnings: ["stablecoin-publication-incomplete:hbd-hive"],
      stablecoinPublication: {
        status: "incomplete", missingActiveIds: ["hbd-hive"], expectedActiveCount: 1,
        presentActiveCount: 0, waivedActiveCount: 0, waivedActiveIds: [], expiredWaiverIds: [], observedAt: BASE_HEALTH.timestamp,
      },
      activePriceCoverage: makeActivePriceCoverage([makeMissingActiveAsset({
        stablecoinId: "hbd-hive", marketCapUsd: null, lastKnownMarketCapUsd: cap,
        lastKnownMarketCapObservedAt: BASE_HEALTH.timestamp, lastKnownMarketCapSource: "supply_history",
      })]),
    };
    const presentation = getPublicHealthWarningPresentation(health.warnings[0]!, health);
    expect(presentation.detail).toContain("hbd-hive");
    expect(presentation.detail).not.toBe(health.warnings[0]);
  });
  it("explains an unnamed publication count mismatch without asserting missing assets", () => {
    const health: HealthResponse = {
      ...BASE_HEALTH,
      stablecoinPublication: {
        status: "incomplete", missingActiveIds: [], expectedActiveCount: 1, presentActiveCount: 0,
        waivedActiveCount: 0, waivedActiveIds: [], expiredWaiverIds: [], observedAt: BASE_HEALTH.timestamp,
      },
    };
    const presentation = getPublicHealthWarningPresentation("stablecoin-publication-incomplete:count-mismatch", health);
    expect(presentation.detail).toContain("counts");
    expect(presentation.detail).not.toContain("missing active assets");
  });
  it.each([
    ["heavy_scheduled_delivery_stalled", "Heavy scheduled delivery stalled", "Public delivery can remain healthy"],
    ["heavy_scheduler_liveness_unavailable", "Heavy scheduled delivery evidence unavailable", "cannot be claimed healthy"],
  ])("explains %s independently of public delivery", (warning, title, detail) => {
    const presentation = getPublicHealthWarningPresentation(warning, BASE_HEALTH);
    expect(presentation.title).toBe(title);
    expect(presentation.detail).toContain(detail);
  });
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

    const presentation = getPublicHealthWarningPresentation(health.warnings[0]!, health);
    expect(presentation.detail).toContain("NXUSD");
    expect(presentation.detail).not.toContain("TUSD");
  });

  it("renders long-running price gaps as catalog reviews, never as the raw slug", () => {
    const health: HealthResponse = {
      ...BASE_HEALTH,
      status: "degraded",
      warnings: ["active-price-coverage-critical-duration:nxusd-nereus"],
      activePriceCoverage: makeActivePriceCoverage([
        makeMissingActiveAsset({
          stablecoinId: "nxusd-nereus",
          symbol: "NXUSD",
          marketCapUsd: 1_500_000,
          consecutiveMissingGenerations: 700,
          alertEligible: true,
        }),
        makeMissingActiveAsset({ stablecoinId: "usdaf-asymmetry", symbol: "USDaf", consecutiveMissingGenerations: 1, alertEligible: false }),
      ]),
    };

    const presentation = getPublicHealthWarningPresentation(health.warnings[0]!, health);
    expect(presentation.detail).toContain("NXUSD");
    expect(presentation.detail).not.toContain("USDaf");
  });

  it("keeps acknowledged assets out of warnings and exposes their review as informational evidence", () => {
    const acknowledgedGap = {
      owner: "ops", reason: "Venue suspended", sources: ["https://example.com/review"],
      reviewedAt: 1_790_121_600, expiresAt: 1_792_713_600,
    };
    const health: HealthResponse = {
      ...BASE_HEALTH,
      warnings: ["active-price-coverage-incomplete:reviewed,unreviewed"],
      activePriceCoverage: makeActivePriceCoverage([
        makeMissingActiveAsset({ stablecoinId: "reviewed", symbol: "REVIEWED", acknowledgedGap, alertEligible: true }),
        makeMissingActiveAsset({ stablecoinId: "unreviewed", symbol: "UNREVIEWED", alertEligible: true }),
      ]),
    };
    const detail = getPublicHealthWarningPresentation(health.warnings[0]!, health).detail;
    expect(detail).toContain("UNREVIEWED");
    expect(detail.replace("UNREVIEWED", "")).not.toContain("REVIEWED");
    const warning = buildPublicHealthStatusCauses(health)[0]!;
    expect(warning.severity).toBe("warning");
    expect(warning.message.replace("UNREVIEWED", "")).not.toContain("REVIEWED");
    expect(getAcknowledgedPriceGapNotice(health.activePriceCoverage)).toContain("2026-10-23");
    health.activePriceCoverage = makeActivePriceCoverage([
      makeMissingActiveAsset({ stablecoinId: "reviewed", acknowledgedGap, alertEligible: false }),
    ]);
    health.warnings = [];
    expect(buildPublicHealthStatusCauses(health)).toEqual([
      expect.objectContaining({ severity: "info", value: 1 }),
    ]);
  });


  it("explains degraded yield production while retaining unknown warning evidence", () => {
    expect(getPublicHealthWarningPresentation("cache-quality-degraded: yield-data:producer-degraded-since-last-clean-run", BASE_HEALTH)).toEqual({
      title: "Yield data quality",
      detail: "A recent yield update reported incomplete or degraded inputs. Yield data remains degraded until a clean update succeeds.",
    });
    expect(getPublicHealthWarningPresentation("unknown-health-reason", BASE_HEALTH)).toEqual({
      title: "Health warning", detail: "unknown-health-reason",
    });
  });

  it("degrades mint/burn status when the critical writer lane is unhealthy despite fresh sync age", () => {
    const sync = {
      ...BASE_HEALTH.mintBurn.sync,
      criticalLaneHealthy: false,
      warning: "Critical mint/burn lane last run errored; cached or partial data may be served.",
    };

    expect(getPublicMintBurnStatus(sync)).toBe("degraded");
  });

  it("keeps dedicated outages scoped while shared source families degrade availability", () => {
    expect(isPublicImpactCircuitKey("live-reserves:ousg-ondo")).toBe(false);
    expect(isPublicImpactCircuitKey("unregistered-source")).toBe(true);

    const circuit = {
      state: "open",
      consecutiveFailures: 3,
      lastFailureAt: 1_700_000_000,
      lastSuccessAt: null,
      openedAt: 1_700_000_000,
    } as const;

    const dedicated = Object.fromEntries(
      Object.values(CIRCUIT_SOURCE_REGISTRY)
        .filter((entry) => entry.scope !== "source-wide")
        .map((entry) => [entry.key, circuit]),
    );
    expect(countPublicImpactOpenCircuits(dedicated)).toBe(0);
    // These dedicated routes formerly contributed four false source-wide outages.
    const dedicatedOutage = {
      "mento-fpmm": circuit,
      "bd-aerodrome": circuit,
      "usdv-jupiter": circuit,
      "susd-solayer-nav": circuit,
    };
    expect(getCircuitImpactStatus(countPublicImpactOpenCircuits(dedicatedOutage))).toBe("healthy");
    const sharedOutage = {
      ...dedicatedOutage,
      "defillama-stablecoins": circuit,
      "coingecko-prices": circuit,
      "protocol-redeem": circuit,
    };
    expect(countPublicImpactOpenCircuits(sharedOutage)).toBe(3);
    expect(getCircuitImpactStatus(countPublicImpactOpenCircuits(sharedOutage))).toBe("degraded");
  });
});

describe("getAgeBandState", () => {
  it("maps ages onto the public component bands, outage at twice the degraded band", () => {
    expect(getAgeBandState(600, 600, 1200)).toBe("operational");
    expect(getAgeBandState(601, 600, 1200)).toBe("delayed");
    expect(getAgeBandState(1201, 600, 1200)).toBe("degraded");
    expect(getAgeBandState(2400, 600, 1200)).toBe("degraded");
    expect(getAgeBandState(2401, 600, 1200)).toBe("outage");
  });

  it("describes the public headline for admin surfaces, loading before failure (R2)", () => {
    expect(describePublicHeadline(undefined, false)).toEqual({ state: null, label: "Loading", title: null });
    expect(describePublicHeadline(undefined, true).label).toBe("Unavailable");
    expect(describePublicHeadline(BASE_HEALTH, false)).toMatchObject({ state: "operational", label: "Operational" });
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

describe("getPublicMintBurnStatus — additional fixtures", () => {
  it("stale when freshnessStatus is stale regardless of critical lane", () => {
    const sync = {
      ...BASE_HEALTH.mintBurn.sync,
      freshnessStatus: "stale" as const,
      criticalLaneHealthy: false,
    };
    expect(getPublicMintBurnStatus(sync)).toBe("stale");
  });
});

