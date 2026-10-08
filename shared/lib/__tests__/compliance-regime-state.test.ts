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
