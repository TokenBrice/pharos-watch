import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { buildCemeteryPlotMap } from "@/lib/cemetery-plot-map";
import {
  PLOT_PROJECTIONS,
  PLOT_STEP_HEIGHT,
  PLOT_UNIT,
  PLOT_Z_SCALE,
  bbox,
  columnFractureTop,
  cylinder,
  desktopSiteMarks,
  faceMatrixE,
  fnv1a,
  graveGeometry,
  hull,
  lighthouseGeometry,
  plotDrawnObjects,
  plotShapeOf,
  portraitSiteMarks,
  project,
  seededStream,
  type PlotGraveShapeInput,
  type PlotMark,
  type PlotPoint,
} from "@/lib/cemetery-plot-geometry";

const dimetric = PLOT_PROJECTIONS.dimetric;
const portrait = PLOT_PROJECTIONS.portrait;

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

describe("projection", () => {
  it("is 2:1 dimetric on the desktop: x = (i − j)·S, y = (i + j)·S/2 − z·S·K", () => {
    for (const [i, j, z] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [-3.2, 4.1, 0.7]]) {
      const [x, y] = project(dimetric, i, j, z);
      expect(x).toBeCloseTo((i - j) * PLOT_UNIT, 9);
      expect(y).toBeCloseTo(((i + j) * PLOT_UNIT) / 2 - z * PLOT_UNIT * PLOT_Z_SCALE, 9);
    }
  });

  it("turns lanes into columns and time into rows on the portrait plan", () => {
    const origin = project(portrait, 0, 0, 0);
    expect(project(portrait, 0, 1, 0)[0]).toBeLessThan(origin[0]); // south lanes to the left
    expect(project(portrait, 0, 1, 0)[1]).toBe(origin[1]);
    expect(project(portrait, 1, 0, 0)[1]).toBeGreaterThan(origin[1]); // later rows further down
    expect(project(portrait, 0, 0, 1)[1]).toBeLessThan(origin[1]); // up is up
  });

  it("maps the lit-face frame's u to −j and v to −z", () => {
    const [a, b, c, d, e, f] = faceMatrixE(dimetric, 2, 3, 0.5);
    const at = (u: number, v: number): PlotPoint => [a * u + c * v + e, b * u + d * v + f];
    const expected = project(dimetric, 2, 3 - 1, 0.5 - 1);
    expect(at(1, 1)[0]).toBeCloseTo(expected[0], 0);
    expect(at(1, 1)[1]).toBeCloseTo(expected[1], 0);
  });
});

describe("hull and bbox", () => {
  it("keeps only the convex outline and bounds every point", () => {
    const pts: PlotPoint[] = [[0, 0], [4, 0], [4, 3], [0, 3], [2, 1], [1, 2], [2, 0]];
    const h = hull(pts);
    expect(h).toHaveLength(4);
    expect(h).toEqual(expect.arrayContaining([[0, 0], [4, 0], [4, 3], [0, 3]]));
    expect(bbox(pts)).toEqual({ x0: 0, y0: 0, x1: 4, y1: 3 });
  });
});

describe("columnFractureTop", () => {
  it("cuts the column with one planar diagonal break, deepened only by a small spall near the break", () => {
    const phase = seededStream(fnv1a("any-id"))() * 6.28;
    const top = columnFractureTop({ phase, amp: 0.3, spall: 0.06 });
    const n = 720;
    const thetas = Array.from({ length: n }, (_, k) => (k / n) * 2 * Math.PI);
    const offsets = thetas.map(top);
    for (const z of offsets) {
      expect(z).toBeLessThanOrEqual(0);
      expect(z).toBeGreaterThanOrEqual(-0.36);
    }
    // Outside the spall the rim lies on one tilted plane through the axis: z = −0.15 − 0.15·cos(θ − phase).
    const plane = (th: number) => -0.15 - 0.15 * Math.cos(th - phase);
    const spalled = thetas.filter((th, k) => Math.abs(offsets[k] - plane(th)) > 1e-12);
    expect(spalled.length).toBeGreaterThan(0);
    expect(spalled.length).toBeLessThan(n / 4);
    for (const th of spalled) {
      expect(Math.cos(th - phase)).toBeGreaterThan(0.5); // only on the low side, near the break
      expect(top(th)).toBeCloseTo(plane(th) - 0.06, 12);
    }
    // The rim stays whole opposite the break.
    expect(top(phase + Math.PI)).toBeCloseTo(0, 12);
  });

  it("lowers the cylinder's cap along the fracture, never raises it", () => {
    const flat = cylinder(dimetric, 0, 0, 0.2, 0, 1, "col");
    const broken = cylinder(dimetric, 0, 0, 0.2, 0, 1, "col", columnFractureTop({ phase: 1, amp: 0.3, spall: 0.06 }), "st-d");
    expect(flat.body).toHaveLength(42);
    expect(classes(broken.marks)).toEqual(["col e", "st-d e"]);
    const capYs = (c: typeof flat) => {
      const cap = c.marks[1];
      return cap.kind === "polygon" ? cap.points.map((p) => p[1]) : [];
    };
    const intact = capYs(flat);
    const cut = capYs(broken);
    expect(cut).toHaveLength(intact.length);
    cut.forEach((y, k) => expect(y).toBeGreaterThanOrEqual(intact[k]));
    expect(cut.some((y, k) => y > intact[k])).toBe(true);
  });
});

