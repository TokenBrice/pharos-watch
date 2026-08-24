import { describe, expect, it } from "vitest";
import {
  validateComposition,
  type CompositionOrbit,
  type CompositionRect,
} from "../maintenance/build-safety-score-map";

const FOOTER_RULE_Y = 880;
const BODY_TOP = 98;
const CHIP_FLOOR = FOOTER_RULE_Y - 4;
const LEFT_BOUND = 56;
const RIGHT_BOUND = 1544;

function orbit(
  tier: string,
  zone: CompositionOrbit["zone"],
  bubbles: CompositionOrbit["bubbles"] = [],
): CompositionOrbit {
  return { tier, zone, bubbles };
}

function chip(id: string, x: number, y: number, w = 60, h = 20): CompositionRect {
  return { id, x, y, w, h };
}

function goldenScene(): { orbits: CompositionOrbit[]; chips: CompositionRect[] } {
  return {
    orbits: [
      orbit("A", { innerRx: 0, innerRy: 0, outerRx: 300, outerRy: 190 }, [
        { id: "usdt-tether", cx: 800, cy: 495, r: 60 },
        { id: "usdc-circle", cx: 940, cy: 495, r: 42 },
      ]),
      orbit("B", { innerRx: 320, innerRy: 210, outerRx: 430, outerRy: 245 }, [
        { id: "pyusd-paypal", cx: 1175, cy: 495, r: 14 },
      ]),
      orbit("C", { innerRx: 450, innerRy: 260, outerRx: 550, outerRy: 285 }, [
        { id: "usdd-tron", cx: 1300, cy: 495, r: 12 },
      ]),
    ],
    chips: [
      chip("usdt-tether", 620, 552, 120, 22),
      chip("usdc-circle", 880, 536, 110, 22),
      chip("pyusd-paypal", 750, 689, 100, 20),
    ],
  };
}

describe("validateComposition — golden orbital scene", () => {
  it("passes a sound composition with no violations", () => {
    expect(validateComposition(goldenScene())).toEqual([]);
  });

  it("passes an empty scene", () => {
    expect(validateComposition({ orbits: [], chips: [] })).toEqual([]);
  });

  it("honours caller-supplied footer and body bounds", () => {
    const violations = validateComposition({ ...goldenScene(), footerRuleY: 700, bodyTop: BODY_TOP });
    expect(violations.some((value) => value.includes("crosses the body bounds"))).toBe(true);
  });
});

describe("validateComposition — chip collisions", () => {
  it("reports a chip pair that overlaps", () => {
    expect(
      validateComposition({
        orbits: [],
        chips: [chip("usdt-tether", 600, 400), chip("usdc-circle", 630, 405)],
      }),
    ).toEqual(["chip overlap: usdt-tether / usdc-circle"]);
  });

  it("demands a 1px gutter between chips", () => {
    const scene = (gap: number) => ({
      orbits: [],
      chips: [chip("a", 600, 400, 60, 20), chip("b", 600 + 60 + gap, 400, 60, 20)],
    });
    expect(validateComposition(scene(0))).toEqual(["chip overlap: a / b"]);
    expect(validateComposition(scene(1))).toEqual([]);
  });

  it("reports every colliding pair once", () => {
    expect(
      validateComposition({
        orbits: [],
        chips: [chip("a", 600, 400), chip("b", 610, 400), chip("c", 620, 400)],
      }),
    ).toEqual(["chip overlap: a / b", "chip overlap: a / c", "chip overlap: b / c"]);
  });
});

