import { describe, expect, it } from "vitest";
import {
  buildDexScoreDetailsJson,
  selectStillFreshDexRouteSetHold,
} from "../persistence";
import {
  makeDexRouteHoldFixture,
  makeP4ScoreResult,
} from "../../__tests__/dex-liquidity-persistence.test-support";

describe("P4 route observation persistence envelope", () => {
  it("preserves the legacy score-component object when route fields are absent", () => {
    expect(JSON.parse(buildDexScoreDetailsJson(makeP4ScoreResult()))).toEqual({
      tvlDepth: 10,
      volumeActivity: 20,
      poolQuality: 30,
      durability: 40,
      pairDiversity: 50,
    });
  });

  it("adds observations without replacing legacy score component keys", () => {
    const result = Object.assign(makeP4ScoreResult(), {
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
    const { candidate, previousRaw, nowSec, previousObservation, coverage } = makeDexRouteHoldFixture();

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

  it("does not retain falling capacity when route identities are unchanged", () => {
    const { candidate, previousObservation, previousRaw, nowSec } = makeDexRouteHoldFixture();
    candidate.exitRouteObservations[0].routeId = previousObservation.routeId;
    expect(selectStillFreshDexRouteSetHold(candidate, previousRaw, nowSec)).toBeNull();
  });

  it("fails closed for unavailable or invalid previous sets and empty candidates", () => {
    const { candidate, previousRaw, nowSec } = makeDexRouteHoldFixture();
    for (const raw of [null, "{", "[]", JSON.stringify({
      ...JSON.parse(previousRaw), exitRouteObservations: [{ routeId: "invalid" }],
    }), JSON.stringify({ ...JSON.parse(previousRaw), exitRouteObservations: [] })]) {
      expect(selectStillFreshDexRouteSetHold(candidate, raw, nowSec)).toBeNull();
    }
    candidate.exitRouteObservations = [];
    expect(selectStillFreshDexRouteSetHold(candidate, previousRaw, nowSec)).toBeNull();
  });

  it("admits the exact freshness boundary but rejects expired or future observations", () => {
    const { candidate, previousObservation, coverage, nowSec } = makeDexRouteHoldFixture();
    for (const [age, held] of [[3_600, true], [3_601, false], [-1, false]] as const) {
      const raw = JSON.stringify({
        exitRouteObservations: [{ ...previousObservation, observedAt: nowSec - age }],
        exitRouteObservationCoverage: coverage,
      });
      expect(selectStillFreshDexRouteSetHold(candidate, raw, nowSec) !== null).toBe(held);
    }
  });

  it("requires minimum prior capacity and includes exactly half candidate capacity", () => {
    const { observation, candidate, coverage, nowSec } = makeDexRouteHoldFixture();
    for (const [prior, next, held] of [
      [99_999, 1_000, false], [100_000, 50_000, true], [100_000, 50_001, false],
    ] as const) {
      const raw = JSON.stringify({
        exitRouteObservations: [observation("old", prior, nowSec)],
        exitRouteObservationCoverage: coverage,
      });
      candidate.exitRouteObservations = [observation("new", next, nowSec)];
      expect(selectStillFreshDexRouteSetHold(candidate, raw, nowSec) !== null).toBe(held);
    }
  });

  it("uses only the 25M/200bps curve point rather than headline capacity", () => {
    const { candidate, previousObservation, coverage, nowSec } = makeDexRouteHoldFixture();
    previousObservation.executableUsd = 1;
    candidate.exitRouteObservations[0].executableUsd = 25_000_000;
    const raw = () => JSON.stringify({
      exitRouteObservations: [previousObservation],
      exitRouteObservationCoverage: coverage,
    });
    expect(selectStillFreshDexRouteSetHold(candidate, raw(), nowSec)).toMatchObject({
      previousBestCapacityUsd: 24_600_000, candidateBestCapacityUsd: 1_000,
    });
    previousObservation.capacityCurve[0].maxCostBps = 100;
    expect(selectStillFreshDexRouteSetHold(candidate, raw(), nowSec)).toBeNull();
    previousObservation.capacityCurve[0].maxCostBps = 200;
    previousObservation.capacityCurve[0].requestedNotionalUsd = 1_000_000;
    expect(selectStillFreshDexRouteSetHold(candidate, raw(), nowSec)).toBeNull();
  });
});
