import { describe, it, expect } from "vitest";
import { buildAdaptiveMonthlyTicks, computeChartYDomain, mergeSeriesByTimestamp } from "../chart-utils";

describe("computeChartYDomain", () => {
  it("returns auto for all-range", () => {
    expect(computeChartYDomain([10, 20, 30], true)).toEqual([0, "auto"]);
  });

  it("pads a varying series by exactly 15% of its range", () => {
    expect(computeChartYDomain([100, 200], false)).toEqual([100 - 100 * 0.15, 200 + 100 * 0.15]);
  });

  it("clamps the padded minimum at zero", () => {
    expect(computeChartYDomain([0, 100], false)).toEqual([0, 100 + 100 * 0.15]);
  });

  it("pads a constant series by exactly 5% of its value", () => {
    expect(computeChartYDomain([7, 7], false)).toEqual([7 - 7 * 0.05, 7 + 7 * 0.05]);
  });
});

describe("mergeSeriesByTimestamp", () => {
  it("sorts unsorted timestamps and keeps rows a single series covers", () => {
    const series = [
      { id: "a", data: [{ ts: 30, v: 3 }, { ts: 10, v: 1 }] },
      { id: "b", data: [{ ts: 20, v: 2 }, { ts: 10, v: 4 }] },
    ];

    expect(mergeSeriesByTimestamp(series, (d) => d.v)).toEqual([
      { ts: 10, a: 1, b: 4 },
      { ts: 20, b: 2 },
      { ts: 30, a: 3 },
    ]);
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

  it("still uses every month at exactly one year of span", () => {
    const ticks = buildAdaptiveMonthlyTicks(
      new Date(2025, 0, 15).getTime(),
      new Date(2026, 0, 15).getTime(),
    );

    expect(ticks).toHaveLength(13);
    expect(ticks[0]).toBe(localMonthStart(2025, 0));
    expect(ticks[11]).toBe(localMonthStart(2025, 11));
    expect(ticks[12]).toBe(localMonthStart(2026, 0));
  });

  it("steps every other month once the span passes one year", () => {
    const ticks = buildAdaptiveMonthlyTicks(
      new Date(2025, 0, 15).getTime(),
      new Date(2026, 1, 20).getTime(),
    );

    expect(ticks).toEqual([
      localMonthStart(2025, 0),
      localMonthStart(2025, 2),
      localMonthStart(2025, 4),
      localMonthStart(2025, 6),
      localMonthStart(2025, 8),
      localMonthStart(2025, 10),
      localMonthStart(2026, 0),
    ]);
  });

  it("steps quarterly and snaps to January once the span passes two years", () => {
    const ticks = buildAdaptiveMonthlyTicks(
      new Date(2024, 5, 15).getTime(),
      new Date(2026, 6, 1).getTime(),
    );

    expect(ticks).toEqual([
      localMonthStart(2025, 0),
      localMonthStart(2025, 3),
      localMonthStart(2025, 6),
      localMonthStart(2025, 9),
      localMonthStart(2026, 0),
      localMonthStart(2026, 3),
      localMonthStart(2026, 6),
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
    expect(buildAdaptiveMonthlyTicks(Number.NaN, new Date(2026, 0, 1).getTime())).toEqual([]);
    expect(buildAdaptiveMonthlyTicks(new Date(2026, 0, 1).getTime(), Number.POSITIVE_INFINITY)).toEqual([]);
  });
});
