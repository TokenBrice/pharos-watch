import { describe, expect, it } from "vitest";
import {
  validateComposition,
  type CompositionBand,
  type CompositionRect,
} from "../maintenance/build-safety-score-map";

// Poster geometry the linter defaults to. Restated here on purpose: if the
// generator moves a constant, these goldens must be re-read rather than
// silently tracking the change.
const FOOTER_RULE_Y = 848;
const BODY_TOP = 192;
const CHIP_FLOOR = FOOTER_RULE_Y - 4; // chips must end above this
const BAND_FLOOR = FOOTER_RULE_Y - 10; // bands must end above this
const LEFT_BOUND = 56; // MARGIN_X - 8
const RIGHT_BOUND = 1544; // WIDTH - MARGIN_X + 8

function band(tier: string, y: number, height: number, bubbles: CompositionBand["bubbles"] = []): CompositionBand {
  return { tier, y, height, bubbles };
}

function chip(id: string, x: number, y: number, w = 60, h = 20): CompositionRect {
  return { id, x, y, w, h };
}

/**
 * A sound miniature of the real composition: five strata stacked from BODY_TOP
 * to just above the footer rule, bubbles inscribed in their bands, chips inside
 * the body bounds and clear of one another.
 */
function goldenScene(): { bands: CompositionBand[]; chips: CompositionRect[] } {
  return {
    bands: [
      band("A", 192, 342, [
        { id: "usdt-tether", cx: 700, cy: 363, r: 150 },
        { id: "usdc-circle", cx: 980, cy: 363, r: 120 },
        { id: "dai-makerdao", cx: 1180, cy: 363, r: 40 },
      ]),
      band("B", 534, 96, [
        { id: "pyusd-paypal", cx: 400, cy: 582, r: 30 },
        { id: "fdusd-first-digital", cx: 470, cy: 582, r: 24 },
      ]),
      band("C", 630, 80, [{ id: "usdd-tron", cx: 400, cy: 670, r: 22 }]),
      band("D", 710, 64, [{ id: "usdx-stables-labs", cx: 400, cy: 742, r: 16 }]),
      band("F", 774, 60, [{ id: "ustc-terra", cx: 400, cy: 804, r: 10 }]),
    ],
    chips: [
      chip("usdt-tether", 620, 480, 160, 22),
      chip("usdc-circle", 900, 480, 140, 22),
      chip("pyusd-paypal", 360, 600, 90, 20),
      chip("usdd-tron", 360, 690, 90, 20),
      chip("ustc-terra", 360, 812, 90, 20),
    ],
  };
}

describe("validateComposition — golden scene", () => {
  it("passes a sound five-stratum composition with no violations", () => {
    expect(validateComposition(goldenScene())).toEqual([]);
  });

  it("passes an empty scene (nothing laid out cannot be malformed)", () => {
    expect(validateComposition({ bands: [], chips: [] })).toEqual([]);
  });

  it("honours caller-supplied footer and body bounds instead of the poster defaults", () => {
    const scene = goldenScene();
    // Same geometry, a footer rule raised above the F stratum: the previously
    // clean scene must now report the overflow.
    const violations = validateComposition({ ...scene, footerRuleY: 700, bodyTop: BODY_TOP });
    expect(violations.some((v) => v.includes("band F: overflows the footer rule"))).toBe(true);
  });
});

describe("validateComposition — chip collisions", () => {
  it("reports a chip pair that overlaps", () => {
    const violations = validateComposition({
      bands: [band("A", 192, 342)],
      chips: [chip("usdt-tether", 600, 400), chip("usdc-circle", 630, 405)],
    });
    expect(violations).toEqual(["chip overlap: usdt-tether / usdc-circle"]);
  });

  it("demands a 1px gutter between chips: flush neighbours collide, 1px apart is clear", () => {
    const scene = (gap: number) => ({
      bands: [band("A", 192, 342)],
      chips: [chip("a", 600, 400, 60, 20), chip("b", 600 + 60 + gap, 400, 60, 20)],
    });
    expect(validateComposition(scene(0))).toEqual(["chip overlap: a / b"]);
    expect(validateComposition(scene(1))).toEqual([]);
  });

  it("reports every colliding pair once, not once per chip", () => {
    const violations = validateComposition({
      bands: [band("A", 192, 342)],
      chips: [chip("a", 600, 400), chip("b", 610, 400), chip("c", 620, 400)],
    });
    expect(violations).toEqual(["chip overlap: a / b", "chip overlap: a / c", "chip overlap: b / c"]);
  });
});

