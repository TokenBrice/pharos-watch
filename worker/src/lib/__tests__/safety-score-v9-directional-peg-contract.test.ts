import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { describe, expect, it } from "vitest";
import {
  normalizeFixedInput,
  parseReportCardsFixedInputCacheValue,
  type ReportCardsFixedInput,
} from "../safety-score-v9/report-cards-fixed-input";
import {
  buildReportCardsFixedInputCacheEntry,
  createReportCardsFixedInput,
  type ReportCardsFixedInputDraft,
} from "../../test-helpers/report-cards-fixed-input";
import { makeV9FixedInput, makeV9TwoAssetFixedInput } from "../../test-helpers/v9-fixed-input";

const PREMIUM_WEIGHT = V9_CANDIDATE_POLICY_V1.policy.semantic.formula.pegPremiumWeight;
type DirectionalPeg = NonNullable<ReportCardsFixedInput["safetyScoreV9DirectionalPeg"]>;
type Draft = Omit<ReportCardsFixedInput, "baseInputGenerationId">;

/** Re-derive the base generation so only the directional admission can reject. */
function draft(input: ReportCardsFixedInput): Draft {
  const { baseInputGenerationId: _baseInputGenerationId, ...rest } = input;
  return rest;
}

function directional(overrides: Partial<DirectionalPeg> = {}): DirectionalPeg {
  return {
    premiumWeight: PREMIUM_WEIGHT,
    pegScoreById: { alpha: 99 },
    activeDiscountPeakBpsById: {},
    ...overrides,
  };
}

describe("Safety Score V9 directional peg fixed-input contract", () => {
  it("admits a capture that omits the optional directional peg input", () => {
    const normalized = normalizeFixedInput(draft(makeV9FixedInput()));
    expect(normalized.safetyScoreV9DirectionalPeg).toBeUndefined();
  });

  it("admits a well-formed directional ingress and sorts its records", () => {
    const input = draft(makeV9TwoAssetFixedInput());
    const normalized = normalizeFixedInput({
      ...input,
      // One row keeps its null score; the other keeps its captured non-null score.
      pegDataById: {
        alpha: { ...input.pegDataById.alpha!, pegScore: null },
        beta: input.pegDataById.beta!,
      },
      activeDepegPeakBpsById: { beta: 1_200, alpha: 1_619 },
      safetyScoreV9DirectionalPeg: directional({
        pegScoreById: { beta: 99, alpha: null },
        activeDiscountPeakBpsById: { beta: 1_200, alpha: null },
      }),
    });

    expect(normalized.safetyScoreV9DirectionalPeg).toEqual({
      premiumWeight: PREMIUM_WEIGHT,
      pegScoreById: { alpha: null, beta: 99 },
      activeDiscountPeakBpsById: { alpha: null, beta: 1_200 },
    });
    expect(Object.keys(normalized.safetyScoreV9DirectionalPeg!.pegScoreById)).toEqual(["alpha", "beta"]);
  });

  it("rejects a peg-score row set that does not match the captured peg rows", () => {
    const input = draft(makeV9TwoAssetFixedInput());
    expect(() =>
      normalizeFixedInput({
        ...input,
        safetyScoreV9DirectionalPeg: directional({ pegScoreById: { alpha: 90 } }),
      }),
    ).toThrow(/V9 directional peg score rows mismatch: missing=beta/);

    expect(() =>
      normalizeFixedInput({
        ...input,
        safetyScoreV9DirectionalPeg: directional({ pegScoreById: { alpha: 90, beta: 90, gamma: 90 } }),
      }),
    ).toThrow(/unexpected=gamma/);
  });

  it("rejects a discount row set that does not match the open-event peak rows", () => {
    expect(() =>
      normalizeFixedInput({
        ...draft(makeV9FixedInput()),
        safetyScoreV9DirectionalPeg: directional({ activeDiscountPeakBpsById: { alpha: 1_200 } }),
      }),
    ).toThrow("V9 directional discount peak rows mismatch: missing=none; unexpected=alpha");

    expect(() =>
      normalizeFixedInput({
        ...draft(makeV9FixedInput({ activeDepegPeakBps: 700 })),
        safetyScoreV9DirectionalPeg: directional({ activeDiscountPeakBpsById: {} }),
      }),
    ).toThrow("V9 directional discount peak rows mismatch: missing=alpha; unexpected=none");
  });

  it("rejects a discount peak above its any-direction peak", () => {
    expect(() =>
      normalizeFixedInput({
        ...draft(makeV9FixedInput({ activeDepegPeakBps: 700 })),
        safetyScoreV9DirectionalPeg: directional({ activeDiscountPeakBpsById: { alpha: 1_200 } }),
      }),
    ).toThrow("V9 directional discount peak 1200 for alpha exceeds its any-direction peak 700");
  });

  it("rejects a score row whose availability differs from the captured peg row", () => {
    expect(() =>
      normalizeFixedInput({
        ...draft(makeV9FixedInput({ pegScore: null })),
        safetyScoreV9DirectionalPeg: directional({ pegScoreById: { alpha: 90 } }),
      }),
    ).toThrow("V9 directional peg score for alpha is 90 but the captured peg row is null");

    expect(() =>
      normalizeFixedInput({
        ...draft(makeV9FixedInput({ pegScore: 90 })),
        safetyScoreV9DirectionalPeg: directional({ pegScoreById: { alpha: null } }),
      }),
    ).toThrow("V9 directional peg score for alpha is null but the captured peg row is 90");
  });

  it("rejects a weighted score below the captured peg row", () => {
    expect(() =>
      normalizeFixedInput({
        ...draft(makeV9FixedInput({ pegScore: 90 })),
        safetyScoreV9DirectionalPeg: directional({ pegScoreById: { alpha: 89 } }),
      }),
    ).toThrow("V9 directional peg score 89 for alpha is below its captured peg row 90");
  });

  it.each([
    ["out-of-range premium weight", { premiumWeight: 1.25 }, /premiumWeight/],
    ["non-positive discount peak", { activeDiscountPeakBpsById: { alpha: 0 } }, /activeDiscountPeakBpsById\.alpha/],
    ["non-integer peg score", { pegScoreById: { alpha: 90.5 } }, /pegScoreById\.alpha/],
  ] as const)("rejects a %s", (_label, overrides, message) => {
    expect(() =>
      normalizeFixedInput({
        ...draft(makeV9FixedInput({ activeDepegPeakBps: 700 })),
        safetyScoreV9DirectionalPeg: { ...directional(), ...overrides },
      }),
    ).toThrow(message);
  });

  it("rejects an object key outside the directional contract", () => {
    expect(() =>
      normalizeFixedInput({
        ...draft(makeV9FixedInput()),
        safetyScoreV9DirectionalPeg: { ...directional(), activePremiumPeakBpsById: { alpha: 1_619 } },
      }),
    ).toThrow(/Malformed fixed report-card input at safetyScoreV9DirectionalPeg/);
  });

  it("round-trips the directional ingress through the fixed-input cache envelope", async () => {
    const input = createReportCardsFixedInput({
      ...(draft(makeV9FixedInput({ activeDepegPeakBps: 1_200 })) as ReportCardsFixedInputDraft),
      safetyScoreV9DirectionalPeg: directional({ activeDiscountPeakBpsById: { alpha: 1_200 } }),
    });
    const entry = await buildReportCardsFixedInputCacheEntry(input);

    await expect(parseReportCardsFixedInputCacheValue(entry.value)).resolves.toEqual(input);
  });
});