describe("graveGeometry", () => {
  it("is deterministic and rounds screen points to 0.1", () => {
    const a = graveGeometry(dimetric, stone({ shape: "broken-column", weather: 3 }));
    expect(graveGeometry(dimetric, stone({ shape: "broken-column", weather: 3 }))).toEqual(a);
    for (const m of a.body) {
      if (m.kind !== "polygon") continue;
      for (const [x, y] of m.points) {
        expect(Math.round(x * 10) / 10).toBe(x);
        expect(Math.round(y * 10) / 10).toBe(y);
      }
    }
    const other = graveGeometry(dimetric, stone({ shape: "broken-column", weather: 3, seed: fnv1a("another") }));
    expect(other.body).not.toEqual(a.body);
  });

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

  it("grows the stone with the height factor", () => {
    const tops = [0.64, 0.8, 1, 1.34].map((heightFactor) => graveGeometry(dimetric, stone({ steps: 0, heightFactor })).topZ);
    for (let k = 1; k < tops.length; k++) expect(tops[k]).toBeGreaterThan(tops[k - 1]);
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
    expect(classes(graveGeometry(dimetric, stone({ shape: "broken-column" })).body)).toContain("st-d e");
  });

  it("makes the colossal column the tallest element: above the lighthouse finial and the mausoleum", () => {
    const lot3 = { lot: 3 as const, steps: 4 as const, cell: { i0: 0, i1: 3.3, j0: 0, j1: 2.76 }, anchor: { i: 1.5, j: 1.38 } };
    const column = graveGeometry(dimetric, stone({ ...lot3, shape: plotShapeOf("broken-column", 3) }));
    const mausoleum = graveGeometry(dimetric, stone({ ...lot3, shape: plotShapeOf("sealed-tablet", 3) }));
    // Same ground point as the column's axis, so screen height compares true height.
    const lighthouse = lighthouseGeometry(dimetric, (lot3.cell.i0 + lot3.cell.i1) / 2 - 0.12, lot3.anchor.j);
    expect(column.topZ).toBeGreaterThan(mausoleum.topZ);
    expect(column.top[1]).toBeLessThan(lighthouse.top[1]);
  });

  it("adds lichen from w2 and moss from w3 only", () => {
    const marks = (weather: 0 | 1 | 2 | 3 | 4) => classes(graveGeometry(dimetric, stone({ weather })).body);
    for (const w of [0, 1] as const) expect(marks(w).filter((c) => c === "lichen" || c === "moss")).toEqual([]);
    expect(marks(2)).toContain("lichen");
    expect(marks(2)).not.toContain("moss");
    expect(marks(4)).toEqual(expect.arrayContaining(["lichen", "moss"]));
  });

  it("draws fresh soil, the bronze plaque, the footstone glyph and the lean only when the grave carries them", () => {
    const plain = graveGeometry(dimetric, stone());
    expect(classes(plain.ground)).toContain("mound es");
    expect(classes(plain.ground)).not.toContain("bronze e");
    expect(plain.ground.some((m) => m.kind === "glyph")).toBe(false);
    expect(plain.lean).toBeNull();

    const marked = graveGeometry(dimetric, stone({ fresh: true, archived: true, footstone: "€", lean: -2.4 }));
    expect(classes(marked.ground)).toEqual(expect.arrayContaining(["soil es", "bronze e"]));
    expect(marked.ground.find((m) => m.kind === "glyph")).toMatchObject({ text: "€" });
    expect(marked.lean?.deg).toBe(-2.4);
  });

  it("draws the same marks under the portrait projection", () => {
    for (const shape of ["pillow", "split-arch", "urn", "broken-column", "sealed-tablet"] as const) {
      expect(classes(graveGeometry(portrait, stone({ shape, weather: 3 })).body)).toEqual(classes(graveGeometry(dimetric, stone({ shape, weather: 3 })).body));
    }
  });
});

describe("scene structure", () => {
  const map = buildCemeteryPlotMap(CEMETERY_ENTRIES, { preset: "desktop" });

  it("lists every drawn volume in paint order", () => {
    const objects = plotDrawnObjects(map);
    expect(objects.map((o) => o.key)).toEqual(map.drawOrder);
    expect(objects.filter((o) => o.kind === "grave")).toHaveLength(map.graves.length);
    expect(objects.filter((o) => o.kind === "lamp").map((o) => (o.kind === "lamp" ? o.year : 0)).sort()).toEqual(map.lamps.map((l) => l.year).sort());
  });

  it("builds one bed cell per lane × year block and the cypress band east first", () => {
    const site = desktopSiteMarks(map);
    for (const bed of site.beds) {
      const lane = map.lanes.find((L) => L.cause === bed.cause)!;
      expect(bed.marks).toHaveLength(3 * lane.cells.length);
    }
    const treeYears = site.trees.map((t) => t.year);
    const byI = [...map.cypress].sort((a, b) => b.i - a.i).map((c) => c.year);
    expect(treeYears).toEqual(byI);
    expect(site.pools).toHaveLength(map.lamps.length);
  });

  it("builds the portrait structure from the portrait model", () => {
    const tall = buildCemeteryPlotMap(CEMETERY_ENTRIES, { preset: "portrait" });
    const site = portraitSiteMarks(tall);
    const crossPaths = site.ground.filter((m) => "cls" in m && m.cls === "gravel");
    expect(crossPaths).toHaveLength(tall.blocks.length - 1);
    expect(site.beds.map((b) => b.cause).sort()).toEqual(tall.lanes.map((L) => L.cause).sort());
  });
});
