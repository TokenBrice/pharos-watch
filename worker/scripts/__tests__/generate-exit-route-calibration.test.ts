import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { DexLiquidityData, ExitRouteObservation } from "@shared/types/market";
import {
  computeDexLiquidityPayloadFingerprint,
  computeReportCardsRegistryFingerprint,
  createReportCardsFixedInput,
} from "../../src/lib/report-cards-fixed-input";
import { buildExitRouteCalibrationReport, selectBestRouteCapacity } from "../generate-exit-route-calibration";

function withoutBaseInputGenerationId<T extends { baseInputGenerationId: string }>(input: T) {
  const { baseInputGenerationId: _baseInputGenerationId, ...legacy } = input;
  return legacy;
}

const CLOCK_SEC = 1_783_891_200;

function fixedInput(dexLiqMap: Record<string, DexLiquidityData> = {}) {
  return {
    schemaVersion: 2 as const,
    capturedAt: "2026-07-12T22:00:00.000Z",
    sourceGeneration: "fixed-fixture",
    dexGenerationId: "dex-generation-42",
    dexPayloadFingerprint: computeDexLiquidityPayloadFingerprint(dexLiqMap, "dex-generation-42"),
    registryRevision: "fixture-revision",
    registryFingerprint: computeReportCardsRegistryFingerprint(),
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
    dexLiqMap,
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

function exactFixedInput() {
  const dexUpdatedAt = CLOCK_SEC - 100;
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    capturedAt: "2026-07-12T22:00:00.000Z",
    sourceGeneration: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${CLOCK_SEC}`,
    dexGenerationId: `dex-liquidity-${dexUpdatedAt}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "fixture-revision",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: CLOCK_SEC,
    updatedAt: CLOCK_SEC,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: dexUpdatedAt, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap: Object.fromEntries(
      ACTIVE_STABLECOINS.map((coin) => [
        coin.id,
        {
          liquidityScore: null,
          concentrationHhi: null,
          poolCount: 0,
          chainCount: 0,
          methodologyVersion: "fixture",
          updatedAt: dexUpdatedAt,
        },
      ]),
    ),
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: Object.fromEntries(ACTIVE_STABLECOINS.map((coin) => [coin.id, false])),
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {},
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

function dexRow(
  exitRouteObservations: ExitRouteObservation[],
  coverage: DexLiquidityData["exitRouteObservationCoverage"],
): DexLiquidityData {
  return {
    totalTvlUsd: 1,
    totalVolume24hUsd: 1,
    totalVolume7dUsd: 1,
    poolCount: 2,
    pairCount: 1,
    chainCount: 1,
    protocolTvl: {},
    chainTvl: {},
    topPools: [],
    liquidityScore: 50,
    concentrationHhi: null,
    depthStability: null,
    tvlChange24h: null,
    tvlChange7d: null,
    updatedAt: CLOCK_SEC - 100,
    dexPriceUsd: null,
    dexDeviationBps: null,
    priceSourceCount: null,
    priceSourceTvl: null,
    priceSources: null,
    effectiveTvlUsd: 1,
    avgPoolStress: null,
    weightedBalanceRatio: null,
    organicFraction: null,
    durabilityScore: null,
    coverageClass: "primary",
    coverageConfidence: 1,
    liquidityEvidenceClass: "measured",
    hasMeasuredLiquidityEvidence: true,
    trendworthy: true,
    sourceMix: {},
    balanceMeasuredTvlUsd: 1,
    organicMeasuredTvlUsd: 1,
    scoreComponents: null,
    lockedLiquidityPct: null,
    methodologyVersion: "fixture",
    exitRouteObservations,
    exitRouteObservationCoverage: coverage,
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

  it("shares lane, future-time, and documented-term eligibility with active scoring", () => {
    const invalidDexRows = [
      observation({ routeId: "dex:future", observedAt: CLOCK_SEC + 1 }),
      observation({ routeId: "dex:wrong-family", routeFamily: "issuer-redemption" }),
    ];
    expect(
      selectBestRouteCapacity({
        observations: invalidDexRows,
        lane: "dex",
        modeledExitSizeUsd: 100_000,
        clockSec: CLOCK_SEC,
        maxObservationAgeSec: 3_600,
      }),
    ).toMatchObject({ status: "observed-ineligible", eligibleObservationCount: 0 });

    const reviewedTerms = observation({
      routeId: "redeem:reviewed",
      routeFamily: "issuer-redemption",
      evidenceKind: "documented-terms",
      observedAt: CLOCK_SEC - 300 * 86_400,
      freshnessSeconds: 300 * 86_400,
    });
    expect(
      selectBestRouteCapacity({
        observations: [reviewedTerms],
        lane: "redemption",
        modeledExitSizeUsd: 100_000,
        clockSec: CLOCK_SEC,
        maxObservationAgeSec: 3_600,
      }),
    ).toMatchObject({ status: "eligible", eligibleObservationCount: 1 });
  });

  it("emits a deterministic all-active replay and an explicit blocked activation decision", () => {
    const options = {
      generationId: "dex-generation-42",
      producerGenerationStatus: "complete" as const,
      activationDecision: "hold" as const,
      decisionReason: "Hold until both route lanes meet the general minimum coverage policy.",
      dexMaxObservationAgeSec: 1_000,
      liveRedemptionMaxObservationAgeSec: 1_000,
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
    expect(first.source).toMatchObject({
      captureKind: "public-reconstruction",
      methodologyMismatchBypassUsed: false,
      registryMismatchBypassUsed: false,
      dexGenerationId: "dex-generation-42",
      redemptionGenerationId: "redemption-backstops-1783891000",
      inputMethodologyVersions: {
        safetyScore: SAFETY_SCORE_METHODOLOGY_VERSION,
      },
    });
    expect(first.source.legacyReplayPayloadFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.source.activeReplayPayloadFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.coverage).toMatchObject({
      activeAssets: first.rows.length,
      dex: { eligibleAssets: 0, observations: 0 },
      redemption: { eligibleAssets: 0, observations: 0 },
    });
    expect(first.activationDecision).toMatchObject({
      decision: "hold",
      activationReady: false,
      decisionConsistentWithGate: true,
      blockers: [
        "capture-not-publication-exact",
        "dex-eligible-asset-floor-not-met",
        "redemption-eligible-asset-floor-not-met",
      ],
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

  it("does not count an eligible observation from partial retained-pool coverage", () => {
    const input = fixedInput({
      "usdc-circle": dexRow([observation()], {
        status: "populated",
        capabilityMatrixVersion: "fixture-v1",
        retainedPoolCount: 2,
        scoreEligiblePoolCount: 1,
        observationCount: 1,
        scoreEligibleObservationCount: 1,
        unsupportedPoolCount: 0,
        evidenceCounts: { "reserve-based-amm-simulation": 1 },
        unsupportedReasons: {},
      }),
    });
    const report = buildExitRouteCalibrationReport(input, {
      generationId: "dex-generation-42",
      producerGenerationStatus: "complete",
      activationDecision: "hold",
      decisionReason: "Partial producer coverage cannot satisfy the DEX floor.",
      dexMaxObservationAgeSec: 1_000,
    });
    const row = report.rows.find((candidate) => candidate.id === "usdc-circle");

    expect(row?.dex).toMatchObject({ status: "observed-ineligible", eligibleObservationCount: 0, best: null });
    expect(row?.dexProducerCoverage).toMatchObject({ complete: false, scoreEligiblePoolCount: 1 });
    expect(report.coverage.dex.eligibleAssets).toBe(0);
    expect(report.activationDecision.blockers).toContain("dex-eligible-asset-floor-not-met");
  });

  it("rejects a calibration generation that is not bound to the captured DEX payload", () => {
    expect(() =>
      buildExitRouteCalibrationReport(fixedInput(), {
        generationId: "different-generation",
        producerGenerationStatus: "complete",
        activationDecision: "hold",
        decisionReason: "fixture",
      }),
    ).toThrow("does not match fixed input DEX generation");
  });

  it("rejects caller-supplied floors below the versioned general policy", () => {
    expect(() =>
      buildExitRouteCalibrationReport(fixedInput(), {
        generationId: "dex-generation-42",
        producerGenerationStatus: "complete",
        activationDecision: "hold",
        decisionReason: "fixture",
        minimumDexEligibleAssets: 1,
      }),
    ).toThrow("minimumDexEligibleAssets must be an integer at least 45");
  });

  it("records replay bypass requests as explicit activation blockers", () => {
    const input = exactFixedInput();
    const report = buildExitRouteCalibrationReport(input, {
      generationId: input.dexGenerationId,
      producerGenerationStatus: "complete",
      activationDecision: "hold",
      decisionReason: "Historical drift replay only.",
      allowMethodologyMismatch: true,
      allowRegistryMismatch: true,
    });

    expect(report.source).toMatchObject({
      captureKind: "exact-publication-inputs",
      methodologyMismatchBypassUsed: true,
      registryMismatchBypassUsed: true,
    });
    expect(report.activationDecision.blockers).toEqual([
      "methodology-mismatch-bypass-used",
      "registry-mismatch-bypass-used",
      "dex-eligible-asset-floor-not-met",
      "redemption-eligible-asset-floor-not-met",
    ]);
  });

  it("derives calibration methodology provenance and rejects a forged exact declaration", () => {
    const input = exactFixedInput();
    const forgedMethodologyVersions = {
      ...input.inputMethodologyVersions,
      dexLiquidity: ["forged-methodology"],
    };
    const reconstruction = withoutBaseInputGenerationId({
      ...input,
      captureKind: "public-reconstruction" as const,
      inputMethodologyVersions: forgedMethodologyVersions,
    });
    const report = buildExitRouteCalibrationReport(reconstruction, {
      generationId: input.dexGenerationId,
      producerGenerationStatus: "complete",
      activationDecision: "hold",
      decisionReason: "Reconstruction provenance test.",
    });

    expect(report.source.inputMethodologyVersions.dexLiquidity).toEqual(["fixture"]);
    expect(report.source.inputMethodologyVersions.dexLiquidity).not.toEqual(forgedMethodologyVersions.dexLiquidity);
    expect(() =>
      buildExitRouteCalibrationReport(
        withoutBaseInputGenerationId({ ...input, inputMethodologyVersions: forgedMethodologyVersions }),
        {
          generationId: input.dexGenerationId,
          producerGenerationStatus: "complete",
          activationDecision: "hold",
          decisionReason: "Exact provenance test.",
        },
      ),
    ).toThrow("producer methodology versions do not match its score-bearing payload rows");
  });

  it("refuses to emit an activation decision while the gate has blockers", () => {
    expect(() =>
      buildExitRouteCalibrationReport(fixedInput(), {
        generationId: "dex-generation-42",
        producerGenerationStatus: "complete",
        activationDecision: "activate",
        decisionReason: "fixture",
      }),
    ).toThrow("Cannot activate same-notional scoring: capture-not-publication-exact");
  });
});
