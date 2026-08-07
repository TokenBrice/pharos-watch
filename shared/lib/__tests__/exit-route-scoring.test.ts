import { describe, expect, it } from "vitest";
import {
  EXIT_ROUTE_SCORING_TABLES,
  blendExitCapacityComponent,
  composeExitComponentScore,
  interpolateExitBreakpointScore,
  resolveExitDelayBandMultiplier,
  resolveExitRequestSupplyNotionalUsd,
  resolveExitScoringRequest,
  resolveExitThresholdBandMultiplier,
} from "@shared/lib/exit-route-scoring";
import {
  computeCapacityScore,
  computeModeledExitSizeUsd,
  computeRedemptionBackstopScore,
} from "@shared/lib/redemption-backstop-scoring";
import { selectV9ExitStressRequest } from "@shared/lib/safety-score-v9/exit";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";

const envelope = V9_CANDIDATE_POLICY_V1;

describe("the one exit request, two denominators", () => {
  it("derives both requests from the same clamped supply share", () => {
    for (const circulatingUsd of [1_000, 500_000, 4_000_000, 120_000_000, 900_000_000, 40_000_000_000]) {
      const raw = resolveExitRequestSupplyNotionalUsd(circulatingUsd, EXIT_ROUTE_SCORING_TABLES.request);
      const supplyDenominator = resolveExitScoringRequest(
        "supply-denominator",
        circulatingUsd,
        EXIT_ROUTE_SCORING_TABLES.request,
      );
      const stress = resolveExitScoringRequest("stress-grid", circulatingUsd, EXIT_ROUTE_SCORING_TABLES.request);

      expect(raw).not.toBeNull();
      expect(supplyDenominator?.rawSupplyRequestUsd).toBe(raw);
      expect(stress?.rawSupplyRequestUsd).toBe(raw);

      // The supply-denominator request is the raw share; the stress request
      // snaps it up to the reviewed notional grid.
      expect(supplyDenominator?.requestedNotionalUsd).toBe(raw);
      expect(stress!.requestedNotionalUsd).toBeGreaterThanOrEqual(raw!);
      expect(EXIT_ROUTE_SCORING_TABLES.request.notionalGridUsd).toContain(stress!.requestedNotionalUsd);
    }
  });

  it("rejects a missing or non-positive supply on both requests", () => {
    for (const circulatingUsd of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveExitScoringRequest("supply-denominator", circulatingUsd, EXIT_ROUTE_SCORING_TABLES.request)).toBeNull();
      expect(resolveExitScoringRequest("stress-grid", circulatingUsd, EXIT_ROUTE_SCORING_TABLES.request)).toBeNull();
    }
  });

  it("keeps each published view's request resolver on the shared engine", () => {
    for (const circulatingUsd of [250_000, 12_000_000, 3_000_000_000]) {
      expect(computeModeledExitSizeUsd(circulatingUsd)).toBe(
        resolveExitScoringRequest("supply-denominator", circulatingUsd, EXIT_ROUTE_SCORING_TABLES.request)!
          .requestedNotionalUsd,
      );
      expect(selectV9ExitStressRequest(circulatingUsd, envelope)!.requestedNotionalUsd).toBe(
        resolveExitScoringRequest("stress-grid", circulatingUsd, EXIT_ROUTE_SCORING_TABLES.request)!
          .requestedNotionalUsd,
      );
    }
  });
});

describe("shared breakpoint interpolation", () => {
  it("clamps at both ends and interpolates linearly between bands", () => {
    const points = EXIT_ROUTE_SCORING_TABLES.coverageRatioBreakpoints;
    expect(interpolateExitBreakpointScore(-1, points)).toBe(0);
    expect(interpolateExitBreakpointScore(0, points)).toBe(0);
    expect(interpolateExitBreakpointScore(0.05, points)).toBe(40);
    expect(interpolateExitBreakpointScore(0.5, points)).toBe(100);
    expect(interpolateExitBreakpointScore(10, points)).toBe(100);
    // Midway between the 0.05/40 and 0.1/60 bands.
    expect(interpolateExitBreakpointScore(0.075, points)).toBeCloseTo(50, 10);
  });

  it("returns the fractional value the pillar consumes, unrounded", () => {
    const raw = interpolateExitBreakpointScore(0.061, EXIT_ROUTE_SCORING_TABLES.coverageRatioBreakpoints);
    expect(Number.isInteger(raw)).toBe(false);
    // The redemption domain view rounds at its own boundary; both read the
    // same ladder.
    expect(computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.061 }).coverageRatioScore).toBe(
      Math.round(raw),
    );
  });
});

