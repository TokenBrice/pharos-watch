import { describe, expect, it } from "vitest";

import {
  exactTickFormatter,
  formatCurrencyTick,
  formatPercentTick,
  logTicks,
  niceTicks,
  niceTicksForValues,
  niceTimeTicks,
} from "@/lib/chart-ticks";

const NICE_MANTISSAS = new Set([1, 2, 2.5, 5]);

function mantissa(step: number): number {
  const m = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
  return Number(m.toFixed(6));
}

describe("niceTicks", () => {
  it("replaces even-division currency ticks with 1/2/2.5/5 steps", () => {
    // Home market-cap chart previously divided $333B into $83B/$167B/$250B.
    const result = niceTicks(0, 322.7e9, { kind: "currency" });
    expect(result.ticks).toEqual([0, 100e9, 200e9, 300e9, 400e9]);
    expect(result.domain).toEqual([0, 400e9]);
  });

  it("labels only in-domain ticks when the domain must stay exact", () => {
    const result = niceTicks(0, 322.7e9, { kind: "currency", extend: false });
    expect(result.domain).toEqual([0, 322.7e9]);
    expect(result.ticks).toEqual([0, 100e9, 200e9, 300e9]);
  });

  it("drops the stray domain-end tick from a capped APY axis", () => {
    const result = niceTicks(0, 13, { kind: "percent", count: 7, extend: false });
    expect(result.ticks).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(result.ticks).not.toContain(13);
  });

  it("gives a 0–50 score window even steps instead of 0/15/30/50", () => {
    expect(niceTicks(0, 50, { kind: "score" }).ticks).toEqual([0, 10, 20, 30, 40, 50]);
    expect(niceTicks(0, 100, { kind: "score" }).ticks).toEqual([0, 25, 50, 75, 100]);
  });

  it("keeps integer kinds on integer steps", () => {
    const bps = niceTicks(0, 7, { kind: "bps", count: 6 });
    expect(bps.ticks.every(Number.isInteger)).toBe(true);
    const score = niceTicks(40, 45, { kind: "score", count: 5 });
    expect(score.ticks.every(Number.isInteger)).toBe(true);
  });

  it("never extends a non-negative series below zero or a share past 100", () => {
    expect(niceTicks(0.2, 9.7, { kind: "percent" }).domain[0]).toBeGreaterThanOrEqual(0);
    const share = niceTicks(12, 97, { kind: "percent" });
    expect(share.domain[1]).toBe(100);
    expect(Math.max(...share.ticks)).toBeLessThanOrEqual(100);
  });

  it("handles small decimal ranges without float noise", () => {
    const result = niceTicks(0.9985, 1.0012, { count: 5 });
    for (const tick of result.ticks) expect(String(tick).length).toBeLessThan(8);
    expect(NICE_MANTISSAS.has(mantissa(result.step))).toBe(true);
  });

  it("handles negative and sign-crossing ranges", () => {
    const result = niceTicks(-3.2e9, 4.1e9, { kind: "currency" });
    expect(result.ticks).toContain(0);
    expect(result.domain[0]).toBeLessThanOrEqual(-3.2e9);
    expect(result.domain[1]).toBeGreaterThanOrEqual(4.1e9);
  });

  it("always uses a 1/2/2.5/5 × 10^n step and evenly spaced ticks", () => {
    const cases: Array<[number, number, number]> = [
      [0, 1, 5], [0, 7, 5], [3, 97, 6], [0, 0.034, 4], [120, 860, 5], [0, 2.4e12, 6], [45, 90, 6], [-12, -2, 5],
    ];
    for (const [min, max, count] of cases) {
      const { ticks, step, domain } = niceTicks(min, max, { count });
      expect(NICE_MANTISSAS.has(mantissa(step))).toBe(true);
      expect(domain[0]).toBeLessThanOrEqual(min);
      expect(domain[1]).toBeGreaterThanOrEqual(max);
      for (let i = 1; i < ticks.length; i++) expect(ticks[i] - ticks[i - 1]).toBeCloseTo(step, 9);
    }
  });

  it("opens a window around a flat series", () => {
    expect(niceTicks(0, 0).ticks).toEqual([0, 0.25, 0.5, 0.75, 1]);
    const flat = niceTicks(5, 5);
    expect(flat.ticks.length).toBeGreaterThanOrEqual(2);
    expect(flat.domain[0]).toBeLessThan(5);
    expect(flat.domain[1]).toBeGreaterThan(5);
  });

  it("returns no ticks for non-finite input", () => {
    expect(niceTicks(Number.NaN, 5).ticks).toEqual([]);
    expect(niceTicks(0, Number.POSITIVE_INFINITY).ticks).toEqual([]);
  });

  it("is deterministic", () => {
    expect(niceTicks(3, 97, { count: 6 })).toEqual(niceTicks(3, 97, { count: 6 }));
  });
});

