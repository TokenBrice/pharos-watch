import { describe, expect, it } from "vitest";
import { STATUS_BLACKLIST_THRESHOLDS, STATUS_MISSING_PRICE_THRESHOLDS, STATUS_RESERVE_COHORT_SLO } from "@shared/lib/status-thresholds";
import { getCircuitImpactStatus, getPublicSafetyScoreStatus, PUBLIC_CIRCUIT_IMPACT_QUORUM, PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER } from "@shared/lib/public-health";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import type { StatusCause, StatusResponse } from "@shared/types/status";
import type { ReserveFeedReview } from "@shared/types/live-reserves";
import type { PublicHealthAssessment } from "../public-health-assessment";
import { makePublicHealth } from "./public-health.test-support";
import {
  makeDataQuality,
  makeReserveComposition as makeBaseReserveComposition,
} from "@shared/types/__tests__/status.test-support";
import { synthesizeOverallCauses } from "../status/evaluation-causes";
import { maxStatus, SEVERITY } from "../status-reliability-shared";
import {
  evaluateAvailabilityStatus,
  evaluateDataQualityStatus,
  evaluateReserveCompositionStatus,
  type AvailabilityEvaluationInput,
  type DataQualityEvaluationInput,
} from "../status/evaluation-rules";
import {
  evaluateStablecoinActivePriceCoverage,
  STABLECOIN_PRICE_GAP_REVIEWS,
  type StablecoinPriceGapReview,
} from "../stablecoin-publication-coverage";

function makeReserveComposition(
  overrides?: Partial<Exclude<StatusResponse["reserveComposition"], { status: "unavailable" }>>,
): Exclude<StatusResponse["reserveComposition"], { status: "unavailable" }> {
  return makeBaseReserveComposition({
    configuredCoins: 10,
    freshCoins: 10,
    independentFreshEligible: 4,
    independentFreshUnverified: 2,
    staticValidatedFresh: 2,
    weakProbeFresh: 2,
    lastSuccessAt: 1_700_000_000,
    oldestFreshAgeSec: 3600,
    freshCoverageRatio: 1,
    authoritativeFreshCoverageRatio: 0.8,
    ...overrides,
  });
}

function makeAvailabilityCauseInput(publicHealth: PublicHealthAssessment) {
  return {
    publicHealth,
    availabilityImpactingUnhealthyCrons: 0,
    watchUnhealthyCrons: 0,
    degradedCronRuns: 0,
    cronErrorCount: 0,
    availabilityImpactingCronErrors: 0,
    availabilityImpactingConsecutiveCronErrors: 0,
    cronHistoryQueryFailed: false,
    cronProgressQueryFailed: false,
    cronLeaseQueryFailed: false,
  };
}

function makeAvailabilityEvaluationInput(
  overrides: Partial<AvailabilityEvaluationInput> = {},
): AvailabilityEvaluationInput {
  return {
    ...makeAvailabilityCauseInput(overrides.publicHealth ?? makePublicHealth()),
    ...overrides,
  };
}

function makeDataQualityEvaluationInput(
  overrides: Partial<DataQualityEvaluationInput> = {},
): DataQualityEvaluationInput {
  const publicHealth = makePublicHealth();
  return {
    nowSec: 1_700_000_000,
    dataQuality: makeDataQuality(),
    repairRunnerAutoRepairCount: null,
    activePriceCoverage: publicHealth.activePriceCoverage,
    missingPriceRatio: 0,
    blacklistMissingRatio: 0,
    blacklistRecentMissing: 0,
    onchainAssessment: { status: "healthy", causes: [], representative: false },
    onchainAssessmentCauses: [],
    reserveCompositionQueryFailed: false,
    reserveComposition: makeReserveComposition(),
    reserveCompositionStatus: "healthy",
    activePriceCoverageImpactStatus: "healthy",
    ...overrides,
  };
}

