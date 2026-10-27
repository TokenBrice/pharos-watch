import { describe, expect, it } from "vitest";
import { isOperationalYieldAdvisory, selectInvestmentWarningSignals } from "../yield-warning-signals";

const OPERATIONAL = [
  "aging", "data-stale", "data-freshness-unknown", "reference-benchmark-degraded", "benchmark-degraded", "benchmark-stale",
];

describe("yield warning signal selection", () => {
  it.each(OPERATIONAL)("excludes the operational advisory %s", (signal) => {
    expect(isOperationalYieldAdvisory(signal)).toBe(true);
    expect(selectInvestmentWarningSignals([signal])).toEqual([]);
  });

  it("keeps investment warnings, safety/evidence signals and unknown keys in order", () => {
    const input = [
      "yield-spike", "aging", "safety-unrated", "opportunity-evidence-missing", "low-source-tvl", "future-key", "data-stale", "reward-heavy",
    ];
    expect(selectInvestmentWarningSignals(input)).toEqual([
      "yield-spike", "safety-unrated", "opportunity-evidence-missing", "low-source-tvl", "future-key", "reward-heavy",
    ]);
  });

  it("returns an empty list for an absent or empty input without inventing a clean claim", () => {
    expect(selectInvestmentWarningSignals(undefined)).toEqual([]);
    expect(selectInvestmentWarningSignals(null)).toEqual([]);
    expect(selectInvestmentWarningSignals([])).toEqual([]);
  });
});
