import { describe, expect, it } from "vitest";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { BACKTEST_ANCHORS, BACKTEST_NEGATIVE_CONTROLS, DEWS_HISTORY_START_SEC } from "../backtest-anchors";
import { BACKTEST_LOOKBACK_DAYS } from "../constants";

function firstRequiredMidnight(windowStart: number): number {
  return Math.ceil(windowStart / DAY_SECONDS) * DAY_SECONDS;
}

describe("backtest anchor fixture", () => {
  it("keeps every anchor lookback inside retained DEWS history", () => {
    expect(BACKTEST_ANCHORS.length).toBeGreaterThan(0);
    for (const anchor of BACKTEST_ANCHORS) {
      const windowStart = anchor.onsetAt - BACKTEST_LOOKBACK_DAYS * DAY_SECONDS;
      expect(
        firstRequiredMidnight(windowStart),
        `${anchor.stablecoinId} requires daily history before stress_signal_history begins`,
      ).toBeGreaterThanOrEqual(DEWS_HISTORY_START_SEC);
    }
  });

  it("keeps every negative control window inside retained DEWS history", () => {
    for (const control of BACKTEST_NEGATIVE_CONTROLS) {
      expect(
        firstRequiredMidnight(control.windowStart),
        `${control.stablecoinId} control window predates stress_signal_history`,
      ).toBeGreaterThanOrEqual(DEWS_HISTORY_START_SEC);
    }
  });

  it("keeps anchor metadata coherent", () => {
    for (const anchor of BACKTEST_ANCHORS) {
      expect(anchor.onsetAt).toBeGreaterThanOrEqual(DEWS_HISTORY_START_SEC);
      expect(anchor.resolvedAt == null || anchor.resolvedAt > anchor.onsetAt).toBe(true);
      expect(anchor.peakAbsBps).toBeGreaterThanOrEqual(200);
    }
  });
});