describe("status evaluation policy", () => {
  it.each([
    ["healthy", "healthy", "healthy"], ["healthy", "degraded", "degraded"],
    ["healthy", "stale", "stale"], ["degraded", "healthy", "degraded"],
    ["degraded", "degraded", "degraded"], ["degraded", "stale", "stale"],
    ["stale", "healthy", "stale"], ["stale", "degraded", "stale"], ["stale", "stale", "stale"],
  ] as const)("aggregates %s and %s using the shared severity order", (left, right, expected) => {
    expect(SEVERITY).toEqual({ healthy: 0, degraded: 1, stale: 2 });
    expect(maxStatus(left, right)).toBe(expected);
  });

  it.each([2, 3])("uses the public circuit quorum for admin causes at %i open groups", (openCircuitCount) => {
    const circuitImpactStatus = getCircuitImpactStatus(openCircuitCount);
    expect(circuitImpactStatus).toBe(openCircuitCount === 2 ? "healthy" : "degraded");
    const result = evaluateAvailabilityStatus(makeAvailabilityCauseInput(makePublicHealth(circuitImpactStatus, {
      openCircuitCount, circuitImpactStatus,
    })));
    const cause = result.causes.find((entry) => entry.code === "open_circuit_groups");
    if (openCircuitCount === 2) expect(cause).toBeUndefined();
    else expect(cause).toMatchObject({ threshold: PUBLIC_CIRCUIT_IMPACT_QUORUM, value: 3 });
  });

  it.each([
    [API_FRESHNESS_MAX_AGE_SEC.reportCards, "healthy"],
    [API_FRESHNESS_MAX_AGE_SEC.reportCards + 1, "degraded"],
    [API_FRESHNESS_MAX_AGE_SEC.reportCards * PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER, "degraded"],
    [API_FRESHNESS_MAX_AGE_SEC.reportCards * PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER + 1, "stale"],
  ] as const)("uses the public Safety floor at accepted age %i (%s)", (ageSec, expected) => {
    const now = Math.floor(Date.now() / 1000);
    const publication = {
      ...makePublicHealth().safetyScorePublication!,
      acceptedAtSec: now - ageSec, attemptedAtSec: now,
    };
    const result = evaluateAvailabilityStatus(makeAvailabilityCauseInput(makePublicHealth("healthy", {
      safetyScorePublication: publication,
      safetyScoreImpactStatus: getPublicSafetyScoreStatus(publication, now),
    })));
    expect(result.status).toBe(expected);
    const cause = result.causes.find((entry) => entry.code === "safety_score_publication_stale");
    if (expected === "healthy") expect(cause).toBeUndefined();
    else {
      expect(cause).toMatchObject({ severity: expected === "stale" ? "critical" : "warning", layer: "availability" });
      expect(cause?.message).toContain(publication.acceptedPublicationGenerationId!);
      expect(cause?.message).toContain(`at ${publication.acceptedAtSec}`);
      expect(cause?.message).toContain(`freshness budget ${API_FRESHNESS_MAX_AGE_SEC.reportCards}s`);
    }
  });

  it.each<[string, Partial<NonNullable<PublicHealthAssessment["safetyScorePublication"]>> | null, string | null]>([
    ["safety_score_publication_unavailable", null, "safety-score-publication-read-failed"],
    ["safety_score_publication_missing", {
      status: "held", acceptedAtSec: null, acceptedPublicationGenerationId: null,
      heldSinceSec: Math.floor(Date.now() / 1000) - 30, reasons: [{ code: "redemption-stale" }],
    }, null],
    ["safety_score_publication_held", {
      status: "held", heldSinceSec: Math.floor(Date.now() / 1000) - 30, reasons: [{ code: "redemption-stale" }],
    }, null],
  ])("names %s instead of trusting healthy caches or watch-tier crons", (code, publicationOverrides, unavailableReason) => {
    const publication = publicationOverrides == null ? null : {
      ...makePublicHealth().safetyScorePublication!, ...publicationOverrides,
    };
    const result = evaluateAvailabilityStatus(makeAvailabilityCauseInput(makePublicHealth("healthy", {
      safetyScorePublication: publication,
      safetyScorePublicationUnavailableReason: unavailableReason,
      safetyScoreImpactStatus: "degraded",
    })));
    expect(result.status).toBe("degraded");
    expect(result.causes).toContainEqual(expect.objectContaining({ code, severity: "warning" }));
    if (code === "safety_score_publication_held") expect(result.causes[0]?.message).toContain("redemption-stale");
  });

  it("describes only the fresh degraded required attempts behind the cron diagnostic count", () => {
    const result = evaluateAvailabilityStatus(makeAvailabilityEvaluationInput({
      degradedCronRuns: 6, cronFindingJobs: { degraded: ["compute-safety-score-v9"] },
    }));
    expect(result.status).toBe("healthy");
    expect(result.causes).toContainEqual(expect.objectContaining({
      code: "degraded_cron_warning", value: 6, severity: "info",
      message: "6 cron job(s) have fresh degraded terminal attempts reporting incomplete required work. Jobs: compute-safety-score-v9.",
    }));
  });

  it.each([
    { circuitQueryError: "circuits-read-failed", circuitImpactStatus: "degraded" as const },
    { mintBurnQueryError: "mint-burn-read-failed", mintBurnImpactStatus: "degraded" as const },
  ])("never grades unavailable service diagnostics healthy (%j)", (overrides) => {
    const result = evaluateAvailabilityStatus(makeAvailabilityCauseInput(makePublicHealth("healthy", overrides)));
    expect(result.status).toBe("degraded");
    expect(result.causes).toContainEqual(expect.objectContaining({ severity: "warning" }));
  });
  it.each(["missing-timestamp", "invalid-timestamp"] as const)("names unavailable cache freshness without invented ratios (%s)", (timestampReason) => {
    const result = evaluateAvailabilityStatus(makeAvailabilityCauseInput(makePublicHealth("stale", {
      caches: { stablecoins: { ageSeconds: null, maxAge: 600, healthy: false, timestampReason } },
      worstCacheRatio: null,
    })));
    const cause = result.causes.find((entry) => entry.code === "cache_freshness_unavailable");
    expect(cause).toBeDefined();
    expect(cause).not.toHaveProperty("value");
    expect(cause?.message).toContain(timestampReason);
    expect(result.causes.some((entry) => entry.code === "cache_ratio_stale")).toBe(false);
  });

  it("preserves an actually measured 99x cache breach", () => {
    const result = evaluateAvailabilityStatus(makeAvailabilityCauseInput(makePublicHealth("stale", {
      caches: { stablecoins: { ageSeconds: 99 * 600, maxAge: 600, healthy: false } }, worstCacheRatio: 99,
    })));
    expect(result.causes.find((entry) => entry.code === "cache_ratio_stale")).toMatchObject({ value: 99 });
  });
  it("does not recover to healthy when stale reserve evidence becomes unreadable", () => {
    const stale = makeReserveComposition({ status: "stale", freshCoins: 0, freshCoverageRatio: 0 });
    const before = evaluateDataQualityStatus(makeDataQualityEvaluationInput({
      reserveComposition: stale,
      reserveCompositionStatus: "stale",
    }));
    const unavailable = makeBaseReserveComposition({ status: "unavailable" });
    const after = evaluateDataQualityStatus(makeDataQualityEvaluationInput({
      reserveComposition: unavailable,
      reserveCompositionStatus: "unavailable",
      reserveCompositionQueryFailed: true,
    }));
    expect(before.status).toBe("stale");
    expect(after.status).toBe("degraded");
    expect(after.causes).toContainEqual(expect.objectContaining({
      code: "reserve_sync_query_failed",
      severity: "warning",
    }));
    expect(unavailable.freshCoverageRatio).toBeNull();
  });

  it("preserves a successfully observed empty reserve cohort", () => {
    const empty = makeBaseReserveComposition();
    expect(evaluateReserveCompositionStatus(empty)).toMatchObject({
      status: "healthy",
      freshCoverageRatio: 0,
      authoritativeFreshCoverageRatio: 0,
    });
    expect(evaluateDataQualityStatus(makeDataQualityEvaluationInput({
      reserveComposition: empty,
    })).status).toBe("healthy");
  });
  it("keeps reserve status healthy for low-count issues when fresh coverage remains high", () => {
    const assessment = evaluateReserveCompositionStatus(
      makeReserveComposition({
        freshCoins: 8,
        staleCoins: 1,
        errorCoins: 1,
        independentFreshEligible: 3,
        independentFreshUnverified: 2,
        staticValidatedFresh: 2,
        weakProbeFresh: 1,
      }),
    );

    expect(assessment.status).toBe("healthy");
    expect(assessment.freshCoverageRatio).toBe(0.8);
    expect(assessment.authoritativeFreshCoverageRatio).toBe(0.7);
  });

  it("degrades reserve status when fresh or authoritative coverage drops below policy thresholds", () => {
    const assessment = evaluateReserveCompositionStatus(
      makeReserveComposition({
        freshCoins: 7,
        staleCoins: 2,
        errorCoins: 1,
        independentFreshEligible: 2,
        independentFreshUnverified: 1,
        staticValidatedFresh: 1,
        weakProbeFresh: 3,
      }),
    );

    expect(assessment.status).toBe("degraded");
    expect(assessment.freshCoverageRatio).toBe(0.7);
    expect(assessment.authoritativeFreshCoverageRatio).toBe(0.4);
  });

  it("degrades reserve status when independent feeds are persistently stale despite high coverage", () => {
    const assessment = evaluateReserveCompositionStatus(
      makeReserveComposition({
        persistentlyStaleIndependentCoins: [{ stablecoinId: "coin-a", ageSec: 1_300_000 }],
      }),
    );

    expect(assessment.status).toBe("degraded");
    expect(assessment.freshCoverageRatio).toBe(1);
    expect(assessment.authoritativeFreshCoverageRatio).toBe(0.8);
  });

  it("keeps a bounded continuation healthy without using deferred share as a capacity verdict", () => {
    const assessment = evaluateReserveCompositionStatus(
      makeReserveComposition({
        runBudgetTruncated: true,
        deferredCoins: 1,
        nextCursorStablecoinId: "coin-a",
      }),
    );

    expect(assessment.status).toBe("healthy");
  });

  it.each([
    [0, false, 0, "healthy"],
    [3, true, 0, "healthy"],
    [0, false, 1, "degraded"],
  ] as const)("keeps live remainder separate from real capacity pressure (%s/%s/%s)", (deferredCoins, runBudgetTruncated, writeTimeoutUncertain, status) => {
    const assessment = evaluateReserveCompositionStatus(makeReserveComposition({
      inProgressCoins: 8, deferredCoins, runBudgetTruncated, writeTimeoutUncertain,
    }));
    expect(assessment.status).toBe(status);
  });

  it("does not degrade reserve coverage for high-share continuation alone", () => {
    const highShare = evaluateReserveCompositionStatus(
      makeReserveComposition({
        runBudgetTruncated: true,
        deferredCoins: 3,
      }),
    );

    expect(highShare.status).toBe("healthy");
  });

  it("degrades reserve status for uncertain writes", () => {
    const uncertainWrite = evaluateReserveCompositionStatus(
      makeReserveComposition({
        writeTimeoutUncertain: 1,
      }),
    );

    expect(uncertainWrite.status).toBe("degraded");
  });

  it("marks reserve status stale only when no fresh coverage remains", () => {
    const assessment = evaluateReserveCompositionStatus(
      makeReserveComposition({
        freshCoins: 0,
        staleCoins: 4,
        missingCoins: 4,
        errorCoins: 2,
        independentFreshEligible: 0,
        independentFreshUnverified: 0,
        staticValidatedFresh: 0,
        weakProbeFresh: 0,
      }),
    );

    expect(assessment.status).toBe("stale");
  });

  it("uses the D1 capacity floor for admin availability", () => {
    const availability = evaluateAvailabilityStatus(makeAvailabilityEvaluationInput({ publicHealth: makePublicHealth("healthy", {
      d1CapacityImpactStatus: "stale",
    }),
    availabilityImpactingCronErrors: 0,
    availabilityImpactingUnhealthyCrons: 0,
    availabilityImpactingConsecutiveCronErrors: 0, })).status;

    expect(availability).toBe("stale");
  });
});

