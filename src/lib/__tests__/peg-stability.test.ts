import { describe, expect, it } from "vitest";
import { DAY_SECONDS } from "@/lib/constants";
import { computePegStability } from "../peg-stability";

type TestPegEvent = {
  startedAt: number;
  endedAt: number | null;
  peakDeviationBps: number;
};

function makeEvent(
  overrides: Partial<TestPegEvent> & Pick<TestPegEvent, "startedAt" | "peakDeviationBps">,
): TestPegEvent {
  return {
    endedAt: null,
    ...overrides,
  };
}

const NOW = 1_700_000_000;

function computeStability(events: TestPegEvent[], earliestDate: number | null, now = NOW) {
  return computePegStability(events as never, earliestDate, now);
}

describe("computePegStability", () => {
  it("returns null when no earliestDate and no events", () => {
    const result = computeStability([], null);
    expect(result).toBeNull();
  });

  it("returns null when historySpanSec <= 0", () => {
    // earliestDate is in the future
    const futureDate = NOW + 1000;
    const result = computeStability([], futureDate);
    expect(result).toBeNull();
  });

  it("returns 100% pegPct when no depeg events", () => {
    const earliestDate = NOW - 365 * DAY_SECONDS;
    const result = computeStability([], earliestDate);
    expect(result).not.toBeNull();
    expect(result!.pegPct).toBe(100);
    expect(result!.eventCount).toBe(0);
    expect(result!.depeggedNow).toBe(false);
    expect(result!.worstDeviationBps).toBeNull();
  });

  it("calculates pegPct correctly with one closed depeg event", () => {
    const earliestDate = NOW - 100 * DAY_SECONDS;
    // 10-day depeg in 100-day window => 90% at peg
    const events = [
      makeEvent({
        startedAt: NOW - 50 * DAY_SECONDS,
        endedAt: NOW - 40 * DAY_SECONDS,
        peakDeviationBps: -300,
      }),
    ];
    const result = computeStability(events, earliestDate);
    expect(result).not.toBeNull();
    expect(result!.pegPct).toBeCloseTo(90, 0);
  });

  it("marks limited=true when tracking span is under 7 days", () => {
    const earliestDate = NOW - 3 * DAY_SECONDS;
    const result = computeStability([], earliestDate);
    expect(result).not.toBeNull();
    expect(result!.limited).toBe(true);
  });

  it("marks limited=false when tracking span is 7+ days", () => {
    const earliestDate = NOW - 10 * DAY_SECONDS;
    const result = computeStability([], earliestDate);
    expect(result).not.toBeNull();
    expect(result!.limited).toBe(false);
  });

  it("detects depeggedNow when there is an ongoing event", () => {
    const earliestDate = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({
        startedAt: NOW - 5 * DAY_SECONDS,
        endedAt: null,
        peakDeviationBps: -500,
      }),
    ];
    const result = computeStability(events, earliestDate);
    expect(result).not.toBeNull();
    expect(result!.depeggedNow).toBe(true);
    expect(result!.currentStreakDays).toBeNull();
  });

  it("calculates currentStreakDays since last closed event", () => {
    const earliestDate = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({
        startedAt: NOW - 100 * DAY_SECONDS,
        endedAt: NOW - 90 * DAY_SECONDS,
        peakDeviationBps: -300,
      }),
    ];
    const result = computeStability(events, earliestDate);
    expect(result).not.toBeNull();
    expect(result!.depeggedNow).toBe(false);
    expect(result!.currentStreakDays).toBe(90); // 90 days since endedAt
  });

  it("returns the most recent endedAt for currentStreakDays with multiple events", () => {
    const earliestDate = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({
        startedAt: NOW - 200 * DAY_SECONDS,
        endedAt: NOW - 190 * DAY_SECONDS,
        peakDeviationBps: -300,
      }),
      makeEvent({
        startedAt: NOW - 100 * DAY_SECONDS,
        endedAt: NOW - 50 * DAY_SECONDS,
        peakDeviationBps: -200,
      }),
    ];
    const result = computeStability(events, earliestDate);
    expect(result).not.toBeNull();
    expect(result!.depeggedNow).toBe(false);
    expect(result!.currentStreakDays).toBe(50); // 50 days since most recent endedAt
  });

  it("reports worstDeviationBps from events", () => {
    const earliestDate = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({ startedAt: NOW - 200 * DAY_SECONDS, endedAt: NOW - 195 * DAY_SECONDS, peakDeviationBps: -200 }),
      makeEvent({ startedAt: NOW - 100 * DAY_SECONDS, endedAt: NOW - 95 * DAY_SECONDS, peakDeviationBps: -700 }),
    ];
    const result = computeStability(events, earliestDate);
    expect(result).not.toBeNull();
    expect(result!.worstDeviationBps).toBe(-700);
  });

  it("reports correct eventCount", () => {
    const earliestDate = NOW - 365 * DAY_SECONDS;
    const events = [
      makeEvent({ startedAt: NOW - 300 * DAY_SECONDS, endedAt: NOW - 295 * DAY_SECONDS, peakDeviationBps: -200 }),
      makeEvent({ startedAt: NOW - 200 * DAY_SECONDS, endedAt: NOW - 195 * DAY_SECONDS, peakDeviationBps: -300 }),
    ];
    const result = computeStability(events, earliestDate);
    expect(result).not.toBeNull();
    expect(result!.eventCount).toBe(2);
  });

  it("falls back to earliest event when earliestDate is null", () => {
    const events = [
      makeEvent({ startedAt: NOW - 200 * DAY_SECONDS, endedAt: NOW - 195 * DAY_SECONDS, peakDeviationBps: -200 }),
    ];
    const result = computeStability(events, null);
    expect(result).not.toBeNull();
    // Tracking starts from the event's startedAt
    expect(result!.pegPct).toBeGreaterThan(0);
  });

  it("handles fully depegged scenario (depeg spans entire window)", () => {
    const earliestDate = NOW - 100 * DAY_SECONDS;
    const events = [
      makeEvent({
        startedAt: NOW - 100 * DAY_SECONDS,
        endedAt: null, // ongoing, covers entire window
        peakDeviationBps: -5000,
      }),
    ];
    const result = computeStability(events, earliestDate);
    expect(result).not.toBeNull();
    expect(result!.pegPct).toBeCloseTo(0, 0);
    expect(result!.depeggedNow).toBe(true);
  });

  // --- formatTrackingSpan (tested indirectly through computePegStability) ---

  it("formats tracking span as days when < 30 days", () => {
    const earliestDate = NOW - 15 * DAY_SECONDS;
    const result = computeStability([], earliestDate);
    expect(result).not.toBeNull();
    expect(result!.trackingSpan).toBe("15d");
  });

  it("formats tracking span as months when < 12 months", () => {
    const earliestDate = NOW - 90 * DAY_SECONDS;
    const result = computeStability([], earliestDate);
    expect(result).not.toBeNull();
    // 90 days / 30.44 ~ 2.95 months, floored to 2
    expect(result!.trackingSpan).toBe("2mo");
  });

  it("formats tracking span as years and months", () => {
    // 2 years and 3 months
    const earliestDate = NOW - (2 * 365 + 90) * DAY_SECONDS;
    const result = computeStability([], earliestDate);
    expect(result).not.toBeNull();
    // (2*365+90) = 820 days, 820/30.44 ~ 26.9 months, 26/12 = 2 years, 26%12 = 2 remaining
    expect(result!.trackingSpan).toMatch(/^2y/);
  });

  it("formats tracking span as years only when no remaining months", () => {
    // Use enough days that floor(days/30.44) gives exactly 24 months (2 years, 0 remaining)
    // 24 * 30.44 = 730.56, so 731 days => floor(731/30.44) = 24 months => 2y 0mo => "2y"
    const earliestDate = NOW - 731 * DAY_SECONDS;
    const result = computeStability([], earliestDate);
    expect(result).not.toBeNull();
    expect(result!.trackingSpan).toBe("2y");
  });

  it("keeps full display history beyond the 4-year PegScore clamp", () => {
    const earliestDate = NOW - 5 * 366 * DAY_SECONDS;
    const result = computeStability([], earliestDate);
    expect(result).not.toBeNull();
    expect(result!.trackingSpan).toBe("5y");
  });
});
