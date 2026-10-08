import { describe, expect, it } from "vitest";
import { SUPPLEMENTAL_RESTORE_MAX_AGE_SEC } from "@shared/lib/supply";
import { buildPeg, buildSupply } from "../safety-score-v9/fact-set-peg-supply";
import { makeV9Extension, makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import { factBuilderContext } from "./safety-score-v9-fact-builders.test-support";

describe("direct peg fact builder", () => {
  it.each([
    { ageSec: 500, state: "known" },
    { ageSec: 501, state: "stale" },
  ])("retains observed magnitude and applies the freshness boundary at age $ageSec", ({ ageSec, state }) => {
    const clockSec = makeV9FixedInput().clockSec;
    const context = factBuilderContext(makeV9FixedInput({
      clockSec, currentDeviationBps: -123, pegObservedAtSec: clockSec - ageSec,
      lastEventAt: clockSec - 1, pegScore: 88,
    }));
    const result = buildPeg(context);
    expect(result).toMatchObject({
      status: { observationState: state }, referenceKind: "fiat", referenceKey: "USD",
      currentDeviationBps: 123, pegScore: 88, activeDepeg: false, activeDepegBps: null,
    });
    expect(context.evidence.get(result.status.evidenceRefIds[0]!)).toMatchObject({
      observedAtSec: clockSec - ageSec,
      sourceGenerationId: context.extension.sources.peg.generationId,
      freshness: { state: state === "known" ? "current" : "stale", ageSec, maxAgeSec: 500 },
    });
  });

  it("does not replace an absent peg observation with neutral peg values", () => {
    const context = factBuilderContext(makeV9FixedInput({ omitPegRow: true }));
    const result = buildPeg(context);
    expect(result).toMatchObject({
      status: { observationState: "missing" }, pegScore: null, currentDeviationBps: null,
      activeDepeg: null, activeDepegBps: null,
    });
    expect([...context.gaps.values()]).toContainEqual(expect.objectContaining({ reasonCode: "missing-peg-input" }));
  });

  it("withholds measured peg values when their reference is unresolved", () => {
    const fixed = makeV9FixedInput({ currentDeviationBps: -200, lastEventAt: makeV9FixedInput().clockSec - 1 });
    const extension = makeV9Extension({ registryFingerprint: fixed.registryFingerprint });
    extension.assets[0]!.pegReference = {
      referenceKind: "other", referenceKey: "unresolved:peg-reference:missing-parent", failureDomains: [],
    };
    const context = factBuilderContext(fixed, extension);
    expect(buildPeg(context)).toMatchObject({
      status: { observationState: "bounded-unknown" }, pegScore: null, currentDeviationBps: null,
    });
    expect([...context.gaps.values()]).toContainEqual(expect.objectContaining({ reasonCode: "missing-applicable-peg" }));
  });
});

describe("direct supply fact builder", () => {
  it.each<{ buckets: Record<string, number>; expectedUsd: number | null; state: "missing" | "known" }>([
    { buckets: {}, expectedUsd: null, state: "missing" },
    { buckets: { peggedUSD: 0 }, expectedUsd: 0, state: "known" },
    { buckets: { peggedUSD: 80, peggedEUR: 20 }, expectedUsd: 100, state: "known" },
  ])("distinguishes aggregate absence, measured zero and USD bucket sums: $buckets", ({ buckets, expectedUsd, state }) => {
    const context = factBuilderContext(makeV9FixedInput({ chainSupplyByChain: {}, aggregateCirculating: buckets }));
    const result = buildSupply(context);
    expect(result).toMatchObject({
      circulatingUsd: expectedUsd, circulatingUnits: null, referencePriceUsd: null, chainDistribution: null,
      status: { observationState: state }, selectedBridgeRoutes: [], selectedRouteSupplyShare: null,
    });
    if (expectedUsd === null) {
      expect([...context.gaps.values()]).toContainEqual(expect.objectContaining({ reasonCode: "missing-pillar-evidence" }));
    } else {
      expect(result.sourceKind).toBe("aggregate-circulating");
      expect(context.evidence.get(result.status.evidenceRefIds[0]!)).toMatchObject({
        sourceId: "report-cards-aggregate-circulating", disposition: "observed",
      });
    }
  });

  it.each([
    { excessAgeSec: 0, state: "known" },
    { excessAgeSec: 1, state: "stale" },
  ])("uses the original aggregate observation clock at the carry-forward ceiling plus $excessAgeSec", ({ excessAgeSec, state }) => {
    const clockSec = SUPPLEMENTAL_RESTORE_MAX_AGE_SEC + makeV9FixedInput().clockSec;
    const observedAtSec = clockSec - SUPPLEMENTAL_RESTORE_MAX_AGE_SEC - excessAgeSec;
    const context = factBuilderContext(makeV9FixedInput({
      clockSec, chainSupplyByChain: {}, aggregateCirculating: { peggedUSD: 123 }, supplyObservedAtSec: observedAtSec,
    }));
    const result = buildSupply(context);
    expect(result).toMatchObject({ circulatingUsd: 123, status: { observationState: state } });
    expect(context.evidence.get(result.status.evidenceRefIds[0]!)).toMatchObject({
      observedAtSec, freshness: { maxAgeSec: SUPPLEMENTAL_RESTORE_MAX_AGE_SEC },
    });
  });

  it("rejects a bridge partition that does not conserve the published aggregate", () => {
    const fixed = makeV9FixedInput({ chainSupplyByChain: {}, aggregateCirculating: { peggedUSD: 100 } });
    const extension = makeV9Extension({ registryFingerprint: fixed.registryFingerprint });
    extension.assets[0]!.supplyReview = {
      selectedBridgeRoutes: [{
        deploymentRouteKey: "ethereum:fixture", supplyUsd: 99, supplyShare: 1,
        reviewState: "selected-reviewed", reviewedRouteKind: "controlled",
      }],
      selectedRouteSupplyShare: 1, unknownRouteSupplyShare: 0, unreviewedRouteSupplyShare: 0, failureDomains: [],
    };
    expect(() => buildSupply(factBuilderContext(fixed, extension))).toThrow(/Aggregate bridge supply rows do not conserve/);
  });
});