describe("status cause text", () => {
  it.each(["active_price_coverage_incomplete", "active_price_coverage_unknown"])(
    "reserves operator diagnostic capacity for %s",
    (code) => {
      const criticalCauses: StatusCause[] = Array.from({ length: 12 }, (_, index) => ({
        code: `critical-${index}`,
        layer: "data-quality",
        severity: "critical",
        message: `Critical cause ${index}`,
      }));
      const activePriceCause: StatusCause = {
        code,
        layer: "data-quality",
        severity: "warning",
        message: "Exact active-price coverage is incomplete.",
      };

      const selected = synthesizeOverallCauses(criticalCauses, [activePriceCause]);

      expect(selected).toHaveLength(12);
      expect(selected.map((cause) => cause.code)).toEqual([
        ...criticalCauses.slice(0, 11).map((cause) => cause.code),
        code,
      ]);
    },
  );

  it("excludes an info-severity durable-code cause from durable retention", () => {
    // A transient active_price_coverage_incomplete is emitted at info severity; it
    // must not reserve or displace a durable slot the way its warning form does.
    const criticalCauses: StatusCause[] = Array.from({ length: 12 }, (_, index) => ({
      code: `critical-${index}`,
      layer: "data-quality",
      severity: "critical",
      message: `Critical cause ${index}`,
    }));
    const infoPriceCause: StatusCause = {
      code: "active_price_coverage_incomplete",
      layer: "data-quality",
      severity: "info",
      message: "Transient live-price miss; not degrading public status.",
    };

    const selected = synthesizeOverallCauses(criticalCauses, [infoPriceCause]);

    expect(selected).toHaveLength(12);
    expect(selected.map((cause) => cause.code)).toEqual(criticalCauses.map((cause) => cause.code));
    expect(selected.some((cause) => cause.code === "active_price_coverage_incomplete")).toBe(false);
  });

  it("warns when the DEX liquidity dataset exceeds its endpoint publication budget", () => {
    const causes = evaluateAvailabilityStatus(makeAvailabilityCauseInput(
      makePublicHealth("healthy", {
        caches: {
          "dex-liquidity": {
            ageSeconds: 14_401,
            maxAge: 43_200,
            healthy: true,
          },
        },
      }),
    )).causes;

    expect(causes).toContainEqual(
      expect.objectContaining({
        code: "dex_pricing_bridge_stale",
        severity: "warning",
        metric: "dexLiquidityAgeSeconds",
        value: 14_401,
        threshold: 14_400,
      }),
    );
    expect(causes.find((cause) => cause.code === "dex_pricing_bridge_stale")?.message)
      .toContain("one missed four-hour scoring runway");
  });

  it("keeps dataset ages inside the endpoint budget off the stale cause the per-row window used to flag", () => {
    // Ages past the 4_500 s per-row `DEX_FRESHNESS_SEC` admission window but at
    // or below the 14_400 s dataset endpoint budget (including the exact
    // boundary) must not fire the dataset-age diagnostic.
    for (const ageSeconds of [4_501, 5_000, 14_400]) {
      const causes = evaluateAvailabilityStatus(makeAvailabilityCauseInput(
        makePublicHealth("healthy", {
          caches: {
            "dex-liquidity": {
              ageSeconds,
              maxAge: 43_200,
              healthy: true,
            },
          },
        }),
      )).causes;

      expect(causes.some((cause) => cause.code === "dex_pricing_bridge_stale")).toBe(false);
    }
  });

  it("emits a warning cache cause when an override-tightened cache breaches its degraded band below the global threshold", () => {
    const causes = evaluateAvailabilityStatus(makeAvailabilityCauseInput(
      makePublicHealth("healthy", {
        // yield-data override bands are 2x/4x, so 2.1x degrades it even though
        // the global 8x band is untouched. A non-overridden cache at the same
        // 2.1x ratio stays healthy, proving per-key override resolution.
        caches: {
          "yield-data": { ageSeconds: 7_560, maxAge: 3_600, healthy: false },
          stablecoins: { ageSeconds: 7_560, maxAge: 3_600, healthy: true },
        },
        worstCacheRatio: 2.1,
      }),
    )).causes;

    expect(causes).toContainEqual(
      expect.objectContaining({
        code: "cache_ratio_degraded",
        severity: "warning",
        message: expect.stringContaining("yield-data"),
        threshold: 2,
      }),
    );
    expect(causes.some((cause) => cause.code === "cache_ratio_stale")).toBe(false);
  });

  it("reports the highest-ratio cache when multiple caches breach the same tier", () => {
    const causes = evaluateAvailabilityStatus(makeAvailabilityCauseInput(
      makePublicHealth("healthy", {
        caches: {
          alpha: { ageSeconds: 32_400, maxAge: 3_600, healthy: false },
          beta: { ageSeconds: 43_200, maxAge: 3_600, healthy: false },
        },
        worstCacheRatio: 12,
      }),
    )).causes;

    expect(causes).toContainEqual(
      expect.objectContaining({
        code: "cache_ratio_degraded",
        message: expect.stringContaining("beta at 12.00x"),
        value: 12,
      }),
    );
  });

  it("escalates an override-tightened cache to a critical stale cause past its stale band", () => {
    const causes = evaluateAvailabilityStatus(makeAvailabilityCauseInput(
      makePublicHealth("healthy", {
        caches: {
          "yield-data": { ageSeconds: 14_760, maxAge: 3_600, healthy: false },
        },
        worstCacheRatio: 4.1,
      }),
    )).causes;

    expect(causes).toContainEqual(
      expect.objectContaining({
        code: "cache_ratio_stale",
        severity: "critical",
        message: expect.stringContaining("yield-data"),
        threshold: 4,
      }),
    );
  });

  it("does not emit a cache-ratio cause when a non-overridden cache is within the global band", () => {
    const causes = evaluateAvailabilityStatus(makeAvailabilityCauseInput(
      makePublicHealth("healthy", {
        caches: {
          stablecoins: { ageSeconds: 18_000, maxAge: 3_600, healthy: true },
        },
        worstCacheRatio: 5,
      }),
    )).causes;

    expect(
      causes.some((cause) => cause.code === "cache_ratio_degraded" || cause.code === "cache_ratio_stale"),
    ).toBe(false);
  });

  it("fires the DEWS-downstream cause on the DEX ratio alone, inside the DEX stale band", () => {
    const causes = evaluateAvailabilityStatus(makeAvailabilityCauseInput(
      makePublicHealth("healthy", {
        caches: {
          "dex-liquidity": { ageSeconds: 2 * 43_200 + 1, maxAge: 43_200, healthy: true },
          dews: { ageSeconds: 21_601, maxAge: 1_800, healthy: false },
        },
        worstCacheRatio: 12.1,
      }),
    )).causes;

    expect(causes).toContainEqual(
      expect.objectContaining({
        code: "dews_downstream_of_dex_liquidity",
        severity: "warning",
        metric: "dexLiquidityAgeSeconds",
        value: 86_401,
        threshold: 86_400,
      }),
    );
    expect(
      causes
        .filter((cause) => cause.code === "dews_downstream_of_dex_liquidity")
        .map((cause) => cause.severity),
    ).toEqual(["warning"]);
  });

  it("stays silent while DEX liquidity is inside twice its budget, even with both caches unhealthy", () => {
    const causes = evaluateAvailabilityStatus(makeAvailabilityCauseInput(
      makePublicHealth("healthy", {
        caches: {
          "dex-liquidity": { ageSeconds: 2 * 43_200, maxAge: 43_200, healthy: false },
          dews: { ageSeconds: 21_600, maxAge: 1_800, healthy: false },
        },
        worstCacheRatio: 12,
      }),
    )).causes;

    expect(causes.some((cause) => cause.code === "dews_downstream_of_dex_liquidity")).toBe(false);
  });

  it("gives mint/burn query failure precedence over stale public classification", () => {
    const causes = evaluateAvailabilityStatus(makeAvailabilityCauseInput(
      makePublicHealth("healthy", {
        mintBurnImpactStatus: "stale",
        mintBurnQueryError: "Mint/burn health data unavailable.",
        mintBurnLastRunStatus: "error",
        mintBurn: {
          ...makePublicHealth().mintBurn,
          sync: {
            lastSuccessfulSyncAt: null,
            freshnessStatus: "stale",
            warning: "Mint/burn sync freshness is stale versus the 30-minute cron cadence.",
            criticalLaneHealthy: false,
          },
        },
      }),
    )).causes;

    expect(causes).toContainEqual(
      expect.objectContaining({
        code: "mint_burn_health_query_failed",
        severity: "warning",
        message:
          "Mint/burn health query failed (mint-burn-read-failed); diagnostics are temporarily unavailable. " +
          "Latest critical cron run status: error.",
      }),
    );
    expect(causes.some((cause) => cause.code === "mint_burn_public_stale")).toBe(false);
  });

  it("emits stale mint/burn cause when the timestamp query succeeds with no recent sync", () => {
    const causes = evaluateAvailabilityStatus(makeAvailabilityCauseInput(
      makePublicHealth("healthy", {
        mintBurnImpactStatus: "stale",
        mintBurnQueryError: null,
        mintBurnLastRunStatus: "error",
        mintBurn: {
          ...makePublicHealth().mintBurn,
          sync: {
            lastSuccessfulSyncAt: null,
            freshnessStatus: "stale",
            warning: "Mint/burn sync freshness is stale versus the 30-minute cron cadence.",
            criticalLaneHealthy: false,
          },
        },
      }),
    )).causes;

    expect(causes).toContainEqual(
      expect.objectContaining({
        code: "mint_burn_public_stale",
        severity: "critical",
      }),
    );
    expect(causes.some((cause) => cause.code === "mint_burn_health_query_failed")).toBe(false);
  });

  it("keeps a fresh healthy mint/burn execution warning as a named informational notice", () => {
    const publicHealth = makePublicHealth();
    publicHealth.mintBurnImpactStatus = "healthy";
    publicHealth.mintBurnBootstrap = false;
    publicHealth.mintBurn.sync = {
      lastSuccessfulSyncAt: 1_699_999_970, freshnessStatus: "fresh", criticalLaneHealthy: true,
      warning: "Critical mint/burn lane is running in degraded mode; coverage may be partial.",
    };
    const result = evaluateAvailabilityStatus(makeAvailabilityCauseInput(publicHealth));
    expect(result.status).toBe("healthy");
    expect(result.causes).toContainEqual(expect.objectContaining({
      code: "mint_burn_public_degraded", severity: "info",
    }));
  });

  it("includes persistent stale independent feed details in degraded reserve sync causes", () => {
    const reserveComposition = makeReserveComposition({
      status: "degraded",
      persistentlyStaleIndependentCoins: [
        { stablecoinId: "coin-a", ageSec: 1_500_000 },
        { stablecoinId: "coin-b", ageSec: 1_400_000 },
        { stablecoinId: "coin-c", ageSec: 1_300_000 },
        { stablecoinId: "coin-d", ageSec: 1_200_000 },
      ],
    });

    const causes = evaluateDataQualityStatus(makeDataQualityEvaluationInput({ dataQuality: makeDataQuality(),
    activePriceCoverage: makePublicHealth().activePriceCoverage,
    missingPriceRatio: 0,
    blacklistMissingRatio: 0,
    blacklistRecentMissing: 0,
    onchainAssessmentCauses: [],
    reserveCompositionQueryFailed: false,
    reserveComposition, })).causes;

    expect(causes).toContainEqual(
      expect.objectContaining({
        code: "reserve_sync_degraded",
        message: expect.stringContaining("4 persistently stale independent feed(s) (coin-a, coin-b, coin-c, +1 more)."),
      }),
    );
  });

  it.each([1799, 1800, 1801])("alerts only beyond the cohort SLO boundary (%ss)", (ageSec) => {
    const result = evaluateDataQualityStatus(makeDataQualityEvaluationInput({
      reserveComposition: makeReserveComposition({
        runBudgetTruncated: false, deferredCoins: 9,
        cohort: {
          slotStartedAt: 1_700_000_000 - ageSec, completedAt: null, ageSec,
          continuationPending: true, completedCohorts: 0, completionP95Sec: null,
        },
      }),
    }));
    expect(result.status).toBe("healthy"); // Ops cause, not a public coverage floor.
    const cause = result.causes.find((entry) => entry.code === "reserve_cohort_slo_exceeded");
    if (ageSec > STATUS_RESERVE_COHORT_SLO.maxAgeSec) {
      expect(cause).toMatchObject({
        severity: "warning", metric: "reserveCohortAgeSec", value: ageSec,
        threshold: STATUS_RESERVE_COHORT_SLO.maxAgeSec,
      });
    } else expect(cause).toBeUndefined();
    expect(result.causes.some((entry) => entry.code === "reserve_sync_budget_truncated")).toBe(false);
  });

  it.each([1800, 1801])("uses completed full-cohort p95 independently of the latest cohort age (%ss)", (completionP95Sec) => {
    const result = evaluateDataQualityStatus(makeDataQualityEvaluationInput({
      reserveComposition: makeReserveComposition({
        cohort: { slotStartedAt: 1000, completedAt: 1100, ageSec: 100,
          continuationPending: false, completedCohorts: 42, completionP95Sec },
      }),
    }));
    expect(result.causes.some((entry) => entry.code === "reserve_cohort_slo_exceeded"))
      .toBe(completionP95Sec > STATUS_RESERVE_COHORT_SLO.maxAgeSec);
  });

  it.each([
    [664, false, "info"],
    [1800, false, "info"],
    [1801, false, "warning"],
    [null, false, "warning"],
    [undefined, false, "warning"],
    [664, true, "warning"],
  ] as const)("classifies lagging cohort p95 with recent maximum %s and open breach %s as %s", (recentCompletionMaxSec, openBreach, severity) => {
    const result = evaluateDataQualityStatus(makeDataQualityEvaluationInput({
      reserveComposition: makeReserveComposition({
        cohort: {
          slotStartedAt: 1000, completedAt: openBreach ? null : 1100,
          ageSec: openBreach ? 1801 : 100, continuationPending: openBreach,
          completedCohorts: 42, completionP95Sec: 3691, recentCompletionMaxSec,
        },
      }),
    }));
    expect(result.causes.find((entry) => entry.code === "reserve_cohort_slo_exceeded"))
      .toMatchObject({ severity, value: openBreach ? 1801 : 3691, threshold: 1800 });
  });

  it("keeps a recent completed-cohort breach visible even when seven-day p95 is within target", () => {
    const result = evaluateDataQualityStatus(makeDataQualityEvaluationInput({
      reserveComposition: makeReserveComposition({
        cohort: {
          slotStartedAt: 1000, completedAt: 1100, ageSec: 100, continuationPending: false,
          completedCohorts: 42, completionP95Sec: 100, recentCompletionMaxSec: 1801,
        },
      }),
    }));
    expect(result.causes.find((entry) => entry.code === "reserve_cohort_slo_exceeded"))
      .toMatchObject({ severity: "warning", metric: "reserveCohortRecentCompletionMaxSec", value: 1801 });
  });

  it("does not invent successful cohort evidence when the overview is unavailable", () => {
    const result = evaluateDataQualityStatus(makeDataQualityEvaluationInput({
      reserveCompositionQueryFailed: true,
    }));
    expect(result.causes.some((entry) => entry.code === "reserve_sync_query_failed")).toBe(true);
    expect(result.causes.some((entry) => entry.code === "reserve_cohort_slo_exceeded")).toBe(false);
  });

  it("emits a distinct warning cause for DDR repair debt", () => {
    const causes = evaluateDataQualityStatus(makeDataQualityEvaluationInput({ dataQuality: makeDataQuality({
      ddrRepairDebtStatus: "present",
      ddrRepairDebtCount: 2,
      ddrRepairDebtCheckedAt: 1_700_000_000,
      ddrRepairDebtEvents: [
        { eventId: 42, reason: "incident-conflict" },
        { eventId: 43, reason: "incident-conflict" },
      ],
    }),
    activePriceCoverage: makePublicHealth().activePriceCoverage,
    missingPriceRatio: 0,
    blacklistMissingRatio: 0,
    blacklistRecentMissing: 0,
    onchainAssessmentCauses: [],
    reserveCompositionQueryFailed: false,
    reserveComposition: makeReserveComposition(), })).causes;

    expect(causes).toContainEqual(
      expect.objectContaining({
        code: "ddr_repair_debt_present",
        severity: "warning",
        metric: "ddrRepairDebtCount",
        value: 2,
      }),
    );
  });

  it("reports acknowledged gaps as info with identity and expiry, and exposes ignored reviews", () => {
    const review = STABLECOIN_PRICE_GAP_REVIEWS[0]!;
    const evaluated = evaluateStablecoinActivePriceCoverage(
      [{ id: review.stablecoinId, price: null }],
      [review.stablecoinId],
      { nowSec: review.reviewedAt, priceGapReviews: [review] },
    );
    const result = evaluateDataQualityStatus(makeDataQualityEvaluationInput({
      nowSec: review.reviewedAt,
      activePriceCoverage: {
        ...evaluated, status: "incomplete", observedAt: review.reviewedAt,
        expiredGapReviewIds: ["expired-coin"], invalidGapReviewIds: ["invalid-coin"],
      },
    }));
    expect(result.status).toBe("healthy");
    const priceCause = result.causes.find((cause) => cause.code === "active_price_coverage_incomplete");
    expect(priceCause?.severity).toBe("info");
    expect(priceCause?.message).toContain(review.stablecoinId);
    expect(priceCause?.message).toContain(new Date(review.expiresAt * 1000).toISOString().slice(0, 10));
    expect(result.causes).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "price_gap_reviews_expired", severity: "info" }),
      expect.objectContaining({ code: "price_gap_reviews_invalid", severity: "info" }),
    ]));
  });

  it("degrades and explains unavailable exact publication evidence", () => {
    const dataQuality = makeDataQuality({
      stablecoinPublication: {
        status: "unknown",
        expectedActiveCount: 364,
        presentActiveCount: 0,
        waivedActiveCount: 0,
        missingActiveIds: [],
        waivedActiveIds: [],
        expiredWaiverIds: [],
        observedAt: null,
      },
    });
    const status = evaluateDataQualityStatus(makeDataQualityEvaluationInput({ dataQuality,
    activePriceCoverageImpactStatus: "healthy",
    missingPriceRatio: 0,
    blacklistMissingRatio: 0,
    blacklistRecentMissing: 0,
    onchainAssessment: { status: "healthy", causes: [], representative: false },
    reserveCompositionStatus: "healthy", })).status;
    const causes = evaluateDataQualityStatus(makeDataQualityEvaluationInput({ dataQuality,
    activePriceCoverage: makePublicHealth().activePriceCoverage,
    missingPriceRatio: 0,
    blacklistMissingRatio: 0,
    blacklistRecentMissing: 0,
    onchainAssessmentCauses: [],
    reserveCompositionQueryFailed: false,
    reserveComposition: makeReserveComposition(), })).causes;

    expect(status).toBe("degraded");
    expect(causes).toContainEqual(
      expect.objectContaining({
        code: "stablecoin_publication_unknown",
        severity: "warning",
      }),
    );
  });

  it.each([
    [30_000_000, "healthy", "info"],
    [96_534_823.01, "healthy", "info"],
    [500_000_000, "healthy", "info"],
  ] as const)("aligns publication cause and floor for retained cap %s", (cap, expectedStatus, severity) => {
    const nowSec = 1_790_000_000;
    const evaluated = evaluateStablecoinActivePriceCoverage([], ["missing"], {
      nowSec, previousAcceptedAssetsById: new Map([["missing", {
        id: "missing", circulating: { peggedUSD: cap }, supplyObservedAt: nowSec - 900,
      }]]),
    });
    const result = evaluateDataQualityStatus(makeDataQualityEvaluationInput({
      nowSec,
      dataQuality: makeDataQuality({
        stablecoinPublication: {
          status: "incomplete", expectedActiveCount: 396, presentActiveCount: 395, waivedActiveCount: 0,
          missingActiveIds: ["missing"], waivedActiveIds: [], expiredWaiverIds: [], observedAt: nowSec,
        },
      }),
      activePriceCoverage: { ...evaluated, status: "incomplete", observedAt: nowSec },
    }));
    expect(result.status).toBe(expectedStatus);
    expect(result.causes).toContainEqual(expect.objectContaining({
      code: "stablecoin_publication_incomplete", severity,
    }));
  });

  it.each([
    [4, "healthy", "info"],
    [19, "healthy", "info"],
    [20, "degraded", "warning"],
  ] as const)("grades %s evidenced publication omissions of 396 by cohort breadth", (count, expectedStatus, severity) => {
    const nowSec = 1_790_000_000;
    const ids = Array.from({ length: count }, (_, index) => `missing-${index}`);
    const evaluated = evaluateStablecoinActivePriceCoverage([], ids, {
      nowSec, previousAcceptedAssetsById: new Map(ids.map((id) => [id, {
        id, circulating: { peggedUSD: 5_000_000 }, supplyObservedAt: nowSec - 900,
      }])),
    });
    const result = evaluateDataQualityStatus(makeDataQualityEvaluationInput({
      nowSec,
      dataQuality: makeDataQuality({
        stablecoinPublication: {
          status: "incomplete", expectedActiveCount: 396, presentActiveCount: 396 - count, waivedActiveCount: 0,
          missingActiveIds: ids, waivedActiveIds: [], expiredWaiverIds: [], observedAt: nowSec,
        },
      }),
      activePriceCoverage: { ...evaluated, status: "incomplete", observedAt: nowSec },
    }));
    expect(result.status).toBe(expectedStatus);
    expect(result.causes).toContainEqual(expect.objectContaining({
      code: "stablecoin_publication_incomplete", severity,
    }));
  });

  it("emits a durable warning without degrading for incomplete active-price coverage", () => {
    const activePriceCoverage = {
      ...makePublicHealth().activePriceCoverage,
      status: "incomplete" as const,
      expectedActiveCount: 3,
      presentActiveCount: 3,
      pricedActiveCount: 1,
      missingPriceCount: 2,
      pricedActiveIds: ["coin-a"],
      missingActiveIds: ["coin-b", "coin-c"],
      missingActiveAssets: [
        {
          stablecoinId: "coin-b",
          symbol: "B",
          marketCapUsd: 20_000_000,
          currentPrice: null,
          currentSource: null,
          currentObservedAt: null,
          currentConfidence: null,
          consecutiveMissingGenerations: 2,
          lastAcceptedPrice: null,
          lastAcceptedSource: null,
          lastAcceptedObservedAt: null,
          rejectionReason: "missing",
          alertEligible: true,
        },
        {
          stablecoinId: "coin-c",
          symbol: "C",
          marketCapUsd: 10_000_000,
          currentPrice: null,
          currentSource: null,
          currentObservedAt: null,
          currentConfidence: null,
          consecutiveMissingGenerations: 1,
          lastAcceptedPrice: null,
          lastAcceptedSource: null,
          lastAcceptedObservedAt: null,
          rejectionReason: "missing",
          alertEligible: false,
        },
      ],
      alertEligibleCount: 1,
      alertEligibleIds: ["coin-b"],
    };

    const status = evaluateDataQualityStatus(makeDataQualityEvaluationInput({ dataQuality: makeDataQuality(),
    activePriceCoverageImpactStatus: "healthy",
    missingPriceRatio: 0,
    blacklistMissingRatio: 0,
    blacklistRecentMissing: 0,
    onchainAssessment: { status: "healthy", causes: [], representative: false },
    reserveCompositionStatus: "healthy", })).status;
    const causes = evaluateDataQualityStatus(makeDataQualityEvaluationInput({ dataQuality: makeDataQuality(),
    activePriceCoverage,
    missingPriceRatio: 0,
    blacklistMissingRatio: 0,
    blacklistRecentMissing: 0,
    onchainAssessmentCauses: [],
    reserveCompositionQueryFailed: false,
    reserveComposition: makeReserveComposition(), })).causes;

    expect(status).toBe("healthy");
    expect(causes).toContainEqual(
      expect.objectContaining({
        code: "active_price_coverage_incomplete",
        severity: "warning",
        metric: "missingActivePrices",
        value: 2,
        message: expect.stringContaining("coin-b"),
      }),
    );
    expect(causes.find((cause) => cause.code === "active_price_coverage_incomplete")?.message).not.toContain("coin-c");
    expect(causes.find((cause) => cause.code === "active_price_coverage_duration_degraded")).toBeUndefined();
  });

  it("emits a public-impact duration cause when a material gap outlives the duration budget", () => {
    const generations = STATUS_MISSING_PRICE_THRESHOLDS.generationsElevated + 4;
    const activePriceCoverage = {
      ...makePublicHealth().activePriceCoverage,
      status: "incomplete" as const,
      expectedActiveCount: 3,
      presentActiveCount: 3,
      pricedActiveCount: 1,
      missingPriceCount: 2,
      pricedActiveIds: ["coin-a"],
      missingActiveIds: ["coin-b", "coin-c"],
      missingActiveAssets: [
        {
          stablecoinId: "coin-b",
          symbol: "B",
          marketCapUsd: STATUS_MISSING_PRICE_THRESHOLDS.durationMaterialMarketCapUsd,
          currentPrice: null,
          currentSource: null,
          currentObservedAt: null,
          currentConfidence: null,
          consecutiveMissingGenerations: generations,
          lastAcceptedPrice: null,
          lastAcceptedSource: null,
          lastAcceptedObservedAt: null,
          rejectionReason: "missing",
          alertEligible: true,
        },
        {
          stablecoinId: "coin-c",
          symbol: "C",
          marketCapUsd: 10_000_000,
          currentPrice: null,
          currentSource: null,
          currentObservedAt: null,
          currentConfidence: null,
          consecutiveMissingGenerations: 1,
          lastAcceptedPrice: null,
          lastAcceptedSource: null,
          lastAcceptedObservedAt: null,
          rejectionReason: "missing",
          alertEligible: false,
        },
      ],
      alertEligibleCount: 1,
      alertEligibleIds: ["coin-b"],
    };

    const result = evaluateDataQualityStatus(makeDataQualityEvaluationInput({
      dataQuality: makeDataQuality(),
      activePriceCoverage,
      activePriceCoverageImpactStatus: "degraded",
      missingPriceRatio: 0,
      blacklistMissingRatio: 0,
      blacklistRecentMissing: 0,
      onchainAssessmentCauses: [],
      reserveCompositionQueryFailed: false,
      reserveComposition: makeReserveComposition(),
    }));

    expect(result.status).toBe("degraded");
    const durationCause = result.causes.find((cause) => cause.code === "active_price_coverage_duration_degraded");
    expect(durationCause).toEqual(expect.objectContaining({
      severity: "warning",
      metric: "missingPriceDurationGenerations",
      value: generations,
      threshold: STATUS_MISSING_PRICE_THRESHOLDS.generationsElevated,
    }));
    expect(durationCause?.message).toContain("coin-b");
    expect(durationCause?.message).not.toContain("coin-c");
  });

  it("emits an info-severity, non-degrading cause for a transient non-alert-eligible price miss", () => {
    const activePriceCoverage = {
      ...makePublicHealth().activePriceCoverage,
      status: "incomplete" as const,
      expectedActiveCount: 3,
      presentActiveCount: 3,
      pricedActiveCount: 2,
      missingPriceCount: 1,
      pricedActiveIds: ["coin-a", "coin-c"],
      missingActiveIds: ["coin-b"],
      missingActiveAssets: [
        {
          stablecoinId: "coin-b",
          symbol: "B",
          marketCapUsd: 20_000_000,
          currentPrice: null,
          currentSource: null,
          currentObservedAt: null,
          currentConfidence: null,
          consecutiveMissingGenerations: 1,
          lastAcceptedPrice: null,
          lastAcceptedSource: null,
          lastAcceptedObservedAt: null,
          rejectionReason: "missing",
          alertEligible: false,
        },
      ],
      alertEligibleCount: 0,
      alertEligibleIds: [],
    };

    // Realistic wiring: the gated public impact status is "healthy" for a
    // transient miss, so the admin dataQualityStatus floor no longer degrades on
    // it either. The cause is still emitted for observability, but at info
    // severity so it is neither public-impacting nor durable.
    const status = evaluateDataQualityStatus(makeDataQualityEvaluationInput({ dataQuality: makeDataQuality(),
    activePriceCoverageImpactStatus: "healthy",
    missingPriceRatio: 0,
    blacklistMissingRatio: 0,
    blacklistRecentMissing: 0,
    onchainAssessment: { status: "healthy", causes: [], representative: false },
    reserveCompositionStatus: "healthy", })).status;
    const causes = evaluateDataQualityStatus(makeDataQualityEvaluationInput({ dataQuality: makeDataQuality(),
    activePriceCoverage,
    missingPriceRatio: 0,
    blacklistMissingRatio: 0,
    blacklistRecentMissing: 0,
    onchainAssessmentCauses: [],
    reserveCompositionQueryFailed: false,
    reserveComposition: makeReserveComposition(), })).causes;

    expect(status).toBe("healthy");
    expect(causes).toContainEqual(
      expect.objectContaining({
        code: "active_price_coverage_incomplete",
        severity: "info",
        metric: "missingActivePrices",
        value: 1,
      }),
    );
  });

  it("retains uncertain-write causes without treating a deferred frontier as degradation", () => {
    const reserveComposition = {
      ...makeReserveComposition({
        status: "degraded",
        runBudgetTruncated: true,
        deferredCoins: 3,
        nextCursorStablecoinId: "coin-tail",
        writeTimeoutUncertain: 1,
      }),
    } as StatusResponse["reserveComposition"];

    const causes = evaluateDataQualityStatus(makeDataQualityEvaluationInput({ dataQuality: makeDataQuality(),
    activePriceCoverage: makePublicHealth().activePriceCoverage,
    missingPriceRatio: 0,
    blacklistMissingRatio: 0,
    blacklistRecentMissing: 0,
    onchainAssessmentCauses: [],
    reserveCompositionQueryFailed: false,
    reserveComposition, })).causes;

    expect(causes).toContainEqual(
      expect.objectContaining({
        code: "reserve_sync_write_uncertain",
        severity: "warning",
      }),
    );
    expect(causes.some((entry) => entry.code === "reserve_sync_budget_truncated")).toBe(false);
  });
});