describe("shared band resolution", () => {
  it("matches delay bands by upper bound and treats a null bound as the tail", () => {
    const bands = EXIT_ROUTE_SCORING_TABLES.settlementDelayBands;
    expect(resolveExitDelayBandMultiplier(0, bands)).toBe(1);
    expect(resolveExitDelayBandMultiplier(3_600, bands)).toBe(1);
    expect(resolveExitDelayBandMultiplier(3_601, bands)).toBe(0.9);
    expect(resolveExitDelayBandMultiplier(604_801, bands)).toBe(0.6);
    expect(resolveExitDelayBandMultiplier(Number.MAX_SAFE_INTEGER, bands)).toBe(0.6);
    // No band matches a non-finite delay; each view applies its own documented
    // fall-through rather than silently taking the tail multiplier.
    expect(resolveExitDelayBandMultiplier(Number.NaN, bands)).toBeNull();
    expect(resolveExitDelayBandMultiplier(Number.POSITIVE_INFINITY, bands)).toBeNull();
  });

  it("keeps the queue ladder at-or-above and the minimum-redeem ladder strictly above", () => {
    const queue = EXIT_ROUTE_SCORING_TABLES.queueBacklogBands;
    expect(resolveExitThresholdBandMultiplier(1, queue, "at-or-above")).toBe(0.65);
    expect(resolveExitThresholdBandMultiplier(0.5, queue, "at-or-above")).toBe(0.8);
    expect(resolveExitThresholdBandMultiplier(0, queue, "at-or-above")).toBe(0.9);

    // Load-bearing divergence between the two ladders: a minimum sitting
    // exactly on a threshold takes the gentler band.
    const minimum = EXIT_ROUTE_SCORING_TABLES.minimumRedeemBands;
    expect(resolveExitThresholdBandMultiplier(1_000_000, minimum, "above")).toBe(0.9);
    expect(resolveExitThresholdBandMultiplier(1_000_001, minimum, "above")).toBe(0.75);
    expect(resolveExitThresholdBandMultiplier(10_000, minimum, "above")).toBeNull();
    expect(resolveExitThresholdBandMultiplier(10_001, minimum, "above")).toBe(0.9);
  });
});

describe("shared component composition", () => {
  it("splits capacity 60/40 between coverage completion and absolute size", () => {
    expect(blendExitCapacityComponent(100, 0)).toBe(60);
    expect(blendExitCapacityComponent(0, 100)).toBe(40);
    expect(blendExitCapacityComponent(80, 40)).toBe(64);
  });

  it("weights the component ladder identically for both published views", () => {
    const components = {
      access: 100,
      settlement: 90,
      executionCertainty: 80,
      capacity: 64,
      outputAssetQuality: 65,
      cost: 50,
    };
    const shared = composeExitComponentScore(components, EXIT_ROUTE_SCORING_TABLES.componentWeights);

    // The redemption domain view's public entry point, on an uncapped route
    // family, is the same weighted ladder rounded to a whole score.
    const domain = computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem",
      accessScore: components.access,
      settlementScore: components.settlement,
      executionCertaintyScore: components.executionCertainty,
      capacityScore: components.capacity,
      outputAssetQualityScore: components.outputAssetQuality,
      costScore: components.cost,
    });
    expect(domain.score).toBe(Math.round(shared));

    // The V9 pillar reads the same weights out of the validated policy
    // envelope, so the ladder is bit-identical on both sides.
    expect(composeExitComponentScore(components, envelope.policy.semantic.exit.componentWeights)).toBe(shared);
  });
});
