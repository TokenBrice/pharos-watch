import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GENIUS_REGIME_STATE,
  isGeniusRegimeEffective,
  type GeniusRulemakingPhase,
  type GeniusRegimeState,
} from "../compliance-regime-state";

afterEach(() => vi.useRealTimers());

const PHASES: GeniusRulemakingPhase[] = [
  "pre-rulemaking", "proposed-rules", "final-rules-issued", "effective",
];

describe("GENIUS explicit release phase", () => {
  it.each(PHASES)("keeps %s independent of wall-clock and declared effective dates", (rulemakingPhase) => {
    vi.useFakeTimers();
    for (const clock of ["2026-10-08", "2027-01-18", "2028-01-18"]) {
      vi.setSystemTime(new Date(`${clock}T00:00:00Z`));
      for (const timing of [
        { effectiveDate: "2027-01-18" },
        { finalRulesIssuedAt: "2026-08-03", effectiveDate: "2026-12-01" },
      ]) {
        const state: GeniusRegimeState = { ...GENIUS_REGIME_STATE, ...timing, rulemakingPhase };
        expect(isGeniusRegimeEffective(state)).toBe(rulemakingPhase === "effective");
      }
    }
  });
});

describe("GENIUS reviewed regime state", () => {
  it("records the OCC final rule without claiming effectiveness", () => {
    expect(GENIUS_REGIME_STATE.rulemakingPhase).toBe("final-rules-issued");
    expect(GENIUS_REGIME_STATE.finalRulesIssuedAt).toBe("2026-10-23");
    expect(GENIUS_REGIME_STATE.effectiveDate).toBe("2027-01-18");
    expect(GENIUS_REGIME_STATE.statutoryFallbackEffectiveDate).toBe("2027-01-18");
    expect(GENIUS_REGIME_STATE.reviewedAt).toBe("2026-10-26");
    expect(isGeniusRegimeEffective()).toBe(false);
  });

  it("keeps the final rule and the PRA forms notice as distinct sources", () => {
    const refs = GENIUS_REGIME_STATE.sourceReferences;
    const finalRule = refs.find((ref) => ref.url.endsWith("/2026-21706.htm"));
    const praNotice = refs.find((ref) => ref.url.endsWith("/2026-21704.htm"));
    expect(finalRule?.label).toBe("OCC final GENIUS implementing rule (91 FR 67000), published October 23, 2026");
    expect(praNotice?.label).toBe(
      "OCC GENIUS licensing and registration forms submitted for OMB review (91 FR 66939), comments due November 23, 2026",
    );
    expect(refs).toHaveLength(20);
    for (const id of ["2026-19860", "2026-19899", "2026-19966"]) {
      expect(refs.find((ref) => ref.url.endsWith(`/${id}.htm`))?.label).toMatch(/, comments due November 30, 2026$/);
    }
  });
});