describe("availability cron-error semantics", () => {
  const baseInput = makeAvailabilityEvaluationInput();

  it("stays healthy when nothing is wrong", () => {
    expect(evaluateAvailabilityStatus(baseInput).status).toBe("healthy");
  });

  it("degrades on a single critical cron error without escalating to stale", () => {
    expect(
      evaluateAvailabilityStatus(makeAvailabilityEvaluationInput({ ...baseInput,
      availabilityImpactingCronErrors: 1,
      availabilityImpactingUnhealthyCrons: 1, })).status,
    ).toBe("degraded");
  });

  it("escalates to stale on 2+ consecutive errors on the same critical cron", () => {
    expect(
      evaluateAvailabilityStatus(makeAvailabilityEvaluationInput({ ...baseInput,
      availabilityImpactingCronErrors: 1,
      availabilityImpactingUnhealthyCrons: 1,
      availabilityImpactingConsecutiveCronErrors: 1, })).status,
    ).toBe("stale");
  });

  it("escalates to stale when 2+ critical crons are simultaneously unhealthy", () => {
    expect(
      evaluateAvailabilityStatus(makeAvailabilityEvaluationInput({ ...baseInput,
      availabilityImpactingCronErrors: 2,
      availabilityImpactingUnhealthyCrons: 2, })).status,
    ).toBe("stale");
  });

  it("preserves cacheImpactStatus=stale escalation independent of cron health", () => {
    expect(
      evaluateAvailabilityStatus(makeAvailabilityEvaluationInput({ ...baseInput,
      publicHealth: makePublicHealth("healthy", { cacheImpactStatus: "stale" }), })).status,
    ).toBe("stale");
  });

  it("respects publicAvailabilityFloor via mintBurnImpactStatus=stale", () => {
    expect(
      evaluateAvailabilityStatus(makeAvailabilityEvaluationInput({ ...baseInput,
      publicHealth: makePublicHealth("healthy", {
        mintBurnImpactStatus: "stale",
        mintBurnLastRunStatus: "error",
      }), })).status,
    ).toBe("stale");
  });

  it("uses an unavailable degradation instead of trusting stale mint/burn classification", () => {
    expect(
      evaluateAvailabilityStatus(makeAvailabilityEvaluationInput({ ...baseInput,
      publicHealth: makePublicHealth("healthy", {
        mintBurnImpactStatus: "stale",
        mintBurnQueryError: "Mint/burn health data unavailable.",
        mintBurnLastRunStatus: "error",
      }), })).status,
    ).toBe("degraded");
  });
});

