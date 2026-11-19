import { describe, expect, it } from "vitest";
import {
  EXIT_ROUTE_SCORING_TABLES,
  blendExitCapacityComponent,
  composeExitComponentScore,
  hasMaterialExitCapacity,
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
import { evaluateV9Exit, selectV9ExitStressRequest } from "@shared/lib/safety-score-v9/exit";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { makeExitRoute } from "./safety-score-v9-exit.test-support";

const envelope = V9_CANDIDATE_POLICY_V1;

describe("caller-owned exit request floors", () => {
  it.each([
    [1_000, 100_000, 100_000, 1_000_000],
    [120_000_000, 6_000_000, 10_000_000, 6_000_000],
    [900_000_000, 25_000_000, 25_000_000, 25_000_000],
  ])("resolves supply %s with separate standalone and Safety stress floors", (supply, raw, grid, safetyStress) => {
    expect(resolveExitRequestSupplyNotionalUsd(supply, EXIT_ROUTE_SCORING_TABLES.request)).toBe(raw);
    expect(resolveExitScoringRequest("supply-denominator", supply, EXIT_ROUTE_SCORING_TABLES.request))
      .toMatchObject({ rawSupplyRequestUsd: raw, requestedNotionalUsd: raw });
    expect(resolveExitScoringRequest("stress-grid", supply, EXIT_ROUTE_SCORING_TABLES.request))
      .toMatchObject({ rawSupplyRequestUsd: raw, requestedNotionalUsd: grid });
    expect(computeModeledExitSizeUsd(supply)).toBe(raw);
    expect(selectV9ExitStressRequest(supply, envelope)?.requestedNotionalUsd).toBe(safetyStress);
    expect(resolveExitScoringRequest("stress", supply, EXIT_ROUTE_SCORING_TABLES.request))
      .toMatchObject({ rawSupplyRequestUsd: raw, requestedNotionalUsd: raw });
  });

  it("keeps an unknown denominator unavailable while selecting maximum stress", () => {
    for (const circulatingUsd of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveExitScoringRequest("supply-denominator", circulatingUsd, EXIT_ROUTE_SCORING_TABLES.request)).toBeNull();
      expect(resolveExitScoringRequest("stress-grid", circulatingUsd, EXIT_ROUTE_SCORING_TABLES.request))
        .toMatchObject({ requestedNotionalUsd: 25_000_000, rawSupplyRequestUsd: 25_000_000 });
      expect(resolveExitScoringRequest("stress", circulatingUsd, EXIT_ROUTE_SCORING_TABLES.request))
        .toMatchObject({ requestedNotionalUsd: 25_000_000, rawSupplyRequestUsd: 25_000_000 });
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
    expect(raw).toBeCloseTo(44.4, 10);
    expect(computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.061 }).coverageRatioScore).toBe(44);
  });
});

describe("policy-owned exit materiality", () => {
  it("uses the caller's breakpoint envelope at first-positive absolute and coverage boundaries", () => {
    const policy = {
      absoluteCapacityBreakpoints: [{ value: 100_000, score: 0 }, { value: 200_001, score: 20 }],
      coverageRatioBreakpoints: [{ value: 0.01, score: 0 }, { value: 0.125, score: 20 }],
    };
    for (const [executableCapacityUsd, requestedNotionalUsd, material] of [
      [200_000, 1_600_001, false],
      [200_001, 1_600_009, true],
      [200_000, 1_600_000, true],
    ] as const) {
      expect(hasMaterialExitCapacity({ executableCapacityUsd, requestedNotionalUsd }, policy)).toBe(material);
    }
  });

  it("treats a non-positive or non-finite executable capacity as immaterial", () => {
    const v9Exit = V9_CANDIDATE_POLICY_V1.policy.semantic.exit;
    for (const executableCapacityUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(hasMaterialExitCapacity({
        executableCapacityUsd,
        requestedNotionalUsd: 1_000_000,
      }, v9Exit)).toBe(false);
    }
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

  it("matches both descending ladders at-or-above their threshold", () => {
    const queue = EXIT_ROUTE_SCORING_TABLES.queueBacklogBands;
    expect(resolveExitThresholdBandMultiplier(1, queue)).toBe(0.65);
    expect(resolveExitThresholdBandMultiplier(0.5, queue)).toBe(0.8);
    expect(resolveExitThresholdBandMultiplier(0, queue)).toBe(0.9);

    // Unified boundary semantics: a minimum sitting exactly on a threshold
    // takes that threshold's band rather than the gentler one below it.
    const minimum = EXIT_ROUTE_SCORING_TABLES.minimumRedeemBands;
    expect(resolveExitThresholdBandMultiplier(1_000_000, minimum)).toBe(0.75);
    expect(resolveExitThresholdBandMultiplier(999_999, minimum)).toBe(0.9);
    expect(resolveExitThresholdBandMultiplier(10_000, minimum)).toBe(0.9);
    expect(resolveExitThresholdBandMultiplier(9_999, minimum)).toBeNull();
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
      capacity: 76,
      outputAssetQuality: 65,
      cost: 50,
    };
    const shared = composeExitComponentScore(components, EXIT_ROUTE_SCORING_TABLES.componentWeights);
    expect(shared).toBe(79.25);
    expect(computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem", executableCapacityUsd: 1_000_000,
      accessScore: 100, settlementScore: 90, executionCertaintyScore: 80,
      capacityScore: 76, outputAssetQualityScore: 65, costScore: 50,
    }).score).toBe(79);
    const route = makeExitRoute({
      settlement: "immediate", execution: "deterministic-basket", outputQuality: "bluechip-collateral",
      capacityEvidenceTier: "live-direct",
      capacityCurve: [{
        requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 1_000_000,
        completionRatio: 1, executionCostBps: 100,
      }],
    });
    const exit = evaluateV9Exit({ circulatingUsd: 20_000_000, routes: [route] }, envelope);
    expect(exit.routes[0]?.components).toEqual(components);
    expect(exit.score).toBe(79.25);
  });
});
