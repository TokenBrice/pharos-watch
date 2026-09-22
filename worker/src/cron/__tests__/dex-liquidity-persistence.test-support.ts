import type {
  ExitRouteObservation,
  ExitRouteObservationCoverage,
} from "@shared/types/market";

import type { FullScoreResult } from "../dex-liquidity/types";

type DexRouteObservationFixture = ExitRouteObservation & {
  capacityCurve: NonNullable<ExitRouteObservation["capacityCurve"]>;
};

export function makeFullScoreResult(overrides: Partial<FullScoreResult> = {}): FullScoreResult {
  return {
    tvl: 1, effectiveTvl: 1, vol24h: 1, score: 1, hhi: 0.1, durability: 50,
    components: { tvlDepth: 10, volumeActivity: 10, poolQuality: 10, durability: 50, pairDiversity: 5 },
    weightedBalanceRatio: null, organicFrac: null, avgStress: null, lockedLiqPct: null,
    coverageClass: "primary", coverageConfidence: 1,
    sourceMix: { dl: { poolCount: 1, tvlUsd: 1 } },
    balanceMeasuredTvlUsd: 0, organicMeasuredTvlUsd: 0,
    ...overrides,
  };
}

export function makeP4ScoreResult(): FullScoreResult {
  return makeFullScoreResult({
    tvl: 1_000_000,
    effectiveTvl: 900_000,
    vol24h: 100_000,
    score: 42,
    hhi: 1,
    components: {
      tvlDepth: 10,
      volumeActivity: 20,
      poolQuality: 30,
      durability: 40,
      pairDiversity: 50,
    },
    coverageConfidence: 0.8,
    sourceMix: { cg_tickers: { poolCount: 1, tvlUsd: 1_000_000 } },
  });
}

export function makeDexRouteObservation(
  routeId: string,
  executableUsd: number,
  observedAt: number,
  options: {
    chain?: string;
    commonModeKeys?: string[];
  } = {},
): DexRouteObservationFixture {
  return {
    routeId,
    routeFamily: "dex-amm",
    scope: {
      kind: "chain-contract",
      chain: options.chain ?? "Ethereum",
      contractOrPoolId: routeId,
      protocol: "curve",
    },
    requestedNotionalUsd: 25_000_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd,
    completionRatio: executableUsd / 25_000_000,
    output: { kind: "tracked-stablecoin", trackedAssetIds: ["usdc-circle"] },
    evidenceKind: "reserve-based-amm-simulation",
    confidence: "high",
    scoreEligible: true,
    observedAt,
    freshnessSeconds: 0,
    commonModeKeys: options.commonModeKeys ?? [
      `pool:${routeId}`,
      "chain:ethereum",
      "protocol:curve",
    ],
    capacityCurve: [{
      requestedNotionalUsd: 25_000_000,
      maxCostBps: 200,
      executableUsd,
      completionRatio: executableUsd / 25_000_000,
    }],
  };
}

export function makeDexRouteObservationCoverage(): ExitRouteObservationCoverage {
  return {
    status: "populated",
    capabilityMatrixVersion: "p4a.9",
    retainedPoolCount: 1,
    observationCount: 1,
    scoreEligibleObservationCount: 1,
    scoreEligiblePoolCount: 1,
    scoreEligibleCapabilityPoolCount: 1,
    unsupportedPoolCount: 0,
    evidenceCounts: { "reserve-based-amm-simulation": 1 },
    unsupportedReasons: {},
  };
}

export function makeDexRouteHoldFixture() {
  const coverage = makeDexRouteObservationCoverage();
  const nowSec = 1_800_000_000;
  const previousObservation = makeDexRouteObservation(
    "dex:usdt:curve:deep",
    24_600_000,
    nowSec - 1_800,
  );
  const candidate = Object.assign(makeFullScoreResult(), {
    exitRouteObservations: [
      makeDexRouteObservation("dex:usdt:sunswap:thin", 1_000, nowSec),
    ],
    exitRouteObservationCoverage: coverage,
  });
  const previousRaw = JSON.stringify({
    exitRouteObservations: [previousObservation],
    exitRouteObservationCoverage: coverage,
  });
  return {
    observation: makeDexRouteObservation,
    coverage,
    nowSec,
    previousObservation,
    candidate,
    previousRaw,
  };
}
