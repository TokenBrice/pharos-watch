import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { buildCemeteryPlotMap } from "@/lib/cemetery-plot-map";
import {
  PLOT_PROJECTIONS,
  PLOT_STEP_HEIGHT,
  fnv1a,
  graveGeometry,
  plotShapeOf,
  portraitSiteMarks,
  type PlotGraveShapeInput,
  type PlotMark,
} from "@/lib/cemetery-plot-geometry";

const dimetric = PLOT_PROJECTIONS.dimetric;

function stone(overrides: Partial<PlotGraveShapeInput> = {}): PlotGraveShapeInput {
  return {
    shape: "pillow",
    lot: 1,
    steps: 1,
    heightFactor: 0.83,
    weather: 0,
    fresh: false,
    archived: false,
    footstone: null,
    seed: fnv1a("fixture"),
    lean: 0,
    cell: { i0: 0, i1: 1.1, j0: 0, j1: 0.92 },
    anchor: { i: 0.3, j: 0.46 },
    ...overrides,
  };
}

const classes = (marks: PlotMark[]) => marks.map((m) => ("cls" in m ? m.cls : m.kind));

describe("graveGeometry", () => {
  it("draws one plinth box per step, and an outlined, hatched plinth for an unrecorded peak", () => {
    const plinthFaces = (marks: PlotMark[]) => classes(marks).filter((c) => c.startsWith("pl-")).length;
    for (const steps of [0, 1, 2, 3, 4] as const) expect(plinthFaces(graveGeometry(dimetric, stone({ steps })).body)).toBe(3 * steps);

    const unrecorded = graveGeometry(dimetric, stone({ steps: null }));
    expect(classes(unrecorded.body).filter((c) => c === "pl-open eo")).toHaveLength(3);
    expect(classes(unrecorded.body)).toContain("hatch");
    const floorStone = graveGeometry(dimetric, stone({ steps: 0 }));
    expect(classes(floorStone.body)).not.toContain("hatch");
    // It stands on its outlined plinth, never on the bare ground of the 0-step class.
    expect(unrecorded.topZ).toBeCloseTo(floorStone.topZ + PLOT_STEP_HEIGHT, 9);
  });

  it("encodes cause, not recovery: only counterparty arches split, regulatory stones stay sealed and whole", () => {
    expect(classes(graveGeometry(dimetric, stone({ shape: "split-arch" })).body)).toContain("crack");
    const tablet = classes(graveGeometry(dimetric, stone({ shape: "sealed-tablet", weather: 4 })).body);
    expect(tablet).toContain("seal e");
    expect(tablet).not.toContain("crack");
    const lot3 = { lot: 3 as const, steps: 4 as const, cell: { i0: 0, i1: 3.3, j0: 0, j1: 2.76 }, anchor: { i: 1.5, j: 1.38 } };
    const mausoleum = graveGeometry(dimetric, stone({ ...lot3, shape: plotShapeOf("sealed-tablet", 3) }));
    expect(classes(mausoleum.body)).not.toContain("crack");
    expect(classes(mausoleum.body)).toContain("door e");
    expect(classes(graveGeometry(dimetric, stone({ shape: "broken-column" })).body)).toContain("brk e");
  });

  it("adds lichen from w2 and moss from w3 only", () => {
    const marks = (weather: 0 | 1 | 2 | 3 | 4) => classes(graveGeometry(dimetric, stone({ weather })).body);
    for (const w of [0, 1] as const) expect(marks(w).filter((c) => c === "lichen" || c === "moss")).toEqual([]);
    expect(marks(2)).toContain("lichen");
    expect(marks(2)).not.toContain("moss");
    expect(marks(4)).toEqual(expect.arrayContaining(["lichen", "moss"]));
  });
});

describe("scene structure", () => {
  it("builds the portrait structure from the portrait model", () => {
    const tall = buildCemeteryPlotMap(CEMETERY_ENTRIES, { preset: "portrait" });
    const site = portraitSiteMarks(tall);
    const crossPaths = site.ground.filter((m) => "cls" in m && m.cls === "gravel");
    expect(crossPaths).toHaveLength(tall.blocks.length - 1);
    expect(site.beds.map((b) => b.cause).sort()).toEqual(tall.lanes.map((L) => L.cause).sort());
  });
});
