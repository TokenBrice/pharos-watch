import { describe, expect, it } from "vitest";
import { canonicalExitRouteScopedKey } from "@shared/types/exit-route-identity";
import { isDexExitRouteCoverageComplete } from "@shared/lib/p4-exit-route-capability-policy";
import { getDexMeasuredExecutionFreshnessMaxSec } from "@shared/types/measured-execution";
import { DEX_MEASURED_CLOSURE_VALUATION_UNAVAILABLE } from "../../measured-execution/valuation-admission";
import { ExitRouteObservationCoverageSchema, ExitRouteObservationSchema, MAX_DEX_EXIT_ROUTE_OBSERVATIONS } from "@shared/types/exit-route";
import { classifyDexPlaceholderCoverage } from "../deployment-census-coverage";
import {
  buildDexScoreDetailsJson,
  selectStillFreshDexRouteSetHold,
} from "../persistence";
import {
  makeDexRouteHoldFixture as makeLegacyRouteHoldFixture,
  makeP4ScoreResult,
} from "../../__tests__/dex-liquidity-persistence.test-support";

function encodeCurrentRouteSet(detail: object): string {
  return JSON.stringify({ exitRouteAdmissionPolicyVersion: 1, ...detail });
}

function makeDexRouteHoldFixture() {
  const fixture = makeLegacyRouteHoldFixture();
  return { ...fixture, previousRaw: encodeCurrentRouteSet(JSON.parse(fixture.previousRaw)) };
}

