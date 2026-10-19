import { describe, expect, it } from "vitest";
import { DAY_SECONDS } from "@/lib/constants";
import { computePegStability } from "../peg-stability";
import type { DepegEvent } from "@shared/types";

const NOW = 1_700_000_000;

function computeStability(events: DepegEvent[], earliestDate: number | null, now = NOW) {
  return computePegStability(events, earliestDate, now);
}

function makeEvent(
  overrides: Partial<DepegEvent> & Pick<DepegEvent, "startedAt" | "peakDeviationBps">,
): DepegEvent {
  return {
    id: 1,
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    pegType: "peggedUSD",
    direction: "below",
    endedAt: null,
    startPrice: 0.985,
    peakPrice: 0.982,
    recoveryPrice: null,
    pegReference: 1,
    source: "live",
    confirmationSources: null,
    pendingReason: null,
    closeReason: null,
    provenance: null,
    ...overrides,
  };
}

describe("computePegStability", () => {
  it("includes all historical incidents even when producer coverage starts after the oldest incident", () => {
    const events = [
      makeEvent({ startedAt: NOW - 300 * DAY_SECONDS, endedAt: NOW - 290 * DAY_SECONDS, peakDeviationBps: -1200 }),
      makeEvent({ startedAt: NOW - 20 * DAY_SECONDS, endedAt: NOW - 19 * DAY_SECONDS, peakDeviationBps: -150 }),
    ];
    expect(computeStability(events, NOW - 90 * DAY_SECONDS)).toMatchObject({
      worstDeviationBps: -1200, eventCount: 2, trackingSpan: "9mo",
    });
  });
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
    const result = computeStability(events.map((event) => ({ ...event, recoveryPrice: 1 })), earliestDate);
    expect(result).not.toBeNull();
    expect(result!.depeggedNow).toBe(false);
    expect(result!.currentStreakDays).toBe(50); // 50 days since most recent endedAt
  });

  it("falls back to the earliest event when earliestDate is null", () => {
    // Deliberately reversed: the later event must not anchor the window.
    const events = [
      makeEvent({ startedAt: NOW - 50 * DAY_SECONDS, endedAt: NOW - 45 * DAY_SECONDS, peakDeviationBps: -200 }),
      makeEvent({ startedAt: NOW - 200 * DAY_SECONDS, endedAt: NOW - 195 * DAY_SECONDS, peakDeviationBps: -300 }),
    ];
    const result = computeStability(events, null);
    expect(result).not.toBeNull();
    // The earliest start (NOW - 200d) anchors the span: 10 depeg days / 200 days.
    expect(result!.pegPct).toBeCloseTo(95, 10);
    expect(result!.trackingSpan).toBe("6mo");
  });

  it("keeps wholly unobserved open history unavailable instead of calling it fully depegged", () => {
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
    expect(result!.pegPct).toBeNull();
    expect(result!.depeggedNow).toBe(true);
  });

  it("keeps full display history beyond the 4-year PegScore clamp", () => {
    const earliestDate = NOW - 5 * 366 * DAY_SECONDS;
    const result = computeStability([], earliestDate);
    expect(result).not.toBeNull();
    expect(result!.trackingSpan).toBe("5y");
  });

  it.each([
    ["recovered-primary", null, "recovered", 10],
    ["recovered-dex", 1, "recovered", 10],
    ["recovered-native", 1, "recovered", 10],
    [null, 1, "legacy_recovered", 10],
    [undefined, 1, "legacy_recovered", 10],
    ["coverage-lost-supply", 1, "coverage_lost", null],
    ["superseded-direction", 1, "superseded", null],
    ["orphan-tracking-removed", 1, "orphan", null],
    [null, null, "unknown_closed", null],
  ] as const)("classifies the newest terminal boundary %s before deriving recovery age", (closeReason, recoveryPrice, latestClosure, days) => {
    const older = { ...makeEvent({ startedAt: NOW - 60 * DAY_SECONDS, endedAt: NOW - 50 * DAY_SECONDS, peakDeviationBps: -200 }), recoveryPrice: 1 };
    const latest = makeEvent({ startedAt: NOW - 20 * DAY_SECONDS, endedAt: NOW - 10 * DAY_SECONDS, peakDeviationBps: -300, closeReason: closeReason ?? null, recoveryPrice });
    for (const events of [[older, latest], [latest, older]]) {
      expect(computeStability(events, NOW - 100 * DAY_SECONDS)).toMatchObject({
        currentStreakDays: days, latestClosure, depeggedNow: false,
      });
    }
  });

  it("keeps a zero-day recorded recovery separate from open and absent history", () => {
    const recovery = makeEvent({ startedAt: NOW - DAY_SECONDS, endedAt: NOW, peakDeviationBps: -200, closeReason: "recovered-primary" });
    expect(computeStability([recovery], NOW - 10 * DAY_SECONDS)).toMatchObject({
      currentStreakDays: 0, latestClosure: "recovered", depeggedNow: false,
    });
    expect(computeStability([{ ...recovery, endedAt: null }], NOW - 10 * DAY_SECONDS)).toMatchObject({
      currentStreakDays: null, latestClosure: null, depeggedNow: true,
    });
    expect(computeStability([], NOW - 10 * DAY_SECONDS)).toMatchObject({
      currentStreakDays: null, latestClosure: null, depeggedNow: false,
    });
  });
});
