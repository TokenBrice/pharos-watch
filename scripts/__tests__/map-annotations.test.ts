import { describe, expect, it, vi } from "vitest";
import {
  annularSectorCandidates,
  bubbleQuadrantCandidates,
  estimateMonospaceText,
  frameRailCandidates,
  planAnnotations,
  validateAnnotationScene,
  type Annotation,
  type AnnotationPlanningScene,
  type AnnotationScene,
  type PlacedAnnotation,
  type Rect,
  type SceneCircle,
  type SceneOrbit,
} from "../lib/map-annotations";

const FRAME: Rect = { x: 0, y: 0, w: 400, h: 240 };
const TEST_POLICY = {
  measureText: estimateMonospaceText,
  bubbleGap: 2.5,
  labelGap: 1,
  leaderGap: 1,
};

function candidate(id: string, x: number, y: number) {
  return { id, anchor: { x, y }, horizontal: "start" as const, vertical: "top" as const };
}

function annotation(
  id: string,
  options: Partial<Annotation> & Pick<Annotation, "priority" | "required" | "candidates">,
): Annotation {
  return {
    id,
    classId: options.classId ?? "labels",
    text: options.text ?? { text: id, fontSize: 10 },
    padding: 0,
    excludes: [],
    ...options,
  };
}

function placed(
  id: string,
  bounds: Rect,
  leaderSegments: PlacedAnnotation["leaderSegments"] = [],
  ignoreLeaderCircleIds: readonly string[] = [],
): PlacedAnnotation {
  return {
    id,
    classId: "labels",
    priority: 1,
    required: false,
    text: { text: id, fontSize: 10 },
    padding: 0,
    excludes: [],
    candidateId: `${id}:candidate`,
    bounds,
    leaderSegments,
    ignoreLeaderCircleIds,
  };
}

function codes(scene: AnnotationScene): string[] {
  return validateAnnotationScene(scene, TEST_POLICY).map((item) => item.code);
}

describe("annotation candidate generation", () => {
  it("generates stable bubble quadrants with rim-to-label leaders", () => {
    const candidates = bubbleQuadrantCandidates({ bubble: { id: "usdc", cx: 100, cy: 80, r: 12 } });
    expect(candidates.map((item) => item.id)).toEqual(["usdc:ne", "usdc:se", "usdc:nw", "usdc:sw"]);
    expect(candidates.every((item) => item.leaderSegments?.length === 1)).toBe(true);
    expect(candidates.every((item) => item.ignoreLeaderCircleIds?.[0] === "usdc")).toBe(true);
  });

  it("generates annular-sector and all four frame-rail candidate families", () => {
    const annular = annularSectorCandidates({
      id: "gap-b-c",
      cx: 200,
      cy: 120,
      innerRx: 50,
      innerRy: 30,
      outerRx: 90,
      outerRy: 60,
      startAngle: -0.6,
      endAngle: 0.6,
      angularSteps: 3,
      radialFractions: [0.35, 0.7],
    });
    expect(annular).toHaveLength(6);
    expect(annular.every((item) => item.region?.innerRx === 50)).toBe(true);
    for (const edge of ["top", "right", "bottom", "left"] as const) {
      expect(frameRailCandidates({ id: "rail", frame: FRAME, edge, count: 4 })).toHaveLength(4);
    }
  });
});

