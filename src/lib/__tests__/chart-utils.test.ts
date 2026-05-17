import { describe, it, expect } from "vitest";
import { buildAdaptiveMonthlyTicks, computeChartYDomain, mergeSeriesByTimestamp } from "../chart-utils";

describe("computeChartYDomain", () => {
  it("returns auto for all-range", () => {
    expect(computeChartYDomain([10, 20, 30], true)).toEqual([0, "auto"]);
  });
  it("applies 15% padding", () => {
    const [min, max] = computeChartYDomain([100, 200], false);
    expect(min).toBeLessThan(100);
    expect(max).toBeGreaterThan(200);
  });
  it("clamps min to 0", () => {
    const [min] = computeChartYDomain([5, 10], false);
    expect(min).toBeGreaterThanOrEqual(0);
  });
});

describe("mergeSeriesByTimestamp", () => {
  it("merges two series by timestamp", () => {
    const series = [
      { id: "a", data: [{ ts: 1, v: 10 }, { ts: 2, v: 20 }] },
      { id: "b", data: [{ ts: 1, v: 30 }, { ts: 3, v: 40 }] },
    ];
    const merged = mergeSeriesByTimestamp(series, (d) => d.v);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toEqual({ ts: 1, a: 10, b: 30 });
  });
});

describe("buildAdaptiveMonthlyTicks", () => {
  const localMonthStart = (year: number, month: number) => new Date(year, month, 1).getTime();

  it("uses every month for ranges under a year", () => {
    const ticks = buildAdaptiveMonthlyTicks(
      new Date(2026, 0, 15).getTime(),
      new Date(2026, 3, 20).getTime(),
    );
    expect(ticks).toEqual([
      localMonthStart(2026, 0),
      localMonthStart(2026, 1),
      localMonthStart(2026, 2),
      localMonthStart(2026, 3),
    ]);
  });

  it("snaps multi-year ranges to January ticks", () => {
    const ticks = buildAdaptiveMonthlyTicks(
      new Date(2021, 4, 15).getTime(),
      new Date(2026, 4, 15).getTime(),
    );
    expect(ticks[0]).toBe(localMonthStart(2022, 0));
    expect(ticks[1]).toBe(localMonthStart(2022, 6));
  });

  it("returns an empty list for invalid ranges", () => {
    expect(buildAdaptiveMonthlyTicks(new Date(2026, 1, 1).getTime(), new Date(2026, 0, 1).getTime())).toEqual([]);
  });
});
