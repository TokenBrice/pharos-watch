import { describe, expect, it } from "vitest";
import census from "./fixtures/safety-score-map-census-2026-10-08.json";
import { validateAnnotationScene } from "../lib/map-annotations";
import {
  annotationSceneForBands,
  fitLayout,
  publicationAnnotationRequests,
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

describe("fixed publication annotations", () => {
  it("places all three mandatory panels at their published bounds in the full scene", () => {
    const annotations = publicationAnnotationRequests();
    expect(annotations).toEqual([
      { id: "grade-key", classId: "chart-key", bounds: { x: 1270, y: 16, w: 282, h: 106 } },
      { id: "supply-mass-rail", classId: "chart-key", bounds: { x: 48, y: 790, w: 300, h: 94 } },
      { id: "footer-encoding", classId: "footer", bounds: { x: 1252, y: 790, w: 300, h: 94 } },
    ]);
    const { bands } = fitLayout(census.coins as Parameters<typeof fitLayout>[0]);
    expect(validateAnnotationScene(annotationSceneForBands(bands, annotations))).toEqual([]);
  });

  it("rejects panel collisions, escaped orbits and forbidden reserved regions", () => {
    const { bands } = fitLayout(census.coins as Parameters<typeof fitLayout>[0]);
    const scene = annotationSceneForBands(bands, publicationAnnotationRequests());
    const panel = scene.annotations![0];
    const codes = (overrides: Partial<typeof scene>) => validateAnnotationScene({ ...scene, ...overrides }).map((item) => item.code);
    expect(codes({ circles: [...scene.circles!, { id: "panel-bubble", cx: 1300, cy: 50, r: 5, role: "bubble" }] })).toContain("label-bubble");
    const rectangles = scene.rectangles!.map((rect) => rect.id.startsWith("masthead-") ? rect : { ...rect, ...panel.bounds });
    expect(codes({ rectangles })).toContain("label-rectangle");
    expect(codes({ orbits: scene.orbits!.map((orbit) => ({ ...orbit, outerRx: orbit.innerRx })) })).toContain("invalid-geometry");
    expect(codes({ orbits: scene.orbits!.map((orbit) => ({ ...orbit, cx: 0 })) })).toContain("orbit-bound");
    expect(codes({ reservedRegions: scene.reservedRegions!.map((region) => ({ ...region, allowedClassIds: [] })) })).toContain("label-reserved");
  });
});