describe("status rule-set behavior at policy boundaries", () => {
  it("emits every data-quality rule's causes once in persisted evaluation order", () => {
    const result = evaluateDataQualityStatus(makeDataQualityEvaluationInput({
      dataQuality: makeDataQuality({
        stablecoinsCacheStatus: "error",
        stablecoinPublication: { status: "unknown", expectedActiveCount: 1, presentActiveCount: 0,
          waivedActiveCount: 0, missingActiveIds: [], waivedActiveIds: [], expiredWaiverIds: [], observedAt: null },
        sourceFailures: [{ source: "blacklist-gaps", message: "unavailable" }],
      }),
      activePriceCoverage: { ...makePublicHealth().activePriceCoverage, status: "unknown" },
      reserveCompositionQueryFailed: true,
      repairRunnerAutoRepairCount: 1,
      missingPriceRatio: 0.5,
      blacklistMissingRatio: 0.02,
      onchainAssessment: { status: "degraded", causes: [], representative: true },
      onchainAssessmentCauses: [{ code: "onchain_supply_stale", layer: "data-quality", severity: "warning", message: "Stale feed" }],
      reserveComposition: makeReserveComposition({
        status: "degraded", writeTimeoutUncertain: 1, expiredFeedReviewIds: ["reviewed-coin"],
      }),
    }));
    expect(result.status).toBe("stale");
    expect(result.causes.map((cause) => cause.code)).toEqual([
      "stablecoins_cache_unavailable", "stablecoin_publication_unknown", "active_price_coverage_unknown",
      "blacklist_gap_query_failed", "reserve_sync_query_failed", "ddr_auto_repair_count",
      "missing_prices_stale", "blacklist_gaps_stale", "onchain_supply_stale",
      "reserve_sync_write_uncertain", "reserve_feed_reviews_expired", "reserve_sync_degraded",
    ]);
  });

  it("names the jobs behind counted cron causes", () => {
    const combined = evaluateAvailabilityStatus({
      ...makeAvailabilityCauseInput(makePublicHealth()),
      availabilityImpactingCronErrors: 0,
      availabilityImpactingUnhealthyCrons: 1,
      availabilityImpactingConsecutiveCronErrors: 0,
      watchUnhealthyCrons: 0,
      degradedCronRuns: 0,
      cronErrorCount: 0,
      cronHistoryQueryFailed: false,
      cronProgressQueryFailed: false,
      cronLeaseQueryFailed: false,
      cronFindingJobs: { availabilityImpactingUnhealthy: ["sync-mint-burn"] },
    });
    expect(combined.causes.find((cause) => cause.code === "unhealthy_crons_present")).toMatchObject({
      message: "1 availability-impacting cron job(s) are unavailable/stale. Jobs: sync-mint-burn.",
      subjects: ["sync-mint-burn"],
    });
  });

  it.each([
    // Below the stale band, price breadth is graded from exact coverage, not the ratio.
    [{ missingPriceRatio: 0.3 }, "healthy"],
    [{ missingPriceRatio: STATUS_MISSING_PRICE_THRESHOLDS.ratioStale }, "healthy"],
    [{ missingPriceRatio: STATUS_MISSING_PRICE_THRESHOLDS.ratioStale + 0.0001 }, "stale"],
    [{ blacklistMissingRatio: STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded }, "degraded"],
    [{ blacklistMissingRatio: STATUS_BLACKLIST_THRESHOLDS.missingRatioStale }, "stale"],
    [{ blacklistRecentMissing: STATUS_BLACKLIST_THRESHOLDS.missingRecentWatch }, "healthy"],
    [{ blacklistRecentMissing: 500 }, "healthy"],
    [{ reserveCompositionStatus: "degraded", reserveComposition: makeReserveComposition({ status: "degraded" }) }, "degraded"],
    [{ reserveCompositionStatus: "stale", reserveComposition: makeReserveComposition({ status: "stale" }) }, "stale"],
  ] as Array<[Partial<DataQualityEvaluationInput>, StatusResponse["dataQualityStatus"]]>)("classifies data quality at policy boundaries", (overrides, status) => {
    const evaluation = evaluateDataQualityStatus(makeDataQualityEvaluationInput(overrides));
    expect(evaluation.status).toBe(status);
  });
});