function makeGoldRouteCarryFixture(capacityUsd = 62_875) {
  const { candidate, observation, coverage } = makeDexRouteHoldFixture();
  const close = Date.parse("2026-11-13T22:00Z") / 1000;
  const decision = close + 1_200;
  const previous = {
    ...observation("base-gold", capacityUsd, close - 600, { chain: "base", commonModeKeys: ["chain:base", "protocol:pancakeswap"] }),
    evidenceKind: "measured-executable-depth" as const,
    output: { kind: "tracked-stablecoin" as const, trackedAssetIds: ["paxg-paxos"] },
  };
  candidate.exitRouteObservations = [observation("current-ethereum", 1_000, decision)];
  const hold = () => selectStillFreshDexRouteSetHold(candidate, JSON.stringify({
    exitRouteObservations: [previous], exitRouteObservationCoverage: coverage,
  }), decision, undefined, { stablecoinId: "usdc-circle", rejectedAssetIds: new Set(["paxg-paxos"]) });
  return { previous, close, decision, hold, observation, candidate };
}

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

  it("records the producer NR reason beside the score components", () => {
    const result = Object.assign(makeP4ScoreResult(), {
      score: null,
      liquidityScoreUnavailableReason: "activity-stale" as const,
    });
    expect(JSON.parse(buildDexScoreDetailsJson(result))).toMatchObject({
      tvlDepth: 10,
      liquidityScoreUnavailableReason: "activity-stale",
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

  it("preserves original Solidly evidence through persistence and a hold without extending its clock", () => {
    const { candidate, previousObservation, coverage, nowSec } = makeDexRouteHoldFixture();
    const originalClock = nowSec - 120;
    const previous = {
      ...previousObservation, scoreEligible: false, observedAt: originalClock, freshnessSeconds: 180,
      ammExecutionEvidence: {
        sourceGenerationId: "dex-liquidity-scoring-stage:original", blockNumber: 52199671,
        blockHash: `0x${"a".repeat(64)}`, blockTimestamp: originalClock,
        inputReference: { priceUsd: 1, sourceId: "coingecko", observedAt: originalClock - 60 },
        outputReference: { priceUsd: 1, sourceId: "coingecko", observedAt: originalClock - 60 },
      },
    };
    const persisted = buildDexScoreDetailsJson(Object.assign(makeP4ScoreResult(), {
      exitRouteObservations: [previous], exitRouteObservationCoverage: coverage,
    }));
    const held = selectStillFreshDexRouteSetHold(candidate, persisted, nowSec);
    expect(held?.observations[0]).toMatchObject(previous);
    expect(ExitRouteObservationSchema.parse(JSON.parse(persisted).exitRouteObservations[0]).ammExecutionEvidence)
      .toEqual(previous.ammExecutionEvidence);
    expect(selectStillFreshDexRouteSetHold(candidate, persisted, originalClock + 3601)).toBeNull();
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
        encodeCurrentRouteSet({
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

  it.each([
    ["legacy-curve", "incompatible-curve-route-policy"],
    ["legacy-measured", "incompatible-measured-route-policy"],
    ["unrelated-closure", "held"],
  ] as const)(
    "does not restore an ineligible former best route over a nonempty candidate (%s)",
    (mode, decision) => {
      const { candidate, previousObservation, coverage, nowSec } = makeDexRouteHoldFixture();
      const previous = mode === "legacy-curve" ? previousObservation : {
        ...previousObservation,
        evidenceKind: "measured-executable-depth" as const,
        adapterProfileId: "uniswap-v3-quoter-v2",
        scope: { ...previousObservation.scope, protocol: "uniswap-v3" },
        output: { kind: "tracked-stablecoin" as const, trackedAssetIds: ["eurc-circle"] },
      };
      const detail = { exitRouteObservations: [previous], exitRouteObservationCoverage: coverage };
      const raw = mode.startsWith("legacy-") ? JSON.stringify(detail) : encodeCurrentRouteSet(detail);
      const decisions: string[] = [];
      const held = selectStillFreshDexRouteSetHold(candidate, raw, nowSec, (reason) => decisions.push(reason), {
        stablecoinId: "usdc-circle",
        rejectedAssetIds: new Set(["tgbp-token"]),
      });
      expect(held !== null).toBe(decision === "held");
      expect(decisions).toEqual([decision]);
    },
  );

  it.each([
    ["eurc-circle", "usdc-circle", "2026-11-13T21:40Z", "2026-11-15T19:00Z", "2026-11-15T22:01Z"],
    ["usdc-circle", "paxg-paxos", "2026-11-18T21:00Z", "2026-11-18T22:16Z", "2026-11-18T23:16Z"],
  ] as const)("holds a missing measured route with its original clock only through its closure (%s/%s)", (input, output, last, closed, reopened) => {
    const { candidate, previousObservation, coverage } = makeDexRouteHoldFixture();
    const previous = { ...previousObservation, observedAt: Date.parse(last) / 1000,
      evidenceKind: "measured-executable-depth", scope: { ...previousObservation.scope, protocol: "uniswap-v3" },
      output: { kind: "tracked-stablecoin", trackedAssetIds: [output] } };
    const details = { exitRouteObservations: [previous], exitRouteObservationCoverage: coverage };
    candidate.exitRouteObservations = [];
    const affected = input === "usdc-circle" ? output : input;
    const valuation = { stablecoinId: input, rejectedAssetIds: new Set<string>([affected]) };
    if (previous.scope.kind !== "chain-contract") throw new Error("expected a measured pool");
    const poolKey = canonicalExitRouteScopedKey(previous.scope.chain, previous.scope.contractOrPoolId);
    const rejectedQuoteHistory = { stablecoinId: input, rejectedAssetIds: new Set<string>(),
      poolReasons: new Map([[poolKey, DEX_MEASURED_CLOSURE_VALUATION_UNAVAILABLE]]) };
    for (const raw of [encodeCurrentRouteSet(details), JSON.stringify(details)]) {
      const held = selectStillFreshDexRouteSetHold(candidate, raw, Date.parse(closed) / 1000, undefined, valuation);
      expect(held?.observations).toEqual([previous]);
      expect(selectStillFreshDexRouteSetHold(candidate, raw, Date.parse(closed) / 1000, undefined, rejectedQuoteHistory)?.observations)
        .toEqual([previous]);
      expect(selectStillFreshDexRouteSetHold(candidate, raw, Date.parse(closed) / 1000, undefined, {
        ...valuation, rejectedAssetIds: new Set(["tgbp-token"]),
      })).toBeNull();
      expect(selectStillFreshDexRouteSetHold(candidate, raw, Date.parse(reopened) / 1000, undefined, valuation)).toBeNull();
    }
    for (const policy of [null, 0, 2, "1"]) {
      const raw = JSON.stringify({ ...details, exitRouteAdmissionPolicyVersion: policy });
      expect(selectStillFreshDexRouteSetHold(candidate, raw, Date.parse(closed) / 1000, undefined, valuation)).toBeNull();
    }
    const expiredBeforeClosure = encodeCurrentRouteSet({ ...details,
      exitRouteObservations: [{ ...previous, observedAt: previous.observedAt - 86_400 }] });
    expect(selectStillFreshDexRouteSetHold(candidate, expiredBeforeClosure, Date.parse(closed) / 1000, undefined, valuation)).toBeNull();
  });

  it("keeps current routes ahead of individually eligible closure carries and counts the published observations", () => {
    const { candidate, observation, coverage } = makeDexRouteHoldFixture();
    const friday = Date.parse("2026-11-13T21:50Z") / 1000;
    const saturday = Date.parse("2026-11-14T12:00Z") / 1000;
    const current = Array.from({ length: MAX_DEX_EXIT_ROUTE_OBSERVATIONS - 1 },
      (_, i) => observation(`usdc-usdt-${i}`, 1_000, saturday, {
        chain: `chain-${i % 3}`, commonModeKeys: [`chain:${i % 3}`, `protocol:${i % 4}`],
      }));
    const missing = {
      ...observation("usdc-paxg", 62_875, friday),
      evidenceKind: "measured-executable-depth" as const,
      output: { kind: "tracked-stablecoin" as const, trackedAssetIds: ["paxg-paxos"] },
    };
    const expired = { ...missing, routeId: "usdc-paxg-expired", observationHistory: {
      completeProducerCycleCount: 2, successfulObservationCount: 2, consecutiveSuccessCount: 2,
      observationWindowStartedAt: friday - 600, observationWindowEndedAt: friday, latestOperationalFailureAt: null,
      conservativeStatistic: "pointwise-minimum" as const, conservativeCapacityCurve: missing.capacityCurve,
    } };
    candidate.exitRouteObservations = current;
    candidate.exitRouteObservationCoverage = {
      ...coverage, retainedPoolCount: 27, scoreEligibleCapabilityPoolCount: 26, scoreEligiblePoolCount: 23,
      observationCount: 23, scoreEligibleObservationCount: 23, evidenceCounts: { "reserve-based-amm-simulation": 23 }, unsupportedPoolCount: 3,
      unsupportedReasons: { "quote-missing": 3 },
    };
    const raw = encodeCurrentRouteSet({
      exitRouteObservations: [expired, { ...current[0], observedAt: friday }, observation("other", 200_000, friday), missing],
      exitRouteObservationCoverage: coverage,
    });
    const valuation = { stablecoinId: "usdc-circle", rejectedAssetIds: new Set(["paxg-paxos"]) };
    const held = selectStillFreshDexRouteSetHold(candidate, raw, saturday, undefined, valuation);
    expect(held?.observations).toEqual([...current, missing]);
    expect(held?.coverage).toEqual({
      ...candidate.exitRouteObservationCoverage, observationCount: 24, scoreEligibleObservationCount: 24,
      evidenceCounts: { "reserve-based-amm-simulation": 23, "measured-executable-depth": 1 },
    });

    candidate.exitRouteObservations = [...current, observation("new", 25_000_000, saturday)];
    expect(selectStillFreshDexRouteSetHold(candidate, raw, saturday, undefined, valuation)).toBeNull();

    const classification = classifyDexPlaceholderCoverage({ deployments: [], outcomeRows: [], nowSec: saturday });
    candidate.exitRouteObservations = [];
    candidate.exitRouteObservationCoverage = classification.coverage;
    const carried = selectStillFreshDexRouteSetHold(candidate, raw, saturday, undefined, valuation);
    expect(carried?.observations).toEqual([missing]);
    const persisted = {
      ...candidate, exitRouteObservations: carried!.observations, exitRouteObservationCoverage: carried!.coverage,
    };
    const details = JSON.parse(buildDexScoreDetailsJson(persisted, { classification, generationId: "saturday", publishedAtSec: saturday }));
    const publishedCoverage = ExitRouteObservationCoverageSchema.parse(details.exitRouteObservationCoverage);
    expect(publishedCoverage).toMatchObject({ retainedPoolCount: 0, observationCount: 1, evidenceCounts: { "measured-executable-depth": 1 } });
    expect(publishedCoverage.scoreEligiblePoolCount).toBe(0);
    expect(details.dexDeploymentCensus.generationId).toBe("saturday");

    // On the Friday after Thanksgiving, 18:00 UTC is in budget at the metal close but too old at the FX close.
    const earlyClose = encodeCurrentRouteSet({ exitRouteObservationCoverage: coverage, exitRouteObservations: [
      { ...missing, observedAt: Date.parse("2026-11-27T18:00Z") / 1000 },
    ] });
    const afterBothClosures = Date.parse("2026-11-28T12:00Z") / 1000;
    expect(selectStillFreshDexRouteSetHold(candidate, earlyClose, afterBothClosures, undefined, valuation)).not.toBeNull();
    expect(selectStillFreshDexRouteSetHold(candidate, earlyClose, afterBothClosures, undefined, {
      stablecoinId: "eurc-circle", rejectedAssetIds: new Set(["paxg-paxos", "eurc-circle"]),
    })).toBeNull();
  });

  it("carries a gold quote only inside the inclusive window ending at the close", () => {
    const { candidate, previous, close, decision, hold } = makeGoldRouteCarryFixture(150_000);
    const budget = getDexMeasuredExecutionFreshnessMaxSec();
    for (const [offset, admitted] of [[-budget - 1, false], [-budget, true], [0, true], [1, false]] as const) {
      previous.observedAt = close + offset;
      expect(hold() !== null).toBe(admitted);
    }
    // A second rejection on a tagged row must not re-enable the whole-set capacity hold.
    previous.observedAt = close + 120;
    if (previous.scope.kind !== "chain-contract") throw new Error("expected a measured pool");
    const poolKey = canonicalExitRouteScopedKey(previous.scope.chain, previous.scope.contractOrPoolId);
    const raw = encodeCurrentRouteSet({ exitRouteObservations: [previous], exitRouteObservationCoverage: candidate.exitRouteObservationCoverage });
    expect(selectStillFreshDexRouteSetHold(candidate, raw, decision, undefined, {
      stablecoinId: "usdc-circle", rejectedAssetIds: new Set(["paxg-paxos"]), poolReasons: new Map([[poolKey, "target-missing"]]),
    })).toBeNull();
  });

  it("keeps a failed current pool uncovered when an unrelated pre-close pool is carried", () => {
    const { candidate, hold } = makeGoldRouteCarryFixture();
    Object.assign(candidate.exitRouteObservationCoverage, {
      retainedPoolCount: 2, scoreEligibleCapabilityPoolCount: 2, unsupportedPoolCount: 1,
      unsupportedReasons: { "quote-failed": 1 },
    });
    const held = hold();
    expect(held?.coverage).toMatchObject({
      observationCount: 2, scoreEligibleObservationCount: 2, scoreEligiblePoolCount: 1,
      scoreEligibleCapabilityPoolCount: 2, unsupportedReasons: { "quote-failed": 1 },
    });
    expect(isDexExitRouteCoverageComplete(held?.coverage)).toBe(false);
  });

  it("applies the selector's concentration bounds after reserving every current route", () => {
    const { candidate, previous, decision, observation, hold } = makeGoldRouteCarryFixture();
    const adapterProfileId = "uniswap-v3-quoter-v2";
    Object.assign(previous, { adapterProfileId });
    for (const [key, limit] of [["protocol:pancakeswap", 7], ["chain:base", 14], ["adapter", 7]] as const) {
      candidate.exitRouteObservations = Array.from({ length: limit }, (_, i) => ({
        ...observation(`fresh-${i}`, 1_000, decision, { commonModeKeys: key === "adapter" ? [] : [key] }),
        ...(key === "adapter" ? { adapterProfileId } : {}),
      }));
      expect(hold()).toBeNull();
      candidate.exitRouteObservations.pop();
      expect(hold()?.observations).toEqual([...candidate.exitRouteObservations, previous]);
    }
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
      const raw = encodeCurrentRouteSet({
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
      const raw = encodeCurrentRouteSet({
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
    const raw = () => encodeCurrentRouteSet({
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
