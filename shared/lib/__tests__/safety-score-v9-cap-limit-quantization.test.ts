import { describe, expect, it } from "vitest";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { scoreV9Input } from "../safety-score-v9/formula";
import type { V9ScoringInput } from "../../types/safety-score-v9";

/**
 * A cap limit is a PUBLISHED ceiling, so it must live in the published score
 * space. Wrapper-local parent limits are the only production source of
 * fractional limits, and a fractional limit combined with the capped-score floor
 * lets a sub-point remainder decide a whole grade band: asusdf-astherus resolved
 * a 49.55 parent limit against a D/C- boundary at 50.
 */
function input(overrides: Partial<V9ScoringInput> = {}): V9ScoringInput {
  return {
    assetId: "quantization-probe",
    pillars: { backing: 80, exit: 80, control: 80 },
    pegApplicable: true,
    pegScore: 100,
    evidenceLevel: "strong",
    trackRecordMonths: 120,
    activeDepegBps: null,
    parentRequired: false,
    parentScore: null,
    structuralSignals: [],
    unresolved: [],
    ...overrides,
  } as V9ScoringInput;
}

describe("V9 cap limits are quantized into the published score space", () => {
  it("floors a fractional parent limit to a whole published point", () => {
    const trace = scoreV9Input(
      input({ parentRequired: true, parentScore: 49.55 }),
      V9_CANDIDATE_POLICY_V1,
    );
    const parentCap = trace.caps.find((cap) => cap.source === "parent");
    expect(parentCap?.limit).toBe(49);
    expect(trace.bindingCap?.limit).toBe(49);
  });

  it("never raises a ceiling: the floored limit is at or below the measured limit", () => {
    for (const measured of [43.45, 49.55, 52.2, 61.9, 65.55, 78.5, 81.8]) {
      const trace = scoreV9Input(
        input({ parentRequired: true, parentScore: measured }),
        V9_CANDIDATE_POLICY_V1,
      );
      const parentCap = trace.caps.find((cap) => cap.source === "parent");
      expect(parentCap?.limit).toBeLessThanOrEqual(measured);
      expect(measured - parentCap!.limit).toBeLessThan(1);
    }
  });

  it("emits no non-integral cap limit at scoreDecimals 0", () => {
    const trace = scoreV9Input(
      input({
        parentRequired: true,
        parentScore: 61.9,
        evidenceLevel: "limited",
        trackRecordMonths: 12,
      }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(trace.caps.length).toBeGreaterThan(1);
    for (const cap of trace.caps) expect(Number.isInteger(cap.limit)).toBe(true);
  });

  it("leaves an already-integral limit untouched", () => {
    const trace = scoreV9Input(
      input({ parentRequired: true, parentScore: 74 }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(trace.caps.find((cap) => cap.source === "parent")?.limit).toBe(74);
  });

  it("keeps the published score unchanged when flooring a fractional limit", () => {
    // min(preCapScore, 49.55) floors to 49; min(preCapScore, 49) also floors to
    // 49, so re-quantizing the limit must not move the published score.
    const fractional = scoreV9Input(
      input({ parentRequired: true, parentScore: 49.55 }),
      V9_CANDIDATE_POLICY_V1,
    );
    const integral = scoreV9Input(
      input({ parentRequired: true, parentScore: 49 }),
      V9_CANDIDATE_POLICY_V1,
    );
    expect(fractional.finalScore).toBe(integral.finalScore);
    expect(fractional.finalGrade).toBe(integral.finalGrade);
  });
});