describe("planAnnotations determinism and degradation", () => {
  it("is identical across repeated runs and shuffled scene, annotation, and candidate order", () => {
    const bubbles: SceneCircle[] = [
      { id: "b", cx: 260, cy: 130, r: 12, role: "bubble" },
      { id: "a", cx: 140, cy: 130, r: 12, role: "bubble" },
    ];
    const requests = [
      annotation("beta", {
        classId: "landmarks",
        priority: 10,
        required: false,
        candidates: [candidate("z", 300, 30), candidate("a", 300, 190)],
      }),
      annotation("legend", {
        classId: "key",
        priority: 100,
        required: true,
        bounds: { w: 70, h: 30 },
        text: undefined,
        candidates: [candidate("right", 310, 10)],
      }),
      annotation("alpha", {
        classId: "landmarks",
        priority: 10,
        required: false,
        candidates: [candidate("right", 20, 190), candidate("left", 20, 30)],
      }),
    ];
    const scene: AnnotationPlanningScene = { frame: FRAME, circles: bubbles, annotationRequests: requests };
    const shuffled: AnnotationPlanningScene = {
      frame: FRAME,
      circles: [...bubbles].reverse(),
      annotationRequests: [...requests].reverse().map((item) => ({ ...item, candidates: [...item.candidates].reverse() })),
    };
    const first = planAnnotations(scene, TEST_POLICY);
    expect(planAnnotations(scene, TEST_POLICY)).toEqual(first);
    expect(planAnnotations(shuffled, TEST_POLICY)).toEqual(first);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.placed.map((item) => item.id)).toEqual(["legend", "alpha", "beta"]);
  });

  it("fails closed when a required annotation has no valid candidate", () => {
    const result = planAnnotations({
      frame: FRAME,
      circles: [{ id: "blocker", cx: 100, cy: 100, r: 45, role: "bubble" }],
      annotationRequests: [annotation("required-key", {
        classId: "key",
        priority: 100,
        required: true,
        bounds: { w: 40, h: 20 },
        text: undefined,
        candidates: [candidate("blocked", 80, 90)],
      })],
    }, TEST_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toMatchObject({ kind: "required-annotation-unplaced", annotationId: "required-key" });
      expect(result.dropped).toEqual([expect.objectContaining({ id: "required-key", reason: "required-failure" })]);
      expect(result.violations.map((item) => item.code)).toContain("label-bubble");
    }
  });

  it("degrades an optional class from N to N-1 by its stable priority prefix", () => {
    const requests = [
      annotation("first", { priority: 30, required: false, candidates: [candidate("only", 20, 20)] }),
      annotation("second", { priority: 20, required: false, candidates: [candidate("only", 150, 20)] }),
      annotation("third", { priority: 10, required: false, bounds: { w: 30, h: 20 }, text: undefined, candidates: [candidate("outside", 390, 220)] }),
    ];
    const result = planAnnotations({ frame: FRAME, annotationRequests: requests }, TEST_POLICY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.placed.map((item) => item.id)).toEqual(["first", "second"]);
      expect(result.dropped).toEqual([expect.objectContaining({ id: "third", reason: "class-degraded" })]);
      expect(result.degradations).toEqual([expect.objectContaining({
        classId: "labels",
        requestedCount: 3,
        placedCount: 2,
        attempts: [3, 2],
        droppedIds: ["third"],
      })]);
    }
  });

  it("degrades a whole optional class to zero when every retained prefix contains an unplaceable leader", () => {
    const result = planAnnotations({
      frame: FRAME,
      annotationRequests: [
        annotation("high-blocked", { priority: 20, required: false, bounds: { w: 20, h: 20 }, text: undefined, candidates: [candidate("outside", 395, 235)] }),
        annotation("low-valid", { priority: 10, required: false, candidates: [candidate("inside", 100, 100)] }),
      ],
    }, TEST_POLICY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.placed).toEqual([]);
      expect(result.dropped.map((item) => [item.id, item.reason])).toEqual([
        ["high-blocked", "class-unplaceable"],
        ["low-valid", "class-unplaceable"],
      ]);
      expect(result.degradations[0]).toMatchObject({ attempts: [2, 1, 0], placedCount: 0 });
    }
  });

  it("uses the injected browser-metrics seam instead of estimating from characters", () => {
    const measureText = vi.fn(() => ({ width: 180, height: 18 }));
    const result = planAnnotations({
      frame: { x: 0, y: 0, w: 100, h: 100 },
      annotationRequests: [annotation("measured", { priority: 1, required: true, candidates: [candidate("at-origin", 0, 0)] })],
    }, { ...TEST_POLICY, measureText });
    expect(measureText).toHaveBeenCalledWith("measured", expect.objectContaining({ text: "measured" }));
    expect(result.ok).toBe(false);
  });
});