describe("niceTicksForValues", () => {
  it("ignores unavailable values rather than reading them as zero", () => {
    expect(niceTicksForValues([null, 40, undefined, Number.NaN, 60]).domain[0]).toBeGreaterThan(0);
    expect(niceTicksForValues([null, undefined]).ticks).toEqual([]);
  });

  it("pulls zero in on request", () => {
    expect(niceTicksForValues([40, 60], { includeZero: true }).ticks[0]).toBe(0);
  });
});

describe("logTicks", () => {
  it("uses powers of ten across wide ranges", () => {
    const result = logTicks(3e6, 2.4e11);
    expect(result.ticks).toEqual([1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12]);
    expect(result.domain).toEqual([1e6, 1e12]);
  });

  it("adds 2× and 5× marks inside narrow ranges", () => {
    expect(logTicks(150, 4000).ticks).toEqual([100, 200, 500, 1000, 2000, 5000, 10000]);
  });

  it("falls back to nice linear values inside a single decade", () => {
    const result = logTicks(113e9, 258e9, { extend: false });
    expect(result.domain).toEqual([113e9, 258e9]);
    expect(result.ticks).toEqual([125e9, 150e9, 175e9, 200e9, 225e9, 250e9]);
  });

  it("returns no ticks for non-positive bounds", () => {
    expect(logTicks(0, 100).ticks).toEqual([]);
    expect(logTicks(-1, 100).ticks).toEqual([]);
  });
});

describe("niceTimeTicks", () => {
  it("labels a multi-year history on aligned years instead of even fractions", () => {
    const result = niceTimeTicks(Date.UTC(2017, 10, 28), Date.UTC(2026, 9, 12), 6);
    expect(result.stepMonths).toBe(24);
    expect(result.ticks.map((tick) => new Date(tick).toISOString().slice(0, 10))).toEqual([
      "2018-01-01", "2020-01-01", "2022-01-01", "2024-01-01", "2026-01-01",
    ]);
  });

  it("uses quarter or month starts for shorter windows", () => {
    const quarter = niceTimeTicks(Date.UTC(2025, 9, 12), Date.UTC(2026, 9, 12), 6);
    expect(quarter.stepMonths).toBe(3);
    expect(new Date(quarter.ticks[0]).getUTCMonth() % 3).toBe(0);
    const month = niceTimeTicks(Date.UTC(2026, 6, 1), Date.UTC(2026, 9, 12), 6);
    expect(month.stepMonths).toBe(1);
    expect(month.ticks[0]).toBe(Date.UTC(2026, 6, 1));
  });

  it("returns no ticks for an empty or invalid window", () => {
    expect(niceTimeTicks(5, 5).ticks).toEqual([]);
    expect(niceTimeTicks(Number.NaN, 5).ticks).toEqual([]);
  });
});

describe("tick labels", () => {
  const labels = (min: number, max: number, format: (value: number) => string) =>
    niceTicks(min, max, { kind: "currency" }).ticks.map(format);

  it("labels 2.5 steps exactly and never collapses distinct ticks", () => {
    expect(labels(0, 9.1e6, formatCurrencyTick)).toEqual(["$0", "$2.5M", "$5M", "$7.5M", "$10M"]);
    expect(labels(0, 1.1e9, formatCurrencyTick)).toEqual(["$0", "$250M", "$500M", "$750M", "$1B", "$1.25B"]);
    expect(labels(0, 2.4e3, formatCurrencyTick)).toEqual(["$0", "$500", "$1K", "$1.5K", "$2K", "$2.5K"]);
  });

  it("keeps labels unique across many ranges", () => {
    for (const max of [7, 13, 91, 2.4e3, 9.1e6, 1.1e9, 3.3e11, 2.2e12]) {
      for (const count of [4, 5, 6, 7]) {
        const ticks = niceTicks(0, max, { kind: "currency", count }).ticks.map(formatCurrencyTick);
        expect(new Set(ticks).size).toBe(ticks.length);
      }
    }
  });

  it("formats percents and other precision-taking formatters exactly", () => {
    expect([2, 2.25, 2.5].map(formatPercentTick)).toEqual(["2%", "2.25%", "2.5%"]);
    const fixed = exactTickFormatter((value, decimals) => value.toFixed(decimals));
    expect([0, 0.025, 1].map(fixed)).toEqual(["0", "0.025", "1"]);
  });
});
