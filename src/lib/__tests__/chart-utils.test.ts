import { describe, it, expect } from "vitest";
import { buildAdaptiveMonthlyTicks, computeChartYDomain, mergeSeriesByTimestamp } from "../chart-utils";

describe("computeChartYDomain", () => {
  it("clamps the padded minimum at zero", () => {
    expect(computeChartYDomain([0, 100], false)).toEqual([0, 100 + 100 * 0.15]);
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
  // Ticks label a UTC data contract, so the expected boundaries are UTC month
  // starts in every viewer timezone.
  const utcMonthStart = (year: number, month: number) => Date.UTC(year, month, 1);

  it("uses every month for ranges under a year", () => {
    const ticks = buildAdaptiveMonthlyTicks(Date.UTC(2026, 0, 15), Date.UTC(2026, 3, 20));
    expect(ticks).toEqual([
      utcMonthStart(2026, 0),
      utcMonthStart(2026, 1),
      utcMonthStart(2026, 2),
      utcMonthStart(2026, 3),
    ]);
  });

  it("still uses every month at exactly one year of span", () => {
    const ticks = buildAdaptiveMonthlyTicks(Date.UTC(2025, 0, 15), Date.UTC(2026, 0, 15));

    expect(ticks).toHaveLength(13);
    expect(ticks[0]).toBe(utcMonthStart(2025, 0));
    expect(ticks[11]).toBe(utcMonthStart(2025, 11));
    expect(ticks[12]).toBe(utcMonthStart(2026, 0));
  });

  it("steps every other month once the span passes one year", () => {
    const ticks = buildAdaptiveMonthlyTicks(Date.UTC(2025, 0, 15), Date.UTC(2026, 1, 20));

    expect(ticks).toEqual([
      utcMonthStart(2025, 0),
      utcMonthStart(2025, 2),
      utcMonthStart(2025, 4),
      utcMonthStart(2025, 6),
      utcMonthStart(2025, 8),
      utcMonthStart(2025, 10),
      utcMonthStart(2026, 0),
    ]);
  });

  it("steps quarterly and snaps to January once the span passes two years", () => {
    const ticks = buildAdaptiveMonthlyTicks(Date.UTC(2024, 5, 15), Date.UTC(2026, 6, 1));

    expect(ticks).toEqual([
      utcMonthStart(2025, 0),
      utcMonthStart(2025, 3),
      utcMonthStart(2025, 6),
      utcMonthStart(2025, 9),
      utcMonthStart(2026, 0),
      utcMonthStart(2026, 3),
      utcMonthStart(2026, 6),
    ]);
  });

  it("snaps multi-year ranges to January ticks", () => {
    const ticks = buildAdaptiveMonthlyTicks(Date.UTC(2021, 4, 15), Date.UTC(2026, 4, 15));
    expect(ticks[0]).toBe(utcMonthStart(2022, 0));
    expect(ticks[1]).toBe(utcMonthStart(2022, 6));
  });

  it("keeps a January tick in January for a negative-offset viewer", () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const ticks = buildAdaptiveMonthlyTicks(Date.UTC(2025, 0, 15), Date.UTC(2026, 1, 20));
      expect(new Date(ticks[0]!).getUTCMonth()).toBe(0);
      expect(new Date(ticks[0]!).getUTCFullYear()).toBe(2025);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});