describe("validateComposition — bounds", () => {
  it("keeps planet edges below the protected header clearance", () => {
    const violations = validateComposition({
      orbits: [orbit("F", { innerRx: 0, innerRy: 0, outerRx: 744, outerRy: 388 }, [
        { id: "header-rider", cx: 800, cy: BODY_TOP + 5, r: 6 },
      ])],
      chips: [],
    });
    expect(violations).toContain("bubble header-rider: crosses the 12px header clearance");
  });

  it("reports a chip whose bottom crosses the footer rule", () => {
    const violations = validateComposition({
      orbits: [],
      chips: [chip("usdt-tether", 600, CHIP_FLOOR - 19, 60, 20)],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^chip usdt-tether: crosses the body bounds/);
  });

  it("accepts a chip that ends exactly on the footer bound", () => {
    expect(validateComposition({ orbits: [], chips: [chip("usdt-tether", 600, CHIP_FLOOR - 20)] })).toEqual([]);
  });

  it("reports a chip that rides above the body top", () => {
    const violations = validateComposition({ orbits: [], chips: [chip("usdt-tether", 600, BODY_TOP - 9)] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^chip usdt-tether: crosses the body bounds/);
  });

  it("reports chips that break either side margin", () => {
    const violations = validateComposition({
      orbits: [],
      chips: [chip("left", LEFT_BOUND - 1, 400), chip("right", RIGHT_BOUND - 59, 400)],
    });
    expect(violations).toEqual([
      expect.stringMatching(/^chip left: crosses the side margin/),
      expect.stringMatching(/^chip right: crosses the side margin/),
    ]);
  });

  it("accepts chips flush against both side bounds", () => {
    expect(
      validateComposition({
        orbits: [],
        chips: [chip("left", LEFT_BOUND, 400), chip("right", RIGHT_BOUND - 60, 400)],
      }),
    ).toEqual([]);
  });
});

describe("validateComposition — orbit integrity", () => {
  it("reports an orbit that overruns the poster body", () => {
    expect(
      validateComposition({
        orbits: [orbit("F", { innerRx: 600, innerRy: 300, outerRx: 760, outerRy: 340 })],
        chips: [],
      }),
    ).toEqual(["orbit F: crosses the body bounds"]);
  });

  it("reports invalid annulus radii", () => {
    const violations = validateComposition({
      orbits: [orbit("B", { innerRx: 410, innerRy: 200, outerRx: 400, outerRy: 190 })],
      chips: [],
    });
    expect(violations).toContain("orbit B: invalid inner/outer radii");
  });

  it("reports bubbles outside either annulus boundary", () => {
    const violations = validateComposition({
      orbits: [
        orbit("B", { innerRx: 175, innerRy: 175, outerRx: 215, outerRy: 215 }, [
          { id: "outside", cx: 1005, cy: 495, r: 12 },
          { id: "inside", cx: 950, cy: 495, r: 12 },
        ]),
      ],
      chips: [],
    });
    expect(violations).toEqual(["bubble outside: escapes orbit B", "bubble inside: escapes orbit B"]);
  });

  it("reports colliding bubbles", () => {
    const violations = validateComposition({
      orbits: [
        orbit("C", { innerRx: 220, innerRy: 220, outerRx: 264, outerRy: 264 }, [
          { id: "one", cx: 1042, cy: 495, r: 12 },
          { id: "two", cx: 1062, cy: 495, r: 12 },
        ]),
      ],
      chips: [],
    });
    expect(violations).toContain("bubble overlap: one / two");
  });

  it("rejects a band whose bubbles leave a large angular dead zone", () => {
    const zone = { innerRx: 220, innerRy: 140, outerRx: 260, outerRy: 180 };
    const guideRx = (zone.innerRx + zone.outerRx) / 2;
    const guideRy = (zone.innerRy + zone.outerRy) / 2;
    const bubbles = [0, 0.08, 0.16, 0.24, 0.32].map((angle, index) => ({
      id: `coin-${index}`,
      cx: 800 + guideRx * Math.cos(angle),
      cy: 482 + guideRy * Math.sin(angle),
      r: 2,
    }));

    expect(validateComposition({ orbits: [orbit("C", zone, bubbles)], chips: [] })).toContain(
      "orbit C: angular gap 341.7deg exceeds 3x mean 72.0deg",
    );
  });
});

describe("validateComposition — the NaN scan", () => {
  it("reports non-finite bubble geometry", () => {
    const violations = validateComposition({
      orbits: [
        orbit("A", { innerRx: 0, innerRy: 0, outerRx: 300, outerRy: 138 }, [
          { id: "nan-radius", cx: 700, cy: 504, r: Number.NaN },
          { id: "infinite-radius", cx: 900, cy: 504, r: Number.POSITIVE_INFINITY },
          { id: "nan-center", cx: Number.NaN, cy: 504, r: 20 },
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

  it("reports non-finite chip geometry", () => {
    expect(
      validateComposition({
        orbits: [],
        chips: [chip("nan-chip", Number.NaN, 400), chip("nan-width", 600, 400, Number.NaN, 20)],
      }),
    ).toEqual(["chip nan-chip: non-finite geometry", "chip nan-width: non-finite geometry"]);
  });

  it("reports non-finite orbit radii", () => {
    const violations = validateComposition({
      orbits: [orbit("A", { innerRx: 0, innerRy: 0, outerRx: Number.NaN, outerRy: Number.POSITIVE_INFINITY })],
      chips: [],
    });
    expect(violations).toEqual(
      expect.arrayContaining(["orbit A: non-finite outerRx (NaN)", "orbit A: non-finite outerRy (Infinity)"]),
    );
  });
});
