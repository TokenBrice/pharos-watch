import { describe, expect, it } from "vitest";
import { SUPPLEMENTAL_RESTORE_MAX_AGE_SEC } from "@shared/lib/supply";
import { buildPeg, buildSupply } from "../safety-score-v9/fact-set-peg-supply";
import { makeV9Extension, makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import { factBuilderContext } from "./safety-score-v9-fact-builders.test-support";
import { createReportCardsFixedInput } from "../../test-helpers/report-cards-fixed-input";

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

  it.each([true, undefined])("does not hide an explicit current-price failure behind a quiet history: %s", (currentPriceUnavailable) => {
    const { baseInputGenerationId: _base, ...draft } = makeV9FixedInput({
      currentDeviationBps: null, eventCount: 0, worstDeviationBps: null, lastEventAt: null, activeDepeg: false,
    });
    const assetId = draft.activeAssetIds[0]!;
    const fixed = createReportCardsFixedInput({ ...draft, pegDataById: {
      ...draft.pegDataById, [assetId]: { ...draft.pegDataById[assetId]!, currentPriceUnavailable },
    } });
    const context = factBuilderContext(fixed);
    const peg = buildPeg(context);
    expect(peg.status.observationState).toBe(currentPriceUnavailable ? "bounded-unknown" : "known");
    expect(peg.currentDeviationBps).toBe(currentPriceUnavailable ? null : 0);
    if (currentPriceUnavailable) {
      expect([...context.gaps.values()]).toContainEqual(expect.objectContaining({
        causeProof: expect.objectContaining({ cause: "A", producerState: "producer-failed", rejectionCode: "peg-current-price-unavailable" }),
      }));
    } else {
      expect(context.gaps.size).toBe(0);
    }
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

  it.each([
    [undefined, "known"], [null, "missing"], [-78_622, "stale"],
  ] as const)("uses the summary clock only when the quote clock is absent (%s)", (quoteOffset, state) => {
    const fixed = makeV9FixedInput({ clockSec: 1_800_000_000, currentDeviationBps: -123, pegScore: 88 });
    const context = factBuilderContext(fixed);
    const row = context.fixedInput.pegDataById[context.asset.assetId]!;
    row.priceSource = "coingecko";
    if (quoteOffset === undefined) delete row.priceObservedAt;
    else row.priceObservedAt = quoteOffset === null ? null : fixed.clockSec + quoteOffset;
    context.extension.sources.peg.observedAtSec = fixed.clockSec - 300;

    const result = buildPeg(context);
    expect(result.status.observationState).toBe(state);
    expect(result.currentDeviationBps).toBe(quoteOffset === null ? null : 123);
    if (state === "known") {
      expect(context.evidence.get(result.status.evidenceRefIds[0]!)?.observedAtSec).toBe(fixed.clockSec - 300);
    } else {
      expect([...context.gaps.values()]).toContainEqual(expect.objectContaining({ reasonCode: "missing-peg-input" }));
    }
  });

  it.each([[undefined, 97], [null, 88], [-1, 97], [0, 88], [1, 88]] as const)(
    "uses the captured endpoint or the legacy event start at the quiet-history cutoff (%s)", (offset, expected) => {
      const context = factBuilderContext(makeV9FixedInput({ pegScore: 88 }));
      const cutoff = context.fixedInput.clockSec - 94_672_800;
      context.fixedInput.pegDataById[context.asset.assetId]!.lastEventAt = cutoff - 239 * 86_400;
      if (offset !== undefined) context.fixedInput.pegEvidenceById = {
        [context.asset.assetId]: { lastAffectedAtSec: offset === null ? null : cutoff + offset },
      };
      expect(buildPeg(context).pegScore).toBe(expected);
    },
  );

  it.each(["history-only", "empty", "held"] as const)("handles a scheduled summary with a %s evidence map", (generation) => {
    const fixed = makeV9FixedInput({ clockSec: 1_800_000_000, currentDeviationBps: -300, pegScore: 91 });
    const context = factBuilderContext(fixed);
    const assetId = context.asset.assetId;
    const row = context.fixedInput.pegDataById[assetId]!;
    row.pegCurrency = "EUR";
    row.lastEventAt = fixed.clockSec - 1;
    const history = { lastAffectedAtSec: fixed.clockSec - 1 };
    context.fixedInput.pegEvidenceById = generation === "empty" ? {} : {
      [assetId]: generation === "history-only" ? history : { ...history, referenceAdmission: {
        status: "held-closed-session", reason: "reference-market-closed", kind: "fx", source: "openExchangeRates",
        cadence: "intraday", referenceObservedAtSec: fixed.clockSec - 3600, quoteObservedAtSec: row.priceObservedAt!,
        decisionAtSec: fixed.clockSec, budgetSec: 21_600, sessionOpenedAtSec: null, generation: "fixture-fx", policyVersion: 1,
      } },
    };
    expect(buildPeg(context)).toMatchObject({
      status: { observationState: generation === "history-only" ? "known" : "bounded-unknown" },
      currentDeviationBps: generation === "history-only" ? 300 : null, pegScore: 91,
    });
  });

  it.each([[21, "known", 100], [22, "bounded-unknown", null]] as const)(
    "revalidates a fresh EUR admission across the Friday close (capture hour %s)", (captureHour, state, deviation) => {
      const observedAtSec = Date.UTC(2026, 10, 13, 21, 59) / 1000;
      const clockSec = Date.UTC(2026, 10, 13, captureHour, captureHour === 21 ? 59 : 1) / 1000;
      const context = factBuilderContext(makeV9FixedInput({ clockSec, currentDeviationBps: -500, pegObservedAtSec: observedAtSec }));
      const id = context.asset.assetId;
      Object.assign(context.fixedInput.pegDataById[id]!, { pegCurrency: "EUR",
        pegReference: { source: "fx", valueUsd: 1.2, asOf: observedAtSec, contributorCount: 1 } });
      context.fixedInput.pegEvidenceById = { [id]: { admittedDeviationBps: 100, referenceAdmission: {
        status: "admitted", reason: "live-reference", kind: "fx", source: "openExchangeRates",
        cadence: "intraday", referenceObservedAtSec: observedAtSec - 60, quoteObservedAtSec: observedAtSec,
        decisionAtSec: observedAtSec, budgetSec: 21_600, sessionOpenedAtSec: null, generation: "friday-fx", policyVersion: 1,
      } } };
      expect(buildPeg(context)).toMatchObject({ status: { observationState: state }, currentDeviationBps: deviation });
    },
  );

  it("withholds the quiet floor when a newer blind incident follows the older proven endpoint", () => {
    const clockSec = 1_795_000_000;
    const context = factBuilderContext(makeV9FixedInput({ clockSec, pegScore: 54, lastEventAt: 1_791_009_048 }));
    context.fixedInput.pegEvidenceById = { [context.asset.assetId]: {
      lastAffectedAtSec: clockSec - 1_200 * 86_400, lastUncertainAffectedAtSec: 1_791_295_299,
    } };
    expect(buildPeg(context).pegScore).toBe(54);
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
