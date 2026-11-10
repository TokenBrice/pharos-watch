import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { describe, expect, it } from "vitest";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { buildPeg, deriveSafetyScoreV9PegScore } from "../safety-score-v9/fact-set-peg-supply";
import { makeV9Extension, makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import { factBuilderContext } from "./safety-score-v9-fact-builders.test-support";

const ASSET_ID = "alpha";
const CLOCK_SEC = makeV9FixedInput().clockSec;
const THREE_DAYS = 3 * 86_400;
const PREMIUM_WEIGHT = V9_CANDIDATE_POLICY_V1.policy.semantic.formula.pegPremiumWeight;
const DIRECTIONAL_PEG_SCORE = 81;
const SUMMARY_PEG_SCORE = 49;

type DirectionalPeg = NonNullable<ReturnType<typeof makeV9FixedInput>["safetyScoreV9DirectionalPeg"]>;

function directionalPeg(overrides: Partial<DirectionalPeg> = {}): DirectionalPeg {
  return {
    premiumWeight: PREMIUM_WEIGHT,
    pegScoreById: { [ASSET_ID]: DIRECTIONAL_PEG_SCORE },
    // Keyed by exactly the witness ids: null is an observed premium-only open event.
    activeDiscountPeakBpsById: { [ASSET_ID]: null },
    ...overrides,
  };
}

/** An open event at `peakBps`, with the summary (and cap witness) reporting it open. */
function openEventInput(
  peakBps: number,
  options: { directionalPeg: DirectionalPeg | null },
) {
  return makeV9FixedInput({
    clockSec: CLOCK_SEC,
    activeDepeg: true,
    activeDepegPeakBps: Math.abs(peakBps),
    currentDeviationBps: peakBps,
    eventCount: 1,
    worstDeviationBps: peakBps,
    lastEventAt: CLOCK_SEC - THREE_DAYS,
    pegScore: SUMMARY_PEG_SCORE,
    ...(options.directionalPeg === null ? {} : { safetyScoreV9DirectionalPeg: options.directionalPeg }),
  });
}

function compileAndEvaluate(fixed: ReturnType<typeof openEventInput>) {
  const extension = makeV9Extension({ registryFingerprint: fixed.registryFingerprint, clockSec: fixed.clockSec });
  const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixed, extension);
  return {
    facts: compiled.assets[0]!,
    evaluated: evaluateV9FactSet(compiled, V9_CANDIDATE_POLICY_V1).assets[0]!,
  };
}

