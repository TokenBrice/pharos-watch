import { describe, expect, it } from "vitest";
import { DEWS_THREAT_BANDS } from "@shared/lib/dews-config";
import { getThreatBand, piecewiseLinear } from "../compatibility";

describe("piecewiseLinear", () => {
  const anchors: [number, number][] = [
    [0, 0],
    [1, 15],
    [3, 40],
    [5, 65],
    [10, 85],
    [20, 100],
  ];

  it("returns 0 at lower bound", () => {
    expect(piecewiseLinear(0, anchors)).toBe(0);
  });

  it("returns exact anchor value", () => {
    expect(piecewiseLinear(3, anchors)).toBe(40);
  });

  it("interpolates between anchors", () => {
    // Between [1, 15] and [3, 40]: at 2, expect 15 + (40-15) * (2-1)/(3-1) = 27.5
    expect(piecewiseLinear(2, anchors)).toBeCloseTo(27.5, 1);
  });

  it("clamps at maximum anchor", () => {
    expect(piecewiseLinear(30, anchors)).toBe(100);
  });

  it("returns last anchor value for Infinity input", () => {
    expect(piecewiseLinear(Infinity, anchors)).toBe(100);
  });

  it("returns first anchor value for -Infinity input", () => {
    expect(piecewiseLinear(-Infinity, anchors)).toBe(0);
  });

  it("returns 0 for an empty anchor set instead of throwing", () => {
    expect(piecewiseLinear(50, [])).toBe(0);
    expect(piecewiseLinear(-1, [])).toBe(0);
  });

  it("clamps at both anchors exactly and interpolates uneven segments", () => {
    const uneven: [number, number][] = [
      [10, 5],
      [20, 50],
      [40, 100],
    ];
    expect(piecewiseLinear(0, uneven)).toBe(5);
    expect(piecewiseLinear(10, uneven)).toBe(5);
    expect(piecewiseLinear(15, uneven)).toBeCloseTo(27.5, 5);
    expect(piecewiseLinear(30, uneven)).toBeCloseTo(75, 5);
    expect(piecewiseLinear(40, uneven)).toBe(100);
    expect(piecewiseLinear(41, uneven)).toBe(100);
  });

  it("holds a single anchor constant across the whole domain", () => {
    const single: [number, number][] = [[10, 7]];
    expect(piecewiseLinear(-5, single)).toBe(7);
    expect(piecewiseLinear(10, single)).toBe(7);
    expect(piecewiseLinear(100, single)).toBe(7);
  });

  it("maps NaN to 0 rather than to the first anchor value", () => {
    const uneven: [number, number][] = [
      [10, 5],
      [20, 50],
    ];
    expect(piecewiseLinear(Number.NaN, uneven)).toBe(0);
  });
});

describe("getThreatBand", () => {
  it.each([
    [0, "CALM"],
    [15, "CALM"],
    [16, "WATCH"],
    [35, "WATCH"],
    [36, "ALERT"],
    [55, "ALERT"],
    [56, "WARNING"],
    [75, "WARNING"],
    [76, "DANGER"],
    [100, "DANGER"],
  ] as const)("score %d => %s", (score, band) => {
    expect(getThreatBand(score)).toBe(band);
  });

  it("treats every configured band upper as an inclusive boundary", () => {
    for (let index = 0; index < DEWS_THREAT_BANDS.length; index++) {
      const band = DEWS_THREAT_BANDS[index];
      expect(getThreatBand(band.upper)).toBe(band.band);
    }
    for (let index = 0; index < DEWS_THREAT_BANDS.length - 1; index++) {
      expect(getThreatBand(DEWS_THREAT_BANDS[index].upper + 1)).toBe(DEWS_THREAT_BANDS[index + 1].band);
    }
  });

  it("falls through to DANGER above the final configured upper", () => {
    const last = DEWS_THREAT_BANDS[DEWS_THREAT_BANDS.length - 1];
    expect(getThreatBand(last.upper + 1)).toBe("DANGER");
    expect(getThreatBand(1000)).toBe("DANGER");
  });

  it("keeps negative scores in CALM and admits fractional scores", () => {
    expect(getThreatBand(-1)).toBe("CALM");
    expect(getThreatBand(15.5)).toBe("WATCH");
  });
});