describe("review expiry reminders", () => {
  const nowSec = 1_700_000_000;
  const runbookUrl = "https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks/review-renewal.md";

  function priceReview(stablecoinId: string, remainingSec: number): StablecoinPriceGapReview {
    return {
      stablecoinId, owner: "ops", reason: "Reviewed missing-price evidence.",
      sources: ["https://example.com/price-evidence"],
      reviewedAt: nowSec - 86400, expiresAt: nowSec + remainingSec,
    };
  }

  function priceInput(
    reviews: StablecoinPriceGapReview[],
    coverageClock = nowSec,
    price: number | null = null,
  ): DataQualityEvaluationInput {
    const evaluated = evaluateStablecoinActivePriceCoverage(
      reviews.map((review) => ({ id: review.stablecoinId, price })),
      reviews.map((review) => review.stablecoinId),
      { nowSec: coverageClock, priceGapReviews: reviews },
    );
    return makeDataQualityEvaluationInput({
      nowSec,
      activePriceCoverage: { ...evaluated, status: evaluated.complete ? "complete" : "incomplete", observedAt: coverageClock },
    });
  }

  function reserveReview(stablecoinId: string, remainingSec: number): ReserveFeedReview {
    return {
      stablecoinId, adapterKey: "midas-mtbill", failureCategory: "unknown",
      warningCodes: [], errorPrefix: "primary:http-json: midas-mtbill:stale-portfolio-timestamp",
      owner: "ops", reason: "Reviewed stale portfolio evidence.",
      sources: [{ url: "https://example.com/reserve-evidence", evidenceDate: "2023-11-13" }],
      reviewedAt: nowSec - 86400, expiresAt: nowSec + remainingSec,
    };
  }

  function reserveInput(reviews: ReserveFeedReview[]): DataQualityEvaluationInput {
    return makeDataQualityEvaluationInput({
      nowSec,
      reserveComposition: makeReserveComposition({
        acknowledgedFeedIds: reviews.map((review) => review.stablecoinId),
        acknowledgedFeeds: reviews,
      }),
    });
  }

  for (const lane of ["price", "reserve"] as const) {
    const code = lane === "price" ? "price_gap_reviews_expiring" : "reserve_feed_reviews_expiring";
    const metric = lane === "price" ? "priceGapReviewsExpiringSoonestSec" : "reserveFeedReviewsExpiringSoonestSec";

    it.each([
      [172740, true],
      [172800, true],
      [172801, false],
      [0, false],
      [-1, false],
    ] as const)(`${lane} lane reminds only inside the inclusive 48h boundary (%i seconds)`, (remainingSec, reminds) => {
      const input = lane === "price"
        ? priceInput([priceReview("coin-a", remainingSec)], nowSec - 2)
        : reserveInput([reserveReview("coin-a", remainingSec)]);
      const result = evaluateDataQualityStatus(input);
      const reminder = result.causes.find((cause) => cause.code === code);
      expect(result.status).toBe("healthy");
      if (reminds) {
        expect(reminder).toMatchObject({
          layer: "data-quality", severity: "info", metric, value: remainingSec, threshold: 172800, runbookUrl,
        });
        expect(reminder?.message).toContain("coin-a");
        expect(reminder?.message).toContain(new Date((nowSec + remainingSec) * 1000).toISOString());
        expect(reminder?.message).toContain(`${Math.floor(remainingSec / 3600)}h left`);
      } else {
        expect(reminder).toBeUndefined();
      }
      if (lane === "reserve") {
        expect(result.causes).toContainEqual(expect.objectContaining({
          code: "reserve_feed_reviews_acknowledged", severity: "info",
        }));
      }
    });

  }

  it("reports expired price reviews without a reminder", () => {
    const input = priceInput([priceReview("coin-a", 0)]);
    expect(input.activePriceCoverage.missingActiveAssets[0].acknowledgedGap).toBeNull();
    const reviewCauses = evaluateDataQualityStatus(input).causes.filter((cause) => cause.code.startsWith("price_gap_reviews_"));
    expect(reviewCauses).toEqual([expect.objectContaining({ code: "price_gap_reviews_expired", severity: "info", runbookUrl })]);
  });

  it("reports expired reserve reviews without acknowledgement or a reminder", () => {
    const input = reserveInput([]);
    input.reserveComposition = makeReserveComposition({ acknowledgedFeeds: [], expiredFeedReviewIds: ["coin-a"] });
    const reviewCauses = evaluateDataQualityStatus(input).causes.filter((cause) => cause.code.startsWith("reserve_feed_reviews_"));
    expect(reviewCauses).toEqual([expect.objectContaining({ code: "reserve_feed_reviews_expired", severity: "info", runbookUrl })]);
  });

  it("does not remind about a price review once its asset is priced", () => {
    const input = priceInput([priceReview("coin-a", 3600)], nowSec, 1);
    expect(input.activePriceCoverage.missingActiveAssets).toEqual([]);
    expect(evaluateDataQualityStatus(input).causes.some((cause) => cause.code === "price_gap_reviews_expiring")).toBe(false);
  });

  it("reminds about a weekly-window price review only while acknowledging the gap", () => {
    // The fixed evaluation clock falls on Tuesday, 22:13 UTC.
    const weekSec = 2 * 86400 + 22 * 3600 + 13 * 60 + 20;
    const review = priceReview("coin-a", 3600);
    review.weeklyUtcWindow = { start: weekSec, end: weekSec + 7200 };
    expect(evaluateDataQualityStatus(priceInput([review])).causes.some((cause) => cause.code === "price_gap_reviews_expiring")).toBe(true);
    review.weeklyUtcWindow = { start: weekSec + 1, end: weekSec + 7200 };
    expect(evaluateDataQualityStatus(priceInput([review])).causes.some((cause) => cause.code === "price_gap_reviews_expiring")).toBe(false);
  });

  it("keeps independent reserve degradation gating alongside an informational reminder", () => {
    const input = reserveInput([reserveReview("coin-a", 3600)]);
    input.reserveComposition = makeReserveComposition({
      status: "degraded", acknowledgedFeedIds: ["coin-a"], acknowledgedFeeds: [reserveReview("coin-a", 3600)],
    });
    input.reserveCompositionStatus = "degraded";
    const result = evaluateDataQualityStatus(input);
    expect(result.status).toBe("degraded");
    expect(result.causes.filter((cause) => cause.severity !== "info")).toEqual([
      expect.objectContaining({ code: "reserve_sync_degraded", severity: "warning" }),
    ]);
    expect(result.causes).toContainEqual(expect.objectContaining({
      code: "reserve_feed_reviews_expiring", severity: "info",
    }));
  });
});
