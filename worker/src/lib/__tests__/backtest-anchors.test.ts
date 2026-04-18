import { describe, expect, it } from "vitest";
import { BACKTEST_ANCHORS, BACKTEST_ANCHORS_VERIFIED } from "../backtest-anchors";

describe("BACKTEST_ANCHORS fixture", () => {
  it("has at least 3 anchors and is frozen", () => {
    expect(BACKTEST_ANCHORS.length).toBeGreaterThanOrEqual(3);
    expect(Object.isFrozen(BACKTEST_ANCHORS)).toBe(true);
  });
  it("every onset is before resolved (when resolved is non-null)", () => {
    for (const a of BACKTEST_ANCHORS) {
      if (a.resolvedAt !== null) expect(a.resolvedAt).toBeGreaterThan(a.onsetAt);
    }
  });
  it("peakAbsBps is positive and finite", () => {
    for (const a of BACKTEST_ANCHORS) {
      expect(Number.isFinite(a.peakAbsBps)).toBe(true);
      expect(a.peakAbsBps).toBeGreaterThan(0);
    }
  });
  it("stablecoinId is kebab-case and non-empty", () => {
    for (const a of BACKTEST_ANCHORS) {
      expect(a.stablecoinId).toMatch(/^[a-z0-9-]+$/);
    }
  });
  it("BACKTEST_ANCHORS have been verified against live data before merge", () => {
    expect(BACKTEST_ANCHORS_VERIFIED).toBe(true);
  });
});
