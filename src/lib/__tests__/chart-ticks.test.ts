import { describe, expect, it } from "vitest";

import {
  formatCurrencyTick,
  logTicks,
  niceTicks,
  niceTicksForValues,
  niceTimeTicks,
} from "@/lib/chart-ticks";

describe("niceTicks", () => {
  it("labels only in-domain ticks when the domain must stay exact", () => {
    const result = niceTicks(0, 322.7e9, { kind: "currency", extend: false });
    expect(result.domain).toEqual([0, 322.7e9]);
    expect(result.ticks).toEqual([0, 100e9, 200e9, 300e9]);
  });

  it("never extends a non-negative series below zero or a share past 100", () => {
    expect(niceTicks(0.2, 9.7, { kind: "percent" }).domain[0]).toBeGreaterThanOrEqual(0);
    const share = niceTicks(12, 97, { kind: "percent" });
    expect(share.domain[1]).toBe(100);
    expect(Math.max(...share.ticks)).toBeLessThanOrEqual(100);
  });

  it("handles negative and sign-crossing ranges", () => {
    const result = niceTicks(-3.2e9, 4.1e9, { kind: "currency" });
    expect(result.ticks).toContain(0);
    expect(result.domain[0]).toBeLessThanOrEqual(-3.2e9);
    expect(result.domain[1]).toBeGreaterThanOrEqual(4.1e9);
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

  it("returns no ticks for non-positive bounds", () => {
    expect(logTicks(0, 100).ticks).toEqual([]);
    expect(logTicks(-1, 100).ticks).toEqual([]);
  });
});

describe("niceTimeTicks", () => {
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
});
