import { describe, expect, it } from "vitest";
import { SUPPLEMENTAL_RESTORE_MAX_AGE_SEC } from "@shared/lib/supply";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { PegSummaryCoin } from "@shared/types/peg";
import { normalizeFixedInput } from "../report-cards-fixed-input";
import { createAssetBuildContext } from "../safety-score-v9/fact-set-context";
import { buildPeg, buildSupply } from "../safety-score-v9/fact-set-peg-supply";
import { makeV9Extension, makeV9FixedInput, makeV9RoleExtension, makeV9TwoAssetFixedInput } from "../../test-helpers/v9-fixed-input";
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

  it.each([null, undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    "does not stamp an unknown, legacy, invalid or future price clock (%s) with a shared clock",
    (clock) => {
      const fixed = makeV9FixedInput({ pegScore: 88, currentDeviationBps: -123 });
      const row: PegSummaryCoin = fixed.pegDataById.alpha!;
      if (clock === undefined) delete row.priceObservedAt;
      else row.priceObservedAt = clock;
      const { baseInputGenerationId: _identity, ...draft } = fixed;
      const context = factBuilderContext(normalizeFixedInput(draft));
      const result = buildPeg(context);
      expect(result.status).toMatchObject({ observationState: "missing", evidenceRefIds: [] });
      expect(context.evidence.has("alpha:peg")).toBe(false);
      expect([...context.gaps.values()]).toContainEqual(expect.objectContaining({
        reasonCode: "missing-peg-input",
        message: expect.stringMatching(clock === undefined ? /legacy/ : /clock/),
      }));
    },
  );

  it("does not renew a cached observation from a fresh shared source or unrelated NAV price", () => {
    const clockSec = makeV9FixedInput().clockSec;
    const fixed = makeV9FixedInput({ pegObservedAtSec: clockSec - 501, pegScore: 88 });
    const row: PegSummaryCoin = fixed.pegDataById.alpha!;
    row.priceSource = "cached";
    row.priceObservedAtMode = "upstream";
    const navId = ACTIVE_STABLECOINS.find((coin) => coin.flags.navToken)!.id;
    fixed.navPriceById = { [navId]: { priceUsd: 1, sourceId: "chainlink-nav", observedAtSec: clockSec, confidence: "high" } };
    const { baseInputGenerationId: _identity, ...draft } = fixed;
    const context = factBuilderContext(normalizeFixedInput(draft), makeV9Extension({
      registryFingerprint: fixed.registryFingerprint, clockSec, observedAtSec: clockSec,
    }));
    const result = buildPeg(context);
    expect(result.status.observationState).toBe("stale");
    expect(context.evidence.get("alpha:peg")).toMatchObject({
      sourceId: "cached", observedAtSec: clockSec - 501,
      freshness: { state: "stale", ageSec: 501, maxAgeSec: 500 },
    });
  });

  it("keeps two assets' distinct freshness verdicts within the same source generation", () => {
    const fixed = makeV9TwoAssetFixedInput();
    fixed.pegDataById.alpha!.priceObservedAt = fixed.clockSec - 501;
    fixed.pegDataById.beta!.priceObservedAt = fixed.clockSec - 100;
    const { baseInputGenerationId: _identity, ...draft } = fixed;
    const normalized = normalizeFixedInput(draft);
    const extension = makeV9RoleExtension(normalized, {});
    const results = extension.assets.map((asset) => {
      const context = createAssetBuildContext(normalized, extension, asset, "a".repeat(64));
      return { result: buildPeg(context), evidence: context.evidence.get(`${asset.assetId}:peg`) };
    });
    expect(results.map(({ result }) => result.status.observationState)).toEqual(["stale", "known"]);
    expect(results.map(({ evidence }) => evidence?.observedAtSec)).toEqual([fixed.clockSec - 501, fixed.clockSec - 100]);
    expect(results[0]!.result.sourceGenerationId).toBe(results[1]!.result.sourceGenerationId);
  });

  it("rejects nominal prices before clock admission even when their timestamp is current", () => {
    const fixed = makeV9FixedInput();
    const row: PegSummaryCoin = fixed.pegDataById.alpha!;
    row.priceSource = "protocol-par";
    row.priceObservedAtMode = "nominal_reference";
    const { baseInputGenerationId: _identity, ...draft } = fixed;
    const context = factBuilderContext(normalizeFixedInput(draft));
    expect(buildPeg(context)).toMatchObject({ status: { observationState: "missing" }, pegScore: null });
    expect(context.evidence.has("alpha:peg")).toBe(false);
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
