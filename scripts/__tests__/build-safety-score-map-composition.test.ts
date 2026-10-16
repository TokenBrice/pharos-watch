import { describe, expect, it } from "vitest";
import {
  validateComposition,
  type CompositionOrbit,
  type CompositionRect,
} from "../maintenance/build-safety-score-map";

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
        { id: "usdt-tether", cx: 800, cy: 463, r: 60 },
        { id: "usdc-circle", cx: 940, cy: 463, r: 42 },
      ]),
      orbit("B", { innerRx: 320, innerRy: 210, outerRx: 430, outerRy: 245 }, [
        { id: "pyusd-paypal", cx: 1175, cy: 463, r: 14 },
      ]),
      orbit("C", { innerRx: 450, innerRy: 260, outerRx: 550, outerRy: 285 }, [
        { id: "usdd-tron", cx: 1300, cy: 463, r: 12 },
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
});
