import { describe, expect, it } from "vitest";
import { computePegYAxis, ewma } from "./peg-chart-math";

describe("computePegYAxis", () => {
  it("returns the default ±2% domain for an empty series", () => {
    expect(computePegYAxis([])).toEqual({
      domain: [0.98, 1.02],
      ticks: [0.98, 0.99, 1, 1.01, 1.02],
      step: 0.01,
    });
  });

  it("floors the half-range at 50 bps for a quiet peg", () => {
    // Quiet peg (±5 bps) and a flat peg both clamp to the same half = 0.005,
    // so they share an identical domain rather than collapsing tighter.
    const quiet = computePegYAxis([1, 1.0005, 0.9995]);
    const flat = computePegYAxis([1, 1, 1]);
    expect(quiet.domain).toEqual(flat.domain);
    expect(1 - quiet.domain[0]).toBeGreaterThanOrEqual(0.005);
  });

  it("produces a domain symmetric around the $1 peg", () => {
    const result = computePegYAxis([1.03, 0.99, 1.0]);
    const [min, max] = result.domain;
    expect(min + max).toBeCloseTo(2, 6);
    expect(1 - min).toBeCloseTo(max - 1, 6);
  });

  it("includes the $1 peg as a tick and spaces ticks by step", () => {
    const result = computePegYAxis([1.02, 0.98]);
    expect(result.ticks).toContain(1);
    for (let i = 1; i < result.ticks.length; i += 1) {
      expect(result.ticks[i] - result.ticks[i - 1]).toBeCloseTo(result.step, 6);
    }
    // Ticks span the full domain.
    expect(result.ticks[0]).toBeCloseTo(result.domain[0], 6);
    expect(result.ticks[result.ticks.length - 1]).toBeCloseTo(result.domain[1], 6);
  });

  it("selects a larger step for a wider deviation range", () => {
    const tight = computePegYAxis([1.001, 0.999]);
    const wide = computePegYAxis([1.15, 0.85]);
    expect(wide.step).toBeGreaterThan(tight.step);
  });
});

describe("ewma", () => {
  it("returns an empty array for empty input", () => {
    expect(ewma([], 0.5)).toEqual([]);
  });

  it("returns the single value unchanged for a one-element series", () => {
    expect(ewma([1.23], 0.5)).toEqual([1.23]);
  });

  it("seeds the output with the first value", () => {
    const out = ewma([1, 2, 3], 0.5);
    expect(out[0]).toBe(1);
  });

  it("with alpha 1 echoes the input series", () => {
    expect(ewma([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });

  it("with alpha 0 holds the first value flat", () => {
    expect(ewma([1, 2, 3], 0)).toEqual([1, 1, 1]);
  });

  it("blends new and prior values by alpha", () => {
    const out = ewma([0, 1], 0.25);
    expect(out[1]).toBeCloseTo(0.25, 6);
  });
});
