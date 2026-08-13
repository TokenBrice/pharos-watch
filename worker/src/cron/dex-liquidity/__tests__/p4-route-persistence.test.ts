import { describe, expect, it } from "vitest";
import {
  buildDexScoreDetailsJson,
  selectStillFreshDexRouteSetHold,
} from "../persistence";
import type { FullScoreResult } from "../types";

function scoreResult(): FullScoreResult {
  return {
    tvl: 1_000_000,
    effectiveTvl: 900_000,
    vol24h: 100_000,
    score: 42,
    hhi: 1,
    durability: 50,
    components: {
      tvlDepth: 10,
      volumeActivity: 20,
      poolQuality: 30,
      durability: 40,
      pairDiversity: 50,
    },
    weightedBalanceRatio: null,
    organicFrac: null,
    avgStress: null,
    lockedLiqPct: null,
    coverageClass: "primary",
    coverageConfidence: 0.8,
    sourceMix: { cg_tickers: { poolCount: 1, tvlUsd: 1_000_000 } },
    balanceMeasuredTvlUsd: 0,
    organicMeasuredTvlUsd: 0,
  };
}

describe("P4 route observation persistence envelope", () => {
  it("preserves the legacy score-component object when route fields are absent", () => {
    expect(JSON.parse(buildDexScoreDetailsJson(scoreResult()))).toEqual({
      tvlDepth: 10,
      volumeActivity: 20,
      poolQuality: 30,
      durability: 40,
      pairDiversity: 50,
    });
  });

  it("adds observations without replacing legacy score component keys", () => {
    const result = Object.assign(scoreResult(), {
      exitRouteObservations: [
        {
          routeId: "dex:usdc:cg-tickers:coinbase",
          routeFamily: "dex-orderbook" as const,
          scope: { kind: "venue" as const, venue: "coinbase", protocol: "coinbase" },
          requestedNotionalUsd: 1_000_000,
          settlementHorizonSec: 300,
          maxCostBps: 200,
          executableUsd: 500_000,
          completionRatio: 0.5,
          output: { kind: "fiat" as const, currency: "USD" },
          evidenceKind: "direct-orderbook-depth" as const,
          confidence: "medium" as const,
          scoreEligible: false,
          observedAt: 1_720_000_000,
          freshnessSeconds: 0,
          commonModeKeys: ["protocol:coinbase", "fiat:usd"],
          capacityCurve: [
            {
              requestedNotionalUsd: 1_000_000,
              maxCostBps: 200,
              executableUsd: 500_000,
              completionRatio: 0.5,
            },
          ],
        },
      ],
      exitRouteObservationCoverage: {
        status: "populated" as const,
        capabilityMatrixVersion: "p4a.1",
        retainedPoolCount: 1,
        observationCount: 1,
        scoreEligibleObservationCount: 0,
        unsupportedPoolCount: 0,
        evidenceCounts: { "direct-orderbook-depth": 1 },
        unsupportedReasons: {},
      },
    });

    expect(JSON.parse(buildDexScoreDetailsJson(result))).toMatchObject({
      tvlDepth: 10,
      pairDiversity: 50,
      exitRouteObservations: [{ routeId: "dex:usdc:cg-tickers:coinbase" }],
      exitRouteObservationCoverage: {
        status: "populated",
        observationCount: 1,
      },
    });
  });

  it("preserves a still-fresh route set for one asset after unconfirmed capacity churn", () => {
    const observation = (
      routeId: string,
      executableUsd: number,
      observedAt: number,
    ) => ({
      routeId,
      routeFamily: "dex-amm" as const,
      scope: {
        kind: "chain-contract" as const,
        chain: "Ethereum",
        contractOrPoolId: routeId,
        protocol: "curve",
      },
      requestedNotionalUsd: 25_000_000,
      settlementHorizonSec: 300,
      maxCostBps: 200,
      executableUsd,
      completionRatio: executableUsd / 25_000_000,
      output: { kind: "tracked-stablecoin" as const, trackedAssetIds: ["usdc-circle"] },
      evidenceKind: "reserve-based-amm-simulation" as const,
      confidence: "high" as const,
      scoreEligible: true,
      observedAt,
      freshnessSeconds: 0,
      commonModeKeys: [`pool:${routeId}`, "chain:ethereum", "protocol:curve"],
      capacityCurve: [{
        requestedNotionalUsd: 25_000_000,
        maxCostBps: 200,
        executableUsd,
        completionRatio: executableUsd / 25_000_000,
      }],
    });
    const coverage = {
      status: "populated" as const,
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
    const nowSec = 1_800_000_000;
    const previousObservation = observation(
      "dex:usdt:curve:deep",
      24_600_000,
      nowSec - 1_800,
    );
    const candidate = Object.assign(scoreResult(), {
      exitRouteObservations: [
        observation("dex:usdt:sunswap:thin", 1_000, nowSec),
      ],
      exitRouteObservationCoverage: coverage,
    });
    const previousRaw = JSON.stringify({
      exitRouteObservations: [previousObservation],
      exitRouteObservationCoverage: coverage,
    });

    expect(
      selectStillFreshDexRouteSetHold(candidate, previousRaw, nowSec),
    ).toMatchObject({
      observations: [{ routeId: "dex:usdt:curve:deep" }],
      previousBestCapacityUsd: 24_600_000,
      candidateBestCapacityUsd: 1_000,
    });
    expect(
      selectStillFreshDexRouteSetHold(
        candidate,
        JSON.stringify({
          exitRouteObservations: [{
            ...previousObservation,
            observedAt: nowSec - 3_601,
          }],
          exitRouteObservationCoverage: coverage,
        }),
        nowSec,
      ),
    ).toBeNull();
  });
});