describe("validateAnnotationScene collision coverage", () => {
  it("reports label-vs-label and label-vs-bubble", () => {
    const violations = codes({
      frame: FRAME,
      circles: [{ id: "bubble", cx: 70, cy: 60, r: 14, role: "bubble" }],
      annotations: [placed("one", { x: 55, y: 50, w: 35, h: 20 }), placed("two", { x: 80, y: 55, w: 35, h: 20 })],
    });
    expect(violations).toContain("label-label");
    expect(violations).toContain("label-bubble");
  });

  it("reports leader-vs-bubble and permits the explicitly targeted bubble", () => {
    const leader = { x1: 30, y1: 100, x2: 180, y2: 100 };
    const scene = {
      frame: FRAME,
      circles: [{ id: "bubble", cx: 100, cy: 100, r: 12, role: "bubble" as const }],
      annotations: [placed("label", { x: 200, y: 90, w: 30, h: 20 }, [leader])],
    };
    expect(codes(scene)).toContain("leader-bubble");
    expect(codes({ ...scene, annotations: [placed("label", { x: 200, y: 90, w: 30, h: 20 }, [leader], ["bubble"])] })).not.toContain("leader-bubble");
  });

  it("reports leader-vs-label", () => {
    expect(codes({
      frame: FRAME,
      annotations: [
        placed("leader", { x: 20, y: 20, w: 30, h: 20 }, [{ x1: 40, y1: 100, x2: 200, y2: 100 }]),
        placed("other", { x: 100, y: 90, w: 40, h: 20 }),
      ],
    })).toContain("leader-label");
  });

  it("reports leader-vs-leader crossings", () => {
    expect(codes({
      frame: FRAME,
      annotations: [
        placed("ascending", { x: 20, y: 20, w: 30, h: 15 }, [{ x1: 70, y1: 70, x2: 150, y2: 150 }]),
        placed("descending", { x: 200, y: 20, w: 30, h: 15 }, [{ x1: 70, y1: 150, x2: 150, y2: 70 }]),
      ],
    })).toContain("leader-leader");
  });

  it("reports frame-bound rejection for every geometry family", () => {
    const violations = validateAnnotationScene({
      frame: FRAME,
      circles: [{ id: "circle", cx: -1, cy: 20, r: 4 }],
      rectangles: [{ id: "rect", x: 390, y: 20, w: 20, h: 10 }],
      lines: [{ id: "line", x1: 10, y1: 10, x2: 410, y2: 10 }],
      reservedRegions: [{ id: "reserved", x: 10, y: 230, w: 20, h: 20 }],
      annotations: [placed("label", { x: 10, y: -2, w: 20, h: 10 })],
    }, TEST_POLICY);
    expect(violations.filter((item) => item.code === "frame-bound").map((item) => item.ids[0])).toEqual([
      "circle",
      "rect",
      "reserved",
      "line",
      "label",
    ]);
  });

  it("checks generic circles, rectangles, segments, and reserved regions", () => {
    const violations = codes({
      frame: FRAME,
      circles: [{ id: "circle", cx: 100, cy: 100, r: 15 }],
      rectangles: [{ id: "rect", x: 105, y: 90, w: 30, h: 20 }],
      lines: [{ id: "line-a", x1: 50, y1: 100, x2: 150, y2: 100 }, { id: "line-b", x1: 100, y1: 50, x2: 100, y2: 150 }],
      reservedRegions: [{ id: "rail", x: 300, y: 20, w: 80, h: 50 }],
      annotations: [placed("intruder", { x: 320, y: 30, w: 20, h: 15 })],
    });
    expect(violations).toEqual(expect.arrayContaining([
      "circle-rectangle",
      "line-circle",
      "line-rectangle",
      "line-line",
      "label-reserved",
    ]));
  });

  it("allows an annotation class explicitly assigned to a reserved rail", () => {
    expect(codes({
      frame: FRAME,
      reservedRegions: [{ id: "legend-rail", x: 300, y: 20, w: 80, h: 50, allowedClassIds: ["key"] }],
      annotations: [{ ...placed("legend", { x: 310, y: 30, w: 60, h: 30 }), classId: "key" }],
    })).not.toContain("label-reserved");
  });
});

