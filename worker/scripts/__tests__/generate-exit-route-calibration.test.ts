import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import type { ExitRouteObservation } from "@shared/types/market";
import { buildExitRouteCalibrationReport, selectBestRouteCapacity } from "../generate-exit-route-calibration";

const CLOCK_SEC = 1_783_891_200;

function fixedInput() {
  return {
    schemaVersion: 1 as const,
    capturedAt: "2026-07-12T22:00:00.000Z",
    sourceGeneration: "fixed-fixture",
    registryRevision: "fixture-revision",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: CLOCK_SEC,
    updatedAt: CLOCK_SEC,
    liquidityStale: false,
    redemptionStale: false,
    inputFreshness: {
      dexLiquidity: { updatedAt: CLOCK_SEC - 100, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: CLOCK_SEC - 200, ageSeconds: 200, stale: false },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap: {},
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: {},
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {},
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  };
}

function observation(overrides: Partial<ExitRouteObservation> = {}): ExitRouteObservation {
  return {
    routeId: "dex:test",
    routeFamily: "dex-amm",
    scope: { kind: "chain-contract", chain: "Ethereum", contractOrPoolId: "0xpool", protocol: "test" },
    requestedNotionalUsd: 100_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: 100_000,
    completionRatio: 1,
    output: { kind: "collateral", assetKeys: ["ethereum:0xasset"] },
    evidenceKind: "reserve-based-amm-simulation",
    confidence: "high",
    scoreEligible: true,
    observedAt: CLOCK_SEC - 60,
    freshnessSeconds: 60,
    commonModeKeys: ["protocol:test", "chain:ethereum"],
    ...overrides,
  };
}

describe("exit-route decision-gate calibration", () => {
  it("selects the greatest absolute eligible capacity with a conservative retained-curve lower bound", () => {
    const smaller = observation({
      routeId: "dex:smaller",
      executableUsd: 80_000,
      completionRatio: 0.8,
      capacityCurve: [
        { requestedNotionalUsd: 100_000, maxCostBps: 200, executableUsd: 80_000, completionRatio: 0.8 },
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 400_000, completionRatio: 0.4 },
      ],
    });
    const larger = observation({
      routeId: "dex:larger",
      executableUsd: 90_000,
      completionRatio: 0.9,
      capacityCurve: [
        { requestedNotionalUsd: 100_000, maxCostBps: 200, executableUsd: 90_000, completionRatio: 0.9 },
        { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 600_000, completionRatio: 0.6 },
      ],
    });
    const stale = observation({ routeId: "dex:stale", observedAt: CLOCK_SEC - 10_000, freshnessSeconds: 10_000 });

    expect(
      selectBestRouteCapacity({
        observations: [smaller, stale, larger],
        lane: "dex",
        modeledExitSizeUsd: 500_000,
        clockSec: CLOCK_SEC,
        maxObservationAgeSec: 1_000,
      }),
    ).toEqual({
      status: "eligible",
      observationCount: 3,
      eligibleObservationCount: 2,
      best: {
        routeId: "dex:larger",
        executableUsd: 90_000,
        completionRatio: 0.18,
        evidenceKind: "reserve-based-amm-simulation",
        confidence: "high",
        observedAt: CLOCK_SEC - 60,
      },
    });
  });

  it("emits a deterministic all-active replay and an explicit blocked activation decision", () => {
    const options = {
      generationId: "dex-generation-42",
      producerGenerationStatus: "complete" as const,
      activationDecision: "hold" as const,
      decisionReason: "Hold until both route lanes meet the general minimum coverage policy.",
      minimumDexEligibleAssets: 1,
      minimumRedemptionEligibleAssets: 1,
      maxObservationAgeSec: 1_000,
    };
    const first = buildExitRouteCalibrationReport(fixedInput(), options);
    const second = buildExitRouteCalibrationReport(fixedInput(), options);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.rows.length).toBeGreaterThan(300);
    expect(first.rows).toEqual([...first.rows].sort((left, right) => left.id.localeCompare(right.id)));
    expect(first.generalPolicy).toMatchObject({
      modeledExitSizeFormulaChanged: false,
      namedAssetTuning: false,
      comparisonRequest: { maxCostBps: 200, settlementHorizonSec: 300 },
    });
    expect(first.coverage).toMatchObject({
      activeAssets: first.rows.length,
      dex: { eligibleAssets: 0, observations: 0 },
      redemption: { eligibleAssets: 0, observations: 0 },
    });
    expect(first.activationDecision).toMatchObject({
      decision: "hold",
      activationReady: false,
      decisionConsistentWithGate: true,
      blockers: ["dex-eligible-asset-floor-not-met", "redemption-eligible-asset-floor-not-met"],
    });
    expect(first.movements.overall).toMatchObject({
      increased: 0,
      decreased: 0,
      gradeChanged: 0,
      unchanged: first.rows.length,
    });
    expect(first.movements.exit.unchanged).toBe(first.rows.length);
    expect(first.coverage.dex.producerCoverageStatuses).toEqual({
      populated: 0,
      unsupported: 0,
      unknown: first.rows.length,
    });
  });
});