describe("Safety Score V9 directional peg fact", () => {
  it("absorbs an open premium: no active depeg, no cap, premium-weighted score", () => {
    const fixed = openEventInput(1_619, { directionalPeg: directionalPeg() });
    const peg = buildPeg(factBuilderContext(fixed));

    expect(peg).toMatchObject({
      status: { observationState: "known" },
      pegScore: deriveSafetyScoreV9PegScore(
        { pegScore: DIRECTIONAL_PEG_SCORE, activeDepeg: true, lastEventAt: CLOCK_SEC - THREE_DAYS },
        CLOCK_SEC,
      ),
      activeDepeg: false,
      activeDepegBps: null,
    });
    // The summary score and the any-direction peak are not what the fact publishes.
    expect(peg.pegScore).toBe(DIRECTIONAL_PEG_SCORE);
    expect(peg.pegScore).not.toBe(SUMMARY_PEG_SCORE);

    const { evaluated } = compileAndEvaluate(fixed);
    expect(evaluated.trace.caps.map((cap) => cap.source)).not.toContain("active-depeg");
    expect(evaluated.scoreInput.peg.activeDepegBps).toBeNull();
  });

  it("caps a premium-only capture in legacy mode, as today", () => {
    const fixed = openEventInput(1_619, { directionalPeg: null });
    const peg = buildPeg(factBuilderContext(fixed));

    expect(peg).toMatchObject({
      pegScore: SUMMARY_PEG_SCORE,
      activeDepeg: true,
      activeDepegBps: 1_619,
    });

    const { evaluated } = compileAndEvaluate(fixed);
    expect(evaluated.trace.caps).toContainEqual(
      expect.objectContaining({ source: "active-depeg", kind: "active-depeg:d", limit: 49 }),
    );
  });

  it("caps an open discount in both modes", () => {
    const legacy = openEventInput(-1_200, { directionalPeg: null });
    expect(buildPeg(factBuilderContext(legacy))).toMatchObject({
      activeDepeg: true,
      activeDepegBps: 1_200,
    });
    const legacyCaps = compileAndEvaluate(legacy).evaluated.trace.caps;
    expect(legacyCaps).toContainEqual(
      expect.objectContaining({ source: "active-depeg", kind: "active-depeg:d", limit: 49 }),
    );

    const directional = openEventInput(-1_200, {
      directionalPeg: directionalPeg({ activeDiscountPeakBpsById: { [ASSET_ID]: 1_200 } }),
    });
    expect(buildPeg(factBuilderContext(directional))).toMatchObject({
      status: { observationState: "known" },
      pegScore: DIRECTIONAL_PEG_SCORE,
      activeDepeg: true,
      activeDepegBps: 1_200,
    });
    const directionalCaps = compileAndEvaluate(directional).evaluated.trace.caps;
    expect(directionalCaps).toContainEqual(
      expect.objectContaining({ source: "active-depeg", kind: "active-depeg:d", limit: 49 }),
    );
  });

  it("fails closed when a witness peak has no discount entry", () => {
    const context = factBuilderContext(openEventInput(1_619, { directionalPeg: directionalPeg() }));
    // Producer inconsistency the contract would reject; the builder must not read
    // an absent entry as "no discount" (R1/R2).
    delete (context.fixedInput.safetyScoreV9DirectionalPeg as DirectionalPeg).activeDiscountPeakBpsById[ASSET_ID];

    const peg = buildPeg(context);
    expect(peg.status.observationState).not.toBe("known");
    expect(peg.pegScore).toBeNull();
    expect(peg.activeDepeg).toBeNull();
    expect(peg.activeDepegBps).toBeNull();
    expect([...context.gaps.values()]).toContainEqual(
      expect.objectContaining({ reasonCode: "missing-peg-input" }),
    );
  });

  it("fails closed when the summary reports an open event with no witness peak", () => {
    const fixed = makeV9FixedInput({
      clockSec: CLOCK_SEC,
      activeDepeg: true,
      currentDeviationBps: -1_200,
      eventCount: 1,
      worstDeviationBps: -1_200,
      lastEventAt: CLOCK_SEC - THREE_DAYS,
      pegScore: SUMMARY_PEG_SCORE,
      safetyScoreV9DirectionalPeg: directionalPeg({ activeDiscountPeakBpsById: {} }),
    });
    const context = factBuilderContext(fixed);

    const peg = buildPeg(context);
    expect(peg.status.observationState).not.toBe("known");
    expect(peg.pegScore).toBeNull();
    expect(peg.activeDepeg).toBeNull();
    expect(peg.activeDepegBps).toBeNull();
    expect([...context.gaps.values()]).toContainEqual(
      expect.objectContaining({ reasonCode: "missing-peg-input" }),
    );
  });

  it("publishes partial active-depeg evidence for a discount the summary does not witness", () => {
    const context = factBuilderContext(makeV9FixedInput({
      clockSec: CLOCK_SEC,
      pegScore: SUMMARY_PEG_SCORE,
      safetyScoreV9DirectionalPeg: directionalPeg({ activeDiscountPeakBpsById: {} }),
    }));
    // Producer inconsistency the contract would reject: the summary reports no
    // open event, yet the directional input carries an open discount.
    (context.fixedInput.safetyScoreV9DirectionalPeg as DirectionalPeg)
      .activeDiscountPeakBpsById[ASSET_ID] = 1_200;

    const peg = buildPeg(context);
    expect(peg.status.observationState).not.toBe("known");
    expect(peg).toMatchObject({
      // The quiet-history window still reads the summary's inactive state.
      pegScore: deriveSafetyScoreV9PegScore(
        { pegScore: DIRECTIONAL_PEG_SCORE, activeDepeg: false, lastEventAt: null },
        CLOCK_SEC,
      ),
      activeDepeg: true,
      activeDepegBps: 1_200,
    });
    expect([...context.gaps.values()]).toContainEqual(
      expect.objectContaining({ reasonCode: "missing-peg-input" }),
    );
  });

  it("fails closed when a directional capture omits its own score row", () => {
    const context = factBuilderContext(openEventInput(-1_200, {
      directionalPeg: directionalPeg({ activeDiscountPeakBpsById: { [ASSET_ID]: 1_200 } }),
    }));
    // Producer inconsistency the contract would reject; the builder must not
    // fall back to the summary's unweighted score either (defence in depth).
    delete (context.fixedInput.safetyScoreV9DirectionalPeg as DirectionalPeg).pegScoreById[ASSET_ID];

    const peg = buildPeg(context);
    expect(peg.status.observationState).not.toBe("known");
    expect(peg.pegScore).toBeNull();
    expect([...context.gaps.values()]).toContainEqual(
      expect.objectContaining({ reasonCode: "missing-peg-input" }),
    );
  });

  it("fails closed when the captured premium weight is not the policy weight", () => {
    const fixed = openEventInput(1_619, { directionalPeg: directionalPeg({ premiumWeight: 0.5 }) });
    const extension = makeV9Extension({ registryFingerprint: fixed.registryFingerprint, clockSec: fixed.clockSec });
    expect(() => compileSafetyScoreV9FactSetFromFixedInput(fixed, extension)).toThrow(
      `Directional peg input premium weight 0.5 does not match policy pegPremiumWeight ${PREMIUM_WEIGHT}`,
    );
  });
});