function realisticFiveBandScene(): AnnotationScene {
  const specs = [
    { id: "A", count: 13, innerRx: 0, innerRy: 0, outerRx: 300, outerRy: 190, orbitRx: 100, orbitRy: 75 },
    { id: "B", count: 41, innerRx: 320, innerRy: 210, outerRx: 430, outerRy: 245, orbitRx: 375, orbitRy: 227.5 },
    { id: "C", count: 133, innerRx: 450, innerRy: 260, outerRx: 550, outerRy: 285, orbitRx: 500, orbitRy: 272.5 },
    { id: "D", count: 75, innerRx: 570, innerRy: 300, outerRx: 650, outerRy: 320, orbitRx: 610, orbitRy: 310 },
    { id: "F", count: 56, innerRx: 670, innerRy: 330, outerRx: 735, outerRy: 359, orbitRx: 702.5, orbitRy: 344.5 },
  ];
  const circles: SceneCircle[] = [];
  const orbits: SceneOrbit[] = [];
  for (const spec of specs) {
    const ids: string[] = [];
    for (let index = 0; index < spec.count; index++) {
      const id = `${spec.id}-${String(index).padStart(3, "0")}`;
      const angle = (index / spec.count) * Math.PI * 2 + specs.indexOf(spec) * 0.31;
      ids.push(id);
      circles.push({
        id,
        cx: 800 + spec.orbitRx * Math.cos(angle),
        cy: 495 + spec.orbitRy * Math.sin(angle),
        r: 3,
        role: "bubble",
      });
    }
    orbits.push({
      id: spec.id,
      cx: 800,
      cy: 495,
      innerRx: spec.innerRx,
      innerRy: spec.innerRy,
      outerRx: spec.outerRx,
      outerRy: spec.outerRy,
      circleIds: ids,
    });
  }
  return { frame: { x: 56, y: 120, w: 1488, h: 740 }, circles, orbits };
}

describe("realistic five-band census", () => {
  it("validates A 13, B 41, C 133, D 75, F 56 without order-sensitive false positives", () => {
    const scene = realisticFiveBandScene();
    expect(scene.circles).toHaveLength(318);
    expect(validateAnnotationScene(scene, TEST_POLICY)).toEqual([]);
    expect(validateAnnotationScene({
      ...scene,
      circles: [...(scene.circles ?? [])].reverse(),
      orbits: [...(scene.orbits ?? [])].reverse().map((orbit) => ({ ...orbit, circleIds: [...orbit.circleIds].reverse() })),
    }, TEST_POLICY)).toEqual([]);
  });

  it("places a required corner key against the realistic census", () => {
    const scene: AnnotationPlanningScene = {
      ...realisticFiveBandScene(),
      annotationRequests: [annotation("grade-key", {
        classId: "key",
        priority: 100,
        required: true,
        bounds: { w: 190, h: 72 },
        text: undefined,
        candidates: frameRailCandidates({
          id: "upper-right",
          frame: { x: 56, y: 120, w: 1488, h: 740 },
          edge: "right",
          count: 3,
          from: 0.08,
          to: 0.24,
          inset: 12,
        }),
      })],
    };
    const result = planAnnotations(scene, TEST_POLICY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.placed).toEqual([expect.objectContaining({ id: "grade-key" })]);
  });

  it("places every required composite inside one reserved key panel", () => {
    const panel = { id: "chart-key-panel", x: 300, y: 20, w: 90, h: 92, allowedClassIds: ["chart-key"] };
    const result = planAnnotations({
      frame: FRAME,
      reservedRegions: [panel],
      annotationRequests: [
        annotation("grade-key", { classId: "chart-key", priority: 30, required: true, bounds: { w: 40, h: 55 }, text: undefined, candidates: [candidate("grade", 305, 25)] }),
        annotation("mass-rail", { classId: "chart-key", priority: 20, required: true, bounds: { w: 35, h: 55 }, text: undefined, candidates: [candidate("mass", 350, 25)] }),
        annotation("size-key", { classId: "chart-key", priority: 10, required: true, bounds: { w: 80, h: 20 }, text: undefined, candidates: [candidate("size", 305, 87)] }),
      ],
    }, TEST_POLICY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.placed.map((item) => item.id)).toEqual(["grade-key", "mass-rail", "size-key"]);
      expect(validateAnnotationScene({ frame: FRAME, reservedRegions: [panel], annotations: result.placed }, TEST_POLICY)).toEqual([]);
    }
  });

  it("rejects a reserved panel before planning when it collides with a bubble", () => {
    const result = planAnnotations({
      frame: FRAME,
      circles: [{ id: "bubble", cx: 350, cy: 60, r: 18, role: "bubble" }],
      reservedRegions: [{ id: "chart-key-panel", x: 300, y: 20, w: 90, h: 92, allowedClassIds: ["chart-key"] }],
      annotationRequests: [annotation("grade-key", {
        classId: "chart-key",
        priority: 30,
        required: true,
        bounds: { w: 80, h: 80 },
        text: undefined,
        candidates: [candidate("grade", 305, 25)],
      })],
    }, TEST_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("invalid-scene");
      expect(result.violations.map((item) => item.code)).toContain("reserved-circle");
    }
  });
});