describe("validateComposition — bounds", () => {
  it("reports a chip whose bottom crosses the footer rule", () => {
    const violations = validateComposition({
      bands: [band("A", 192, 342)],
      chips: [chip("usdt-tether", 600, CHIP_FLOOR - 19, 60, 20)],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^chip usdt-tether: crosses the body bounds/);
  });

  it("accepts a chip that ends exactly on the footer bound", () => {
    expect(
      validateComposition({
        bands: [band("A", 192, 342)],
        chips: [chip("usdt-tether", 600, CHIP_FLOOR - 20, 60, 20)],
      }),
    ).toEqual([]);
  });

  it("reports a chip that rides above the body top", () => {
    const violations = validateComposition({
      bands: [band("A", 192, 342)],
      chips: [chip("usdt-tether", 600, BODY_TOP - 9, 60, 20)],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^chip usdt-tether: crosses the body bounds/);
  });

  it("reports chips that break either side margin", () => {
    const violations = validateComposition({
      bands: [band("A", 192, 342)],
      chips: [chip("left", LEFT_BOUND - 1, 400, 60, 20), chip("right", RIGHT_BOUND - 59, 400, 60, 20)],
    });
    expect(violations).toEqual([
      expect.stringMatching(/^chip left: crosses the side margin/),
      expect.stringMatching(/^chip right: crosses the side margin/),
    ]);
  });

  it("accepts chips flush against both side bounds", () => {
    expect(
      validateComposition({
        bands: [band("A", 192, 342)],
        chips: [chip("left", LEFT_BOUND, 400, 60, 20), chip("right", RIGHT_BOUND - 60, 400, 60, 20)],
      }),
    ).toEqual([]);
  });
});

describe("validateComposition — band integrity", () => {
  it("reports a stratum stack that overruns the footer rule", () => {
    const violations = validateComposition({
      bands: [band("F", BAND_FLOOR - 40, 41)],
      chips: [],
    });
    expect(violations).toEqual([`band F: overflows the footer rule (bottom ${BAND_FLOOR + 1}.0 > ${BAND_FLOOR})`]);
  });

  it("accepts a stratum that ends exactly on the footer allowance", () => {
    expect(validateComposition({ bands: [band("F", BAND_FLOOR - 40, 40)], chips: [] })).toEqual([]);
  });

  it("reports a bubble that escapes its stratum above and below", () => {
    const violations = validateComposition({
      bands: [
        band("B", 400, 100, [
          { id: "over-top", cx: 500, cy: 405, r: 10 },
          { id: "over-bottom", cx: 600, cy: 495, r: 10 },
          { id: "inside", cx: 700, cy: 450, r: 40 },
        ]),
      ],
      chips: [],
    });
    expect(violations).toEqual(["bubble over-top: escapes band B", "bubble over-bottom: escapes band B"]);
  });

  it("accepts a bubble inscribed exactly in its stratum", () => {
    expect(
      validateComposition({
        bands: [band("B", 400, 100, [{ id: "snug", cx: 500, cy: 450, r: 50 }])],
        chips: [],
      }),
    ).toEqual([]);
  });
});

describe("validateComposition — the NaN scan", () => {
  // The original defect: maxMcap = 0 gives k = Infinity, every radius is NaN,
  // every NaN comparison is false, so the layout "fits" and a blank poster
  // ships with exit code 0. The linter is the last net under that cascade.
  it("reports non-finite bubble geometry instead of letting NaN read as 'fits'", () => {
    const violations = validateComposition({
      bands: [
        band("A", 192, 342, [
          { id: "nan-radius", cx: 700, cy: 363, r: Number.NaN },
          { id: "infinite-radius", cx: 800, cy: 363, r: Number.POSITIVE_INFINITY },
          { id: "nan-center", cx: Number.NaN, cy: 363, r: 20 },
        ]),
      ],
      chips: [],
    });
    expect(violations).toEqual([
      expect.stringMatching(/^bubble nan-radius: non-finite geometry/),
      expect.stringMatching(/^bubble infinite-radius: non-finite geometry/),
      expect.stringMatching(/^bubble nan-center: non-finite geometry/),
    ]);
  });

  it("does not also report a NaN bubble as escaping its band (one violation per bubble)", () => {
    const violations = validateComposition({
      bands: [band("A", 192, 342, [{ id: "nan-radius", cx: 700, cy: 363, r: Number.NaN }])],
      chips: [],
    });
    expect(violations).toHaveLength(1);
  });

  it("reports non-finite chip geometry and skips its bounds and overlap checks", () => {
    const violations = validateComposition({
      bands: [band("A", 192, 342)],
      chips: [chip("nan-chip", Number.NaN, 400), chip("nan-width", 600, 400, Number.NaN, 20)],
    });
    expect(violations).toEqual(["chip nan-chip: non-finite geometry", "chip nan-width: non-finite geometry"]);
  });

  it("reports non-finite band y and height", () => {
    const violations = validateComposition({
      bands: [band("A", Number.NaN, Number.POSITIVE_INFINITY)],
      chips: [],
    });
    expect(violations).toEqual(
      expect.arrayContaining(["band A: non-finite y (NaN)", "band A: non-finite height (Infinity)"]),
    );
  });

  it("catches an all-NaN scene rather than declaring it sound", () => {
    const violations = validateComposition({
      bands: [
        band("A", 192, 342, [
          { id: "a", cx: Number.NaN, cy: Number.NaN, r: Number.NaN },
          { id: "b", cx: Number.NaN, cy: Number.NaN, r: Number.NaN },
        ]),
      ],
      chips: [chip("a", Number.NaN, Number.NaN, Number.NaN, Number.NaN)],
    });
    expect(violations.length).toBeGreaterThan(0);
  });
});
